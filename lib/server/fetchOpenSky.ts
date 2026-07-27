// OpenSky Network — 한국 bbox **단일 쿼리**(states/all)로 실시간 항공기 상태벡터 수집.
//
// 왜 OpenSky인가: adsb.lol/airplanes.live 지역 팬아웃(7개 원)은 한국을 인천 250nm 하나로만 덮고
//   요청 수가 많아 429 위험이 있었다. OpenSky states/all 은 **bbox 한 번**으로 한반도 전역을 균일하게
//   준다(velocity·track 포함 → deadReckon 유지 가능).
//
// 인증: 2026-03 부터 basic auth 폐지 → OAuth2 client_credentials. 계정에서 API client 발급 →
//   .env.local 에 OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET. 미설정 시 **익명 모드**(저한도)로 동작.
//   무료: 비상업·연구용. 크레딧은 조회 면적에 비례 차감(무료 ~8000/일).
import { safeFetch } from "./safeFetch";
import type { Aircraft } from "./fetchAircraft";

const STATES_URL = "https://opensky-network.org/api/states/all";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";

// 한반도 bbox (제주 포함). states/all?lamin&lomin&lamax&lomax
const KR = { lamin: 33.0, lomin: 124.0, lamax: 39.5, lomax: 132.0 };

let tokenCache: { token: string; exp: number } | null = null;
let cooldownUntil = 0;

/** true=OAuth 자격증명 설정됨(고한도), false=익명 모드(저한도). */
export function isOpenSkyAuthed(): boolean {
  return Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
}

// OAuth2 client_credentials 토큰(≈30분). 자격증명 없으면 null(익명).
async function getToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (tokenCache && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`opensky oauth ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 1800) * 1000 };
  return tokenCache.token;
}

// states 배열 인덱스: 0 icao24, 1 callsign, 5 lon, 6 lat, 7 baro_alt(m), 9 velocity(m/s), 10 true_track, 13 geo_alt(m)
type State = (string | number | boolean | null)[];

// 콜사인 기반 분류(OpenSky는 extended=1 없으면 category 미제공) — fetchAircraft.classify와 동일 규칙.
function classify(callsign: string): Aircraft["category"] {
  const cs = callsign.trim().toUpperCase();
  if (/^(RCH|CNV|EVAC|GRZLY|PLF)/.test(cs)) return "mil";
  if (/^[A-Z]{3}\d/.test(cs)) return "commercial";
  if (/^N\d/.test(cs) || cs === "") return "private";
  return "commercial";
}

/** 한국 bbox 실시간 항공기(단일 쿼리). 429/쿨다운/오류 시 throw → 호출측이 adsb.lol 로 폴백. */
export async function fetchOpenSkyKorea(): Promise<Aircraft[]> {
  if (Date.now() < cooldownUntil) throw new Error("opensky cooldown");
  const token = await getToken().catch(() => null); // OAuth 실패해도 익명으로 시도
  const url = `${STATES_URL}?lamin=${KR.lamin}&lomin=${KR.lomin}&lamax=${KR.lamax}&lomax=${KR.lomax}`;
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  const r = await safeFetch(url, { accept: "application/json", timeoutMs: 10_000, headers });
  if (r.status === 429) {
    cooldownUntil = Date.now() + 10 * 60_000; // 429 → 10분 쿨다운
    throw new Error("opensky 429");
  }
  if (!r.ok) throw new Error(`opensky ${r.status}`);
  const j = (await r.json()) as { states?: State[] | null };

  const out: Aircraft[] = [];
  for (const s of j.states ?? []) {
    const lon = s[5];
    const lat = s[6];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const callsign = String(s[1] ?? "").trim();
    const baroM = typeof s[7] === "number" ? s[7] : typeof s[13] === "number" ? (s[13] as number) : 0;
    const velMs = typeof s[9] === "number" ? s[9] : 0;
    const track = typeof s[10] === "number" ? s[10] : 0;
    out.push({
      hex: String(s[0] ?? ""),
      callsign,
      lon,
      lat,
      alt: Math.round(baroM * 3.28084), // m → ft
      gs: Math.round(velMs / 0.514444), // m/s → kt
      track,
      category: classify(callsign),
    });
  }
  return out;
}
