// Space-Track.org (18 SDS 권위 카탈로그) 클라이언트 — 고도화 §A1.
//
// 왜 필요한가: 이 환경에서 CelesTrak은 차단(무응답)이고, 폴백인 SatNOGS는 아마추어 무선
// 위성 DB라 Starlink·KOMPSAT 등이 아예 없다(빈 배열 반환). 결과적으로 그 위성들은
// 744일 된 데모 TLE로 영구 폴백됐다. Space-Track은 전 카탈로그를 커버한다.
//
// 자격증명은 서버 전용 환경변수로만 읽는다(NEXT_PUBLIC_ 접두사 금지 → 클라 번들에 안 실림).
//   .env.local:
//     SPACETRACK_IDENTITY=<계정 이메일>
//     SPACETRACK_PASSWORD=<비밀번호>
//
// 레이트리밋(중요): Space-Track은 분당 30회 / 시간당 300회를 넘기면 계정을 차단한다.
// 그래서 (1) 세션 쿠키를 재사용하고 (2) 여러 위성을 한 번의 쿼리로 묶는다.
import { safeFetch } from "./safeFetch";

const BASE = "https://www.space-track.org";
const LOGIN_URL = `${BASE}/ajaxauth/login`;

// 세션은 실제로 ~2시간 유효. 여유를 두고 90분만 재사용한다.
const SESSION_TTL_MS = 90 * 60 * 1000;
// 배치 쿼리 최소 간격 — 레이트리밋 보호용 하한선.
const MIN_QUERY_INTERVAL_MS = 60 * 1000;

let session: { cookie: string; ts: number } | null = null;
let lastQueryTs = 0;

export type StElset = { noradId: number; name: string; tle1: string; tle2: string };

export function isConfigured(): boolean {
  return Boolean(process.env.SPACETRACK_IDENTITY && process.env.SPACETRACK_PASSWORD);
}

/** 로그인 → 세션 쿠키. 캐시된 쿠키가 살아있으면 재사용(레이트리밋 절약). */
export async function getSessionCookie(): Promise<string> {
  return getCookie();
}

async function getCookie(): Promise<string> {
  if (session && Date.now() - session.ts < SESSION_TTL_MS) return session.cookie;

  const identity = process.env.SPACETRACK_IDENTITY ?? "";
  const password = process.env.SPACETRACK_PASSWORD ?? "";
  if (!identity || !password) throw new Error("spacetrack: 자격증명 미설정");

  const r = await safeFetch(LOGIN_URL, {
    method: "POST",
    body: new URLSearchParams({ identity, password }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual", // Set-Cookie를 직접 읽어야 하므로
    timeoutMs: 20_000,
  });

  // 자격증명 오류는 401. 성공은 200(또는 302).
  if (r.status === 401) throw new Error("spacetrack: 자격증명 거부됨 (401) — .env.local 확인");
  if (r.status >= 400) throw new Error(`spacetrack login ${r.status}`);

  const raw = r.headers.get("set-cookie");
  if (!raw) throw new Error("spacetrack: 세션 쿠키 없음");
  // "chocolatechip=...; path=/; HttpOnly" → 이름=값 부분만
  const cookie = raw
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  session = { cookie, ts: Date.now() };
  return cookie;
}

/** 3LE 파싱 — "0 NAME" / "1 ..." / "2 ..." 3줄 반복. */
function parse3le(text: string): StElset[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  const out: StElset[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("1 ") || !lines[i + 1]?.startsWith("2 ")) continue;
    const tle1 = lines[i];
    const tle2 = lines[i + 1];
    const noradId = Number(tle1.slice(2, 7).trim());
    if (!Number.isInteger(noradId) || noradId <= 0) continue;
    const prev = lines[i - 1] ?? "";
    const name = prev.startsWith("0 ") ? prev.slice(2).trim() : `NORAD ${noradId}`;
    out.push({ noradId, name, tle1, tle2 });
    i++; // tle2 소비
  }
  return out;
}

/**
 * 여러 위성의 최신 원소를 한 번의 쿼리로 가져온다.
 * class/gp = 객체별 *최신* GP 원소(과거 이력은 gp_history).
 */
export async function fetchLatestElsets(noradIds: number[]): Promise<StElset[]> {
  if (!isConfigured() || noradIds.length === 0) return [];

  const since = Date.now() - lastQueryTs;
  if (since < MIN_QUERY_INTERVAL_MS) {
    throw new Error(`spacetrack: 레이트리밋 보호 (${Math.ceil((MIN_QUERY_INTERVAL_MS - since) / 1000)}s 후 재시도)`);
  }

  const cookie = await getCookie();
  const ids = [...new Set(noradIds)].join(",");
  const url =
    `${BASE}/basicspacedata/query/class/gp` +
    `/NORAD_CAT_ID/${ids}` +
    `/orderby/NORAD_CAT_ID/format/3le`;

  const r = await safeFetch(url, { headers: { cookie }, timeoutMs: 25_000, accept: "text/plain" });
  if (r.status === 401) {
    session = null; // 세션 만료 → 다음 호출에서 재로그인
    throw new Error("spacetrack: 세션 만료 (401)");
  }
  if (!r.ok) throw new Error(`spacetrack query ${r.status}`);

  lastQueryTs = Date.now();
  return parse3le(await r.text());
}
