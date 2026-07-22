import { NextResponse } from "next/server";
import { isOpenAqConfigured } from "@/lib/server/fetchOpenAQ";
import { ingestOpenAQ } from "@/lib/server/ingest";
import { db, dbReady } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/ingest/openaq { bbox?, maxLocations? } → OpenAQ 최신 대기질을 observations(레인 ②)에 적재.
export async function POST(req: Request) {
  if (!(await dbReady())) {
    return NextResponse.json({ ok: false, reason: "DB 미가용 (DATABASE_URL/컨테이너 확인)" }, { status: 200 });
  }
  if (!isOpenAqConfigured()) {
    return NextResponse.json(
      { ok: false, reason: "OpenAQ 미설정", need: ["OPENAQ_API_KEY"], hint: "explore.openaq.org → Register → API Keys 에서 무료 발급 후 .env.local 에 추가" },
      { status: 200 }
    );
  }

  let body: { bbox?: string; maxLocations?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 기본값 */
  }
  const parts = (body.bbox ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류" }, { status: 200 });
  }
  const [west, south, east, north] = parts as [number, number, number, number];

  try {
    const res = await ingestOpenAQ([west, south, east, north], body.maxLocations);
    if (!res) return NextResponse.json({ ok: false, reason: "OpenAQ 미설정" }, { status: 200 });
    const { rows } = await db().query<{ kind: string; n: string }>(
      `SELECT kind, count(*)::text AS n FROM observations
        WHERE source='openaq' AND geom && ST_MakeEnvelope($1,$2,$3,$4,4326)
        GROUP BY kind ORDER BY kind`,
      [west, south, east, north]
    );
    return NextResponse.json({
      ok: true,
      fetched: res.fetched,
      inserted: res.inserted,
      byKind: Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)])),
      bbox: parts.join(","),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
