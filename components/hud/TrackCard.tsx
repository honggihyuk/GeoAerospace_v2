"use client";

import { useEffect, useMemo, useState } from "react";
import { computeOrbit, telemetry } from "@/lib/orbit";
import { useStore } from "@/lib/store";
import { simClock } from "@/lib/simClock";
import { centralAngleDeg, findNextPass, type Pass } from "@/lib/passes";

const SEOUL = { lat: 37.5665, lon: 126.978, altKm: 0.038 };

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
    const tick = () => setTel(telemetry(orbit, simClock.nowDate()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [orbit]);

  // 다음 통과 (고도화 B4). 관측 지점은 가장 가까운 온라인 지상국 — 없으면 서울.
  const stations = useStore((s) => s.stations);
  const visibleCount = useStore((s) => s.visibleCount);
  const [pass, setPass] = useState<{ site: string; p: Pass } | null>(null);
  useEffect(() => {
    if (!orbit) return;
    let alive = true;
    // 통과 탐색은 SGP4를 수천 번 돌리므로 렌더를 막지 않도록 다음 tick으로 미룬다.
    const id = setTimeout(() => {
      const site =
        stations.length > 0
          ? stations.reduce((a, b) =>
              centralAngleDeg({ lat: a.lat, lon: a.lon }, SEOUL) <= centralAngleDeg({ lat: b.lat, lon: b.lon }, SEOUL) ? a : b
            )
          : null;
      const obs = site ? { lat: site.lat, lon: site.lon, altKm: site.altKm } : SEOUL;
      const minEl = site ? site.minHorizonDeg : 10;
      const p = findNextPass(orbit.satrec, obs, simClock.nowDate(), { minElevationDeg: minEl, searchHours: 24 });
      if (alive) setPass(p ? { site: site ? site.name : "서울", p } : null);
    }, 0);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [orbit, stations]);

  // 기동 감지 (고도화 A3) — 기동이 있었다면 그 이전 예측은 무효다.
  const [man, setMan] = useState<ManeuverInfo | null>(null);
  useEffect(() => {
    if (!selectedNorad) return;
    let alive = true;
    setMan(null);
    fetch(`/api/maneuvers?norad=${selectedNorad}`)
      .then((r) => r.json())
      .then((j) => alive && setMan(j?.available ? j : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [selectedNorad]);

  // 위치 출처 — 정밀 ephemeris를 쓰는 중인지 (A3)
  const precise = useStore((s) => s.precise);
  const usingPrecise = !!precise && precise.norad === selectedNorad;

  // 실측 오차 (고도화 A2) — NASA 정밀 ephemeris 대조. 모델 추정이 아니라 실제 차이다.
  const [precision, setPrecision] = useState<Precision | null>(null);
  useEffect(() => {
    if (!selectedNorad) return;
    let alive = true;
    setPrecision(null);
    fetch(`/api/precision?norad=${selectedNorad}`)
      .then((r) => r.json())
      .then((j) => alive && setPrecision(j?.available ? j : null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [selectedNorad]);

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

      <div style={S.statusRow}>
        <span>
          <span style={S.sl}>TLE</span>{" "}
          <b className="mono" style={{ color: ageColor(tel.ageDays) }}>
            {tel.ageDays.toFixed(1)}d
          </b>
          {/* 실측값이 있으면 추정치 대신 그것을 쓴다 — 정직성(§A4) */}
          <span style={S.sub2}>
            {precision ? ` · ${fmtKm(precision.measuredErrorKm)}` : ` · ~±${tel.estErrKm.toFixed(0)}km`}
          </span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ ...S.dot, background: tel.illuminated ? "var(--amber)" : "var(--faint)", boxShadow: tel.illuminated ? "0 0 6px var(--amber)" : "none" }} />
          <b style={{ color: tel.illuminated ? "var(--amber)" : "var(--muted)", fontSize: 11 }}>{tel.illuminated ? "일조" : "식(그림자)"}</b>
        </span>
      </div>

      <div style={S.prec}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={S.sl}>가시 지상국</span>
          <b className="mono" style={{ fontSize: 12, color: visibleCount > 0 ? "var(--ok)" : "var(--muted)" }}>
            {visibleCount} / {stations.length || "…"}
          </b>
        </div>
        {pass && (
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
            다음 통과 {countdown(pass.p.start)} · 최대 {pass.p.peakElevationDeg.toFixed(0)}°
            <br />
            <span style={{ color: "var(--faint)" }}>
              {pass.site} · {Math.round(pass.p.durationSec / 60)}분
            </span>
          </div>
        )}
      </div>

      {man?.last && (
        <div style={S.prec}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={S.sl}>최근 기동</span>
            <b className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>
              {man.daysSinceLast != null ? `${man.daysSinceLast.toFixed(0)}일 전` : "—"}
            </b>
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
            궤도 +{man.last.deltaSemiMajorKm.toFixed(2)} km · {man.last.fromEpoch.slice(0, 10)}
            <br />
            <span style={{ color: "var(--faint)" }}>
              {man.spanDays.toFixed(0)}일 이력에서 {man.maneuvers.length}건 검출
            </span>
          </div>
        </div>
      )}

      {precision && (
        <div style={S.prec}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={S.sl}>{usingPrecise ? "위치 출처" : "실측 오차"}</span>
            <span className="mono" style={{ fontSize: 10, color: usingPrecise ? "var(--ok)" : "var(--faint)" }}>
              {usingPrecise ? precision.reference.source : `vs ${precision.reference.source}`}
            </span>
          </div>
          {usingPrecise && (
            <div className="mono" style={{ fontSize: 10.5, color: "var(--ok)", marginTop: 4 }}>
              정밀 ephemeris 사용 중 — SGP4 대비 {fmtKm(precision.measuredErrorKm)} 개선
            </div>
          )}
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4, lineHeight: 1.5 }}>
            along {fmtKm(Math.abs(precision.ric.alongTrack))} · radial {fmtKm(Math.abs(precision.ric.radial))}
            <br />
            증가율 {precision.growthKmPerDay.toFixed(2)} km/일
          </div>
        </div>
      )}

      <div style={S.hint}>▸ 지도의 위성을 클릭하면 추적 대상 전환</div>
    </div>
  );
}

type ManeuverInfo = {
  maneuvers: { deltaSemiMajorKm: number; fromEpoch: string }[];
  last: { deltaSemiMajorKm: number; fromEpoch: string } | null;
  daysSinceLast: number | null;
  spanDays: number;
};

type Precision = {
  measuredErrorKm: number;
  ric: { radial: number; alongTrack: number; crossTrack: number };
  growthKmPerDay: number;
  reference: { source: string; frame: string };
};

function ageColor(days: number): string {
  return days < 2 ? "var(--ok)" : days < 7 ? "var(--warn)" : "var(--crit)";
}

/** km 미만은 m로 — sub-km 정밀도를 뭉개지 않는다. */
function fmtKm(km: number): string {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

/** 통과 시각까지 남은 시간. 이미 통과 중이면 그렇게 표시. */
function countdown(atMs: number): string {
  const s = Math.round((atMs - simClock.now()) / 1000);
  if (s <= 0) return "진행 중";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}시간 ${m}분 후` : `${m}분 ${s % 60}초 후`;
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
  // 좌측 열 하단에 붙는다 (절대배치 아님 — LayerRail과 공간을 나눠 갖는다)
  card: {
    position: "relative",
    width: 236,
    padding: "14px 15px",
    pointerEvents: "auto",
    // 짧은 화면에서는 카드도 양보한다. flexShrink:0으로 두면 카드가 버티면서
    // LayerRail이 사용 불가능한 높이로 눌리고 카드 자신도 화면 밖으로 잘린다.
    flexShrink: 1,
    minHeight: 0,
    maxHeight: "62%",
    overflowY: "auto",
    overflowX: "hidden",
  },
  brk: { position: "absolute", width: 12, height: 12, border: "1px solid var(--amber)", opacity: 0.7 },
  hd: { display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 },
  sub: { fontSize: 10.5, color: "var(--muted)", marginBottom: 12, letterSpacing: "0.05em" },
  grid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 12px" },
  l: { fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" },
  v: { fontSize: 16, marginTop: 1 },
  u: { fontSize: 10, color: "var(--muted)", textDecoration: "none", marginLeft: 2 },
  hint: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--grid)", fontSize: 10.5, color: "var(--faint)" },
  prec: { marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--grid)" },
  statusRow: { marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--grid)", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11.5, color: "var(--muted)" },
  sl: { fontSize: 9.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)" },
  sub2: { fontSize: 10.5, color: "var(--faint)" },
  dot: { width: 7, height: 7, borderRadius: "50%", display: "inline-block" },
};
