import { NextResponse } from "next/server";
import { fetchInsarNorway } from "@/lib/server/fetchInsarNorway";
import { ingestInsar } from "@/lib/server/ingest";
import { db, dbReady } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// POST /api/ingest/insar-ngu { bbox, dataset?, minCoherence?, maxPoints? }
// InSAR Norway(NGU) 실측 Sentinel-1 지반운동을 observations(kind='subsidence', source='insar-ngu')에 적재.
//   value = mean_velocity (mm/yr LoS, 음수=침하). 커버리지: 노르웨이.
//   dataset은 https://insar.ngu.no/insar-api/list-datasets 에서 대상 지역 트랙 선택(기본 Bergen).
export async function POST(req: Request) {
  if (!(await dbReady())) return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });

  let body: { bbox?: string; dataset?: string; minCoherence?: number; maxPoints?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }
  const parts = (body.bbox ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  try {
    const res = await fetchInsarNorway(bbox, {
      dataset: body.dataset,
      minCoherence: body.minCoherence,
      maxPoints: body.maxPoints,
    });
    if (!res.points.length) {
      return NextResponse.json(
        { ok: false, reason: `해당 bbox에 데이터 없음 (dataset=${res.dataset} 커버리지 밖일 수 있음)`, dataset: res.dataset },
        { status: 200 }
      );
    }
    const { fetched, inserted } = await ingestInsar(res.points, { source: "insar-ngu" });
    const { rows } = await db().query<{ n: string; min: string; avg: string }>(
      `SELECT count(*)::text n, min(value)::text min, round(avg(value)::numeric,2)::text avg
         FROM observations WHERE source='insar-ngu' AND geom && ST_MakeEnvelope($1,$2,$3,$4,4326)`,
      [bbox[0], bbox[1], bbox[2], bbox[3]]
    );
    return NextResponse.json({
      ok: true,
      dataset: res.dataset,
      rawPoints: res.rawPoints,
      fetched,
      inserted,
      inBbox: Number(rows[0]?.n ?? 0),
      maxSubsidenceMmYr: rows[0]?.min ? Math.abs(Number(rows[0].min)) : null,
      meanMmYr: rows[0]?.avg ? Number(rows[0].avg) : null,
      source: "insar-ngu (InSAR Norway 실측)",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
