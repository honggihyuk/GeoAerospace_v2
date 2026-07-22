"use client";

// 우상단 큐브 표면 레이어 선택 — 큐브샛 관측 활성 시에만 표시.
// 정사영상(VWorld) / Copernicus DEM / SAR 를 구분해 전환한다.
import type { CSSProperties } from "react";
import { useStore, type CubeSurface } from "@/lib/store";

const OPTIONS: { key: CubeSurface; label: string; hint: string }[] = [
  { key: "ortho", label: "정사영상", hint: "VWorld 항공영상" },
  { key: "dem", label: "고도 음영", hint: "지형고도 30m (Terrarium)" },
  { key: "sar", label: "SAR", hint: "Sentinel-1 후방산란" },
];

export default function CubeLayerPanel() {
  const active = useStore((s) => s.cube.active);
  const surface = useStore((s) => s.cube.surface);
  const setSurface = useStore((s) => s.setCubeSurface);
  if (!active) return null;

  return (
    <div className="glass" style={PANEL}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.14em", color: "var(--faint)", marginBottom: 8 }}>큐브 표면 · 한반도 관측</div>
      {OPTIONS.map((o) => {
        const on = surface === o.key;
        return (
          <button key={o.key} onClick={() => setSurface(o.key)} style={{ ...ROW, ...(on ? ROW_ON : {}) }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, background: on ? "var(--amber)" : "var(--faint)", flex: "0 0 auto" }} />
            <span style={{ flex: 1, textAlign: "left" }}>
              <b style={{ fontSize: 12, color: on ? "var(--txt)" : "var(--muted)" }}>{o.label}</b>
              <div style={{ fontSize: 9.5, color: "var(--faint)" }}>{o.hint}</div>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ChatDrawer(right:16, width:340)를 피해 그 왼쪽에 배치 — 우상단이되 겹치지 않게.
const PANEL: CSSProperties = { position: "absolute", right: 372, top: 74, zIndex: 24, width: 176, padding: "11px 12px" };
const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  padding: "7px 8px",
  border: "1px solid transparent",
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
};
const ROW_ON: CSSProperties = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.14)" };
