// 가시성·풋프린트·통과 예측 (고도화 §B4).
//
// 전부 순수 함수로 두고 테스트한다. 여기 수학이 틀리면 "지금 이 지상국이 위성을 본다"는
// 화면 표시가 조용히 거짓이 되는데, 눈으로는 판별할 수 없다.
import * as satellite from "satellite.js";

export const R_EARTH_KM = 6371.0088; // 평균 반경

export type GeoPoint = { lat: number; lon: number; altKm?: number };

/**
 * 커버리지 풋프린트의 지심각(중심각, deg).
 * 최소앙각 ε에서 위성이 보이는 지표 원의 각반경:
 *   λ = acos( (Re / (Re+h)) · cos ε ) − ε
 * ε=0이면 기하학적 지평선(ISS 428 km → 약 20.4°).
 */
export function footprintCentralAngleDeg(altKm: number, minElevationDeg = 0): number {
  if (altKm <= 0) return 0;
  const eps = (minElevationDeg * Math.PI) / 180;
  const ratio = (R_EARTH_KM / (R_EARTH_KM + altKm)) * Math.cos(eps);
  if (ratio >= 1) return 0; // 앙각이 너무 높아 보이는 영역이 없음
  return ((Math.acos(ratio) - eps) * 180) / Math.PI;
}

/** 풋프린트 지표 반경(km) — 지심각을 대원 거리로 환산. */
export function footprintRadiusKm(altKm: number, minElevationDeg = 0): number {
  return (footprintCentralAngleDeg(altKm, minElevationDeg) * Math.PI * R_EARTH_KM) / 180;
}

/** 두 지점 사이 대원 중심각(deg). */
export function centralAngleDeg(a: GeoPoint, b: GeoPoint): number {
  const d = Math.PI / 180;
  const la1 = a.lat * d, la2 = b.lat * d;
  const dla = (b.lat - a.lat) * d, dlo = (b.lon - a.lon) * d;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180) / Math.PI;
}

export type LookAngles = { azimuthDeg: number; elevationDeg: number; rangeKm: number };

/** 지상 관측점에서 본 위성의 방위/앙각/거리. */
export function lookAngles(satrec: satellite.SatRec, observer: GeoPoint, date: Date): LookAngles | null {
  const pv = satellite.propagate(satrec, date);
  if (!pv?.position || typeof pv.position === "boolean") return null;
  const gmst = satellite.gstime(date);
  const ecf = satellite.eciToEcf(pv.position, gmst);
  const obs = {
    longitude: (observer.lon * Math.PI) / 180,
    latitude: (observer.lat * Math.PI) / 180,
    height: observer.altKm ?? 0,
  };
  const la = satellite.ecfToLookAngles(obs, ecf);
  return {
    azimuthDeg: (la.azimuth * 180) / Math.PI,
    elevationDeg: (la.elevation * 180) / Math.PI,
    rangeKm: la.rangeSat,
  };
}

export type Pass = {
  /** 가시 시작(AOS) */
  start: number;
  /** 가시 종료(LOS) */
  end: number;
  /** 최대 앙각 시각 */
  peak: number;
  peakElevationDeg: number;
  durationSec: number;
};

/**
 * 다음 통과를 찾는다. 조밀 탐색으로 앙각이 임계값을 상향 교차하는 지점을 찾고,
 * 이분법으로 경계를 다듬는다.
 *
 * 스텝 크기 주의: LEO 통과는 5~10분이라 스텝이 크면 통째로 놓친다.
 * 기본 30 s면 최단 통과도 여러 표본이 잡힌다.
 */
export function findNextPass(
  satrec: satellite.SatRec,
  observer: GeoPoint,
  from: Date,
  opts: { minElevationDeg?: number; searchHours?: number; stepSec?: number } = {}
): Pass | null {
  const minEl = opts.minElevationDeg ?? 0;
  const horizonSec = (opts.searchHours ?? 24) * 3600;
  const step = opts.stepSec ?? 30;
  const t0 = from.getTime();

  const elAt = (sec: number): number => {
    const la = lookAngles(satrec, observer, new Date(t0 + sec * 1000));
    return la ? la.elevationDeg : -90;
  };

  // 상향 교차 지점 탐색
  let prev = elAt(0);
  let aosSec: number | null = null;
  let s = step;
  for (; s <= horizonSec; s += step) {
    const cur = elAt(s);
    if (prev < minEl && cur >= minEl) {
      aosSec = s;
      break;
    }
    prev = cur;
  }
  if (aosSec === null) return null;

  // 이분법으로 AOS 경계 정밀화
  const refine = (lo: number, hi: number, rising: boolean): number => {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const above = elAt(mid) >= minEl;
      if (above === rising) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const aos = refine(aosSec - step, aosSec, true);

  // 하향 교차(LOS) 탐색
  let losSec = aos;
  for (let t = aos + step; t <= aos + 3 * 3600; t += step) {
    if (elAt(t) < minEl) {
      losSec = refine(t - step, t, false);
      break;
    }
    losSec = t;
  }

  // 최대 앙각 — 황금분할 대신 단순 조밀 탐색(구간이 짧아 충분)
  let peakSec = aos;
  let peakEl = -90;
  const n = 60;
  for (let i = 0; i <= n; i++) {
    const t = aos + ((losSec - aos) * i) / n;
    const e = elAt(t);
    if (e > peakEl) {
      peakEl = e;
      peakSec = t;
    }
  }

  return {
    start: t0 + aos * 1000,
    end: t0 + losSec * 1000,
    peak: t0 + peakSec * 1000,
    peakElevationDeg: peakEl,
    durationSec: losSec - aos,
  };
}

export type Station = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  altKm: number;
  /** 지상국이 스스로 신고한 최소 앙각(deg). */
  minHorizonDeg: number;
};

export type StationVisibility = Station & { elevationDeg: number; azimuthDeg: number; rangeKm: number };

/**
 * 지금 이 위성을 볼 수 있는 지상국 목록.
 * 지상국마다 min_horizon(장애물·안테나 제약)이 달라서 일괄 0°로 판정하면 안 된다.
 */
export function visibleStations(
  satrec: satellite.SatRec,
  stations: readonly Station[],
  date: Date
): StationVisibility[] {
  const out: StationVisibility[] = [];
  for (const st of stations) {
    const la = lookAngles(satrec, { lat: st.lat, lon: st.lon, altKm: st.altKm }, date);
    if (!la) continue;
    if (la.elevationDeg >= st.minHorizonDeg) {
      out.push({ ...st, elevationDeg: la.elevationDeg, azimuthDeg: la.azimuthDeg, rangeKm: la.rangeKm });
    }
  }
  return out.sort((a, b) => b.elevationDeg - a.elevationDeg);
}
