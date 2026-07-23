"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { GIBS_LAYERS } from "@/lib/gibs";
import { GK2A_NORAD, loadGk2a, loadGk2aSeries } from "@/lib/gk2aClient";

type Key = "orbits" | "groundTracks" | "satellites" | "aircraft" | "terrain" | "fires" | "cctv" | "incident" | "signal";

export default function LayerRail() {
  const layers = useStore((s) => s.layers);
  const toggle = useStore((s) => s.toggleLayer);
  const aircraftCount = useStore((s) => s.aircraftCount);
  const satCount = useStore((s) => s.sats.length);
  const fires = useStore((s) => s.fires);
  const cctv = useStore((s) => s.cctv);
  const incident = useStore((s) => s.incident);
  const signal = useStore((s) => s.signal);
  const gibs = useStore((s) => s.gibs);
  const gk2a = useStore((s) => s.gk2a);
  const selected = useStore((s) => s.selectedNorad);
  const pov = useStore((s) => s.povNorad);
  const setPov = useStore((s) => s.setPov);
  const setGk2a = useStore((s) => s.setGk2a);
  const setGibs = useStore((s) => s.setGibs);
  const [gibsDate, setGibsDate] = useState("");
  useEffect(() => {
    let alive = true;
    // 날짜는 서버가 프로브로 정한다 — "오늘"은 스와스 미수집으로 대부분 빈 영상(B1 실측)
    fetch("/api/gibs")
      .then((r) => r.json())
      .then((j) => alive && setGibsDate(j?.date ?? ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const fireHint =
    fires.status === "loading" ? "…" : fires.status === "error" ? "실패" : fires.total ? fires.total.toLocaleString() : "FIRMS";
  const cctvHint =
    cctv.status === "loading"
      ? "…"
      : cctv.status === "error"
        ? "실패"
        : cctv.status === "ready"
          ? `${cctv.points.length}${cctv.sample ? " 샘플" : ""}`
          : "ITS";
  const incHint =
    incident.status === "loading"
      ? "…"
      : incident.status === "error" || incident.configured === false
        ? "미등록"
        : incident.status === "ready"
          ? String(incident.points.length)
          : "UTIC";
  const sigHint =
    signal.status === "loading"
      ? "…"
      : signal.status === "error" || signal.configured === false
        ? "키필요"
        : signal.status === "ready"
          ? String(signal.points.length)
          : "인천·대구";

  const items: { k: Key; label: string; hint: string }[] = [
    { k: "orbits", label: "궤도 링", hint: "SGP4" },
    { k: "satellites", label: "위성", hint: String(satCount) },
    { k: "aircraft", label: "항공기", hint: aircraftCount ? aircraftCount.toLocaleString() : "…" },
    { k: "terrain", label: "3D 지형", hint: "DEM" },
    { k: "fires", label: "산불", hint: fireHint },
    { k: "cctv", label: "도로 CCTV", hint: cctvHint },
    { k: "incident", label: "돌발상황", hint: incHint },
    { k: "signal", label: "신호교차로", hint: sigHint },
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
      <div style={S.gibs}>
        <span className="eyebrow" style={{ fontSize: 9.5 }}>
          위성영상 (GIBS)
        </span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {[{ id: "off", label: "끔" }, ...GIBS_LAYERS.map((l) => ({ id: l.id, label: l.label.replace(/\s*\(.*\)/, "") }))].map((o) => {
            const active = o.id === "off" ? !gibs : gibs?.layerId === o.id;
            return (
              <span
                key={o.id}
                onClick={() => (o.id === "off" ? setGibs(null) : setGibs({ layerId: o.id, date: gibsDate }))}
                style={{ ...S.chip, ...(active ? S.chipOn : {}) }}
              >
                {o.label}
              </span>
            );
          })}
        </div>
        {gibs && (
          <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 5 }}>
            TIME={gibs.date}
          </div>
        )}
      </div>

      {(gk2a.status !== "idle" || selected === GK2A_NORAD) && (
        <div style={S.gibs}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="eyebrow" style={{ fontSize: 9.5 }}>
              천리안2A 관측
            </span>
            {gk2a.synthetic && (
              <span className="mono" style={{ fontSize: 9, color: "var(--warn)" }}>
                합성
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {[
              { wt: "105", u: "BT", label: "적외" },
              { wt: "063", u: "BT", label: "수증기" },
              { wt: "038", u: "BT", label: "단파(화재)" },
              { wt: "006", u: "A", label: "가시" },
            ].map((o) => (
              <span
                key={o.wt}
                onClick={() => loadGk2a(o.wt, o.u)}
                style={{ ...S.chip, ...(gk2a.waveType === o.wt ? S.chipOn : {}) }}
              >
                {o.label}
              </span>
            ))}
          </div>
          <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 5 }}>
            {gk2a.status === "loading"
              ? "불러오는 중…"
              : gk2a.status === "error"
                ? "조회 실패"
                : gk2a.dateTime
                  ? `${gk2a.channel} · ${fmtKst(gk2a.dateTime)} KST`
                  : ""}
          </div>
          {gk2a.status === "ready" && (
            <div style={{ marginTop: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9.5, color: "var(--faint)" }}>
                <span>관측 강조</span>
                <span className="mono">{Math.round(gk2a.emphasis * 100)}%</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(gk2a.emphasis * 100)}
                onChange={(e) => setGk2a({ emphasis: Number(e.target.value) / 100 })}
                style={{ width: "100%", accentColor: "var(--cyan)" }}
              />
            </div>
          )}

          {/* K2: 2분 간격 시계열 — 정지궤도만 가능한 관측 */}
          {gk2a.status === "ready" && gk2a.series.length === 0 && (
            <div
              onClick={() => loadGk2aSeries(gk2a.waveType, gk2a.unitType, 12, 2)}
              style={{ ...S.chip, marginTop: 7, display: "inline-block" }}
            >
              ▶ 2분 간격 시계열 (24분)
            </div>
          )}
          {gk2a.status === "loading" && gk2a.seriesProgress > 0 && (
            <div className="mono" style={{ fontSize: 9.5, color: "var(--cyan)", marginTop: 6 }}>
              시계열 수집 {Math.round(gk2a.seriesProgress * 100)}%
            </div>
          )}
          {gk2a.series.length > 1 && (
            <div style={{ marginTop: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  onClick={() => setGk2a({ playing: !gk2a.playing })}
                  style={{ ...S.chip, ...S.chipOn, minWidth: 26, textAlign: "center" }}
                >
                  {gk2a.playing ? "❚❚" : "▶"}
                </span>
                <input
                  type="range"
                  min={0}
                  max={gk2a.series.length - 1}
                  value={gk2a.frameIndex}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    const f = gk2a.series[i];
                    setGk2a({ frameIndex: i, playing: false, grid: f.grid, dateTime: f.dateTime });
                  }}
                  style={{ flex: 1, accentColor: "var(--cyan)" }}
                />
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: "var(--faint)", marginTop: 4 }}>
                {gk2a.frameIndex + 1}/{gk2a.series.length} 프레임 · 2분 간격
              </div>
            </div>
          )}
          {pov != null && (
            <div onClick={() => setPov(null)} style={{ ...S.chip, ...S.chipOn, marginTop: 7, display: "inline-block" }}>
              ← 자유 시점으로
            </div>
          )}
        </div>
      )}

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
        <span style={S.lgi}>
          <i style={{ ...S.swz, background: "#ff6b1e" }} />
          화재(FRP)
        </span>
      </div>
    </div>
  );
}

/** YYYYMMDDHHmm → MM/DD HH:mm */
function fmtKst(dt: string): string {
  if (dt.length < 12) return dt;
  return `${dt.slice(4, 6)}/${dt.slice(6, 8)} ${dt.slice(8, 10)}:${dt.slice(10, 12)}`;
}

const S: Record<string, React.CSSProperties> = {
  // 좌측 열(app/page.tsx의 flex 컨테이너) 안에 놓인다. 예전엔 절대배치라
  // TrackCard가 커지면 서로의 높이를 모른 채 겹쳤다.
  rail: {
    width: 180,
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    // 내용(레이어 + GIBS + 천리안2A + 시계열)이 길어지면 열 안에서 스크롤한다
    minHeight: 0,
    // 아주 짧은 화면에서도 최소한의 조작 영역은 남긴다
    flexBasis: "auto",
    overflowY: "auto",
    overflowX: "hidden",
    pointerEvents: "auto",
    flexShrink: 1,
  },
  head: { margin: "2px 4px 8px" },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, cursor: "pointer" },
  rowOn: { background: "rgba(92,225,255,0.09)" },
  name: { flex: 1, fontSize: 12.5 },
  hint: { fontSize: 10, color: "var(--faint)" },
  sw: { width: 26, height: 15, borderRadius: 20, background: "var(--grid)", position: "relative", flexShrink: 0 },
  swOn: { background: "linear-gradient(90deg, var(--cyan-dim), var(--cyan))" },
  knob: { position: "absolute", width: 11, height: 11, borderRadius: "50%", background: "#0a1120", top: 2, left: 2, transition: "left .15s" },
  knobOn: { left: 13, background: "#04121a" },
  gibs: { margin: "10px 4px 2px", paddingTop: 9, borderTop: "1px solid var(--grid)" },
  chip: { fontSize: 10, padding: "3px 7px", borderRadius: 5, borderWidth: 1, borderStyle: "solid", borderColor: "var(--grid)", color: "var(--muted)", cursor: "pointer" },
  chipOn: { borderColor: "var(--cyan-dim)", color: "var(--cyan)", background: "rgba(92,225,255,0.09)" },
  legend: { margin: "10px 4px 2px", display: "flex", flexWrap: "wrap", gap: "5px 12px" },
  lgi: { display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--muted)" },
  swz: { width: 8, height: 8, borderRadius: 2, display: "inline-block" },
};
