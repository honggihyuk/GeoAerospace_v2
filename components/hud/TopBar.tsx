"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { runAgent } from "@/lib/agent";

function utcClock() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export default function TopBar() {
  const [clock, setClock] = useState("--:--:-- UTC");
  const [cmd, setCmd] = useState("");
  const busy = useStore((s) => s.agentBusy);
  const tleSource = useStore((s) => s.tleSource);
  const tleState = tleSource === "loading" ? "loading" : tleSource === "demo" ? "demo" : "live";
  const tleColor = tleState === "live" ? "var(--ok)" : tleState === "loading" ? "var(--cyan)" : "var(--warn)";
  const tleText = tleState === "live" ? `LIVE · ${tleSource}` : tleState === "loading" ? "LOADING…" : "DEMO";
  useEffect(() => {
    setClock(utcClock());
    const id = setInterval(() => setClock(utcClock()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={S.bar}>
      <div style={S.brand}>
        <span style={S.mark} />
        <b style={S.wordmark}>
          GEO<span style={{ color: "var(--cyan)" }}>AEROSPACE</span>
        </b>
      </div>

      <label style={S.cmd}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" strokeWidth="2">
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4-4" />
        </svg>
        <input
          style={S.input}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && cmd.trim() && !busy) {
              runAgent(cmd.trim());
              setCmd("");
            }
          }}
          placeholder="위성·항공·궤도를 자연어로 명령…  예) ISS를 추적해줘"
        />
        <kbd style={S.kbd}>⌘K</kbd>
      </label>

      <div style={S.status}>
        <span style={S.chip}>
          <span style={S.dot} />
          <span style={{ letterSpacing: "0.08em" }}>LIVE</span>
        </span>
        <span style={S.chip}>
          <span style={{ color: "var(--faint)" }}>TLE</span>
          <span className="mono" style={{ color: tleColor }}>
            {tleText}
          </span>
        </span>
        <span className="mono" style={S.clock}>
          {clock}
        </span>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 58,
    zIndex: 30,
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "0 18px",
    background: "linear-gradient(180deg, rgba(5,7,15,0.9), rgba(5,7,15,0))",
    pointerEvents: "none",
  },
  brand: { display: "flex", alignItems: "center", gap: 10, pointerEvents: "auto" },
  mark: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "radial-gradient(circle at 35% 30%, #1a3a5c, #0a1a2e)",
    boxShadow: "0 0 12px rgba(92,225,255,0.5)",
    border: "1px solid rgba(92,225,255,0.6)",
  },
  wordmark: { fontSize: 15, letterSpacing: "0.16em", fontWeight: 700 },
  cmd: {
    flex: 1,
    maxWidth: 560,
    display: "flex",
    alignItems: "center",
    gap: 10,
    height: 36,
    padding: "0 14px",
    borderRadius: 9,
    background: "rgba(10,17,32,0.7)",
    border: "1px solid var(--grid)",
    color: "var(--muted)",
    pointerEvents: "auto",
  },
  input: { flex: 1, background: "none", border: 0, outline: "none", color: "var(--txt)", fontSize: 13, fontFamily: "var(--sans)" },
  kbd: { fontFamily: "var(--mono)", fontSize: 10, color: "var(--faint)", border: "1px solid var(--grid)", borderRadius: 4, padding: "1px 5px" },
  status: { display: "flex", alignItems: "center", gap: 16, marginLeft: "auto", pointerEvents: "auto" },
  chip: { display: "flex", alignItems: "center", gap: 7, fontSize: 11 },
  dot: { width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", boxShadow: "0 0 8px var(--ok)" },
  clock: { fontSize: 13, color: "var(--cyan)", letterSpacing: "0.04em" },
};
