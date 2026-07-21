// SatNOGS Network 지상국 (고도화 §B4) — 실제 운영 중인 아마추어 지상국 네트워크.
//
// 왜 이 소스인가: 전 세계 4,000곳 이상이 등록돼 있고, 각 지상국이 스스로 신고한
// min_horizon(주변 장애물·안테나 제약에 따른 최소 앙각)을 제공한다. 가시성을 일괄 0°로
// 판정하면 실제로는 보이지 않는 지상국을 "본다"고 표시하게 된다.
import { safeFetch } from "./safeFetch";
import type { Station } from "@/lib/passes";

const URL = "https://network.satnogs.org/api/stations/?format=json";
const TTL_MS = 6 * 60 * 60 * 1000; // 지상국 목록은 자주 바뀌지 않는다

type Raw = {
  id: number;
  name: string;
  lat: number | null;
  lng: number | null;
  altitude: number | null; // m
  min_horizon: number | null; // deg
  status: string; // Online | Offline | Testing
  observations?: number;
};

export type StationSet = { stations: Station[]; total: number; online: number; fetchedAt: number };

let cache: { v: StationSet; ts: number } | null = null;

export async function fetchStations(): Promise<StationSet> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.v;

  const r = await safeFetch(URL, { timeoutMs: 30_000, accept: "application/json" });
  if (!r.ok) throw new Error(`satnogs network ${r.status}`);
  const raw = (await r.json()) as Raw[];
  if (!Array.isArray(raw)) throw new Error("satnogs network: 예상치 못한 형식");

  // 온라인만 — 오프라인 지상국을 "가시"라고 표시하면 실제와 다르다.
  const stations: Station[] = [];
  for (const s of raw) {
    if (s.status !== "Online") continue;
    if (typeof s.lat !== "number" || typeof s.lng !== "number") continue;
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    stations.push({
      id: s.id,
      name: s.name ?? `station ${s.id}`,
      lat: s.lat,
      lon: s.lng,
      altKm: (s.altitude ?? 0) / 1000,
      // 신고값이 없으면 보수적으로 10° (지평선 근처는 실제로 잘 안 보인다)
      minHorizonDeg: typeof s.min_horizon === "number" ? s.min_horizon : 10,
    });
  }

  const v: StationSet = { stations, total: raw.length, online: stations.length, fetchedAt: Date.now() };
  cache = { v, ts: Date.now() };
  return v;
}
