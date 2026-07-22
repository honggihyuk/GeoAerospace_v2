// PostgreSQL(PostGIS + pgvector) 연결 (설계서 §4.3). 서버 전용.
// DATABASE_URL 미설정이거나 연결 실패 시 호출측이 인메모리로 폴백하도록 dbReady()를 노출한다.
import { Pool } from "pg";

const URL = process.env.DATABASE_URL;

let pool: Pool | null = null;

export function db(): Pool {
  if (!URL) throw new Error("DATABASE_URL 미설정");
  if (!pool) {
    pool = new Pool({
      connectionString: URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 4_000,
    });
    // 유휴 클라이언트 오류가 프로세스를 죽이지 않게 흡수(폴백 경로가 처리).
    pool.on("error", () => {});
  }
  return pool;
}

// 연결 가능 여부를 모듈 캐시 (매 요청 프로브 비용 회피, 실패는 짧게 재프로브).
let readyCache: { ok: boolean; ts: number } | null = null;
const READY_TTL_MS = 15_000;

/** DB 사용 가능 여부를 실제 쿼리로 확인. false면 호출측이 인메모리 폴백. */
export async function dbReady(): Promise<boolean> {
  if (!URL) return false;
  const now = Date.now();
  if (readyCache && now - readyCache.ts < READY_TTL_MS) return readyCache.ok;
  let ok = false;
  try {
    await db().query("SELECT 1");
    ok = true;
  } catch {
    ok = false;
  }
  readyCache = { ok, ts: now };
  return ok;
}

/** number[] → pgvector 리터럴 문자열 ('[0.1,0.2,...]'). */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
