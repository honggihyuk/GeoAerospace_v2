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
  for (const k of keys) if (t.includes(k)) return k;
  return null;
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
