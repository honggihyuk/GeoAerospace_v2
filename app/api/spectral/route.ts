import { NextResponse } from "next/server";
import { computeIndex, type IndexName } from "@/lib/server/spectralIndex";

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

  const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  // 과대 AOI 방어 — 창이 커지면 COG 읽기가 급증한다. 초과 시 축소를 권고(자기교정 반환).
  const degW = bbox[2] - bbox[0];
  const degH = bbox[3] - bbox[1];
  if (degW <= 0 || degH <= 0) return NextResponse.json({ ok: false, reason: "bbox 순서 오류 (w<e, s<n)" }, { status: 200 });
  if (degW > 1.0 || degH > 1.0) {
    return NextResponse.json(
      { ok: false, reason: `AOI가 너무 큼 (${degW.toFixed(2)}°×${degH.toFixed(2)}°). 1°×1° 이하로 좁혀 재요청`, max_deg: 1.0 },
      { status: 200 }
    );
  }

  const date = u.searchParams.get("date") ?? undefined;
  const cloudRaw = Number(u.searchParams.get("cloud"));
  const maxCloud = Number.isFinite(cloudRaw) ? Math.min(100, Math.max(0, cloudRaw)) : 30;

  try {
    const stats = await computeIndex(index, bbox, { date, maxCloud });
    return NextResponse.json({ ok: true, ...stats });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
