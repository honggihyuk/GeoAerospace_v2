// 경찰청 도시교통정보센터(UTIC) 전국 CCTV 목록 — ITS가 비어있는 **도심·지자체** CCTV 보강.
//   목록: https://www.utic.go.kr/map/mapcctv.do?key=  ⚠️ **Referer 헤더 필수**(없으면 {"code":"9999"}).
//        IP 등록·쿠키는 불필요(실측). 응답 JSON 배열 ~17,175건(5MB).
//   필드: CCTVID·CCTVNAME·XCOORD(lon)·YCOORD(lat) WGS84·KIND·CENTERNAME·CH·ID·PASSWD·PORT·CCTVIP·MOVIE.
//
//   ⚠️ 재생: 스트림 URL 규칙이 **지자체(KIND)별로 완전히 분기**한다(H=대구·F=전주·Y=창원·J=울산·C=수원·
//      II=공주·HH=진주… + 경기도 전용 서버 API, KBS 등). 클라이언트 재구현은 취약 → UTIC의
//      `openDataCctvStream.jsp` 플레이어를 **iframe으로 임베드**해 분기 처리를 UTIC에 위임한다.
//      (JSP는 Referer 불요·X-Frame-Options 없음 실측). 대신 cross-origin이라 **VLM 프레임 판독은 불가**
//      — ITS CCTV(HLS 직접재생)가 판독을 계속 담당한다.
//   ⚠️ iframe src에 key가 노출된다(UTIC 자체도 window.open으로 그렇게 연다). 공개 배포 시 서버 프록시 검토.
import { safeFetch } from "./safeFetch";
import type { CctvItem } from "./fetchCctv";

const LIST = "https://www.utic.go.kr/map/mapcctv.do";
const STREAM = "https://www.utic.go.kr/jsp/map/openDataCctvStream.jsp";

type Row = {
  CCTVID?: string;
  CCTVNAME?: string;
  XCOORD?: number | string;
  YCOORD?: number | string;
  KIND?: string;
  CENTERNAME?: string;
  CH?: number | string;
  ID?: string | number;
  PASSWD?: string;
  PORT?: string | number;
  CCTVIP?: string | number;
  MOVIE?: string;
};

export function isCctvUticConfigured(): boolean {
  return Boolean(process.env.UTIC_API_KEY);
}

// 목록이 4.4MB라 매 요청 재다운로드는 낭비(+dev 서버 부담) — CCTV 위치는 거의 불변이라 메모리 캐시.
const TTL_MS = 10 * 60_000;
let cache: { at: number; rows: Row[] } | null = null;

function inKorea(lon: number, lat: number): boolean {
  return lon > 123 && lon < 132.5 && lat > 32.5 && lat < 39.5;
}

/** UTIC 플레이어가 여는 것과 동일한 스트림 URL. cctvName은 **이중 인코딩**(UTIC 원본 규칙). */
export function buildStreamUrl(key: string, r: Row): string {
  const v = (x: unknown) => (x === undefined || x === null || x === "" ? "undefined" : String(x));
  const name = encodeURIComponent(encodeURIComponent(r.CCTVNAME ?? ""));
  return (
    `${STREAM}?key=${encodeURIComponent(key)}&cctvid=${encodeURIComponent(v(r.CCTVID))}&cctvName=${name}` +
    `&kind=${encodeURIComponent(v(r.KIND))}&cctvip=${encodeURIComponent(v(r.CCTVIP))}&cctvch=${encodeURIComponent(v(r.CH))}` +
    `&id=${encodeURIComponent(v(r.ID))}&cctvpasswd=${encodeURIComponent(v(r.PASSWD))}&cctvport=${encodeURIComponent(v(r.PORT))}`
  );
}

/**
 * UTIC CCTV. bbox[w,s,e,n] 안만. 기본적으로 **국가교통정보센터(ITS 계열) 항목은 제외** —
 * ITS 레이어와 중복이고 ITS쪽이 HLS 직접재생(+VLM)이라 우월하다. 남는 건 도심·지자체 CCTV.
 */
export async function fetchCctvUtic(
  bbox?: [number, number, number, number],
  includeIts = false
): Promise<{ items: CctvItem[]; source: string; configured: boolean }> {
  const key = process.env.UTIC_API_KEY;
  const source = "경찰청 도시교통정보센터(UTIC) 제공";
  if (!key) return { items: [], source, configured: false };

  let rows: Row[];
  if (cache && Date.now() - cache.at < TTL_MS) {
    rows = cache.rows;
  } else {
    const r = await safeFetch(`${LIST}?key=${encodeURIComponent(key)}`, {
      accept: "application/json",
      timeoutMs: 30_000,
      // ⚠️ Referer 없으면 9999(비정상적인 접근) — UTIC 목록 API의 유일한 관문.
      headers: { referer: `http://www.utic.go.kr/guide/cctvOpenData.do?key=${key}` },
    });
    if (!r.ok) throw new Error(`utic cctv ${r.status}`);
    const text = await r.text();
    if (/"code"\s*:\s*"9999"|비정상적인 접근/.test(text)) throw new Error("UTIC CCTV 접근 거부(Referer/키 확인)");
    try {
      rows = JSON.parse(text) as Row[];
    } catch {
      throw new Error("UTIC CCTV 응답 파싱 실패");
    }
    if (!Array.isArray(rows)) return { items: [], source, configured: true };
    cache = { at: Date.now(), rows };
  }

  const out: CctvItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const lon = Number(row.XCOORD);
    const lat = Number(row.YCOORD);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inKorea(lon, lat)) continue; // 손상 좌표 2건 제거
    if (!includeIts && (row.CENTERNAME ?? "").includes("국가교통정보센터")) continue; // ITS 중복 제외
    if (bbox && (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3])) continue;
    const id = String(row.CCTVID ?? `${lon.toFixed(5)},${lat.toFixed(5)}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: (row.CCTVNAME ?? "CCTV").trim() || "CCTV",
      lon,
      lat,
      // ⚠️ 스트림 URL에는 인증키가 들어간다 → 6천 건 전부에 키를 실어 보내지 않고,
      //    클릭 시점에 서버가 만들어 302하는 우리 라우트를 가리킨다(페이로드·키 위생 개선).
      url: `/api/cctv/stream?cctvid=${encodeURIComponent(String(row.CCTVID ?? ""))}`,
      format: "utic-jsp", // 클라이언트가 iframe으로 렌더할 신호
      source: "utic",
    });
  }
  return { items: out, source, configured: true };
}

/** CCTVID → 실제 UTIC 스트림 URL(키 포함). 캐시된 목록에서 조회, 없으면 1회 갱신. */
export async function resolveStreamUrl(cctvid: string): Promise<string | null> {
  const key = process.env.UTIC_API_KEY;
  if (!key) return null;
  if (!cache || Date.now() - cache.at >= TTL_MS) await fetchCctvUtic(); // 캐시 채우기
  const row = cache?.rows.find((r) => String(r.CCTVID) === cctvid);
  return row ? buildStreamUrl(key, row) : null;
}
