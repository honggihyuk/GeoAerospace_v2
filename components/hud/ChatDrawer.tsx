"use client";

import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { runAgent } from "@/lib/agent";

export default function ChatDrawer() {
  const [open, setOpen] = useState(true);
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.agentBusy);
  const [val, setVal] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [chat, busy]);

  const send = () => {
    const t = val.trim();
    if (!t || busy) return;
    setVal("");
    runAgent(t);
  };

  if (!open) {
    return (
      <button className="glass" style={S.launcher} onClick={() => setOpen(true)} aria-label="GeoAgent 열기">
        <span style={S.ai}>G</span>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>GeoAgent</span>
      </button>
    );
  }

  return (
    <div className="glass" style={S.drawer}>
      <div style={S.head}>
        <span style={S.ai}>G</span>
        <b style={{ fontSize: 13 }}>GeoAgent</b>
        <span style={S.st}>
          Qwen3-8B · 로컬 <b style={{ color: "var(--ok)" }}>●</b>
        </span>
        <button style={S.close} onClick={() => setOpen(false)} aria-label="닫기">
          ✕
        </button>
      </div>

      <div ref={threadRef} style={S.thread}>
        {chat.length === 0 && (
          <div style={S.hint}>
            <div style={{ color: "var(--muted)", marginBottom: 8 }}>자연어로 지도를 제어하세요.</div>
            {["서울로 이동해줘", "ISS를 추적해줘", "항공기 레이어를 꺼줘", "도쿄 상공을 보여줘"].map((ex) => (
              <button key={ex} style={S.chipBtn} onClick={() => runAgent(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {chat.map((m, i) =>
          m.role === "user" ? (
            <div key={i} style={S.msgU}>
              {m.content}
            </div>
          ) : (
            <div key={i} style={S.msgA}>
              <div style={S.who}>GeoAgent</div>
              {m.tools && m.tools.length > 0 && (
                <div style={S.plan}>
                  {m.tools.map((t, k) => (
                    <div key={k} style={S.step}>
                      <span style={{ color: "var(--ok)" }}>✓</span> {t}
                    </div>
                  ))}
                </div>
              )}
              <p style={S.p}>{m.content}</p>
            </div>
          )
        )}
        {busy && (
          <div style={S.msgA}>
            <div style={S.who}>GeoAgent</div>
            <div style={S.step}>
              <span className="spinner-dot" style={S.dot} /> 추론 중…
            </div>
          </div>
        )}
      </div>

      <div style={S.box}>
        <input
          style={S.input}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="명령… 예) 파리로 이동"
          disabled={busy}
        />
        <button style={{ ...S.send, opacity: busy ? 0.5 : 1 }} onClick={send} aria-label="전송">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  drawer: { position: "absolute", right: 16, top: 74, bottom: 20, zIndex: 25, width: 340, display: "flex", flexDirection: "column", overflow: "hidden" },
  launcher: { position: "absolute", right: 16, bottom: 20, zIndex: 25, display: "flex", alignItems: "center", gap: 9, padding: "10px 14px", cursor: "pointer", color: "var(--txt)" },
  head: { display: "flex", alignItems: "center", gap: 10, padding: "13px 15px", borderBottom: "1px solid var(--grid)" },
  ai: { width: 22, height: 22, borderRadius: 6, background: "linear-gradient(135deg, var(--cyan), #2b6f9c)", display: "grid", placeItems: "center", color: "#04121a", fontWeight: 800, fontSize: 12, boxShadow: "0 0 14px rgba(92,225,255,0.4)", flexShrink: 0 },
  st: { marginLeft: "auto", fontSize: 9.5, letterSpacing: "0.08em", color: "var(--faint)", textTransform: "uppercase" },
  close: { background: "none", border: 0, color: "var(--faint)", cursor: "pointer", fontSize: 13, marginLeft: 6 },
  thread: { flex: 1, overflowY: "auto", padding: 15, display: "flex", flexDirection: "column", gap: 13 },
  hint: { display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" },
  chipBtn: { background: "rgba(92,225,255,0.08)", border: "1px solid var(--cyan-dim)", color: "var(--cyan)", borderRadius: 8, padding: "6px 11px", fontSize: 12, cursor: "pointer", fontFamily: "var(--sans)" },
  msgU: { alignSelf: "flex-end", maxWidth: "88%", background: "rgba(92,225,255,0.1)", border: "1px solid rgba(92,225,255,0.2)", padding: "9px 12px", borderRadius: "12px 12px 3px 12px", fontSize: 12.5 },
  msgA: { maxWidth: "92%" },
  who: { fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--cyan)", marginBottom: 5, fontWeight: 600 },
  plan: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 7 },
  step: { display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--muted)" },
  dot: { width: 7, height: 7, borderRadius: "50%", background: "var(--cyan)", boxShadow: "0 0 8px var(--cyan)" },
  p: { fontSize: 12.5, color: "#d6e2f5", margin: 0, lineHeight: 1.55 },
  box: { margin: "0 12px 12px", display: "flex", alignItems: "center", gap: 9, height: 40, padding: "0 6px 0 13px", borderRadius: 10, background: "rgba(10,17,32,0.75)", border: "1px solid var(--grid)" },
  input: { flex: 1, background: "none", border: 0, outline: "none", color: "var(--txt)", fontSize: 12.5, fontFamily: "var(--sans)" },
  send: { width: 28, height: 28, borderRadius: 7, background: "var(--cyan)", border: 0, display: "grid", placeItems: "center", color: "#04121a", cursor: "pointer", flexShrink: 0 },
};
