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

// REGION_CD(UTIC 자체코드) → 도시명. L29=인천 확인(개방데이터 샘플). 나머지는 원본 노출.
function regionLabel(cd: string): string {
  const map: Record<string, string> = { L29: "인천", L27: "대구" };
  return map[cd] ?? cd;
}

/** X_COORD/Y_COORD → WGS84 도. 마이크로도(정수)면 ÷1e6, 이미 도 단위면 그대로. */
function toDegree(v: number): number {
  return Math.abs(v) > 1000 ? v / 1_000_000 : v;
}
function inKorea(lon: number, lat: number): boolean {
  return lon > 123 && lon < 132.5 && lat > 32.5 && lat < 39.5;
}

function parseRows(text: string): Row[] {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const j = JSON.parse(text) as { response?: { body?: { items?: { item?: unknown } | unknown } } };
      const items = j.response?.body?.items;
      const raw = (items as { item?: unknown })?.item ?? items ?? [];
      return (Array.isArray(raw) ? raw : [raw]) as Row[];
    } catch {
      return [];
    }
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

  const PER = 1000;
  const out: SignalIntersection[] = [];
  const seen = new Set<string>();
  for (let page = 1; out.length < maxRows; page++) {
    // data.go.kr 서비스키는 이미 URL-encoded로 발급되는 경우가 많아 이중인코딩 방지 — 그대로 부착.
    const url = `${BASE}?serviceKey=${key}&type=json&numOfRows=${PER}&pageNo=${page}`;
    const r = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 15_000 });
    const text = await r.text();
    if (!r.ok || /Unauthorized|SERVICE_KEY_IS_NOT_REGISTERED|resultCode>?"?:?\s*"?3[0-9]/.test(text)) {
      throw new Error("신호개방 인증 실패(data.go.kr 서비스키 확인)");
    }
    const rows = parseRows(text);
    if (!rows.length) break;
    for (const row of rows) {
      const lon = toDegree(Number(row.X_COORD));
      const lat = toDegree(Number(row.Y_COORD));
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
