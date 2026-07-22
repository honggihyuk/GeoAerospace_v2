// ITS 국가교통정보센터 전국 도로 CCTV (openapi.its.go.kr). ITS_API_KEY 필요(무료: its.go.kr).
//   GET /cctvInfo?apiKey=KEY&type={ex|its}&cctvType=1&minX&maxX&minY&maxY&getType=json
//   응답: response.data[] — coordx=경도(lon), coordy=위도(lat) WGS84, cctvname, cctvurl(HLS), cctvformat.
import { safeFetch } from "./safeFetch";

const BASE = "https://openapi.its.go.kr:9443/cctvInfo";

export type CctvItem = { id: string; name: string; lon: number; lat: number; url: string | null; format: string | null };

type ItsRow = { coordx?: string | number; coordy?: string | number; cctvname?: string; cctvurl?: string; cctvformat?: string };

export function isCctvConfigured(): boolean {
  return Boolean(process.env.ITS_API_KEY);
}

async function fetchType(key: string, type: "ex" | "its", bbox: [number, number, number, number]): Promise<CctvItem[]> {
  const [w, s, e, n] = bbox;
  const url =
    `${BASE}?apiKey=${encodeURIComponent(key)}&type=${type}&cctvType=1` +
    `&minX=${w}&maxX=${e}&minY=${s}&maxY=${n}&getType=json`;
  const r = await safeFetch(url, { accept: "application/json", timeoutMs: 20_000 });
  if (!r.ok) throw new Error(`its ${type} ${r.status}`);
  const j = (await r.json()) as { response?: { data?: ItsRow[] }; header?: { resultCode?: number; resultMsg?: string } };
  // 인증키 오류 등은 header.resultCode 로 온다(HTTP 200일 수 있음).
  if (j.header?.resultCode && j.header.resultCode !== 0) throw new Error(`its ${j.header.resultMsg ?? j.header.resultCode}`);
  const rows = j.response?.data ?? [];
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

/** bbox[w,s,e,n] 안의 도로 CCTV (고속도로 ex + 국도 its 병합, 좌표 중복 제거). */
export async function fetchCctv(bbox: [number, number, number, number]): Promise<{ items: CctvItem[]; source: string }> {
  const key = process.env.ITS_API_KEY;
  if (!key) throw new Error("ITS_API_KEY 미설정");
  const settled = await Promise.allSettled([fetchType(key, "ex", bbox), fetchType(key, "its", bbox)]);
  const seen = new Set<string>();
  const items: CctvItem[] = [];
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const it of s.value) {
      const k = `${it.lon.toFixed(5)},${it.lat.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }
  return { items, source: "ITS 국가교통정보센터" };
}
