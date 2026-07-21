import { describe, expect, it } from "vitest";
import * as satellite from "satellite.js";
import {
  centralAngleDeg,
  findNextPass,
  footprintCentralAngleDeg,
  footprintRadiusKm,
  lookAngles,
  R_EARTH_KM,
  visibleStations,
  type Station,
} from "./passes";
import { SATELLITES } from "./tle";

const ISS = SATELLITES.find((s) => s.noradId === 25544)!;
const satrec = satellite.twoline2satrec(ISS.tle1, ISS.tle2);
// 데모 TLE의 epoch 부근으로 잡아야 SGP4가 물리적으로 타당한 값을 낸다.
const EPOCH = new Date(Date.UTC(2024, 6, 5, 11, 0, 0));

describe("풋프린트 기하", () => {
  it("ISS 고도(428 km)에서 지심각 ≈ 20.44° (지표 반경 ~2273 km)", () => {
    expect(footprintCentralAngleDeg(428)).toBeCloseTo(20.4382, 3);
    expect(footprintRadiusKm(428)).toBeCloseTo(2272.6, 0);
  });

  it("최소앙각이 오르면 풋프린트가 줄어든다", () => {
    const a = footprintCentralAngleDeg(428, 0);
    const b = footprintCentralAngleDeg(428, 10);
    const c = footprintCentralAngleDeg(428, 30);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("고도가 오르면 풋프린트가 커진다", () => {
    expect(footprintCentralAngleDeg(1000)).toBeGreaterThan(footprintCentralAngleDeg(400));
    // 정지궤도에서는 지구의 약 81°(반각)를 본다
    expect(footprintCentralAngleDeg(35786)).toBeCloseTo(81.3, 0);
  });

  it("고도 0이면 풋프린트도 0", () => {
    expect(footprintCentralAngleDeg(0)).toBe(0);
  });

  it("앙각이 90°에 가까우면 보이는 영역이 사라진다", () => {
    expect(footprintCentralAngleDeg(428, 90)).toBe(0);
  });

  it("지표 반경이 지심각과 일관된다", () => {
    const deg = footprintCentralAngleDeg(428);
    expect(footprintRadiusKm(428)).toBeCloseTo((deg * Math.PI * R_EARTH_KM) / 180, 6);
  });
});

describe("대원 중심각", () => {
  it("같은 점은 0", () => {
    expect(centralAngleDeg({ lat: 37.5, lon: 127 }, { lat: 37.5, lon: 127 })).toBeCloseTo(0, 9);
  });
  it("극과 적도는 90°", () => {
    expect(centralAngleDeg({ lat: 90, lon: 0 }, { lat: 0, lon: 0 })).toBeCloseTo(90, 6);
  });
  it("대척점은 180°", () => {
    expect(centralAngleDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(180, 6);
  });
});

describe("가시성 판정", () => {
  it("위성 바로 아래(서브위성점)에서는 앙각이 90°에 가깝다", () => {
    const pv = satellite.propagate(satrec, EPOCH);
    const gmst = satellite.gstime(EPOCH);
    const gd = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
    const sub = {
      lat: satellite.degreesLat(gd.latitude),
      lon: satellite.degreesLong(gd.longitude),
    };
    const la = lookAngles(satrec, sub, EPOCH)!;
    expect(la.elevationDeg).toBeGreaterThan(89);
    // 거리는 대략 고도와 같아야 한다
    expect(la.rangeKm).toBeCloseTo(gd.height, 0);
  });

  it("대척점에서는 보이지 않는다 (앙각 음수)", () => {
    const pv = satellite.propagate(satrec, EPOCH);
    const gmst = satellite.gstime(EPOCH);
    const gd = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
    const anti = {
      lat: -satellite.degreesLat(gd.latitude),
      lon: satellite.degreesLong(gd.longitude) + 180,
    };
    expect(lookAngles(satrec, anti, EPOCH)!.elevationDeg).toBeLessThan(0);
  });

  it("풋프린트 경계 밖의 지상국은 가시 목록에서 빠진다", () => {
    const pv = satellite.propagate(satrec, EPOCH);
    const gmst = satellite.gstime(EPOCH);
    const gd = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
    const subLat = satellite.degreesLat(gd.latitude);
    const subLon = satellite.degreesLong(gd.longitude);
    const λ = footprintCentralAngleDeg(gd.height);

    const stations: Station[] = [
      { id: 1, name: "inside", lat: subLat, lon: subLon, altKm: 0, minHorizonDeg: 0 },
      { id: 2, name: "outside", lat: -subLat, lon: subLon + 180, altKm: 0, minHorizonDeg: 0 },
    ];
    const vis = visibleStations(satrec, stations, EPOCH);
    expect(vis.map((v) => v.name)).toEqual(["inside"]);
    expect(λ).toBeGreaterThan(0);
  });

  it("지상국별 min_horizon을 존중한다", () => {
    const pv = satellite.propagate(satrec, EPOCH);
    const gmst = satellite.gstime(EPOCH);
    const gd = satellite.eciToGeodetic(pv.position as satellite.EciVec3<number>, gmst);
    const sub = { lat: satellite.degreesLat(gd.latitude), lon: satellite.degreesLong(gd.longitude) };
    // 서브위성점이라 앙각 ~90°: min_horizon 89°는 통과, 91°는 탈락해야 한다
    const mk = (minHorizonDeg: number): Station => ({ id: 1, name: "s", ...sub, altKm: 0, minHorizonDeg });
    expect(visibleStations(satrec, [mk(89)], EPOCH)).toHaveLength(1);
    expect(visibleStations(satrec, [mk(91)], EPOCH)).toHaveLength(0);
  });
});

describe("통과 예측", () => {
  // ISS 경사각 51.6° → 서울(37.5°N)에서는 하루 여러 번 통과한다.
  const SEOUL = { lat: 37.5665, lon: 126.978, altKm: 0.038 };

  it("24시간 안에 통과를 찾는다", () => {
    const p = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: 10 });
    expect(p).not.toBeNull();
  });

  it("AOS < peak < LOS 순서와 지속시간이 일관된다", () => {
    const p = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: 10 })!;
    expect(p.start).toBeLessThan(p.peak);
    expect(p.peak).toBeLessThan(p.end);
    expect(p.durationSec).toBeCloseTo((p.end - p.start) / 1000, 3);
    // LEO 통과는 통상 2~15분
    expect(p.durationSec).toBeGreaterThan(60);
    expect(p.durationSec).toBeLessThan(15 * 60);
  });

  it("AOS/LOS 경계에서 앙각이 임계값과 일치한다", () => {
    const minEl = 10;
    const p = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: minEl })!;
    expect(lookAngles(satrec, SEOUL, new Date(p.start))!.elevationDeg).toBeCloseTo(minEl, 1);
    expect(lookAngles(satrec, SEOUL, new Date(p.end))!.elevationDeg).toBeCloseTo(minEl, 1);
  });

  it("최대 앙각이 임계값 이상이고 통과 중 실제 최댓값이다", () => {
    const p = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: 10 })!;
    expect(p.peakElevationDeg).toBeGreaterThanOrEqual(10);
    for (let i = 0; i <= 40; i++) {
      const t = new Date(p.start + ((p.end - p.start) * i) / 40);
      expect(lookAngles(satrec, SEOUL, t)!.elevationDeg).toBeLessThanOrEqual(p.peakElevationDeg + 1e-6);
    }
  });

  it("임계 앙각을 올리면 통과가 더 늦거나 없어진다", () => {
    const lo = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: 5 })!;
    const hi = findNextPass(satrec, SEOUL, EPOCH, { minElevationDeg: 60 });
    if (hi) expect(hi.start).toBeGreaterThanOrEqual(lo.start);
  });

  it("위성이 절대 도달하지 못하는 위도에서는 null", () => {
    // ISS 경사각 51.6° → 북극(90°N)에서는 통과가 없다
    const p = findNextPass(satrec, { lat: 89.9, lon: 0 }, EPOCH, { minElevationDeg: 10, searchHours: 24 });
    expect(p).toBeNull();
  });
});
