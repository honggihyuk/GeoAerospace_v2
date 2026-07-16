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

async function fetchOne(id: number): Promise<SatDef | null> {
  const cached = cache.get(id);
  if (cached && Date.now() - cached.ts < TTL_MS) return toDef(id, cached);

  // CelesTrak / SatNOGS 병렬 레이스 — 먼저 성공하는 소스가 승리 (§4.8-B 회복탄력).
  // (CelesTrak 차단 네트워크에서도 SatNOGS가 즉시 응답 → 데모 지연 제거)
  try {
    const got = await Promise.any([fromCelestrak(id), fromSatnogs(id)]);
    cache.set(id, { ...got, ts: Date.now() });
    return toDef(id, got);
  } catch {
    /* 두 소스 모두 실패 */
  }
  if (cached) return toDef(id, cached); // 스테일 캐시
  const demo = SATELLITES.find((s) => s.noradId === id); // 최후: 데모 TLE로라도 표시
  return demo ?? null;
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
