// 클라이언트: /api/tle 에서 실시간 TLE 로드, 실패 시 데모 세트 폴백.
import { useEffect } from "react";
import { useStore } from "./store";
import { SATELLITES, type SatDef } from "./tle";

/**
 * TLE 로딩 훅 — 뷰(2D/3D)와 무관하게 한 번만 마운트되어야 한다.
 * 갱신 주기는 고도화 §A1 권고(활성 LEO 1~2h)에 맞춰 90분.
 */
const REFRESH_MS = 90 * 60 * 1000;

export function useLiveTles() {
  useEffect(() => {
    let alive = true;
    const apply = async () => {
      const { sats, source } = await loadLiveTles();
      if (alive) useStore.getState().setSats(sats, source);
    };
    apply();
    const id = setInterval(apply, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
}

/**
 * 정밀 ephemeris 로드 (고도화 A3) — 있으면 SGP4 대신 쓴다.
 * 창(±8h)이 끝나기 전에 갱신해야 하므로 4시간마다 다시 받는다.
 */
export function usePreciseEphemeris(norad = 25544) {
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/ephemeris?norad=${norad}&hours=8`)
        .then((r) => r.json())
        .then((j) => {
          if (!alive) return;
          useStore.getState().setPrecise(j?.available ? j : null);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 4 * 60 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [norad]);
}

/** SatNOGS 지상국 로드 (고도화 B4). 뷰와 무관하게 한 번만. */
export function useGroundStations() {
  useEffect(() => {
    let alive = true;
    fetch("/api/stations")
      .then((r) => r.json())
      .then((j) => {
        if (alive && Array.isArray(j?.stations)) useStore.getState().setStations(j.stations);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
}

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
