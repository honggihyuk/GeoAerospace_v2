import { computeIndexGrid, type IndexName } from "@/lib/server/spectralIndex";
import { renderIndexPng } from "@/lib/server/indexColormap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/spectral/image?index=ndvi|ndwi|nbr&bbox=w,s,e,n&date=&cloud=
//   지수 격자를 컬러맵 PNG로 렌더 → maplibre image 소스로 bbox에 정합해 올린다.
//   무효 픽셀(구름·nodata)은 투명이라 배경 지도가 비친다.
const VALID: IndexName[] = ["ndvi", "ndwi", "nbr"];

export async function GET(req: Request) {
  const u = new URL(req.url);
  const index = (u.searchParams.get("index") ?? "ndvi").toLowerCase() as IndexName;
  const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (!VALID.includes(index) || parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return new Response("bad request", { status: 400 });
  }
  const bbox = parts as [number, number, number, number];
  if (bbox[2] - bbox[0] > 1 || bbox[3] - bbox[1] > 1) return new Response("AOI too large (max 1deg)", { status: 400 });

  const cloudRaw = Number(u.searchParams.get("cloud"));
  try {
    const grid = await computeIndexGrid(index, bbox, {
      date: u.searchParams.get("date") ?? undefined,
      maxCloud: Number.isFinite(cloudRaw) ? cloudRaw : 30,
    });
    const png = await renderIndexPng(index, grid.values, grid.width, grid.height);
    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        // 장면·격자 정보를 헤더로 노출(클라이언트가 캡션에 쓸 수 있게).
        "x-scene-id": grid.scene.id,
        "x-scene-date": grid.scene.date,
        "cache-control": "private, max-age=600",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
