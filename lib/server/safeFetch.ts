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
  "sentinel-cogs.s3.us-west-2.amazonaws.com", // Sentinel-2 L2A COG 밴드(공개) — 분광지수 NDVI/NDWI/NBR
]);

/**
 * 호스트 allowlist 검사만 노출한다.
 * geotiff.js처럼 **자체 HTTP Range 요청**을 쓰는 라이브러리는 safeFetch를 태울 수 없으므로,
 * 호출 전에 이걸로 호스트를 검증해 SSRF 가드의 의도(allowlist)를 유지한다.
 */
export function isAllowedHost(urlOrHost: string): boolean {
  try {
    const h = urlOrHost.includes("://") ? new URL(urlOrHost).hostname : urlOrHost;
    return ALLOW_HOSTS.has(h);
  } catch {
    return false;
  }
}

/**
 * ⚠️ 중간 인증서를 누락해 체인 검증이 실패하는 호스트(UNABLE_TO_VERIFY_LEAF_SIGNATURE).
 * UTIC(경찰청)이 그렇다 — curl/일부 런타임은 통과하지만 Node fetch는 거부한다.
 * 이 호스트에 한해 node:https로 요청해 **체인 검증만** 완화한다(TLS 암호화·allowlist·타임아웃은 유지).
 * http로 내리면 URL의 인증키가 평문 노출되므로 그보다 안전한 선택.
 */
const BROKEN_TLS_CHAIN = new Set(["www.utic.go.kr"]);

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

  const reqHeaders = { accept, "user-agent": "GeoAerospace/0.1 (dev)", ...headers };
  if (BROKEN_TLS_CHAIN.has(u.hostname)) return insecureChainFetch(u, { method, body, headers: reqHeaders, timeoutMs });

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

/**
 * BROKEN_TLS_CHAIN 호스트 전용 — node:https로 체인 검증만 끄고 요청한다.
 * 호스트 allowlist·https 강제는 호출부(safeFetch)에서 이미 통과한 뒤에만 도달한다.
 */
async function insecureChainFetch(
  u: URL,
  o: { method: string; body?: string; headers: Record<string, string>; timeoutMs: number }
): Promise<Response> {
  const https = await import("node:https");
  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: o.method,
        headers: o.headers,
        rejectUnauthorized: false, // ⚠️ 체인 검증만 완화 — 암호화는 유지
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") h.set(k, v);
            else if (Array.isArray(v)) h.set(k, v.join(", "));
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 200, headers: h }));
        });
      }
    );
    req.setTimeout(o.timeoutMs, () => req.destroy(new Error(`timeout ${o.timeoutMs}ms`)));
    req.on("error", reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/** NORAD 카탈로그 번호 검증 (사용자 입력 → 쿼리 파라미터). */
export function validNoradId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 1_000_000;
}
