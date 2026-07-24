import { geocodeServer } from "@/lib/server/geocode";

/** place가 오면 서버가 지오코딩해 bbox+폴리곤을 만든다(폴리곤은 URL로 못 넘기므로 서버에서 처리). */
export async function resolveAoi(
  place: string | null,
  bboxParam: string | null,
  maxDeg: number
): Promise<{ bbox: [number, number, number, number]; polygon: [number, number][][] | null; name?: string } | { error: string }> {
  if (place) {
    const g = await geocodeServer(place);
    if (!g) return { error: `장소를 찾지 못했습니다: ${place}` };
    // 지오코더 경계를 상한으로 클램프(중심 유지).
    const w = Math.min(maxDeg, Math.max(0.02, g.bbox[2] - g.bbox[0]));
    const h = Math.min(maxDeg, Math.max(0.02, g.bbox[3] - g.bbox[1]));
    return {
      bbox: [g.lng - w / 2, g.lat - h / 2, g.lng + w / 2, g.lat + h / 2],
      polygon: g.polygon,
      name: g.displayName,
    };
  }
  const p = (bboxParam ?? "").split(",").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return { error: "bbox 형식 오류 (w,s,e,n) 또는 place 필요" };
  const b = p as [number, number, number, number];
  if (b[2] - b[0] <= 0 || b[3] - b[1] <= 0) return { error: "bbox 순서 오류 (w<e, s<n)" };
  if (b[2] - b[0] > maxDeg || b[3] - b[1] > maxDeg) return { error: `AOI가 너무 큼 — ${maxDeg}°×${maxDeg}° 이하로 재요청` };
  return { bbox: b, polygon: null };
}
