"use client";

import dynamic from "next/dynamic";
import { useStore } from "@/lib/store";
import { useGroundStations, useLiveTles, usePreciseEphemeris } from "@/lib/tleClient";
import { useGk2aOnSelect, useGk2aPlayback } from "@/lib/gk2aClient";
import TopBar from "@/components/hud/TopBar";
import TrackCard from "@/components/hud/TrackCard";
import LayerRail from "@/components/hud/LayerRail";
import ChatDrawer from "@/components/hud/ChatDrawer";
import ViewSwitcher from "@/components/hud/ViewSwitcher";
import TimeController from "@/components/hud/TimeController";
import CubeLayerPanel from "@/components/hud/CubeLayerPanel";

const LEFT_COL: React.CSSProperties = {
  position: "absolute",
  left: 16,
  top: 74,
  bottom: 20,
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 10,
  // 열 자체는 클릭을 막지 않는다 — 빈 공간으로 지도를 조작할 수 있어야 한다
  pointerEvents: "none",
};

const SKETCHFAB_URL = "https://sketchfab.com/models/af0cf9d222d2430f90727bc3cede33a8/embed";

function GeoscanOverlay() {
  return (
    <div
      className="glass"
      style={{
        position: "absolute",
        right: 16,
        top: 74,
        zIndex: 30,
        width: "min(42vw, 560px)",
        minWidth: 320,
        maxWidth: 560,
        borderRadius: 18,
        overflow: "hidden",
        boxShadow: "0 16px 48px rgba(0,0,0,0.38)",
        border: "1px solid rgba(92,225,255,0.18)",
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px 10px" }}>
        <div>
          <div style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Geoscan 16U</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.12em", color: "var(--muted)" }}>SKETCHFAB EMBED</div>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--cyan)" }}>EXACT MODEL</div>
      </div>
      <div style={{ position: "relative", paddingTop: "100%", background: "#090d16" }}>
        <iframe
          title="Geoscan 16U"
          frameBorder="0"
          allow="autoplay; fullscreen; xr-spatial-tracking; web-share"
          allowFullScreen
          loading="lazy"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          src={SKETCHFAB_URL}
        />
      </div>
      <div style={{ padding: "10px 14px 14px", fontFamily: "var(--sans)", fontSize: 11, lineHeight: 1.45, color: "var(--muted)" }}>
        대한민국 상공 16U 큐브샛을 Sketchfab의 실제 외형으로 표시합니다. 3D 씬은 유지되고, 이 패널만 정확한 모델을 제공합니다.
      </div>
    </div>
  );
}

const boot = (label: string) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      display: "grid",
      placeItems: "center",
      background: "var(--space)",
      color: "var(--faint)",
      fontFamily: "var(--mono)",
      letterSpacing: "0.2em",
      fontSize: 12,
    }}
  >
    {label}
  </div>
);

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), { ssr: false, loading: () => boot("INITIALIZING ORBITAL COMMAND…") });
const SpaceView = dynamic(() => import("@/components/SpaceView"), { ssr: false, loading: () => boot("ENTERING ORBITAL SPACE…") });

export default function Page() {
  const view = useStore((s) => s.view);
  const geoscanOverlayOpen = useStore((s) => s.geoscanOverlayOpen);
  useLiveTles(); // 뷰 전환과 무관하게 유지 — MapCanvas에 있으면 3D 전환 시 취소된다
  useGroundStations();
  usePreciseEphemeris(); // A3: 정밀 ephemeris 우선 사용
  useGk2aOnSelect(); // GK2A 선택 시 관측 격자 자동 로드
  useGk2aPlayback(); // K2: 2분 간격 시계열 재생
  return (
    <main style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {view === "globe" ? <MapCanvas /> : <SpaceView />}
      {view === "space" && geoscanOverlayOpen ? <GeoscanOverlay /> : null}
      <TopBar />
      <ViewSwitcher />
      <CubeLayerPanel />
      {/* 좌측 열 — LayerRail(위)과 TrackCard(아래)가 세로 공간을 나눠 갖는다.
          각자 absolute로 두면 내용이 길어질 때 서로를 가린다. */}
      <div style={LEFT_COL}>
        <LayerRail />
        <div style={{ flex: 1, minHeight: 8 }} />
        <TrackCard />
      </div>
      <TimeController />
      <ChatDrawer />
    </main>
  );
}
