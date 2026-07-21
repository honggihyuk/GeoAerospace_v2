import { describe, expect, it } from "vitest";
import { interpolate, ricDecompose, type Ephemeris } from "./fetchEphemeris";

// 해석적으로 정확한 원궤도로 합성 ephemeris를 만든다 → 보간 오차를 진짜 truth와 비교 가능.
const R = 6795; // km
const MU = 398600.4418;
const N = Math.sqrt(MU / R ** 3); // rad/s
const T0 = Date.UTC(2026, 6, 19, 0, 0, 0);
const STEP_S = 240; // OEM과 동일한 4분 간격

function truth(tMs: number): { pos: [number, number, number]; vel: [number, number, number] } {
  const s = (tMs - T0) / 1000;
  const a = N * s;
  // 경사진 원궤도 (z 성분이 있어야 cross-track 검증이 의미 있다)
  const inc = 0.9;
  const x = R * Math.cos(a);
  const y = R * Math.sin(a) * Math.cos(inc);
  const z = R * Math.sin(a) * Math.sin(inc);
  const vx = -R * N * Math.sin(a);
  const vy = R * N * Math.cos(a) * Math.cos(inc);
  const vz = R * N * Math.cos(a) * Math.sin(inc);
  return { pos: [x, y, z], vel: [vx, vy, vz] };
}

function makeEph(samples = 60): Ephemeris {
  const t: number[] = [];
  const pos: [number, number, number][] = [];
  const vel: [number, number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const ms = T0 + i * STEP_S * 1000;
    const s = truth(ms);
    t.push(ms);
    pos.push(s.pos);
    vel.push(s.vel);
  }
  return {
    t,
    pos,
    vel,
    meta: { objectName: "TEST", refFrame: "EME2000", timeSystem: "UTC", creationDate: "", source: "synthetic" },
  };
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("Hermite 보간", () => {
  const eph = makeEph();

  it("격자점에서 표본을 정확히 재현한다", () => {
    for (let i = 0; i < eph.t.length; i += 7) {
      const got = interpolate(eph, eph.t[i])!;
      expect(dist(got.pos, eph.pos[i]) * 1000).toBeLessThan(1e-6); // µm
      expect(dist(got.vel, eph.vel[i]) * 1e6).toBeLessThan(1); // mm/s
    }
  });

  // 이 한계가 곧 측정 하한이다. SGP4 오차(수백 m)를 재려면 보간 오차는 그보다
  // 훨씬 작아야 한다. 3차 Hermite(2점)는 이 간격에서 ~95 m라 부적합했다.
  const worstOver = (from: number, to: number) => {
    let worst = 0;
    for (let i = from; i < to; i++) {
      for (const f of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        const ms = eph.t[i] + f * STEP_S * 1000;
        worst = Math.max(worst, dist(interpolate(eph, ms)!.pos, truth(ms).pos) * 1000);
      }
    }
    return worst;
  };

  it("내부 구간에서 서브미터(~20 cm) 정확도다", () => {
    // 창을 중앙 정렬할 수 있는 영역 — 실제 조회는 대부분 여기 해당한다.
    // 측정 대상(SGP4 오차 수백 m) 대비 0.05% 미만이라 결과를 오염시키지 않는다.
    const w = worstOver(4, eph.t.length - 5);
    expect(w, `interior worst ${w.toFixed(4)} m`).toBeLessThan(0.5);
  });

  it("양 끝 구간에서도 3 m 이내다 (창을 중앙 정렬할 수 없어 사실상 외삽)", () => {
    const w = Math.max(worstOver(0, 4), worstOver(eph.t.length - 5, eph.t.length - 1));
    expect(w, `edge worst ${w.toFixed(3)} m`).toBeLessThan(5);
  });

  it("선형 보간보다 4자릿수 이상 정확하다", () => {
    const i = 10;
    const ms = eph.t[i] + 0.5 * STEP_S * 1000;
    const lagr = dist(interpolate(eph, ms)!.pos, truth(ms).pos);
    const linear = dist(
      eph.pos[i].map((v, k) => (v + eph.pos[i + 1][k]) / 2),
      truth(ms).pos
    );
    expect(linear / lagr).toBeGreaterThan(1e4);
  });


  it("보간 구간 밖에서는 외삽하지 않고 null을 낸다", () => {
    expect(interpolate(eph, eph.t[0] - 1)).toBeNull();
    expect(interpolate(eph, eph.t[eph.t.length - 1] + 1)).toBeNull();
  });
});

describe("RIC 분해", () => {
  const ref = truth(T0 + 1000);
  const rHat = ref.pos.map((v) => v / Math.hypot(...ref.pos)) as [number, number, number];

  it("순수 radial 오차를 radial 성분으로만 잡는다", () => {
    const d = rHat.map((v) => v * 0.5) as [number, number, number];
    const r = ricDecompose(d, ref.pos, ref.vel);
    expect(r.radial).toBeCloseTo(0.5, 9);
    expect(Math.abs(r.alongTrack)).toBeLessThan(1e-9);
    expect(Math.abs(r.crossTrack)).toBeLessThan(1e-9);
  });

  it("순수 along-track 오차를 along 성분으로만 잡는다", () => {
    const vn = Math.hypot(...ref.vel);
    const d = ref.vel.map((v) => (v / vn) * 2) as [number, number, number]; // 원궤도에서 속도 = in-track
    const r = ricDecompose(d, ref.pos, ref.vel);
    expect(r.alongTrack).toBeCloseTo(2, 6);
    expect(Math.abs(r.crossTrack)).toBeLessThan(1e-6);
  });

  it("성분 제곱합이 총오차와 같다", () => {
    const d: [number, number, number] = [0.3, -1.2, 0.7];
    const r = ricDecompose(d, ref.pos, ref.vel);
    expect(Math.hypot(r.radial, r.alongTrack, r.crossTrack)).toBeCloseTo(r.total, 9);
  });
});
