// OpenAQ v3 지상 대기질 (레인 ② 다종화) — 위경도 포인트 관측.
// v3는 X-API-Key 필수(v2는 2025 폐지, 410). 키 무료 발급: explore.openaq.org → Register → API Keys.
//   .env.local:  OPENAQ_API_KEY=<발급키>
//
// 흐름: /v3/locations?bbox 로 관측소를 찾고(센서→파라미터 맵 구성),
//       관측소별 /latest 로 최신값을 받아 센서 맵과 조인해 파라미터별 포인트를 만든다.
import { safeFetch } from "./safeFetch";

const BASE = "https://api.openaq.org/v3";

// 적재 대상 대기질 파라미터 (그 외 파라미터는 노이즈라 제외).
const AQ_PARAMS = new Set(["pm25", "pm10", "no2", "o3", "so2", "co"]);

export type AqPoint = {
  lat: number;
  lon: number;
  parameter: string; // 'no2' | 'pm25' ...
  value: number;
  unit: string;
  datetime: string | null; // ISO UTC
  location: string;
  sensorsId: number;
};

export function isOpenAqConfigured(): boolean {
  return Boolean(process.env.OPENAQ_API_KEY);
}

type LocResult = {
  id: number;
  name?: string;
  coordinates?: { latitude?: number; longitude?: number };
  sensors?: { id: number; parameter?: { name?: string; units?: string } }[];
};
type LatestResult = { value?: number; sensorsId?: number; datetime?: { utc?: string } };

async function getJson<T>(path: string, key: string, timeoutMs = 20_000): Promise<T> {
  const r = await safeFetch(`${BASE}${path}`, { headers: { "X-API-Key": key }, accept: "application/json", timeoutMs });
  if (!r.ok) throw new Error(`openaq ${r.status}`);
  return (await r.json()) as T;
}

/** bbox[w,s,e,n] 안의 최신 대기질 관측 포인트. maxLocations로 요청량을 제한. */
export async function fetchOpenAQ(
  bbox: [number, number, number, number],
  opts: { maxLocations?: number } = {}
): Promise<{ points: AqPoint[]; locations: number; source: string }> {
  const key = process.env.OPENAQ_API_KEY;
  if (!key) throw new Error("OPENAQ_API_KEY 미설정");
  const [w, s, e, n] = bbox;
  const maxLoc = Math.min(50, Math.max(1, opts.maxLocations ?? 15));

  // 1) bbox 내 관측소 + 센서(파라미터) 맵.
  const locs = await getJson<{ results?: LocResult[] }>(`/locations?bbox=${w},${s},${e},${n}&limit=${maxLoc}`, key);
  const results = locs.results ?? [];

  // sensorsId → 파라미터·단위·좌표·관측소명
  const sensorMap = new Map<number, { parameter: string; unit: string; lat: number; lon: number; location: string }>();
  const locIds: number[] = [];
  for (const L of results) {
    const lat = L.coordinates?.latitude;
    const lon = L.coordinates?.longitude;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    locIds.push(L.id);
    for (const sen of L.sensors ?? []) {
      const pname = (sen.parameter?.name ?? "").toLowerCase();
      if (!AQ_PARAMS.has(pname)) continue;
      sensorMap.set(sen.id, { parameter: pname, unit: sen.parameter?.units ?? "", lat, lon, location: L.name ?? String(L.id) });
    }
  }

  // 2) 관측소별 최신값 (실패 격리 — 429 등은 건너뜀).
  const points: AqPoint[] = [];
  const settled = await Promise.allSettled(
    locIds.map((id) => getJson<{ results?: LatestResult[] }>(`/locations/${id}/latest`, key, 15_000))
  );
  for (const res of settled) {
    if (res.status !== "fulfilled") continue;
    for (const m of res.value.results ?? []) {
      const sid = m.sensorsId;
      if (typeof sid !== "number" || typeof m.value !== "number") continue;
      // OpenAQ 결측/무효 센티넬(-999·9999 등)과 음수 농도 제외 — 안 걸러내면 평균이 오염된다.
      if (m.value < 0 || m.value >= 9999) continue;
      const meta = sensorMap.get(sid);
      if (!meta) continue; // AQ 대상 파라미터가 아니거나 맵에 없음
      points.push({
        lat: meta.lat,
        lon: meta.lon,
        parameter: meta.parameter,
        value: m.value,
        unit: meta.unit,
        datetime: m.datetime?.utc ?? null,
        location: meta.location,
        sensorsId: sid,
      });
    }
  }

  return { points, locations: locIds.length, source: "OpenAQ v3" };
}
