// 항공기 ADS-B 수집 (설계서 §4.2 · §4.8-D) — 다중 소스 폴백 + 지역 팬아웃
// + single-flight + 캐시 + 429 쿨다운 + Promise.allSettled 회복탄력.
import { safeFetch } from "./safeFetch";

export type Aircraft = {
  hex: string;
  callsign: string;
  lon: number;
  lat: number;
  alt: number; // ft
  gs: number; // knots
  track: number; // deg
  category: "commercial" | "private" | "jet" | "mil";
};

// 주요 트래픽 허브 (지역 팬아웃, 반경 nm)
const REGIONS: [number, number, number][] = [
  [50.03, 8.56, 250], // Frankfurt
  [51.47, -0.45, 250], // London
  [40.64, -73.78, 250], // New York
  [33.94, -118.4, 250], // Los Angeles
  [37.46, 126.44, 250], // Incheon
  [35.55, 139.78, 250], // Tokyo
  [25.25, 55.36, 250], // Dubai
];

type Raw = { hex?: string; flight?: string; r?: string; lat?: number; lon?: number; alt_baro?: number | string; gs?: number; track?: number; category?: string; t?: string };

function classify(callsign: string, category?: string, type?: string): Aircraft["category"] {
  const cs = callsign.trim().toUpperCase();
  if (category === "A7" || /^(RCH|CNV|EVAC|GRZLY|PLF)/.test(cs)) return "mil";
  // 3레터 ICAO 항공사 콜사인(3문자+숫자) → 상용
  if (/^[A-Z]{3}\d/.test(cs)) return "commercial";
  // N-번호 등록기호(미국 개인기) 등
  if (/^N\d/.test(cs) || cs === "") return "private";
  if (type && /^(GLF|LJ|C25|C56|CL|E55|H25)/.test(type)) return "jet";
  return "commercial";
}

function normalize(raw: Raw[]): Aircraft[] {
  const out: Aircraft[] = [];
  for (const a of raw) {
    if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
    const callsign = (a.flight ?? "").trim();
    const alt = typeof a.alt_baro === "number" ? a.alt_baro : 0;
    out.push({
      hex: a.hex ?? "",
      callsign,
      lon: a.lon,
      lat: a.lat,
      alt,
      gs: typeof a.gs === "number" ? a.gs : 0,
      track: typeof a.track === "number" ? a.track : 0,
      category: classify(callsign, a.category, a.t),
    });
  }
  return out;
}

const cooldown = new Map<string, number>(); // source → until(ts)
function onCooldown(src: string) {
  const u = cooldown.get(src);
  return u !== undefined && Date.now() < u;
}

async function fromSource(base: string, host: string, lat: number, lon: number, nm: number): Promise<Aircraft[]> {
  if (onCooldown(host)) throw new Error(`${host} cooldown`);
  const r = await safeFetch(`${base}/v2/point/${lat}/${lon}/${nm}`, 7000);
  if (r.status === 429) {
    cooldown.set(host, Date.now() + 15 * 60_000); // 429 → 15분 쿨다운
    throw new Error(`${host} 429`);
  }
  if (!r.ok) throw new Error(`${host} ${r.status}`);
  const j = (await r.json()) as { ac?: Raw[]; aircraft?: Raw[] };
  return normalize(j.ac ?? j.aircraft ?? []);
}

async function fetchRegion(lat: number, lon: number, nm: number): Promise<Aircraft[]> {
  // adsb.lol → airplanes.live 폴백
  for (const [base, host] of [
    ["https://api.adsb.lol", "api.adsb.lol"],
    ["https://api.airplanes.live", "api.airplanes.live"],
  ] as const) {
    try {
      return await fromSource(base, host, lat, lon, nm);
    } catch {
      /* 다음 소스 */
    }
  }
  return [];
}

// --- single-flight + 캐시 (10초) ---
let cache: { data: Aircraft[]; source: string; ts: number } | null = null;
let inFlight: Promise<{ data: Aircraft[]; source: string }> | null = null;
const CACHE_MS = 10_000;

export async function fetchAircraft(): Promise<{ data: Aircraft[]; source: string }> {
  if (cache && Date.now() - cache.ts < CACHE_MS) return { data: cache.data, source: cache.source };
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const settled = await Promise.allSettled(REGIONS.map(([la, lo, nm]) => fetchRegion(la, lo, nm)));
    const merged = new Map<string, Aircraft>();
    for (const s of settled) {
      if (s.status === "fulfilled") for (const ac of s.value) if (ac.hex) merged.set(ac.hex, ac);
    }
    const data = [...merged.values()];
    const source = data.length ? "adsb.lol/airplanes.live" : "unavailable";
    cache = { data, source, ts: Date.now() };
    return { data, source };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
