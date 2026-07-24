// Clay 임베딩 → pgvector 적재. 파티션(gh:ym)을 한 번 다운로드해 clay_cells에 벌크 삽입.
//   이후 변화 스캔은 조회 시 240MB 다운로드 없이 DB의 `<=>` 코사인을 쓴다.
import { db } from "./db";
import { loadPartition } from "./regionChange";

/** cell_id의 셀 임베딩 벡터를 pgvector 리터럴('[a,b,...]')로. */
function vecLiteral(v: Float32Array): string {
  // 소수 6자리로 잘라 페이로드 축소(임베딩 정밀도엔 충분).
  let s = "[";
  for (let i = 0; i < v.length; i++) s += (i ? "," : "") + v[i].toFixed(6);
  return s + "]";
}

export type IngestResult = { gh: string; ym: string; cells: number; inserted: number; skipped: boolean; ms: number };

/**
 * 한 파티션(geohash·ym)을 적재. 이미 적재돼 있으면 건너뛴다(멱등).
 * ⚠️ 233k행 규모라 배치 삽입 + ON CONFLICT DO NOTHING. 최초 1회만 무겁다.
 */
export async function ingestClayPartition(gh: string, ym: string, force = false): Promise<IngestResult> {
  const t0 = Date.now();
  const client = db();

  if (!force) {
    const { rows } = await client.query<{ n: string }>("SELECT count(*) n FROM clay_cells WHERE geohash=$1 AND ym=$2", [gh, ym]);
    if (Number(rows[0].n) > 0) return { gh, ym, cells: Number(rows[0].n), inserted: 0, skipped: true, ms: Date.now() - t0 };
  }

  const part = await loadPartition(gh, ym); // 캐시/다운로드
  const entries = [...part.entries()];
  let inserted = 0;
  const BATCH = 500; // 500행 × 258파라미터 ≈ 12.9만 < pg 65535 한도의 여유 아래로 유지하려 파라미터 대신 리터럴 사용

  // ⚠️ 벡터 256차원을 파라미터로 넣으면 행당 258개라 배치가 작아진다 → 벡터는 SQL 리터럴로,
  //    나머지(cell_id·ym·gh·lon·lat)만 파라미터로. 리터럴은 이미 우리가 만든 숫자라 주입 위험 없음.
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    const vals: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const [cid, c] of slice) {
      // ($1,$2,$3, ST_SetSRID(ST_MakePoint($4,$5),4326), '[...]'::vector)
      vals.push(`($${p++},$${p++},$${p++},ST_SetSRID(ST_MakePoint($${p++},$${p++}),4326),'${vecLiteral(c.v)}'::vector)`);
      params.push(cid, ym, gh, c.cx, c.cy);
    }
    const q = `INSERT INTO clay_cells (cell_id, ym, geohash, geom, embedding) VALUES ${vals.join(",")} ON CONFLICT (cell_id, ym) DO NOTHING`;
    const r = await client.query(q, params);
    inserted += r.rowCount ?? 0;
  }
  return { gh, ym, cells: entries.length, inserted, skipped: false, ms: Date.now() - t0 };
}
