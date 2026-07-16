// 클라이언트: /api/tle 에서 실시간 TLE 로드, 실패 시 데모 세트 폴백.
import { SATELLITES, type SatDef } from "./tle";

export async function loadLiveTles(): Promise<{ sats: SatDef[]; source: string }> {
  try {
    const ids = SATELLITES.map((s) => s.noradId).join(",");
    const r = await fetch(`/api/tle?ids=${ids}`, { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { sats?: SatDef[]; source?: string };
    if (!j.sats || j.sats.length === 0) throw new Error("empty");
    return { sats: j.sats, source: j.source ?? "celestrak" };
  } catch {
    return { sats: SATELLITES, source: "demo" };
  }
}
