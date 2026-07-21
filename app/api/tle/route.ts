import { NextResponse } from "next/server";
import { fetchTleByIds } from "@/lib/server/fetchTle";
import { SATELLITES } from "@/lib/tle";

export const dynamic = "force-dynamic";

// GET /api/tle?ids=25544,44713  — 실시간 TLE 수집 (get_tle, 설계서 §7.5)
export async function GET(req: Request) {
  const url = new URL(req.url);
  const idsParam = url.searchParams.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => Number(s.trim()))
    : SATELLITES.map((s) => s.noradId);

  try {
    const { sats, source, bySource } = await fetchTleByIds(ids);
    if (sats.length === 0) {
      // 전 소스 실패 → 데모 세트로 폴백(HTTP 200, 클라 표기 'demo')
      return NextResponse.json({ sats: SATELLITES, source: "demo", fetchedAt: Date.now() });
    }
    return NextResponse.json({ sats, source, bySource, fetchedAt: Date.now() });
  } catch (e) {
    return NextResponse.json({ sats: SATELLITES, source: "demo", error: String(e), fetchedAt: Date.now() });
  }
}
