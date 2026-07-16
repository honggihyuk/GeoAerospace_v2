// SSRF 가드 (설계서 §4.8-B / §10) — 경량판.
// 외부 fetch는 호스트 allowlist + https + 타임아웃으로 제한.
// (리다이렉트 홉 재검증 등 전체 방어는 P6에서 강화.)

const ALLOW_HOSTS = new Set([
  "celestrak.org",
  "db.satnogs.org",
  "api.adsb.lol",
  "api.airplanes.live",
  "nominatim.openstreetmap.org",
]);

export async function safeFetch(url: string, timeoutMs = 8000): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`SSRF: protocol not allowed (${u.protocol})`);
  if (!ALLOW_HOSTS.has(u.hostname)) throw new Error(`SSRF: host not allowed (${u.hostname})`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      redirect: "error", // public→private 리다이렉트 우회 차단
      headers: { accept: "text/plain, application/json", "user-agent": "GeoAerospace/0.1 (dev)" },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** NORAD 카탈로그 번호 검증 (사용자 입력 → 쿼리 파라미터). */
export function validNoradId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000;
}
