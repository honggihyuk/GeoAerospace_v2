// 서버측 지오코딩 — 면적 검증 + **실제 폴리곤** 확보(AWS get_best_geometry 이식).
//   폴리곤은 클라이언트로 보내지 않고 서버가 바로 클리핑에 쓴다(수백 정점을 URL로 못 넘긴다).
import { safeFetch } from "./safeFetch";

export type GeoHit = {
  lat: number;
  lng: number;
  bbox: [number, number, number, number];
  areaKm2: number | null;
  displayName: string;
  type: string;
  /** 외곽 링들(lon/lat). Polygon=1개, MultiPolygon=여러 개. 없으면 null → bbox로 분석. */
  polygon: [number, number][][] | null;
  fallback?: boolean;
  rejected?: number;
};

type Hit = {
  lat: string;
  lon: string;
  boundingbox?: string[];
  display_name?: string;
  type?: string;
  geojson?: { type: string; coordinates: unknown };
};

/** bbox[w,s,e,n] 대략 면적(km²) — 위도 보정 포함. */
export function bboxAreaKm2(b: [number, number, number, number]): number {
  const latMid = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return Math.abs((b[2] - b[0]) * 111.32 * Math.cos(latMid) * ((b[3] - b[1]) * 110.57));
}

/** GeoJSON Polygon/MultiPolygon → 외곽 링 배열. 그 외 타입(점·선)은 null. */
function outerRings(g?: { type: string; coordinates: unknown }): [number, number][][] | null {
  if (!g) return null;
  if (g.type === "Polygon") return [(g.coordinates as [number, number][][])[0]];
  if (g.type === "MultiPolygon") return (g.coordinates as [number, number][][][]).map((p) => p[0]);
  return null;
}

/**
 * 지명 → 좌표·경계·폴리곤. 면적이 과도한 후보는 기각하고, 통과분 중 **가장 큰 것**을 고른다
 * (Nominatim 1순위는 역·건물 같은 POI인 경우가 많다 — "울진" → 울진역 1km²).
 */
export async function geocodeServer(q: string, maxKm2 = 10_000): Promise<GeoHit | null> {
  const r = await safeFetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=5&polygon_geojson=1&q=${encodeURIComponent(q)}`,
    { timeoutMs: 10_000, accept: "application/json" }
  );
  if (!r.ok) return null;
  const hits = (await r.json()) as Hit[];
  if (!hits.length) return null;

  const scored = hits
    .map((h) => {
      const lat = Number(h.lat);
      const lng = Number(h.lon);
      const bb = h.boundingbox?.map(Number); // [south, north, west, east]
      const bbox: [number, number, number, number] | null =
        bb && bb.length === 4 && bb.every(Number.isFinite) ? [bb[2], bb[0], bb[3], bb[1]] : null;
      return {
        lat,
        lng,
        bbox,
        areaKm2: bbox ? bboxAreaKm2(bbox) : null,
        displayName: h.display_name ?? "",
        type: h.type ?? "",
        polygon: outerRings(h.geojson),
      };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  if (!scored.length) return null;

  const passed = scored.filter((s) => s.areaKm2 === null || s.areaKm2 <= maxKm2);
  const ok = passed.sort((a, b) => (b.areaKm2 ?? 0) - (a.areaKm2 ?? 0))[0];
  if (ok && ok.bbox) return { ...ok, bbox: ok.bbox, rejected: scored.length - passed.length };

  // 전부 기각(또는 bbox 없음) — 좌표 기준 폴백.
  const f = scored[0];
  const pad = 0.05;
  return {
    lat: f.lat,
    lng: f.lng,
    bbox: [f.lng - pad, f.lat - pad, f.lng + pad, f.lat + pad],
    areaKm2: null,
    displayName: f.displayName,
    type: f.type,
    polygon: null, // 폴백은 폴리곤을 쓰지 않는다(경계를 신뢰할 수 없음)
    fallback: true,
  };
}
