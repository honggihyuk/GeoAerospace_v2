// 서버 정확도 검증 (설계서 §9) — 표준 SGP4 골든값 대조.
// 참조: Vallado, Crawford, Hujsak & Kelso, "Revisiting Spacetrack Report #3",
//       AIAA 2006-6753, sgp4-ver 검증 세트 (satellite 00005, t=0, TEME 프레임).
import { describe, it, expect } from "vitest";
import * as satellite from "satellite.js";
import { computeOrbit } from "./orbit";
import type { SatDef } from "./tle";

// sgp4-ver 표준 검증 TLE (catalog 00005)
const L1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
const L2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";

// 공표된 TEME 상태벡터 @ tsince = 0.0 min (km, km/s)
const GOLD_R = { x: 7022.46529266, y: -1400.08296755, z: 0.03995155 };
const GOLD_V = { x: 1.893841015, y: 6.405893759, z: 4.534807250 };

describe("SGP4 정확도 (Vallado sgp4-ver 골든 벡터)", () => {
  it("catalog 00005 @ t=0 이 공표 TEME 상태벡터와 오차 이내로 일치", () => {
    const satrec = satellite.twoline2satrec(L1, L2);
    const out = satellite.sgp4(satrec, 0);
    expect(out.position).toBeTruthy();
    expect(out.velocity).toBeTruthy();
    const r = out.position as { x: number; y: number; z: number };
    const v = out.velocity as { x: number; y: number; z: number };

    // 위치 오차 < 10 m, 속도 오차 < 1 mm/s (satellite.js는 참조 구현에 매우 근접)
    expect(Math.abs(r.x - GOLD_R.x)).toBeLessThan(0.01);
    expect(Math.abs(r.y - GOLD_R.y)).toBeLessThan(0.01);
    expect(Math.abs(r.z - GOLD_R.z)).toBeLessThan(0.01);
    expect(Math.abs(v.x - GOLD_V.x)).toBeLessThan(0.001);
    expect(Math.abs(v.y - GOLD_V.y)).toBeLessThan(0.001);
    expect(Math.abs(v.z - GOLD_V.z)).toBeLessThan(0.001);
  });
});

describe("궤도 파이프라인 불변식 (ISS)", () => {
  const iss: SatDef = {
    noradId: 25544,
    name: "ISS (ZARYA)",
    tle1: "1 25544U 98067A   24187.45789227  .00016717  00000+0  30074-3 0  9993",
    tle2: "2 25544  51.6416 121.2333 0009035  99.8340 260.3893 15.50022067    05",
    color: [255, 183, 77],
    kind: "tracked",
  };

  it("한 주기 궤도 링/지상궤적을 생성하고 물리적으로 타당하다", () => {
    const o = computeOrbit(iss, new Date("2024-07-05T12:00:00Z"), 180);
    expect(o).not.toBeNull();
    if (!o) return;

    // 주기: ISS ≈ 92.9 min
    expect(o.periodMin).toBeGreaterThan(85);
    expect(o.periodMin).toBeLessThan(100);

    // 경사각: 51.6°
    const incl = (o.satrec.inclo * 180) / Math.PI;
    expect(incl).toBeGreaterThan(51.0);
    expect(incl).toBeLessThan(52.0);

    // 궤도 링: 충분히 샘플, 고도는 LEO 범위(m)
    expect(o.ring.length).toBeGreaterThan(100);
    for (const [lon, lat, alt] of o.ring) {
      expect(lon).toBeGreaterThanOrEqual(-180.001);
      expect(lon).toBeLessThanOrEqual(180.001);
      expect(lat).toBeGreaterThanOrEqual(-90.001);
      expect(lat).toBeLessThanOrEqual(90.001);
      expect(alt).toBeGreaterThan(150_000); // > 150 km
      expect(alt).toBeLessThan(600_000); // < 600 km
    }

    // 지상궤적: 자오선 분할된 세그먼트 존재
    expect(o.track.length).toBeGreaterThanOrEqual(1);
  });
});
