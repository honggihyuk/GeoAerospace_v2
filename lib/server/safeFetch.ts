// SSRF 가드 (설계서 §4.8-B / §10) — 경량판.
// 외부 fetch는 호스트 allowlist + https + 타임아웃으로 제한.
// (리다이렉트 홉 재검증 등 전체 방어는 P6에서 강화.)

const ALLOW_HOSTS = new Set([
  "celestrak.org",
  "db.satnogs.org",
  "network.satnogs.org", // SatNOGS 지상국 네트워크 (고도화 B4)
  "api.adsb.lol",
  "api.airplanes.live",
  "nominatim.openstreetmap.org",
  "gibs.earthdata.nasa.gov", // NASA GIBS 위성영상 (고도화 B1)
  "www.space-track.org", // 18 SDS 권위 카탈로그 (고도화 A1)
  "nasa-public-data.s3.amazonaws.com", // NASA ISS 정밀 ephemeris OEM (고도화 A2)
  "firms.modaps.eosdis.nasa.gov", // NASA FIRMS 활성 화재 (제안서 §4.7 / P5.5)
  "eonet.gsfc.nasa.gov", // NASA EONET 화산 이벤트 (P5.5)
  "apis.data.go.kr", // 공공데이터포털 — 기상청 GK2A 위성자료 (제안서_GK2A)
  "earth-search.aws.element84.com", // Element84 earth-search STAC — 무인증 장면 검색 (레인 ③)
  "api.openaq.org", // OpenAQ v3 지상 대기질 — X-API-Key 필요 (레인 ②)
  "elevation-tiles-prod.s3.amazonaws.com", // AWS Terrarium DEM — FIRMS 바다 오탐 필터용 고도 샘플
  "insar.ngu.no", // InSAR Norway(NGU) — 실측 Sentinel-1 지반운동 mm/yr, 무인증 (레인 ②)
  "openapi.its.go.kr", // ITS 국가교통정보센터 — 전국 도로 CCTV(좌표+스트림), ITS_API_KEY 필요
  "www.utic.go.kr", // 경찰청 도시교통정보센터(UTIC) — 실시간 돌발정보(imsOpenData), 소통지도(telMap). key+IP 인증(https 지원)
]);

type FetchOpts = {
  timeoutMs?: number;
  accept?: string;
  method?: string;
  body?: string;
  /** 추가 요청 헤더. 인증 쿠키 등. */
  headers?: Record<string, string>;
  /** 기본은 "error"(리다이렉트 우회 차단). 로그인처럼 Set-Cookie를 직접 읽어야 할 때만 "manual". */
  redirect?: RequestRedirect;
};

export async function safeFetch(url: string, opts: number | FetchOpts = {}): Promise<Response> {
  const o: FetchOpts = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const { timeoutMs = 8000, accept = "text/plain, application/json", method = "GET", body, headers, redirect = "error" } = o;

  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error(`SSRF: protocol not allowed (${u.protocol})`);
  if (!ALLOW_HOSTS.has(u.hostname)) throw new Error(`SSRF: host not allowed (${u.hostname})`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      body,
      signal: ctrl.signal,
      redirect, // public→private 리다이렉트 우회 차단
      headers: { accept, "user-agent": "GeoAerospace/0.1 (dev)", ...headers },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** NORAD 카탈로그 번호 검증 (사용자 입력 → 쿼리 파라미터). */
export function validNoradId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000;
}
