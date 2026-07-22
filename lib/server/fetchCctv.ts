// ITS 국가교통정보센터 전국 도로 CCTV (openapi.its.go.kr:9443/cctvInfo).
//   응답 data[]: coordx=경도(lon), coordy=위도(lat) WGS84, cctvname, cctvurl(HLS), cctvformat.
//
// 인증키: ITS_API_KEY 있으면 그것(전국·bbox 정확), 없으면 데모키 "test".
//   ⚠️ 데모키 "test" = 무등록으로 실제 CCTV(실좌표+실HLS 스트림)를 주지만
//      **bbox 무시·서울권 20개 고정**(실측 확인). 전국 실데이터는 its.go.kr 무료키 필요.
//   데모키는 XML만 반환(getType 무시) → XML/JSON 양쪽 파싱.
import { safeFetch } from "./safeFetch";

const BASE = "https://openapi.its.go.kr:9443/cctvInfo";

export type CctvItem = { id: string; name: string; lon: number; lat: number; url: string | null; format: string | null };
type ItsRow = { coordx?: string | number; coordy?: string | number; cctvname?: string; cctvurl?: string; cctvformat?: string };

export function isCctvConfigured(): boolean {
  return Boolean(process.env.ITS_API_KEY); // 실키 여부(데모키 아님)
}

// 단순 평면 XML 파서(의존성 없음) — <data>…</data> 블록에서 태그값 추출.
function parseXml(xml: string): ItsRow[] {
  const blocks = xml.match(/<data>[\s\S]*?<\/data>/g) ?? [];
  const tag = (b: string, t: string) => {
    const m = b.match(new RegExp(`<${t}>([^<]*)</${t}>`));
    return m ? m[1] : undefined;
  };
  return blocks.map((b) => ({
    coordx: tag(b, "coordx"),
    coordy: tag(b, "coordy"),
    cctvname: tag(b, "cctvname"),
    cctvurl: tag(b, "cctvurl"),
    cctvformat: tag(b, "cctvformat"),
  }));
}

function parseJson(text: string): ItsRow[] {
  try {
    const j = JSON.parse(text) as { response?: { data?: ItsRow[] } };
    return j.response?.data ?? [];
  } catch {
    return [];
  }
}

async function fetchType(key: string, type: "ex" | "its", bbox: [number, number, number, number]): Promise<CctvItem[]> {
  const [w, s, e, n] = bbox;
  const url = `${BASE}?apiKey=${encodeURIComponent(key)}&type=${type}&cctvType=1&minX=${w}&maxX=${e}&minY=${s}&maxY=${n}&getType=json`;
  const r = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`its ${type} ${r.status}`);
  const text = await r.text();
  const rows = text.trimStart().startsWith("<") ? parseXml(text) : parseJson(text);
  const out: CctvItem[] = [];
  for (const row of rows) {
    const lon = Number(row.coordx);
    const lat = Number(row.coordy);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    out.push({
      id: `${type}:${row.cctvname ?? ""}:${lon.toFixed(5)},${lat.toFixed(5)}`,
      name: row.cctvname ?? "CCTV",
      lon,
      lat,
      url: row.cctvurl ?? null,
      format: row.cctvformat ?? null,
    });
  }
  return out;
}

/** bbox[w,s,e,n] 안의 도로 CCTV. demo=true면 데모키(서울권 20개 고정). */
export async function fetchCctv(bbox: [number, number, number, number]): Promise<{ items: CctvItem[]; source: string; demo: boolean }> {
  const key = process.env.ITS_API_KEY ?? "test";
  const demo = key === "test";
  // 데모키는 어차피 고정 20개(ex)만 주므로 ex만. 실키는 고속도로+국도 병합.
  const types = demo ? (["ex"] as const) : (["ex", "its"] as const);
  const settled = await Promise.allSettled(types.map((t) => fetchType(key, t, bbox)));
  const seen = new Set<string>();
  const items: CctvItem[] = [];
  for (const st of settled) {
    if (st.status !== "fulfilled") continue;
    for (const it of st.value) {
      const k = `${it.lon.toFixed(5)},${it.lat.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }
  return {
    items,
    source: demo ? "ITS 데모키 (서울권 20개 고정 · 전국은 ITS_API_KEY 필요)" : "ITS 국가교통정보센터",
    demo,
  };
}
