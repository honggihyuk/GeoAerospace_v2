import { create } from "zustand";
import { SATELLITES, type SatDef } from "./tle";

type Layers = {
  orbits: boolean;
  groundTracks: boolean;
  satellites: boolean;
  aircraft: boolean;
  terrain: boolean;
};

type AppState = {
  selectedNorad: number | null;
  layers: Layers;
  sats: SatDef[]; // 로드된 TLE (기본: 데모 세트, 마운트 후 실시간 교체)
  tleSource: string; // 'celestrak' | 'satnogs' | 'demo'
  aircraftCount: number;
  aircraftSource: string;
  select: (norad: number | null) => void;
  toggleLayer: (k: keyof Layers) => void;
  setSats: (sats: SatDef[], source: string) => void;
  setAircraftMeta: (count: number, source: string) => void;
};

export const useStore = create<AppState>((set) => ({
  selectedNorad: 25544, // ISS 기본 추적
  layers: { orbits: true, groundTracks: true, satellites: true, aircraft: true, terrain: true },
  sats: SATELLITES,
  tleSource: "demo",
  aircraftCount: 0,
  aircraftSource: "—",
  select: (norad) => set({ selectedNorad: norad }),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setSats: (sats, source) => set({ sats, tleSource: source }),
  setAircraftMeta: (count, source) => set({ aircraftCount: count, aircraftSource: source }),
}));
