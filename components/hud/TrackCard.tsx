"use client";

import { useEffect, useMemo, useState } from "react";
import { computeOrbit, telemetry } from "@/lib/orbit";
import { useStore } from "@/lib/store";

export default function TrackCard() {
  const selectedNorad = useStore((s) => s.selectedNorad);
  const sats = useStore((s) => s.sats);
  const def = useMemo(() => sats.find((s) => s.noradId === selectedNorad) ?? null, [sats, selectedNorad]);
  const orbit = useMemo(() => (def ? computeOrbit(def) : null), [def]);

  const [tel, setTel] = useState<ReturnType<typeof telemetry> | null>(null);
  useEffect(() => {
    if (!orbit) {
      setTel(null);
      return;
    }
    const tick = () => setTel(telemetry(orbit));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [orbit]);

  if (!def || !tel) return null;
  const amber = def.kind === "tracked";

  return (
    <div className="glass" style={S.card}>
      <span style={{ ...S.brk, top: 7, left: 7, borderRight: 0, borderBottom: 0 }} />
      <span style={{ ...S.brk, top: 7, right: 7, borderLeft: 0, borderBottom: 0 }} />
      <span style={{ ...S.brk, bottom: 7, left: 7, borderRight: 0, borderTop: 0 }} />
      <span style={{ ...S.brk, bottom: 7, right: 7, borderLeft: 0, borderTop: 0 }} />

      <div style={S.hd}>
        <b style={{ fontSize: 15, color: amber ? "var(--amber)" : "var(--txt)" }}>{def.name}</b>
      </div>
      <div className="mono" style={S.sub}>
        NORAD {def.noradId} · {def.kind.toUpperCase()}
      </div>

      <div style={S.grid}>
        <Cell l="고도 ALT" v={String(tel.altKm)} u="km" />
        <Cell l="속도 VEL" v={tel.velocity} u="km/s" ok />
        <Cell l="경사각" v={tel.inclDeg} u="°" />
        <Cell l="주기" v={tel.periodMin} u="min" />
      </div>
      <div style={S.hint}>▸ 지도의 위성을 클릭하면 추적 대상 전환</div>
    </div>
  );
}

function Cell({ l, v, u, ok }: { l: string; v: string; u: string; ok?: boolean }) {
  return (
    <div>
      <div style={S.l}>{l}</div>
      <div className="mono" style={{ ...S.v, color: ok ? "var(--ok)" : "var(--txt)" }}>
        {v}
        <s style={S.u}>{u}</s>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  card: { position: "absolute", left: 16, bottom: 20, zIndex: 20, width: 236, padding: "14px 15px", overflow: "hidden" },
  brk: { position: "absolute", width: 12, height: 12, border: "1px solid var(--amber)", opacity: 0.7 },
  hd: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 },
  sub: { fontSize: 10.5, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.05em" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 12px" },
  l: { fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" },
  v: { fontSize: 16, marginTop: 1 },
  u: { fontSize: 10, color: "var(--muted)", textDecoration: "none", marginLeft: 2 },
  hint: { marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--grid)", fontSize: 10.5, color: "var(--faint)" },
};
