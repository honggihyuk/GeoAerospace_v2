// 레인 ② 공간검색 (설계서 §4.3) — observations 테이블에 대한 bbox 질의 + 그라운딩 요약.
// FIRMS 화재·OpenAQ 대기질·InSAR 변위점 등 위치를 가진 관측을 ST_MakeEnvelope로 조회한다.
// DB 미가용 시 빈 배열 → 호출측은 공간 그라운딩 없이 진행(치명적 아님).
import { db, dbReady } from "@/lib/server/db";

export type Observation = {
  source: string;
  kind: string;
  lng: number;
  lat: number;
  value: number | null;
  unit: string | null;
  props: Record<string, unknown>;
  observedAt: string | null;
};

/** bbox[w,s,e,n] 안의 관측 조회 (kind 선택 필터, 최신순). */
export async function queryObservations(
  bbox: [number, number, number, number],
  opts: { kind?: string; limit?: number } = {}
): Promise<Observation[]> {
  if (!(await dbReady())) return [];
  const [w, s, e, n] = bbox;
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  try {
    const { rows } = await db().query<{
      source: string; kind: string; lng: number; lat: number;
      value: string | null; unit: string | null; props: Record<string, unknown> | null; observed_at: Date | null;
    }>(
      `SELECT source, kind, ST_X(geom) AS lng, ST_Y(geom) AS lat, value, unit, props, observed_at
         FROM observations
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          AND ($5::text IS NULL OR kind = $5)
        ORDER BY observed_at DESC NULLS LAST
        LIMIT $6`,
      [w, s, e, n, opts.kind ?? null, limit]
    );
    return rows.map((r) => ({
      source: r.source,
      kind: r.kind,
      lng: Number(r.lng),
      lat: Number(r.lat),
      value: r.value == null ? null : Number(r.value),
      unit: r.unit ?? null,
      props: r.props ?? {},
      observedAt: r.observed_at ? new Date(r.observed_at).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export const KIND_LABEL: Record<string, string> = {
  fire: "활성 화재",
  volcano: "화산",
  no2: "NO₂",
  co: "CO",
  o3: "오존(O₃)",
  so2: "SO₂",
  pm25: "초미세먼지(PM2.5)",
  pm10: "미세먼지(PM10)",
  subsidence: "지반침하",
};

/** 관측 배열 → VLM/LLM 그라운딩용 한 줄 요약 (종류별 개수·대표수치). */
export function summarizeObservations(obs: Observation[]): string {
  if (!obs.length) return "";
  const byKind = new Map<string, Observation[]>();
  for (const o of obs) {
    const a = byKind.get(o.kind) ?? [];
    a.push(o);
    byKind.set(o.kind, a);
  }
  const parts: string[] = [];
  for (const [kind, arr] of byKind) {
    const label = KIND_LABEL[kind] ?? kind;
    const vals = arr.map((o) => o.value).filter((v): v is number => v != null);
    if (vals.length) {
      let max = -Infinity;
      for (const v of vals) if (v > max) max = v;
      const unit = arr.find((o) => o.unit)?.unit ?? "";
      parts.push(`${label} ${arr.length}건(최대 ${Math.round(max * 10) / 10}${unit})`);
    } else {
      parts.push(`${label} ${arr.length}건`);
    }
  }
  return `이 영역 관측 DB: ${parts.join(", ")}.`;
}
