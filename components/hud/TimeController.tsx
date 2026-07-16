"use client";

import { useEffect, useState } from "react";
import { simClock } from "@/lib/simClock";

const SPEEDS = [1, 60, 3600];

function fmtOffset(ms: number): string {
  const a = Math.abs(ms);
  if (a < 2000) return "실시간";
  const sign = ms < 0 ? "−" : "+";
  const h = Math.floor(a / 3600000);
  const m = Math.floor((a % 3600000) / 60000);
  if (h > 24) return `${sign}${(h / 24).toFixed(1)}일`;
  return `${sign}${h}시간 ${m}분`;
}
function simUtc(): string {
  const d = simClock.nowDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export default function TimeController() {
  const [rate, setRate] = useState(1);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, []);

  const offset = simClock.offsetMs();
  const live = Math.abs(offset) < 2000 && rate === 1 && !paused;

  return (
    <div className="glass" style={S.wrap}>
      <button style={S.btn} onClick={() => { simClock.seek(-3600000); setTick((t) => t + 1); }} aria-label="1시간 뒤로" title="−1시간">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" /></svg>
      </button>
      <button
        style={{ ...S.btn, ...S.play }}
        onClick={() => { const p = !paused; simClock.setPaused(p); setPaused(p); }}
        aria-label={paused ? "재생" : "일시정지"}
      >
        {paused ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
        )}
      </button>
      <button style={S.btn} onClick={() => { simClock.seek(3600000); setTick((t) => t + 1); }} aria-label="1시간 앞으로" title="+1시간">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" /></svg>
      </button>

      <button
        style={S.spd}
        onClick={() => { const next = SPEEDS[(SPEEDS.indexOf(rate) + 1) % SPEEDS.length]; simClock.setRate(next); setRate(next); }}
        title="배속"
      >
        {rate}×
      </button>

      <div style={S.readout}>
        <span className="mono" style={{ color: "var(--cyan)" }}>{simUtc()} UTC</span>
        <span className="mono" style={{ color: live ? "var(--ok)" : "var(--amber)", fontSize: 10 }}>
          {live ? "● LIVE" : fmtOffset(offset)}
        </span>
      </div>

      {!live && (
        <button style={S.now} onClick={() => { simClock.reset(); setRate(1); setPaused(false); setTick((t) => t + 1); }} title="현재로">
          NOW
        </button>
      )}
      <span style={{ display: "none" }}>{tick}</span>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { position: "absolute", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 20, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px" },
  btn: { width: 28, height: 28, borderRadius: 7, border: "1px solid var(--grid)", background: "rgba(10,17,32,0.7)", color: "var(--txt)", display: "grid", placeItems: "center", cursor: "pointer" },
  play: { background: "var(--cyan)", borderColor: "var(--cyan)", color: "#04121a" },
  spd: { fontFamily: "var(--mono)", fontSize: 11, color: "var(--cyan)", border: "1px solid var(--cyan-dim)", borderRadius: 6, padding: "5px 9px", background: "none", cursor: "pointer", minWidth: 44 },
  readout: { display: "flex", flexDirection: "column", lineHeight: 1.25, marginLeft: 4, minWidth: 92 },
  now: { fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.08em", color: "var(--amber)", border: "1px solid rgba(255,183,77,0.4)", borderRadius: 6, padding: "5px 8px", background: "rgba(255,183,77,0.08)", cursor: "pointer" },
};
