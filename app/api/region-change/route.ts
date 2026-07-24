import { NextResponse } from "next/server";
import { scanRegionChange } from "@/lib/server/regionChange";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // 파티션 다운(~26s)×시점×지오해시라 넉넉히

// GET /api/region-change?bbox=w,s,e,n&from=YYYY-MM&to=YYYY-MM
//   Clay 임베딩 광역 변화 스캔. 픽셀 변화탐지(/api/change)의 상위 계층 — 1.28km 셀 단위.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];
  const degW = bbox[2] - bbox[0], degH = bbox[3] - bbox[1];
  if (degW <= 0 || degH <= 0) return NextResponse.json({ ok: false, reason: "bbox 순서 오류" }, { status: 200 });
  // 광역 스캔이지만 파티션 필터가 O(셀 수)라 너무 크면 느리다 — 5°까지 허용(픽셀 탐지의 10배).
  if (degW > 5 || degH > 5) return NextResponse.json({ ok: false, reason: "AOI가 너무 큼 — 5°×5° 이하로 재요청", max_deg: 5 }, { status: 200 });

  const ym = (s: string | null) => (s && /^\d{4}-\d{2}$/.test(s) ? s : null);
  const from = ym(u.searchParams.get("from"));
  const to = ym(u.searchParams.get("to"));
  if (!from || !to) return NextResponse.json({ ok: false, reason: "from·to는 YYYY-MM 형식 필수" }, { status: 200 });
  if (from >= to) return NextResponse.json({ ok: false, reason: "from이 to보다 앞서야 합니다" }, { status: 200 });

  try {
    const res = await scanRegionChange(bbox, from, to);
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
