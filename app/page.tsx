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
  useLiveTles(); // 뷰 전환과 무관하게 유지 — MapCanvas에 있으면 3D 전환 시 취소된다
  useGroundStations();
  usePreciseEphemeris(); // A3: 정밀 ephemeris 우선 사용
  useGk2aOnSelect(); // GK2A 선택 시 관측 격자 자동 로드
  useGk2aPlayback(); // K2: 2분 간격 시계열 재생
  return (
    <main style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {view === "globe" ? <MapCanvas /> : <SpaceView />}
      <TopBar />
      <ViewSwitcher />
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
