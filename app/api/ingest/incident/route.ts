import { NextResponse } from "next/server";
import { ingestIncidents } from "@/lib/server/ingest";
import { db, dbReady } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/ingest/incident { bbox? } → ITS 실시간 돌발(사고·공사·통제)을 observations(레인 ②)에 적재.
//   소스: ITS 국가교통정보센터 eventInfo (ITS_API_KEY, 없으면 데모키 "test"=전국고정). 데모키는 bbox로 필터.
export async function POST(req: Request) {
  if (!(await dbReady())) {
    return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });
  }
  let body: { bbox?: string } = {};
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

  try {
    const res = await ingestIncidents([west, south, east, north]);
    if (!res) return NextResponse.json({ ok: false, reason: "ITS 돌발 조회 실패" }, { status: 200 });
    const { rows } = await db().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM observations
        WHERE kind='incident' AND geom && ST_MakeEnvelope($1,$2,$3,$4,4326)`,
      [west, south, east, north]
    );
    return NextResponse.json({
      ok: true,
      fetched: res.fetched, // bbox 내 돌발 수(데모키는 필터 후)
      inserted: res.inserted, // 신규 적재(중복 제외)
      inBbox: Number(rows[0]?.n ?? 0), // 현재 bbox 내 누적 돌발 관측 수
      bbox: parts.join(","),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
