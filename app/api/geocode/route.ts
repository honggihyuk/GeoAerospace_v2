import { NextResponse } from "next/server";
import { safeFetch } from "@/lib/server/safeFetch";

export const dynamic = "force-dynamic";

// GET /api/geocode?q=[&maxKm2=]  — Nominatim(OSM) 지오코딩 (SSRF 가드, 설계서 §4.5)
//
// AWS geospatial-agent의 get_best_geometry(교차검증)를 우리 스택에 맞춰 이식:
//   ① 후보를 여러 개 받아 **경계 면적이 과도한 결과를 기각**한다(도시를 물었는데 국가/주가 오는 경우).
//   ② 통과한 결과의 **실제 bbox를 함께 반환** → 호출부가 고정 패드 대신 실제 경계를 쓸 수 있다.
//   ③ 모두 기각되면 1순위 좌표 기준 폴백 bbox를 주고 사유를 남긴다(AWS _create_fallback_bbox와 같은 취지).
// 지오코딩 오매칭이 조용히 "엉뚱한 지역 분석"으로 이어지는 것을 코드 레벨에서 막는 층이다.

type Hit = { lat: string; lon: string; boundingbox?: string[]; display_name?: string; type?: string };

/** bbox[w,s,e,n] 대략 면적(km²) — 위도 보정 포함(고위도에서 경도 1°가 짧아진다). */
function bboxAreaKm2(b: [number, number, number, number]): number {
  const latMid = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  const wKm = (b[2] - b[0]) * 111.32 * Math.cos(latMid);
  const hKm = (b[3] - b[1]) * 110.57;
  return Math.abs(wKm * hKm);
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const q = u.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });
  // 기본 상한 — 도시 규모(≈100×100km)까지 허용. 국가/주 단위 오매칭을 거른다.
  const maxKm2 = Math.max(1, Number(u.searchParams.get("maxKm2") ?? 10_000));

  try {
    const r = await safeFetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`, {
      timeoutMs: 8000,
      accept: "application/json",
    });
    if (!r.ok) return NextResponse.json({ error: `nominatim ${r.status}` });
    const hits = (await r.json()) as Hit[];
    if (!hits.length) return NextResponse.json({ error: "not found" });

    const scored = hits.map((h) => {
      const lat = Number(h.lat);
      const lng = Number(h.lon);
      // Nominatim boundingbox = [south, north, west, east] (문자열)
      const bb = h.boundingbox?.map(Number);
      const bbox: [number, number, number, number] | null =
        bb && bb.length === 4 && bb.every(Number.isFinite) ? [bb[2], bb[0], bb[3], bb[1]] : null;
      return { lat, lng, bbox, areaKm2: bbox ? bboxAreaKm2(bbox) : null, name: h.display_name ?? "", type: h.type ?? "" };
    });

    // ① 면적 과도 결과 기각
    const valid = scored.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
    const passed = valid.filter((s) => s.areaKm2 === null || s.areaKm2 <= maxKm2);
    // ② 통과분 중 **면적이 가장 큰 것**을 고른다 — Nominatim 1순위는 역·건물 같은 POI인 경우가 많은데
    //    ("울진" → 울진역 1km²) 지역 분석에는 행정경계/취락이 맞다. 상한은 이미 걸려 있으므로 안전하다.
    const ok = passed.sort((a, b) => (b.areaKm2 ?? 0) - (a.areaKm2 ?? 0))[0];
    if (ok) {
      return NextResponse.json({
        lat: ok.lat,
        lng: ok.lng,
        bbox: ok.bbox,
        areaKm2: ok.areaKm2 === null ? null : Math.round(ok.areaKm2),
        displayName: ok.name,
        type: ok.type,
        rejected: valid.length - passed.length, // 면적 상한에 실제로 걸린 후보 수
      });
    }

    // ③ 전부 기각 — 1순위 좌표 기준 폴백 bbox(±0.05° ≈ 11km)를 반환하고 사유를 남긴다.
    const first = scored[0];
    if (!Number.isFinite(first?.lat) || !Number.isFinite(first?.lng)) return NextResponse.json({ error: "not found" });
    const pad = 0.05;
    const smallest = Math.min(...scored.map((s) => s.areaKm2 ?? Infinity));
    return NextResponse.json({
      lat: first.lat,
      lng: first.lng,
      bbox: [first.lng - pad, first.lat - pad, first.lng + pad, first.lat + pad],
      areaKm2: null,
      displayName: first.name,
      type: first.type,
      fallback: true,
      reason: `모든 후보의 경계가 과도(최소 ${Math.round(smallest)} km² > ${maxKm2} km²) — 좌표 기준 폴백 bbox 사용`,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) });
  }
}
