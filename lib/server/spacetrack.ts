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
// ⚠️ 정책 준수(계정 정지 사건 2026-07-24): 모든 Space-Track 쿼리는 반드시 spacetrackFetch()를 통과한다.
//   Space-Track 권고 & 우리 규칙 —
//     • 최신 원소는 class/gp 만 사용(gp_history 절대 금지 — 220M행짜리 "일회성 과거조회" 전용).
//     • 클래스별 **시간당 최대 1회**. 여러 위성은 한 번의 배치 쿼리로 묶는다.
//     • 붐비는 구간(매시 정각/30분) ±10~20분 회피(예 :12/:48 OK, :00/:30 금지).
//     • gp_history 는 절대 폴링/스케줄로 호출하지 않는다(사용자 액션당 1회, 강캐시).
//   위반 시 계정 정지 → 스페이스플라이트 안전 사용자에게 피해. 킬스위치: SPACETRACK_DISABLED=1.
import { safeFetch } from "./safeFetch";

const BASE = "https://www.space-track.org";
const LOGIN_URL = `${BASE}/ajaxauth/login`;

// 세션은 실제로 ~2시간 유효. 여유를 두고 90분만 재사용한다.
const SESSION_TTL_MS = 90 * 60 * 1000;
// 정책 하한: 쿼리 클래스별 1회/시간(gp, gp_history 각각).
const MIN_QUERY_INTERVAL_MS = 60 * 60 * 1000;

export type StQueryKind = "gp" | "gp_history";
export type StElset = { noradId: number; name: string; tle1: string; tle2: string };

let session: { cookie: string; ts: number } | null = null;
const lastQueryTs: Record<StQueryKind, number> = { gp: 0, gp_history: 0 };

export function isConfigured(): boolean {
  // 킬스위치 — 계정 정지/점검 시 즉시 전면 비활성(공개소스·데모로 우아하게 폴백).
  if (/^(1|true)$/i.test(process.env.SPACETRACK_DISABLED ?? "")) return false;
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

// 붐비는 구간 회피 — 매시 정각/30분 직후 12분은 금지. 허용 = :12–:29, :42–:59(분%30 ≥ 12).
function offPeakGuard(): void {
  const m = new Date().getUTCMinutes() % 30;
  if (m < 12) throw new Error(`spacetrack: 붐비는 시간대 회피(정각/30분 직후 ${12 - m}분 대기)`);
}

/**
 * 모든 Space-Track 쿼리의 단일 관문 — 정책 준수 게이트.
 * 클래스별 1회/시간 + 붐비는구간 회피 + 세션 쿠키 재사용 + 401(세션만료) 처리.
 * 성공한 쿼리만 타임스탬프를 갱신한다(에러로 소진되지 않게).
 */
export async function spacetrackFetch(url: string, o: { kind: StQueryKind; accept?: string; timeoutMs?: number }): Promise<Response> {
  if (!isConfigured()) throw new Error("spacetrack: 비활성(자격증명 미설정 또는 SPACETRACK_DISABLED)");
  const since = Date.now() - lastQueryTs[o.kind];
  if (since < MIN_QUERY_INTERVAL_MS) {
    throw new Error(`spacetrack[${o.kind}]: 시간당 1회 제한(${Math.ceil((MIN_QUERY_INTERVAL_MS - since) / 60_000)}분 후 가능)`);
  }
  offPeakGuard();
  const cookie = await getCookie();
  const r = await safeFetch(url, { headers: { cookie }, accept: o.accept ?? "text/plain", timeoutMs: o.timeoutMs ?? 25_000 });
  if (r.status === 401) {
    session = null; // 세션 만료 → 다음 호출에서 재로그인
    throw new Error("spacetrack: 세션 만료/거부 (401)");
  }
  if (!r.ok) throw new Error(`spacetrack[${o.kind}] ${r.status}`);
  lastQueryTs[o.kind] = Date.now();
  return r;
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
 * 여러 위성의 **최신** 원소를 한 번의 배치 쿼리로 가져온다(정책: gp, gp_history 아님).
 * decay_date/null-val = 소멸체 제외로 응답 축소(권고). NORAD 워치리스트라 한 배치로 충분.
 * 레이트리밋·붐비는구간·세션은 spacetrackFetch 관문이 강제한다 → 초과 시 throw, 호출측이 폴백.
 */
export async function fetchLatestElsets(noradIds: number[]): Promise<StElset[]> {
  if (!isConfigured() || noradIds.length === 0) return [];
  const ids = [...new Set(noradIds)].join(",");
  const url =
    `${BASE}/basicspacedata/query/class/gp` +
    `/NORAD_CAT_ID/${ids}/decay_date/null-val` +
    `/orderby/NORAD_CAT_ID/format/3le`;
  const r = await spacetrackFetch(url, { kind: "gp", accept: "text/plain", timeoutMs: 25_000 });
  return parse3le(await r.text());
}
