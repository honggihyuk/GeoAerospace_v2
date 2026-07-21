import { NextResponse } from "next/server";
import { fetchFires, isAreaApiConfigured, MAX_POINTS, type Bbox } from "@/lib/server/fetchFires";

export const dynamic = "force-dynamic";

// GET /api/fires?bbox=W,S,E,N&dayRange=1&minFrp=100&minConfidence=50&limit=2000
// NASA FIRMS 활성 화재 + EONET 화산 (개발제안서 §4.7 / P5.5).
//
// MAP_KEY는 서버에만 있고 응답에도 절대 싣지 않는다. 클라는 키 설정 여부(`precise`)만 안다.
function parseBbox(raw: string | null): Bbox | undefined {
  if (!raw) return undefined;
  const p = raw.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return undefined;
  const [west, south, east, north] = p;
  if (south > north || south < -90 || north > 90) return undefined;
  return { west, south, east, north };
}

function num(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  try {
    const result = await fetchFires({
      bbox: parseBbox(u.searchParams.get("bbox")),
      dayRange: num(u.searchParams.get("dayRange")),
      minFrp: num(u.searchParams.get("minFrp")),
      minConfidence: num(u.searchParams.get("minConfidence")),
      limit: Math.min(MAX_POINTS, num(u.searchParams.get("limit")) ?? MAX_POINTS),
      includeVolcanoes: u.searchParams.get("volcanoes") !== "0",
    });
    return NextResponse.json(result, { headers: { "cache-control": "public, max-age=300" } });
  } catch (e) {
    return NextResponse.json(
      { points: [], summary: null, error: String(e), areaApi: isAreaApiConfigured() },
      { status: 200 }
    );
  }
}
