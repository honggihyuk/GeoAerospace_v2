// ITS 국가교통정보센터 실시간 돌발정보 (openapi.its.go.kr:9443/eventInfo).
//   경찰청 UTIC(imsOpenData)은 key+서버IP 인증이라 배포가 까다롭다. ITS eventInfo는 **기존 ITS_API_KEY**
//   (없으면 데모키 "test")로 서버IP 등록 없이 전국 돌발(사고·공사·통제)을 준다. CCTV·소통과 동일 호스트/키.
//   ⚠️ 실키=JSON, 데모키 "test"=XML(getType 무시) → 양파싱(fetchCctv 패턴). 데모키는 bbox 무시·전국 고정.
//   필드: type(도로종류)·eventType·eventDetailType·coordX(lon)·coordY(lat) WGS84·roadName·roadDrcType·
//        lanesBlocked·message·startDate·endDate·linkId.
import { safeFetch } from "./safeFetch";
import type { IncidentItem, IncidentKind } from "./fetchIncidentUtic";

const BASE = "https://openapi.its.go.kr:9443/eventInfo";

type Row = Record<string, string | undefined>;

function inKorea(lon: number, lat: number): boolean {
  return lon > 123 && lon < 132.5 && lat > 32.5 && lat < 39.5;
}

// eventType/세부유형 텍스트로 종류 분류(UTIC 분류와 동일 팔레트로 매핑).
function classify(t: string): IncidentKind {
  if (/사고|추돌|전복|충돌/.test(t)) return "accident";
  if (/공사|작업|보수|포장|점검/.test(t)) return "construction";
  if (/행사|집회|마라톤|축제/.test(t)) return "event";
  if (/통제|차단|폐쇄|전면|부분/.test(t)) return "control";
  if (/결빙|폭우|폭설|안개|적설|침수|기상|미끄/.test(t)) return "weather";
  return "other";
}

function parseRows(text: string): Row[] {
  const t = text.trimStart();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { body?: { items?: unknown } };
      const raw = j.body?.items ?? [];
      return (Array.isArray(raw) ? raw : [raw]) as Row[];
    } catch {
      return [];
    }
  }
  const blocks = t.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const tag = (b: string, n: string) => b.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`, "i"))?.[1]?.trim();
  const fields = ["type", "eventType", "eventDetailType", "coordX", "coordY", "roadName", "roadDrcType", "lanesBlocked", "message", "startDate", "endDate"];
  return blocks.map((b) => {
    const row: Row = {};
    for (const f of fields) row[f] = tag(b, f);
    return row;
  });
}

// 한 키로 eventInfo 조회 → 실패(HTTP 오류/resultCode 4xxx)면 null.
async function tryKey(key: string, bbox: [number, number, number, number]): Promise<string | null> {
  const [w, s, e, n] = bbox;
  const url = `${BASE}?apiKey=${encodeURIComponent(key)}&type=all&eventType=all&getType=json&minX=${w}&maxX=${e}&minY=${s}&maxY=${n}`;
  const r = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 15_000 });
  if (!r.ok) return null;
  const text = await r.text();
  if (/개인 제한량|유효.*아닙니다|resultCode>?"?:?\s*"?4\d{3}/.test(text)) return null; // 한도/인증 실패
  return text;
}

/**
 * ITS 전국 돌발. 실키(ITS_API_KEY) 우선, 실패(eventInfo 미허용·일일한도 401/4001)면 **데모키 "test"로 폴백**.
 * ⚠️ 실키=bbox 정확/JSON, 데모키=전국 고정 24건/XML(getType 무시). fetchCctv와 동일 철학.
 */
export async function fetchIncidentsIts(
  bbox?: [number, number, number, number]
): Promise<{ items: IncidentItem[]; source: string; configured: boolean; sample: boolean }> {
  const box = bbox ?? ([124.5, 33.0, 131.0, 38.7] as [number, number, number, number]);
  const realKey = process.env.ITS_API_KEY;

  let text: string | null = null;
  let sample = true;
  if (realKey && realKey !== "test") {
    text = await tryKey(realKey, box);
    if (text) sample = false;
  }
  if (!text) text = await tryKey("test", box); // 데모키 폴백(전국 고정)
  if (!text) throw new Error("ITS eventInfo 조회 실패(실키 한도/권한 + 데모키 모두 실패)");

  const rows = parseRows(text);
  const out: IncidentItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const lon = Number(row.coordX);
    const lat = Number(row.coordY);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inKorea(lon, lat)) continue;
    const evt = `${row.eventType ?? ""} ${row.eventDetailType ?? ""}`.trim();
    const road = (row.roadName ?? "").trim();
    const msg = (row.message ?? "").trim();
    const title = msg || evt || "돌발상황";
    const id = `${lon.toFixed(5)},${lat.toFixed(5)}:${(row.startDate ?? "").slice(0, 12)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: classify(evt),
      typeCd: (row.eventType ?? "").trim(),
      title,
      lon,
      lat,
      road: road || (row.type ?? "").trim(),
      start: (row.startDate ?? "").trim(),
      end: (row.endDate ?? "").trim(),
      // 방향 + 차단 차로를 통제정보로.
      control: [row.roadDrcType, row.lanesBlocked].map((x) => (x ?? "").trim()).filter(Boolean).join(" · "),
      important: /사고|충돌|전복|통제|폐쇄|전면/.test(evt),
    });
  }
  return {
    items: out,
    source: sample ? "ITS 국가교통정보센터 (데모키 · 전국 고정)" : "ITS 국가교통정보센터 실시간 돌발",
    configured: !sample,
    sample,
  };
}
