// NASA FIRMS 활성 화재 탐지 (개발제안서 §4.7 / P5.5).
//
// 두 경로를 지원한다:
//  1. **Area API** — `FIRMS_MAP_KEY`가 설정된 경우. bbox·기간·type을 서버에서 필터해
//     작은 응답을 받는다. 제안서가 명시한 경로이며 `type`(0=초목/1=화산/2=정적/3=해상)을
//     쓸 수 있는 유일한 경로다. 한도 5000요청/10분.
//  2. **Open Data 전지구 CSV** — 키가 없을 때. 키 없이 즉시 동작하지만 전지구 24h 전량을
//     받아야 한다(실측 VIIRS 13 MB/16만점, MODIS 2.3 MB/3만점). 파일이 3시간 주기로
//     갱신되므로 **서버에 캐시해두고 bbox 필터만 메모리에서** 수행한다.
//
// 키는 서버 전용 환경변수로만 읽는다(NEXT_PUBLIC_ 금지 → 클라 번들에 실리지 않음):
//   .env.local:  FIRMS_MAP_KEY=<발급받은 키>
//
// 제안서의 OSIRIS 차용 항목을 모두 반영: VIIRS→MODIS 폴백, EONET 화산 병합,
// 의존성 없는 자체 CSV 파서, 대영역 샘플링, Promise.allSettled 장애 격리.
import { safeFetch } from "./safeFetch";

const FIRMS_HOST = "https://firms.modaps.eosdis.nasa.gov";
const EONET = "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes&limit=100";

/** 전지구 CSV는 3시간 주기로 갱신된다. */
const GLOBAL_TTL_MS = 60 * 60 * 1000;
const EONET_TTL_MS = 6 * 60 * 60 * 1000;

/** 전송량·렌더 부담 제어 (제안서 §4.7). */
export const MAX_POINTS = 2000;

export type FirePoint = {
  lat: number;
  lon: number;
  /** 화재복사파워 (MW) — 강도 */
  frp: number;
  /** 0~100 정규화. VIIRS는 low/nominal/high 문자열이라 환산한다. */
  confidence: number;
  acqDate: string;
  acqTime: string;
  daynight: "D" | "N" | "";
  kind: "fire" | "volcano";
  title?: string;
};

export type Bbox = { west: number; south: number; east: number; north: number };

export type FireResult = {
  points: FirePoint[];
  summary: {
    total: number;
    returned: number;
    sampled: boolean;
    maxFrp: number;
    meanFrp: number;
    volcanoes: number;
  };
  source: string;
  /** Area API를 썼는지 (키 설정 여부) */
  precise: boolean;
  fetchedAt: number;
};

export function isAreaApiConfigured(): boolean {
  return Boolean(process.env.FIRMS_MAP_KEY);
}

// ── CSV 파서 (의존성 없음) ───────────────────────────────────────────────────
/** FIRMS CSV는 인용부호 없는 단순 형식이라 분할만으로 충분하다. */
function parseFirmsCsv(text: string): FirePoint[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => head.indexOf(name);

  const iLat = idx("latitude");
  const iLon = idx("longitude");
  const iFrp = idx("frp");
  const iConf = idx("confidence");
  const iDate = idx("acq_date");
  const iTime = idx("acq_time");
  const iDn = idx("daynight");
  const iType = idx("type"); // Area API에만 존재
  if (iLat < 0 || iLon < 0) return [];

  const out: FirePoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(",");
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // type 필터는 Area API 응답에만 적용 가능
    if (iType >= 0 && c[iType]?.trim() !== "" && Number(c[iType]) !== 0) continue;
    out.push({
      lat,
      lon,
      frp: iFrp >= 0 ? Number(c[iFrp]) || 0 : 0,
      confidence: normalizeConfidence(iConf >= 0 ? c[iConf] : ""),
      acqDate: iDate >= 0 ? (c[iDate] ?? "") : "",
      acqTime: iTime >= 0 ? (c[iTime] ?? "") : "",
      daynight: iDn >= 0 && (c[iDn] === "D" || c[iDn] === "N") ? c[iDn] : "",
      kind: "fire",
    });
  }
  return out;
}

/** VIIRS는 low/nominal/high 문자열, MODIS는 0~100 숫자 → 0~100으로 통일. */
function normalizeConfidence(raw: string): number {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "low") return 20;
  if (s === "nominal") return 60;
  if (s === "high") return 90;
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

// ── 전지구 CSV 캐시 ──────────────────────────────────────────────────────────
type GlobalSet = { points: FirePoint[]; source: string };
const globalCache = new Map<string, { v: GlobalSet; ts: number }>();

const GLOBAL_SOURCES: { key: string; url: string; label: string }[] = [
  {
    key: "viirs",
    url: `${FIRMS_HOST}/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv`,
    label: "NASA FIRMS (VIIRS SNPP)",
  },
  {
    key: "modis",
    url: `${FIRMS_HOST}/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv`,
    label: "NASA FIRMS (MODIS)",
  },
];

/** VIIRS 우선, 실패 시 MODIS 폴백 (제안서 §4.7). */
async function fetchGlobal(): Promise<GlobalSet> {
  for (const s of GLOBAL_SOURCES) {
    const hit = globalCache.get(s.key);
    if (hit && Date.now() - hit.ts < GLOBAL_TTL_MS) return hit.v;
    try {
      const r = await safeFetch(s.url, { timeoutMs: 60_000, accept: "text/csv,text/plain" });
      if (!r.ok) continue;
      const text = await r.text();
      if (!text.includes("latitude") || text.length < 200) continue;
      const points = parseFirmsCsv(text);
      if (points.length === 0) continue;
      const v = { points, source: s.label };
      globalCache.set(s.key, { v, ts: Date.now() });
      return v;
    } catch {
      continue; // 다음 소스로 폴백
    }
  }
  throw new Error("FIRMS: 전 소스 실패");
}

// ── Area API ────────────────────────────────────────────────────────────────
async function fetchArea(bbox: Bbox, dayRange: number, source: string): Promise<GlobalSet> {
  const key = process.env.FIRMS_MAP_KEY ?? "";
  const area = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`;
  const url = `${FIRMS_HOST}/api/area/csv/${key}/${source}/${area}/${dayRange}`;
  const r = await safeFetch(url, { timeoutMs: 45_000, accept: "text/csv,text/plain" });
  if (!r.ok) throw new Error(`firms area ${r.status}`);
  const text = await r.text();
  // 키가 틀리면 200에 "Invalid MAP_KEY." 본문이 온다 — 상태코드로는 알 수 없다.
  if (/invalid map_key/i.test(text)) throw new Error("FIRMS: MAP_KEY 거부됨");
  return { points: parseFirmsCsv(text), source: `NASA FIRMS Area API (${source})` };
}

// ── EONET 화산 ──────────────────────────────────────────────────────────────
let eonetCache: { v: FirePoint[]; ts: number } | null = null;

async function fetchVolcanoes(): Promise<FirePoint[]> {
  if (eonetCache && Date.now() - eonetCache.ts < EONET_TTL_MS) return eonetCache.v;
  const r = await safeFetch(EONET, { timeoutMs: 20_000, accept: "application/json" });
  if (!r.ok) throw new Error(`eonet ${r.status}`);
  const j = (await r.json()) as { events?: Array<{ title?: string; geometry?: Array<{ coordinates?: number[]; date?: string }> }> };
  const out: FirePoint[] = [];
  for (const e of j.events ?? []) {
    const g = e.geometry?.[e.geometry.length - 1];
    const c = g?.coordinates;
    if (!c || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    out.push({
      lat: c[1],
      lon: c[0],
      frp: 0,
      confidence: 100,
      acqDate: (g?.date ?? "").split("T")[0] ?? "",
      acqTime: "",
      daynight: "",
      kind: "volcano",
      title: e.title,
    });
  }
  eonetCache = { v: out, ts: Date.now() };
  return out;
}

// ── 공개 API ────────────────────────────────────────────────────────────────
function inBbox(p: { lat: number; lon: number }, b: Bbox): boolean {
  if (p.lat < b.south || p.lat > b.north) return false;
  // 날짜변경선을 넘는 bbox 처리
  return b.west <= b.east ? p.lon >= b.west && p.lon <= b.east : p.lon >= b.west || p.lon <= b.east;
}

/** 균등 간격 샘플링 — 상위 FRP만 남기면 약한 화재가 통째로 사라져 분포가 왜곡된다. */
function sample<T>(arr: T[], max: number): { out: T[]; sampled: boolean } {
  if (arr.length <= max) return { out: arr, sampled: false };
  const step = arr.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return { out, sampled: true };
}

export type FireQuery = {
  bbox?: Bbox;
  dayRange?: number;
  minFrp?: number;
  minConfidence?: number;
  includeVolcanoes?: boolean;
  source?: string;
  limit?: number;
};

export async function fetchFires(q: FireQuery = {}): Promise<FireResult> {
  const bbox = q.bbox;
  const dayRange = Math.min(10, Math.max(1, q.dayRange ?? 1));
  const limit = Math.min(MAX_POINTS, Math.max(1, q.limit ?? MAX_POINTS));
  const useArea = isAreaApiConfigured() && !!bbox;

  // 화재와 화산을 병렬로, 서로의 실패를 격리 (Promise.allSettled)
  const [fireRes, volcRes] = await Promise.allSettled([
    useArea
      ? fetchArea(bbox!, dayRange, q.source ?? "VIIRS_SNPP_NRT").catch(async (e) => {
          console.warn("[fires] Area API 실패, Open Data로 폴백:", String(e));
          return fetchGlobal();
        })
      : fetchGlobal(),
    q.includeVolcanoes === false ? Promise.resolve([]) : fetchVolcanoes(),
  ]);

  if (fireRes.status === "rejected") throw new Error(String(fireRes.reason));
  let points = fireRes.value.points;
  const source = fireRes.value.source;
  const precise = useArea && source.includes("Area API");

  // Open Data 경로는 전지구를 받았으므로 여기서 bbox를 적용한다.
  // (Area API 경로는 서버가 이미 잘라 보냈지만, 경계 밖 값이 섞여도 무해하다.)
  if (bbox) points = points.filter((p) => inBbox(p, bbox));
  if (q.minFrp != null) points = points.filter((p) => p.frp >= q.minFrp!);
  if (q.minConfidence != null) points = points.filter((p) => p.confidence >= q.minConfidence!);

  const volcanoes = volcRes.status === "fulfilled" ? volcRes.value.filter((v) => !bbox || inBbox(v, bbox)) : [];

  // 주의: Math.max(...arr)는 인자를 스택에 펼치므로 큰 배열에서 RangeError가 난다.
  // 전지구 조회는 16만 점이라 실제로 터졌다 — 반드시 순회로 구한다.
  const total = points.length;
  let maxFrp = 0;
  let sumFrp = 0;
  for (const p of points) {
    if (p.frp > maxFrp) maxFrp = p.frp;
    sumFrp += p.frp;
  }
  const meanFrp = total ? sumFrp / total : 0;

  const { out, sampled } = sample(points, Math.max(1, limit - volcanoes.length));
  const merged = [...out, ...volcanoes];

  return {
    points: merged,
    summary: {
      total,
      returned: merged.length,
      sampled,
      maxFrp: Math.round(maxFrp * 10) / 10,
      meanFrp: Math.round(meanFrp * 10) / 10,
      volcanoes: volcanoes.length,
    },
    source: volcanoes.length ? `${source} + NASA EONET` : source,
    precise,
    fetchedAt: Date.now(),
  };
}
