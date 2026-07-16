"use client";

import dynamic from "next/dynamic";
import { useStore } from "@/lib/store";
import TopBar from "@/components/hud/TopBar";
import TrackCard from "@/components/hud/TrackCard";
import LayerRail from "@/components/hud/LayerRail";
import ChatDrawer from "@/components/hud/ChatDrawer";
import ViewSwitcher from "@/components/hud/ViewSwitcher";
import TimeController from "@/components/hud/TimeController";

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
  return (
    <main style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {view === "globe" ? <MapCanvas /> : <SpaceView />}
      <TopBar />
      <ViewSwitcher />
      <LayerRail />
      <TrackCard />
      <TimeController />
      <ChatDrawer />
    </main>
  );
}
