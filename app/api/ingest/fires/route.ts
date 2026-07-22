import { NextResponse } from "next/server";
import { ingestFires } from "@/lib/server/ingest";
import { db, dbReady } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/ingest/fires { bbox?, day? } → FIRMS 활성 화재를 observations(레인 ②)에 적재.
export async function POST(req: Request) {
  if (!(await dbReady())) {
    return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });
  }
  let body: { bbox?: string; day?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 기본값 사용 */
  }

  const parts = (body.bbox ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류" }, { status: 200 });
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  const dayRange = Math.min(10, Math.max(1, Number(body.day ?? 3)));

  try {
    const { fetched, inserted, rejectedLowConf, rejectedWater } = await ingestFires([west, south, east, north], dayRange);
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM observations WHERE geom && ST_MakeEnvelope($1,$2,$3,$4,4326)`,
      [west, south, east, north]
    );
    return NextResponse.json({
      ok: true,
      fetched,
      inserted,
      rejectedLowConf, // 저신뢰도로 제거된 화재 수
      rejectedWater, // 바다(해수면 이하)로 제거된 오탐 수
      inBbox: Number(rows[0]?.n ?? 0),
      bbox: parts.join(","),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
