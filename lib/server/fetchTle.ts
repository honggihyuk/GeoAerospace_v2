// get_tle 도구 (설계서 §7.5) — CelesTrak GP API 1차 + SatNOGS 폴백 + 4h 캐시 + 회복탄력.
import { safeFetch, validNoradId } from "./safeFetch";
import { SATELLITES, type SatDef } from "@/lib/tle";

const TTL_MS = 4 * 60 * 60 * 1000; // 4시간 (설계서 §4.8-B)

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
  const r = await safeFetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=tle`);
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

async function fetchOne(id: number): Promise<SatDef | null> {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.ts < TTL_MS) {
    const m = meta(id);
    return { noradId: id, name: cached.name || m.name, tle1: cached.tle1, tle2: cached.tle2, color: m.color, kind: m.kind };
  }
  // CelesTrak → SatNOGS 폴백
  for (const src of [fromCelestrak, fromSatnogs]) {
    try {
      const got = await src(id);
      cache.set(id, { ...got, ts: Date.now() });
      const m = meta(id);
      return { noradId: id, name: got.name || m.name, tle1: got.tle1, tle2: got.tle2, color: m.color, kind: m.kind };
    } catch {
      /* 다음 소스 시도 */
    }
  }
  // 스테일 캐시 유지 (있으면)
  if (cached) {
    const m = meta(id);
    return { noradId: id, name: cached.name || m.name, tle1: cached.tle1, tle2: cached.tle2, color: m.color, kind: m.kind };
  }
  return null;
}

/** 여러 위성 TLE를 회복탄력적으로 수집 (Promise.allSettled). */
export async function fetchTleByIds(ids: number[]): Promise<{ sats: SatDef[]; source: string }> {
  const valid = ids.filter((n) => validNoradId(n));
  const settled = await Promise.allSettled(valid.map((id) => fetchOne(id)));
  const sats = settled
    .filter((s): s is PromiseFulfilledResult<SatDef | null> => s.status === "fulfilled")
    .map((s) => s.value)
    .filter((v): v is SatDef => v !== null);
  const anyLive = sats.length > 0;
  // 대표 소스 태깅
  const src = valid.length && cache.get(valid[0])?.source ? cache.get(valid[0])!.source : anyLive ? "celestrak" : "unavailable";
  return { sats, source: src };
}
