// 관측 인제스트 (레인 ②) — FIRMS·OpenAQ → observations 적재.
// /api/ingest/* 라우트와 /api/region/describe(온디맨드)가 공유한다.
import { fetchFires, type FirePoint } from "./fetchFires";
import { fetchOpenAQ, isOpenAqConfigured } from "./fetchOpenAQ";
import { sampleElevations } from "./demSample";
import { db } from "./db";

export type IngestResult = { fetched: number; inserted: number };
export type FireIngestResult = IngestResult & { rejectedLowConf: number; rejectedWater: number };

/** FIRMS 활성 화재 → observations. 오탐 감소: 저신뢰도 게이트 + 바다(해수면 이하) 제거.
 *  minConfidence: 이 신뢰도 미만 화재 제거(기본 30 → VIIRS 'low'=20 컷).
 *  seaRejectM: 화재점 지형고도가 이 값 이하면 바다 오탐으로 제거(기본 -15 m). */
export async function ingestFires(
  bbox: [number, number, number, number],
  dayRange = 3,
  opts: { minConfidence?: number; seaRejectM?: number } = {}
): Promise<FireIngestResult> {
  const minConf = opts.minConfidence ?? 30;
  const seaReject = opts.seaRejectM ?? -15;
  const [west, south, east, north] = bbox;
  const res = await fetchFires({ bbox: { west, south, east, north }, dayRange, includeVolcanoes: true });

  // 1) 신뢰도 게이트 — 화재만(화산 이벤트는 보존). 구름 가장자리·약한 열원 오탐을 상당수 제거.
  const confPass = res.points.filter((p) => p.kind !== "fire" || p.confidence >= minConf);
  const rejectedLowConf = res.points.length - confPass.length;

  // 2) 바다 오탐 제거 — 화재점 지형고도를 DEM에서 샘플, 해수면 이하면 물(sun-glint 등)로 판정해 제거.
  //    고도 불명(타일 실패)은 보존한다(과잉 제거 방지).
  const firePts = confPass.filter((p) => p.kind === "fire");
  let elevs: (number | null)[] = firePts.map(() => null);
  try {
    elevs = await sampleElevations(firePts.map((p) => ({ lon: p.lon, lat: p.lat })));
  } catch {
    /* 샘플 실패 → 전부 보존 */
  }
  const water = new Map<FirePoint, boolean>();
  firePts.forEach((p, i) => {
    const e = elevs[i];
    water.set(p, e != null && e <= seaReject);
  });
  const kept = confPass.filter((p) => !(p.kind === "fire" && water.get(p)));
  const rejectedWater = confPass.length - kept.length;

  const client = await db().connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const p of kept) {
      let observedAt: string | null = null;
      if (p.acqDate) {
        const t = (p.acqTime ?? "").padStart(4, "0");
        observedAt = `${p.acqDate}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
      }
      const r = await client.query(
        `INSERT INTO observations (source, kind, geom, value, unit, props, observed_at)
         VALUES ('firms', $1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, 'MW', $5::jsonb, $6)
         ON CONFLICT (source, kind, observed_at, geom) DO NOTHING`,
        [
          p.kind,
          p.lon,
          p.lat,
          p.kind === "fire" ? p.frp : null,
          JSON.stringify({ confidence: p.confidence, daynight: p.daynight, title: p.title ?? null }),
          observedAt,
        ]
      );
      inserted += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { fetched: res.points.length, inserted, rejectedLowConf, rejectedWater };
}

export type InsarPoint = { lon: number; lat: number; velocity: number; observedAt?: string | null };

/** InSAR 지표 변위점 → observations (kind='subsidence', mm/yr, 음수=침하).
 * "소비 모델": 사전계산된 InSAR 산출물(EGMS/LiCSAR/국내 관측망 등)을 포인트로 받아 적재한다.
 * value 부호 관례: 음수 = 침하(내려앉음), 양수 = 융기. */
export async function ingestInsar(points: InsarPoint[], opts: { source?: string } = {}): Promise<IngestResult> {
  const source = opts.source ?? "insar";
  const client = await db().connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const p of points) {
      if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat) || !Number.isFinite(p.velocity)) continue;
      const r = await client.query(
        `INSERT INTO observations (source, kind, geom, value, unit, props, observed_at)
         VALUES ($1, 'subsidence', ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, 'mm/yr', '{}'::jsonb, $5)
         ON CONFLICT (source, kind, observed_at, geom) DO NOTHING`,
        [source, p.lon, p.lat, p.velocity, p.observedAt ?? null]
      );
      inserted += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { fetched: points.length, inserted };
}

/** OpenAQ 최신 대기질 → observations. 키 미설정이면 null(호출측이 건너뜀). */
export async function ingestOpenAQ(bbox: [number, number, number, number], maxLocations = 15): Promise<IngestResult | null> {
  if (!isOpenAqConfigured()) return null;
  const res = await fetchOpenAQ(bbox, { maxLocations });

  const client = await db().connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const p of res.points) {
      const r = await client.query(
        `INSERT INTO observations (source, kind, geom, value, unit, props, observed_at)
         VALUES ('openaq', $1, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6::jsonb, $7)
         ON CONFLICT (source, kind, observed_at, geom) DO NOTHING`,
        [p.parameter, p.lon, p.lat, p.value, p.unit || null, JSON.stringify({ location: p.location, sensorsId: p.sensorsId }), p.datetime]
      );
      inserted += r.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { fetched: res.points.length, inserted };
}
