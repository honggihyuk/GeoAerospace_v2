import { NextResponse } from "next/server";
import { ingestInsar, type InsarPoint } from "@/lib/server/ingest";
import { db, dbReady } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/ingest/insar → InSAR 지표 변위점을 observations(레인 ②, kind='subsidence')에 적재.
// "소비 모델": 사전계산된 InSAR 산출물을 두 형식 중 하나로 받는다.
//   1) { points: [{lon,lat,velocity,observedAt?}], source? }  — velocity: mm/yr, 음수=침하
//   2) { geojson: FeatureCollection<Point>, source? }         — 속성에서 velocity 자동 추출
// 실데이터 소스 예: EGMS(유럽), COMET LiCSAR(전지구 프레임), 국내 지반침하 관측망.
//   ⚠️ 한반도 커버 무료 API는 부재 — 산출물 파일을 이 라우트로 흘려보내는 방식.

const VEL_KEYS = ["velocity", "vel", "mean_velocity", "VEL", "v", "deformation", "los_velocity"];

function extractPoints(geojson: unknown): InsarPoint[] {
  const fc = geojson as { features?: unknown[] };
  if (!Array.isArray(fc.features)) return [];
  const out: InsarPoint[] = [];
  for (const f of fc.features) {
    const feat = f as { geometry?: { type?: string; coordinates?: number[] }; properties?: Record<string, unknown> };
    if (feat.geometry?.type !== "Point" || !Array.isArray(feat.geometry.coordinates)) continue;
    const [lon, lat] = feat.geometry.coordinates;
    const props = feat.properties ?? {};
    let velocity: number | undefined;
    for (const k of VEL_KEYS) {
      const v = props[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        velocity = v;
        break;
      }
    }
    if (typeof lon !== "number" || typeof lat !== "number" || velocity === undefined) continue;
    const ts = props["observed_at"] ?? props["date"] ?? props["time"];
    out.push({ lon, lat, velocity, observedAt: typeof ts === "string" ? ts : null });
  }
  return out;
}

export async function POST(req: Request) {
  if (!(await dbReady())) return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });

  let body: { points?: InsarPoint[]; geojson?: unknown; source?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }

  const points: InsarPoint[] = Array.isArray(body.points)
    ? body.points
    : body.geojson
      ? extractPoints(body.geojson)
      : [];
  if (!points.length) {
    return NextResponse.json({ ok: false, reason: "변위점 없음 (points[] 또는 geojson FeatureCollection<Point> 필요)" }, { status: 200 });
  }

  try {
    const { fetched, inserted } = await ingestInsar(points, { source: body.source });
    // 침하 통계 요약 (음수=침하이므로 가장 빠른 침하는 min).
    const { rows } = await db().query<{ n: string; min: string; avg: string }>(
      `SELECT count(*)::text n, min(value)::text min, round(avg(value)::numeric,2)::text avg
         FROM observations WHERE kind='subsidence'`
    );
    return NextResponse.json({
      ok: true,
      fetched,
      inserted,
      source: body.source ?? "insar",
      subsidenceTotal: Number(rows[0]?.n ?? 0),
      maxSubsidenceMmYr: rows[0]?.min ? Math.abs(Number(rows[0].min)) : null,
      meanMmYr: rows[0]?.avg ? Number(rows[0].avg) : null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
