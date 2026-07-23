import { create } from "zustand";
import { SATELLITES, type SatDef } from "./tle";
import type { Station } from "./passes";
import type { PreciseEphemeris } from "./precise";

type Layers = {
  orbits: boolean;
  groundTracks: boolean;
  satellites: boolean;
  aircraft: boolean;
  terrain: boolean;
  /** NASA FIRMS 활성 화재 + EONET 화산 (제안서 §4.7 / P5.5) */
  fires: boolean;
  /** ITS 국가교통정보센터 전국 도로 CCTV */
  cctv: boolean;
  /** 경찰청 도시교통정보센터(UTIC) 실시간 돌발(사고·공사·통제) */
  incident: boolean;
  /** 경찰청 신호개방 — 인천·대구 신호제어 교차로 */
  signal: boolean;
};

export type CctvPoint = { id: string; name: string; lon: number; lat: number; url: string | null; format: string | null };
type CctvState = { points: CctvPoint[]; source: string; sample: boolean; status: "idle" | "loading" | "ready" | "error" };

export type IncidentKind = "accident" | "construction" | "event" | "control" | "weather" | "other";
export type IncidentPoint = {
  id: string;
  kind: IncidentKind;
  typeCd: string;
  title: string;
  lon: number;
  lat: number;
  road: string;
  start: string;
  end: string;
  control: string;
  important: boolean;
};
type IncidentState = {
  points: IncidentPoint[];
  source: string;
  /** UTIC 키/서버 IP 미등록 등으로 데이터 못 받은 상태 표기용 */
  configured: boolean;
  reason: string | null;
  status: "idle" | "loading" | "ready" | "error";
};

export type SignalPoint = {
  id: string;
  region: string;
  regionLabel: string;
  intNo: string;
  name: string;
  lon: number;
  lat: number;
  updated: string;
};
type SignalState = {
  points: SignalPoint[];
  source: string;
  configured: boolean;
  reason: string | null;
  status: "idle" | "loading" | "ready" | "error";
};

/** FIRMS 탐지점 (클라 표시용) */
export type FirePoint = {
  lat: number;
  lon: number;
  frp: number;
  confidence: number;
  acqDate: string;
  acqTime: string;
  kind: "fire" | "volcano";
  title?: string;
};

export type FireState = {
  points: FirePoint[];
  source: string;
  total: number;
  sampled: boolean;
  maxFrp: number;
  /** 에이전트 filter_fires가 건 필터 — HUD에 무엇이 걸려있는지 보여준다 */
  filter: { minFrp?: number; dayRange?: number; region?: string } | null;
  /** 마지막 조회 영역 — VLM 해석이 같은 화면을 보도록 (제안서 §4.7 3계층) */
  bbox: string | null;
  status: "idle" | "loading" | "ready" | "error";
};

export type ChatMsg = { role: "user" | "assistant"; content: string; tools?: string[] };

export type ViewMode = "globe" | "space";

/** GIBS 실사 텍스처 상태 (고도화 B1). date = 실제로 입혀진 트루컬러 UTC 날짜. */
export type Imagery = { status: "loading" | "live" | "off"; date: string | null };

export type CubeSurface = "ortho" | "dem" | "sar";

type AppState = {
  view: ViewMode;
  setView: (v: ViewMode) => void;
  /** 한반도 큐브 관측(큐브샛 더블클릭). surface = 큐브 표면 데이터 소스. */
  cube: { active: boolean; surface: CubeSurface };
  setCubeActive: (a: boolean) => void;
  setCubeSurface: (s: CubeSurface) => void;
  geoscanOverlayOpen: boolean;
  setGeoscanOverlayOpen: (open: boolean) => void;
  selectedNorad: number | null;
  layers: Layers;
  sats: SatDef[]; // 로드된 TLE (기본: 데모 세트, 마운트 후 실시간 교체)
  tleSource: string; // 'celestrak' | 'satnogs' | 'demo' | 'loading'
  aircraftCount: number;
  aircraftSource: string;
  chat: ChatMsg[];
  agentBusy: boolean;
  imagery: Imagery;
  setImagery: (i: Imagery) => void;
  /** SatNOGS 온라인 지상국 (고도화 B4) */
  stations: Station[];
  setStations: (s: Station[]) => void;
  /** 현재 추적 위성을 보고 있는 지상국 수 — HUD 표시용 */
  visibleCount: number;
  setVisibleCount: (n: number) => void;
  /** 정밀 ephemeris (고도화 A3) — 있으면 SGP4 대신 이걸로 위치를 낸다 */
  precise: PreciseEphemeris | null;
  setPrecise: (p: PreciseEphemeris | null) => void;
  fires: FireState;
  setFires: (f: Partial<FireState>) => void;
  cctv: CctvState;
  setCctv: (c: Partial<CctvState>) => void;
  incident: IncidentState;
  setIncident: (i: Partial<IncidentState>) => void;
  signal: SignalState;
  setSignal: (s: Partial<SignalState>) => void;
  /** GIBS 맥락영상 오버레이 (제안서 §4.7). null이면 표시 안 함. */
  gibs: { layerId: string; date: string; opacity: number } | null;
  setGibs: (g: { layerId: string; date: string; opacity?: number } | null) => void;
  /** GK2A 격자 오버레이 (제안서_GK2A). synthetic이면 UI에 반드시 표기한다. */
  gk2a: {
    status: "idle" | "loading" | "ready" | "error";
    channel: string;
    waveType: string;
    unitType: string;
    dateTime: string;
    synthetic: boolean;
    bounds: { west: number; south: number; east: number; north: number } | null;
    grid: number[][] | null;
    meta: { gridKm: number; xdim: number; ydim: number; x0: number; y0: number } | null;
    /**
     * 2분 간격 시계열 (제안서_GK2A §K2). 정지궤도라 같은 지점을 계속 응시하므로
     * 극궤도로는 원리적으로 불가능한 "언제 시작해 어디로 번졌나"를 볼 수 있다.
     */
    series: { dateTime: string; grid: number[][] }[];
    frameIndex: number;
    playing: boolean;
    /** 시계열 수집 진행률 0~1 */
    seriesProgress: number;
    /** 관측 강조 0~1 — 오버레이 불투명도와 기반 억제를 함께 움직인다 */
    emphasis: number;
  };
  setGk2a: (g: Partial<AppState["gk2a"]>) => void;
  /** 위성 시점 모드 — 해당 위성 위치에서 지구를 바라본다. null이면 자유 시점. */
  povNorad: number | null;
  setPov: (n: number | null) => void;
  select: (norad: number | null) => void;
  toggleLayer: (k: keyof Layers) => void;
  setSats: (sats: SatDef[], source: string) => void;
  setAircraftMeta: (count: number, source: string) => void;
  pushChat: (m: ChatMsg) => void;
  setBusy: (b: boolean) => void;
};

export const useStore = create<AppState>((set) => ({
  view: "globe",
  setView: (v) => set({ view: v }),
  cube: { active: false, surface: "sar" },
  setCubeActive: (active) => set((s) => ({ cube: { ...s.cube, active } })),
  setCubeSurface: (surface) => set((s) => ({ cube: { ...s.cube, surface } })),
  geoscanOverlayOpen: true,
  setGeoscanOverlayOpen: (geoscanOverlayOpen) => set({ geoscanOverlayOpen }),
  selectedNorad: 25544, // ISS 기본 추적
  layers: { orbits: true, groundTracks: true, satellites: true, aircraft: true, terrain: true, fires: false, cctv: false, incident: false, signal: false },
  sats: SATELLITES,
  tleSource: "loading",
  aircraftCount: 0,
  aircraftSource: "—",
  chat: [],
  agentBusy: false,
  imagery: { status: "loading", date: null },
  setImagery: (i) => set({ imagery: i }),
  stations: [],
  setStations: (stations) => set({ stations }),
  visibleCount: 0,
  setVisibleCount: (visibleCount) => set({ visibleCount }),
  precise: null,
  setPrecise: (precise) => set({ precise }),
  fires: { points: [], source: "", total: 0, sampled: false, maxFrp: 0, filter: null, bbox: null, status: "idle" },
  setFires: (f) => set((s) => ({ fires: { ...s.fires, ...f } })),
  cctv: { points: [], source: "", sample: false, status: "idle" },
  setCctv: (c) => set((s) => ({ cctv: { ...s.cctv, ...c } })),
  incident: { points: [], source: "", configured: true, reason: null, status: "idle" },
  setIncident: (i) => set((s) => ({ incident: { ...s.incident, ...i } })),
  signal: { points: [], source: "", configured: true, reason: null, status: "idle" },
  setSignal: (sig) => set((s) => ({ signal: { ...s.signal, ...sig } })),
  gibs: null,
  setGibs: (g) => set({ gibs: g ? { opacity: 0.85, ...g } : null }),
  gk2a: {
    status: "idle",
    channel: "",
    waveType: "105",
    unitType: "BT",
    dateTime: "",
    synthetic: false,
    bounds: null,
    grid: null,
    meta: null,
    series: [],
    frameIndex: 0,
    playing: false,
    seriesProgress: 0,
    emphasis: 0.6,
  },
  setGk2a: (g) => set((s) => ({ gk2a: { ...s.gk2a, ...g } })),
  povNorad: null,
  setPov: (povNorad) => set({ povNorad }),
  select: (norad) => set({ selectedNorad: norad }),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setSats: (sats, source) => set({ sats, tleSource: source }),
  setAircraftMeta: (count, source) => set({ aircraftCount: count, aircraftSource: source }),
  pushChat: (m) => set((s) => ({ chat: [...s.chat, m] })),
  setBusy: (b) => set({ agentBusy: b }),
}));
