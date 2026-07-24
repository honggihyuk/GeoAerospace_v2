import { NextResponse } from "next/server";
import { computeIndex, type IndexName } from "@/lib/server/spectralIndex";
import { resolveAoi } from "@/lib/server/aoi";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/spectral?index=ndvi|ndwi|nbr&bbox=w,s,e,n&date=YYYY-MM-DD&cloud=30
//   Sentinel-2 분광지수 통계(면적·분류·분포). 결정론 계산 — LLM은 이 숫자를 서술만 한다.
const VALID: IndexName[] = ["ndvi", "ndwi", "nbr"];

export async function GET(req: Request) {
  const u = new URL(req.url);
  const index = (u.searchParams.get("index") ?? "ndvi").toLowerCase() as IndexName;
  if (!VALID.includes(index)) {
    return NextResponse.json({ ok: false, reason: `index는 ${VALID.join("|")} 중 하나` }, { status: 200 });
  }

  // place를 주면 서버가 지오코딩해 **실제 폴리곤으로 클리핑**한다(사각형보다 정확).
  const aoi = await resolveAoi(u.searchParams.get("place"), u.searchParams.get("bbox"), 1.0);
  if ("error" in aoi) return NextResponse.json({ ok: false, reason: aoi.error }, { status: 200 });

  const date = u.searchParams.get("date") ?? undefined;
  const cloudRaw = Number(u.searchParams.get("cloud"));
  const maxCloud = Number.isFinite(cloudRaw) ? Math.min(100, Math.max(0, cloudRaw)) : 30;

  try {
    const stats = await computeIndex(index, aoi.bbox, { date, maxCloud, polygon: aoi.polygon ?? undefined });
    return NextResponse.json({ ok: true, place: aoi.name, clipped: !!aoi.polygon, bbox: aoi.bbox, ...stats });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
