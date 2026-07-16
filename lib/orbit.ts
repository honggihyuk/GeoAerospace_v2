// 궤도 계산 파이프라인 (설계서 §7.4)
// TLE → SGP4(satellite.js) → ECI → GMST 회전 → 측지 좌표
// 산출: 궤도 링(고도 유지 [lon,lat,alt]) + 지상궤적(±180° 분할) + 현재 위치
import * as satellite from "satellite.js";
import type { SatDef } from "./tle";

export type LonLatAlt = [number, number, number];

export type OrbitData = {
  def: SatDef;
  satrec: satellite.SatRec;
  ring: LonLatAlt[]; // 한 주기 궤도 링 (고도 m)
  track: [number, number][][]; // 지상궤적 (자오선 분할된 세그먼트)
  periodMin: number;
};

function eciToLonLatAlt(satrec: satellite.SatRec, date: Date): LonLatAlt | null {
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === "boolean") return null;
  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(pv.position, gmst);
  const lon = satellite.degreesLong(geo.longitude);
  const lat = satellite.degreesLat(geo.latitude);
  const alt = geo.height * 1000; // km → m
  if (Number.isNaN(lon) || Number.isNaN(lat)) return null;
  return [lon, lat, alt];
}

/** 한 주기 궤도를 샘플링해 링/지상궤적을 만든다. */
export function computeOrbit(def: SatDef, now = new Date(), steps = 180): OrbitData | null {
  const satrec = satellite.twoline2satrec(def.tle1, def.tle2);
  // satrec.no = 평균 운동(rad/min) → 주기(min)
  const periodMin = (2 * Math.PI) / satrec.no;
  const ring: LonLatAlt[] = [];
  const track: [number, number][][] = [];
  let seg: [number, number][] = [];
  let prevLon: number | null = null;

  for (let i = 0; i <= steps; i++) {
    const t = new Date(now.getTime() + (i / steps) * periodMin * 60_000);
    const p = eciToLonLatAlt(satrec, t);
    if (!p) continue;
    const [lon, lat, alt] = p;
    ring.push([lon, lat, alt]);
    // 지상궤적: 자오선(±180°) 교차 시 세그먼트 분할
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) {
      if (seg.length > 1) track.push(seg);
      seg = [];
    }
    seg.push([lon, lat]);
    prevLon = lon;
  }
  if (seg.length > 1) track.push(seg);
  if (ring.length < 8) return null;

  return { def, satrec, ring, track, periodMin };
}

/** 현재 순간의 위성 위치 [lon,lat,alt(m)]. 클라이언트 매 프레임 전파용. */
export function currentPosition(satrec: satellite.SatRec, date = new Date()): LonLatAlt | null {
  return eciToLonLatAlt(satrec, date);
}

/** 텔레메트리 요약 (HUD 카드용). */
export function telemetry(o: OrbitData, date = new Date()) {
  const pv = satellite.propagate(o.satrec, date);
  let velocity = 0;
  let altKm = 0;
  if (pv && pv.position && typeof pv.position !== "boolean" && pv.velocity && typeof pv.velocity !== "boolean") {
    const v = pv.velocity;
    velocity = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z); // km/s
    const gmst = satellite.gstime(date);
    altKm = satellite.eciToGeodetic(pv.position, gmst).height;
  }
  const inclDeg = (o.satrec.inclo * 180) / Math.PI;
  return {
    altKm: Math.round(altKm),
    velocity: velocity.toFixed(2),
    inclDeg: inclDeg.toFixed(1),
    periodMin: o.periodMin.toFixed(1),
  };
}
