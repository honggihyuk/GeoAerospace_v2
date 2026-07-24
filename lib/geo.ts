// 지오코딩 (설계서 §4.5 그라운딩) — 주요 도시 내장 테이블 + Nominatim 폴백.
// 모델이 좌표를 emit하지 않고 지명만 넘김 → 좌표 환각 방지.

const CITIES: Record<string, [number, number]> = {
  // [lng, lat]
  서울: [126.98, 37.57], seoul: [126.98, 37.57],
  부산: [129.08, 35.18], busan: [129.08, 35.18],
  도쿄: [139.76, 35.68], tokyo: [139.76, 35.68],
  오사카: [135.5, 34.69], osaka: [135.5, 34.69],
  베이징: [116.4, 39.9], beijing: [116.4, 39.9],
  상하이: [121.47, 31.23], shanghai: [121.47, 31.23],
  홍콩: [114.17, 22.32], "hong kong": [114.17, 22.32],
  싱가포르: [103.82, 1.35], singapore: [103.82, 1.35],
  뉴욕: [-74.01, 40.71], "new york": [-74.01, 40.71], nyc: [-74.01, 40.71],
  la: [-118.24, 34.05], "los angeles": [-118.24, 34.05], 로스앤젤레스: [-118.24, 34.05],
  런던: [-0.13, 51.51], london: [-0.13, 51.51],
  파리: [2.35, 48.86], paris: [2.35, 48.86],
  베를린: [13.4, 52.52], berlin: [13.4, 52.52],
  모스크바: [37.62, 55.75], moscow: [37.62, 55.75],
  두바이: [55.27, 25.2], dubai: [55.27, 25.2],
  시드니: [151.21, -33.87], sydney: [151.21, -33.87],
  샌프란시스코: [-122.42, 37.77], "san francisco": [-122.42, 37.77],
  한국: [127.5, 36.5], korea: [127.5, 36.5], 대한민국: [127.5, 36.5],
  일본: [138.0, 37.0], japan: [138.0, 37.0],
  미국: [-98.0, 39.0], usa: [-98.0, 39.0],
};

/** 텍스트에서 알려진 도시명을 탐지 (긴 것 우선). 의도 해석 레이어용. */
export function findCity(text: string): string | null {
  const t = text.toLowerCase();
  const keys = Object.keys(CITIES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    // ⚠️ ASCII 키는 **단어 경계**로 매칭한다 — 부분문자열이면 "Folsom Lake"의 'la'가 로스앤젤레스로,
    //    "Florida"의 'la'가 잡히는 오인식이 난다(실측: Folsom Lake → la로 LA를 분석). 한글은
    //    교착어라 경계 개념이 약하고 도시명이 부분일치로 문제되는 경우가 드물어 includes 유지.
    if (/^[a-z0-9 ]+$/.test(k)) {
      if (new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t)) return k;
    } else if (t.includes(k)) {
      return k;
    }
  }
  return null;
}

/**
 * 지명 → 분석용 AOI. 지오코더가 준 **실제 경계**를 쓰되 상·하한으로 클램프한다.
 *   - 고정 패드는 큰 도시엔 너무 좁고 작은 마을엔 너무 넓다 → 실제 bbox가 훨씬 낫다.
 *   - maxDeg: API 상한(분광 1°, 변화 0.5°)을 넘지 않게 중심 기준 축소.
 *   - minDeg: 점(point) 결과가 픽셀 부족으로 실패하지 않게 최소 크기 보장.
 * 내장 테이블 도시는 좌표만 있으므로 기본 패드를 쓴다.
 */
export async function geocodeArea(
  place: string,
  maxDeg: number,
  minDeg = 0.02
): Promise<{ center: [number, number]; bbox: [number, number, number, number]; source: "table" | "osm" | "fallback" } | null> {
  const clamp = (c: [number, number], b: [number, number, number, number] | null, src: "table" | "osm" | "fallback") => {
    const [lng, lat] = c;
    let w = b ? b[2] - b[0] : minDeg * 2;
    let h = b ? b[3] - b[1] : minDeg * 2;
    w = Math.min(maxDeg, Math.max(minDeg, w));
    h = Math.min(maxDeg, Math.max(minDeg, h));
    // 중심은 지오코더 좌표를 신뢰(경계 중심이 아니라) — 관심 지점이 중앙에 오도록.
    return { center: c, bbox: [lng - w / 2, lat - h / 2, lng + w / 2, lat + h / 2] as [number, number, number, number], source: src };
  };

  const key = place.trim().toLowerCase().replace(/(광역시|특별시|시|로|으로|에|를|을)$/u, "").trim();
  const t = CITIES[key] ?? CITIES[place.trim().toLowerCase()];
  if (t) return clamp(t, null, "table");

  try {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(place)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { lat?: number; lng?: number; bbox?: number[]; fallback?: boolean };
    if (typeof j.lng !== "number" || typeof j.lat !== "number") return null;
    const bb = j.bbox && j.bbox.length === 4 ? (j.bbox as [number, number, number, number]) : null;
    return clamp([j.lng, j.lat], bb, j.fallback ? "fallback" : "osm");
  } catch {
    return null;
  }
}

/** 지명 → [lng, lat]. 내장 테이블 우선, 없으면 /api/geocode(Nominatim). */
export async function geocodePlace(place: string): Promise<[number, number] | null> {
  const key = place.trim().toLowerCase().replace(/(광역시|특별시|시|로|으로|에|를|을)$/u, "").trim();
  if (CITIES[key]) return CITIES[key];
  if (CITIES[place.trim().toLowerCase()]) return CITIES[place.trim().toLowerCase()];
  try {
    const r = await fetch(`/api/geocode?q=${encodeURIComponent(place)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = (await r.json()) as { lng?: number; lat?: number };
    return typeof j.lng === "number" && typeof j.lat === "number" ? [j.lng, j.lat] : null;
  } catch {
    return null;
  }
}
