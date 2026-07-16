import { NextResponse } from "next/server";
import { fetchAircraft } from "@/lib/server/fetchAircraft";

export const dynamic = "force-dynamic";

// GET /api/aircraft — 다중 소스 ADS-B 수집 (query_aircraft, 설계서 §4.2)
export async function GET() {
  try {
    const { data, source } = await fetchAircraft();
    return NextResponse.json({ aircraft: data, count: data.length, source, fetchedAt: Date.now() });
  } catch (e) {
    return NextResponse.json({ aircraft: [], count: 0, source: "error", error: String(e), fetchedAt: Date.now() });
  }
}
