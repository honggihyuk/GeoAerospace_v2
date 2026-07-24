import { NextResponse } from "next/server";
import { computeChange } from "@/lib/server/changeDetection";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/change?bbox=w,s,e,n&from=YYYY-MM-DD&to=YYYY-MM-DD&cloud=40
//   두 시점 분광지수 변화(Tier 1 합성) + dNBR 연소 심각도. 결정론 계산.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];
  const degW = bbox[2] - bbox[0];
  const degH = bbox[3] - bbox[1];
  if (degW <= 0 || degH <= 0) return NextResponse.json({ ok: false, reason: "bbox 순서 오류 (w<e, s<n)" }, { status: 200 });
  // 변화 탐지는 지수 6회 읽기라 비용이 커 AOI를 더 좁게 제한한다(자기교정 반환).
  if (degW > 0.5 || degH > 0.5) {
    return NextResponse.json(
      { ok: false, reason: `AOI가 너무 큼 (${degW.toFixed(2)}°×${degH.toFixed(2)}°). 0.5°×0.5° 이하로 좁혀 재요청`, max_deg: 0.5 },
      { status: 200 }
    );
  }

  const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) {
    return NextResponse.json({ ok: false, reason: "from·to는 YYYY-MM-DD 형식 필수" }, { status: 200 });
  }
  if (from! >= to!) return NextResponse.json({ ok: false, reason: "from이 to보다 앞서야 합니다" }, { status: 200 });

  const cloudRaw = Number(u.searchParams.get("cloud"));
  try {
    const res = await computeChange(bbox, from!, to!, { maxCloud: Number.isFinite(cloudRaw) ? cloudRaw : 40 });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
