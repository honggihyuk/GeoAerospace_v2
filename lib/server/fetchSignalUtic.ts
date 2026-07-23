// 경찰청 신호개방 데이터 — 인천·대구 신호제어 교차로 기반정보(CrossRoadInfoService).
//   엔드포인트: apis.data.go.kr/1320000/CrossRoadInfoService/getCrossRoadInfoList (https, 이미 allowlist).
//   ⚠️ 인증: UTIC 웹키가 아니라 **data.go.kr 서비스키**(DATA_GO_KR_SIGNAL_KEY). 미발급 시 게이트웨이 "Unauthorized".
//   응답: REGION_CD·INT_NO·INT_NM·X_COORD·Y_COORD·UPD_DTIME.
//   좌표: X_COORD/Y_COORD = WGS84 마이크로도(예 126775207→126.775207, 37506690→37.506690) → ÷1e6.
//   신호계획(TOD)은 PlanCrossRoadInfoService/getPlanCRRSInfo로 INT_NO 조인(팝업 온디맨드, 추후).
import { safeFetch } from "./safeFetch";

const BASE = "https://apis.data.go.kr/1320000/CrossRoadInfoService/getCrossRoadInfoList";

export type SignalIntersection = {
  id: string; // REGION_CD:INT_NO
  region: string; // REGION_CD 원본
  regionLabel: string; // 인천/대구/…(best-effort)
  intNo: string; // INT_NO
  name: string; // INT_NM
  lon: number;
  lat: number;
  updated: string; // UPD_DTIME
};

type Row = Record<string, string | number | undefined>;

export function isSignalConfigured(): boolean {
  return Boolean(process.env.DATA_GO_KR_SIGNAL_KEY);
}

// REGION_CD(UTIC 자체코드) → 도시명. 실데이터 확인: L01=서울, L29=인천, L27=대구. 나머지는 원본 노출.
function regionLabel(cd: string): string {
  const map: Record<string, string> = { L01: "서울", L27: "대구", L29: "인천" };
  return map[cd] ?? cd;
}

/**
 * X_COORD/Y_COORD → WGS84 도. 실데이터 정수 스케일이 일정치 않아(문서 ÷1e6, 실 API ÷1e7)
 * 경도·위도를 **각자 기대범위**로 내려올 때까지 10으로 나눈다. 위도(37…)는 <1000 정규화로는
 * 375.58에서 잘못 멈추므로 반드시 위도 상한(≈90)으로 따로 정규화해야 한다.
 */
function normLon(v: number): number {
  let d = Math.abs(v);
  let g = 0;
  while (d > 133 && g++ < 12) d /= 10;
  return d;
}
function normLat(v: number): number {
  let d = Math.abs(v);
  let g = 0;
  while (d > 40 && g++ < 12) d /= 10;
  return d;
}
function inKorea(lon: number, lat: number): boolean {
  return lon > 123 && lon < 132.5 && lat > 32.5 && lat < 39.5;
}

/** 헤더 원소인가(데이터 행이 아님) — resultCode/resultMsg만 있고 좌표·교차로번호 없음. */
function isHeader(o: Row): boolean {
  return (o.resultCode !== undefined || o.resultMsg !== undefined) && o.INT_NO === undefined && o.X_COORD === undefined;
}

function parseRows(text: string): Row[] {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    const j = JSON.parse(text) as unknown; // 파싱 실패는 상위에서 인증실패로 처리
    // 실 API 형식: [{헤더}, {행}, …] 평탄 배열. (표준 {response:{body:{items:{item}}}}도 함께 지원)
    if (Array.isArray(j)) return (j as Row[]).filter((o) => !isHeader(o));
    const std = j as { response?: { body?: { items?: { item?: unknown } | unknown } } };
    const items = std.response?.body?.items;
    const raw = (items as { item?: unknown })?.item ?? items ?? [];
    return (Array.isArray(raw) ? raw : [raw]) as Row[];
  }
  // XML: <item>…</item> 평면 파서.
  const blocks = t.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const tag = (b: string, n: string) => b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`, "i"))?.[1]?.trim();
  return blocks.map((b) => ({
    REGION_CD: tag(b, "REGION_CD"),
    INT_NO: tag(b, "INT_NO"),
    INT_NM: tag(b, "INT_NM"),
    X_COORD: tag(b, "X_COORD"),
    Y_COORD: tag(b, "Y_COORD"),
    UPD_DTIME: tag(b, "UPD_DTIME"),
  }));
}

/** 신호제어 교차로 목록(인천·대구). data.go.kr는 페이지네이션 — 최대 maxRows까지 수집. */
export async function fetchSignalIntersections(
  maxRows = 4000
): Promise<{ items: SignalIntersection[]; source: string; configured: boolean }> {
  const key = process.env.DATA_GO_KR_SIGNAL_KEY;
  const source = "경찰청 도시교통정보센터(UTIC) 신호개방 · data.go.kr";
  if (!key) return { items: [], source, configured: false };

  const PER = 100; // ⚠️ 서비스가 numOfRows를 100으로 캡 → 100씩 페이지네이션
  const out: SignalIntersection[] = [];
  const seen = new Set<string>();
  for (let page = 1; out.length < maxRows; page++) {
    // data.go.kr 서비스키는 이미 URL-encoded로 발급되는 경우가 많아 이중인코딩 방지 — 그대로 부착.
    const url = `${BASE}?serviceKey=${key}&type=json&numOfRows=${PER}&pageNo=${page}`;
    const r = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 15_000 });
    const text = await r.text();
    const head = text.trimStart()[0];
    // 게이트웨이 평문 오류(Forbidden/Unauthorized/Unexpected errors 등) = JSON/XML이 아님.
    if (!r.ok || (head !== "{" && head !== "[" && head !== "<")) {
      throw new Error(`신호개방 인증/권한 오류: ${text.trim().slice(0, 80)} — data.go.kr 활용신청·서비스키 확인`);
    }
    let rows: Row[];
    try {
      rows = parseRows(text);
    } catch {
      throw new Error(`신호개방 응답 파싱 실패: ${text.trim().slice(0, 80)}`);
    }
    if (!rows.length) break;
    for (const row of rows) {
      const lon = normLon(Number(row.X_COORD));
      const lat = normLat(Number(row.Y_COORD));
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inKorea(lon, lat)) continue;
      const region = String(row.REGION_CD ?? "").trim();
      const intNo = String(row.INT_NO ?? "").trim();
      const id = `${region}:${intNo}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        region,
        regionLabel: regionLabel(region),
        intNo,
        name: String(row.INT_NM ?? "").trim() || "교차로",
        lon,
        lat,
        updated: String(row.UPD_DTIME ?? "").trim(),
      });
    }
    if (rows.length < PER) break; // 마지막 페이지
  }
  return { items: out, source, configured: true };
}
