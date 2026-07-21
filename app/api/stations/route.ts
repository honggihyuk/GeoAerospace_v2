import { NextResponse } from "next/server";
import { fetchStations } from "@/lib/server/fetchStations";

export const dynamic = "force-dynamic";

// GET /api/stations — 온라인 SatNOGS 지상국 (고도화 B4).
// 가시성 판정 자체는 클라에서 매 프레임 수행한다(위성 위치가 계속 바뀌므로).
export async function GET() {
  try {
    const s = await fetchStations();
    return NextResponse.json(s, { headers: { "cache-control": "public, max-age=1800" } });
  } catch (e) {
    return NextResponse.json({ stations: [], total: 0, online: 0, error: String(e) }, { status: 200 });
  }
}
