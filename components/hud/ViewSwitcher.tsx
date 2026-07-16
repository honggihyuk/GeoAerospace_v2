"use client";

import { useStore } from "@/lib/store";

export default function ViewSwitcher() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <div className="glass" style={S.wrap}>
      <button style={{ ...S.btn, ...(view === "globe" ? S.on : {}) }} onClick={() => setView("globe")}>
        2D 글로브
      </button>
      <button style={{ ...S.btn, ...(view === "space" ? S.on : {}) }} onClick={() => setView("space")}>
        3D 우주 뷰
      </button>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { position: "absolute", top: 68, left: "50%", transform: "translateX(-50%)", zIndex: 25, display: "flex", padding: 3, gap: 2 },
  btn: {
    fontFamily: "var(--sans)",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--muted)",
    background: "none",
    border: 0,
    padding: "6px 14px",
    borderRadius: 7,
    cursor: "pointer",
  },
  on: { background: "rgba(92,225,255,0.14)", color: "var(--cyan)" },
};
