// 경찰청 도시교통정보센터(UTIC) 전국 실시간 돌발정보 (imsOpenData.do).
//   레퍼런스: http://www.utic.go.kr/guide/utisRefIncident.do
//   제공: 경찰청·국토부·경기도청·서울시설공단 외 — 좌표 포함 실시간 돌발(사고·공사·행사·통제·기상).
//   ⚠️ 인증: key + 서버 IP. UTIC에 공인 IP 미등록 시 {"resultCode":"02","resultMsg":"유효한 KEY값이 아닙니다."}.
//   ⚠️ 포맷: 레퍼런스는 XML 명시이나 오류는 JSON으로 옴 → XML/JSON 양쪽 파싱(fetchCctv·fetchTraffic 패턴).
//   좌표: locationDataX=경도(lon), locationDataY=위도(lat) WGS84(telMap x/y와 동일 체계).
import { safeFetch } from "./safeFetch";

const BASE = "https://www.utic.go.kr/guide/imsOpenData.do";

export type IncidentKind = "accident" | "construction" | "event" | "control" | "weather" | "other";

export type IncidentItem = {
  id: string;
  kind: IncidentKind; // 제목 키워드로 파생(코드정의서 비의존)
  typeCd: string; // incidenteTypeCd 원본
  title: string; // incidentTitle
  lon: number;
  lat: number;
  road: string; // roadName
  start: string; // startDate
  end: string; // endDate
  control: string; // controlType (통제정보)
  important: boolean; // important === 'Y'
};

// 원시 필드(문자/숫자 혼재) — imsOpenData 속성명.
type Row = Record<string, string | number | undefined>;

/** 한반도 경위도 범위 — TM/오좌표 방어(telMap 예시가 WGS84 도 단위임을 근거). */
function inKorea(lon: number, lat: number): boolean {
  return lon > 123 && lon < 132.5 && lat > 32.5 && lat < 39.5;
}

/** 사람이 읽는 제목/유형 텍스트로 돌발 종류 분류(코드표 없이 견고). */
function classify(title: string, typeCd: string): IncidentKind {
  const t = `${title} ${typeCd}`;
  if (/사고|추돌|전복|충돌/.test(t)) return "accident";
  if (/공사|작업|보수|포장|점검/.test(t)) return "construction";
  if (/행사|집회|마라톤|축제/.test(t)) return "event";
  if (/통제|차단|폐쇄|전면|부분통제/.test(t)) return "control";
  if (/결빙|폭우|폭설|안개|적설|침수|기상/.test(t)) return "weather";
  return "other";
}

function parseRows(text: string): Row[] {
  const t = text.trimStart();
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const j = JSON.parse(text) as unknown;
      const arr = Array.isArray(j)
        ? j
        : ((j as { items?: unknown; response?: { body?: { items?: unknown } } }).items ??
            (j as { response?: { body?: { items?: unknown } } }).response?.body?.items ??
            []);
      return (Array.isArray(arr) ? arr : [arr]) as Row[];
    } catch {
      return [];
    }
  }
  // XML: 반복 블록에서 태그값 추출(의존성 없는 평면 파서, fetchCctv 패턴).
  const blocks = t.match(/<(item|data|incident)>[\s\S]*?<\/\1>/g) ?? [];
  const tag = (b: string, name: string) => b.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))?.[1]?.trim();
  const fields = [
    "incidentId",
    "incidenteTypeCd",
    "incidentTitle",
    "locationDataX",
    "locationDataY",
    "roadName",
    "startDate",
    "endDate",
    "controlType",
    "important",
  ];
  return blocks.map((b) => {
    const row: Row = {};
    for (const f of fields) row[f] = tag(b, f);
    return row;
  });
}

/** UTIC 전국 실시간 돌발. bbox 주면 그 안만 필터(imsOpenData는 전국 반환). */
export async function fetchIncidents(
  bbox?: [number, number, number, number]
): Promise<{ items: IncidentItem[]; source: string; configured: boolean }> {
  const key = process.env.UTIC_API_KEY;
  const source = "경찰청 도시교통정보센터(UTIC) 제공"; // 준수사항: 출처 표기 의무
  if (!key) return { items: [], source, configured: false };

  const url = `${BASE}?key=${encodeURIComponent(key)}`;
  const r = await safeFetch(url, { accept: "text/xml, application/json", timeoutMs: 15_000 });
  if (!r.ok) throw new Error(`utic incident ${r.status}`);
  const text = await r.text();

  // 인증 실패(IP 미등록 등)를 명시적으로 구분 — 빈 결과와 혼동 방지.
  if (/유효한 KEY값이 아닙니다|비정상적인 접근|resultCode":"0[29]"/.test(text)) {
    throw new Error("UTIC 인증 실패(키·서버 IP 등록 확인)");
  }

  const rows = parseRows(text);
  const out: IncidentItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const lon = Number(row.locationDataX);
    const lat = Number(row.locationDataY);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inKorea(lon, lat)) continue;
    if (bbox && (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3])) continue;
    const title = String(row.incidentTitle ?? "").trim() || "돌발상황";
    const typeCd = String(row.incidenteTypeCd ?? "").trim();
    const id = String(row.incidentId ?? `${lon.toFixed(5)},${lat.toFixed(5)}`);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: classify(title, typeCd),
      typeCd,
      title,
      lon,
      lat,
      road: String(row.roadName ?? "").trim(),
      start: String(row.startDate ?? "").trim(),
      end: String(row.endDate ?? "").trim(),
      control: String(row.controlType ?? "").trim(),
      important: String(row.important ?? "").trim().toUpperCase() === "Y",
    });
  }
  return { items: out, source, configured: true };
}
