import { NextResponse } from "next/server";
import { fetchSignalIntersections } from "@/lib/server/fetchSignalUtic";

export const dynamic = "force-dynamic";

// GET /api/signal → 인천·대구 신호제어 교차로(좌표+이름). data.go.kr 서비스키(DATA_GO_KR_SIGNAL_KEY) 필요.
export async function GET() {
  try {
    const { items, source, configured } = await fetchSignalIntersections();
    return NextResponse.json({ ok: true, configured, source, count: items.length, intersections: items });
  } catch (e) {
    return NextResponse.json({ ok: false, configured: true, reason: String(e), intersections: [] }, { status: 200 });
  }
}
