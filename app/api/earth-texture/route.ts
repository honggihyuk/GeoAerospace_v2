import { NextResponse } from "next/server";
import { ALLOWED_WIDTHS, fetchEarthImagery, GIBS_LAYER, type ImageryLayer } from "@/lib/server/fetchEarthImagery";

export const dynamic = "force-dynamic";

// GET /api/earth-texture?layer=day|night|base&w=1024|2048|4096
// 3D 지구 구에 입힐 NASA GIBS 등장방형 텍스처 (고도화 B1).
const LAYERS: ImageryLayer[] = ["day", "dayprev", "night", "base"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("layer");
  const layer: ImageryLayer = LAYERS.includes(q as ImageryLayer) ? (q as ImageryLayer) : "day";
  const wParam = Number(url.searchParams.get("w"));
  const width = (ALLOWED_WIDTHS as readonly number[]).includes(wParam) ? wParam : 2048;

  try {
    const img = await fetchEarthImagery(layer, width);
    return new NextResponse(img.body, {
      headers: {
        "content-type": img.type,
        "content-length": String(img.body.byteLength),
        "cache-control": "public, max-age=3600",
        "x-imagery-date": img.date,
        "x-imagery-layer": GIBS_LAYER[layer],
      },
    });
  } catch (e) {
    // 클라는 502를 받으면 양식화된 지구로 폴백한다(텍스처 없이도 동작).
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
