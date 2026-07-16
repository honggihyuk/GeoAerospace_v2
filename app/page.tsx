"use client";

import dynamic from "next/dynamic";
import TopBar from "@/components/hud/TopBar";
import TrackCard from "@/components/hud/TrackCard";
import LayerRail from "@/components/hud/LayerRail";

const MapCanvas = dynamic(() => import("@/components/MapCanvas"), {
  ssr: false,
  loading: () => (
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
      INITIALIZING ORBITAL COMMAND…
    </div>
  ),
});

export default function Page() {
  return (
    <main style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <MapCanvas />
      <TopBar />
      <LayerRail />
      <TrackCard />
    </main>
  );
}
