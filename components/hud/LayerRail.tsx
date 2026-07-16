"use client";

import { useStore } from "@/lib/store";

type Key = "orbits" | "groundTracks" | "satellites" | "aircraft" | "terrain";

export default function LayerRail() {
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  const aircraftCount = useStore((s) => s.aircraftCount);
  const satCount = useStore((s) => s.sats.length);

  const items: { k: Key; label: string; hint: string }[] = [
    { k: "orbits", label: "궤도 링", hint: "SGP4" },
    { k: "groundTracks", label: "지상궤적", hint: "TRACK" },
    { k: "satellites", label: "위성", hint: String(satCount) },
    { k: "aircraft", label: "항공기", hint: aircraftCount ? aircraftCount.toLocaleString() : "…" },
    { k: "terrain", label: "3D 지형", hint: "DEM" },
  ];

  return (
    <div className="glass" style={S.rail}>
      <div style={S.head}>
        <span className="eyebrow">Layers</span>
      </div>
      {items.map((it) => {
        const on = layers[it.k];
        return (
          <div key={it.k} style={{ ...S.row, ...(on ? S.rowOn : {}) }} onClick={() => toggle(it.k)}>
            <span style={{ ...S.name, color: on ? "var(--txt)" : "var(--muted)" }}>{it.label}</span>
            <span className="mono" style={S.hint}>
              {it.hint}
            </span>
            <span style={{ ...S.sw, ...(on ? S.swOn : {}) }}>
              <span style={{ ...S.knob, ...(on ? S.knobOn : {}) }} />
            </span>
          </div>
        );
      })}
      <div style={S.legend}>
        <span style={S.lgi}>
          <i style={{ ...S.swz, background: "var(--cyan)" }} />
          페이로드
        </span>
        <span style={S.lgi}>
          <i style={{ ...S.swz, background: "var(--amber)" }} />
          추적(ISS)
        </span>
        <span style={S.lgi}>
          <i style={{ ...S.swz, background: "#d2e6ff" }} />
          항공기
        </span>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  rail: { position: "absolute", left: 16, top: 74, zIndex: 20, width: 180, padding: 12, display: "flex", flexDirection: "column", gap: 4 },
  head: { margin: "2px 4px 8px" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer" },
  rowOn: { background: "rgba(92,225,255,0.09)" },
  name: { flex: 1, fontSize: 12.5 },
  hint: { fontSize: 10, color: "var(--faint)" },
  sw: { width: 26, height: 15, borderRadius: 20, background: "var(--grid)", position: "relative", flexShrink: 0 },
  swOn: { background: "linear-gradient(90deg, var(--cyan-dim), var(--cyan))" },
  knob: { position: "absolute", width: 11, height: 11, borderRadius: "50%", background: "#0a1120", top: 2, left: 2, transition: "left .15s" },
  knobOn: { left: 13, background: "#04121a" },
  legend: { margin: "10px 4px 2px", display: "flex", flexWrap: "wrap", gap: "5px 12px" },
  lgi: { display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--muted)" },
  swz: { width: 8, height: 8, borderRadius: 2, display: "inline-block" },
};
