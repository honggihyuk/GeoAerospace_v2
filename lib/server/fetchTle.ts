// get_tle 도구 (설계서 §7.5) — Space-Track 1차(배치) + CelesTrak/SatNOGS 폴백 + 캐시 + 회복탄력.
//
// 소스 우선순위 (고도화 §A1):
//   1. Space-Track  — 18 SDS 권위 카탈로그. 전 객체 커버. 배치 1회로 전부 수집.
//   2. CelesTrak    — 공개 GP API. (일부 망에서 차단될 수 있음)
//   3. SatNOGS      — 아마추어 무선 위성 DB. 커버리지 제한적(Starlink·KOMPSAT 없음).
//   4. 스테일 캐시 → 데모 TLE (최후)
import { safeFetch, validNoradId } from "./safeFetch";
import { fetchLatestElsets, isConfigured as stConfigured } from "./spacetrack";
import { SATELLITES, type SatDef } from "@/lib/tle";

const TTL_MS = 2 * 60 * 60 * 1000; // 2시간 — 활성 LEO 신선도 위해 단축 (고도화 A1)

type CacheEntry = { tle1: string; tle2: string; name: string; source: string; ts: number };
const cache = new Map<number, CacheEntry>();

function meta(norad: number): { color: [number, number, number]; kind: SatDef["kind"]; name: string } {
  const s = SATELLITES.find((x) => x.noradId === norad);
  return s
    ? { color: s.color, kind: s.kind, name: s.name }
    : { color: [92, 225, 255], kind: "payload", name: `NORAD ${norad}` };
}

function parseCelestrakTle(text: string): { name: string; tle1: string; tle2: string } | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const i1 = lines.findIndex((l) => l.startsWith("1 "));
  if (i1 < 0 || !lines[i1 + 1]?.startsWith("2 ")) return null;
  const name = i1 > 0 ? lines[i1 - 1] : "UNKNOWN";
  return { name, tle1: lines[i1], tle2: lines[i1 + 1] };
}

async function fromCelestrak(id: number) {
  const r = await safeFetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=tle`, 6000);
  if (!r.ok) throw new Error(`celestrak ${r.status}`);
  const p = parseCelestrakTle(await r.text());
  if (!p) throw new Error("celestrak: no GP data");
  return { ...p, source: "celestrak" };
}

async function fromSatnogs(id: number) {
  const r = await safeFetch(`https://db.satnogs.org/api/tle/?format=json&norad_cat_id=${id}`);
  if (!r.ok) throw new Error(`satnogs ${r.status}`);
  const j = (await r.json()) as Array<{ tle0?: string; tle1: string; tle2: string }>;
  const t = Array.isArray(j) ? j[0] : null;
  if (!t?.tle1 || !t?.tle2) throw new Error("satnogs: empty");
  // 3LE tle0 는 선행 "0 " (라인번호)을 포함할 수 있음 → 제거
  const name = (t.tle0 ?? "").replace(/^0\s+/, "").trim() || meta(id).name;
  return { name, tle1: t.tle1, tle2: t.tle2, source: "satnogs" };
}

function toDef(id: number, e: { name: string; tle1: string; tle2: string }): SatDef {
  const m = meta(id);
  return { noradId: id, name: e.name || m.name, tle1: e.tle1, tle2: e.tle2, color: m.color, kind: m.kind };
}

/** 공개 소스 레이스 — 먼저 성공하는 쪽이 승리 (§4.8-B 회복탄력). */
async function fetchOnePublic(id: number): Promise<CacheEntry | null> {
  try {
    const got = await Promise.any([fromCelestrak(id), fromSatnogs(id)]);
    const entry = { ...got, ts: Date.now() };
    cache.set(id, entry);
    return entry;
  } catch {
    return null; // 두 공개 소스 모두 실패
  }
}

export type TleResult = {
  sats: SatDef[];
  /** 대표 소스 — 데모가 섞이면 정직하게 알린다. */
  source: string;
  /** 위성별 실제 출처 (배지·디버깅용). */
  bySource: Record<string, number>;
};

/** 여러 위성 TLE를 회복탄력적으로 수집. */
export async function fetchTleByIds(ids: number[]): Promise<TleResult> {
  const valid = ids.filter((n) => validNoradId(n));
  const resolved = new Map<number, CacheEntry>();

  // 0) 살아있는 캐시 먼저
  const missing: number[] = [];
  for (const id of valid) {
    const c = cache.get(id);
    if (c && Date.now() - c.ts < TTL_MS) resolved.set(id, c);
    else missing.push(id);
  }

  // 1) Space-Track 배치 — 한 번의 쿼리로 남은 전부를 시도
  if (missing.length && stConfigured()) {
    try {
      const elsets = await fetchLatestElsets(missing);
      for (const e of elsets) {
        if (!missing.includes(e.noradId)) continue;
        const entry: CacheEntry = { name: e.name, tle1: e.tle1, tle2: e.tle2, source: "spacetrack", ts: Date.now() };
        cache.set(e.noradId, entry);
        resolved.set(e.noradId, entry);
      }
    } catch (err) {
      console.warn("[tle] Space-Track 실패, 공개 소스로 폴백:", String(err));
    }
  }

  // 2) 남은 것만 공개 소스로 개별 수집
  const stillMissing = valid.filter((id) => !resolved.has(id));
  if (stillMissing.length) {
    const settled = await Promise.allSettled(stillMissing.map((id) => fetchOnePublic(id)));
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value) resolved.set(stillMissing[i], s.value);
    });
  }

  // 3) 스테일 캐시 → 데모 (최후)
  const sats: SatDef[] = [];
  const bySource: Record<string, number> = {};
  for (const id of valid) {
    let entry = resolved.get(id);
    let src: string;
    if (entry) {
      src = entry.source;
    } else if ((entry = cache.get(id))) {
      src = "stale"; // 만료됐지만 없는 것보다 낫다
    } else {
      const demo = SATELLITES.find((s) => s.noradId === id);
      if (!demo) continue;
      sats.push(demo);
      bySource.demo = (bySource.demo ?? 0) + 1;
      continue;
    }
    sats.push(toDef(id, entry));
    bySource[src] = (bySource[src] ?? 0) + 1;
  }

  // 대표 소스: 전부 한 소스면 그 이름, 섞이면 우세 소스 + 저하 표시.
  // (이전 구현은 첫 위성의 소스만 보고 태깅해, 절반이 데모여도 LIVE로 표시했다.)
  const names = Object.keys(bySource);
  const degraded = (bySource.demo ?? 0) + (bySource.stale ?? 0);
  let source: string;
  if (names.length === 0) source = "unavailable";
  else if (names.length === 1) source = names[0];
  else {
    const top = names.reduce((a, b) => (bySource[a] >= bySource[b] ? a : b));
    source = degraded > 0 ? `${top}+demo` : top;
  }

  return { sats, source, bySource };
}
