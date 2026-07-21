import { describe, expect, it } from "vitest";
import history from "./__fixtures__/iss_gp_history.json";
import { detectManeuvers, type Elset } from "./maneuvers";

// 실제 Space-Track gp_history — ISS 70일치 272건.
// 이 기간에 재부스트 2회(2026-06-10, 2026-07-01)가 실제로 있었다.
const real = history as Elset[];

describe("실제 ISS 이력에서의 기동 감지", () => {
  const a = detectManeuvers(real);

  it("표본과 기간이 기대대로다", () => {
    expect(a.sampleCount).toBe(272);
    expect(a.spanDays).toBeGreaterThan(65);
  });

  it("항력 기준선이 음수다 (반장축은 서서히 감소해야 한다)", () => {
    expect(a.dragBaselineKmPerDay).toBeLessThan(0);
  });

  it("재부스트 2건을 찾는다", () => {
    expect(a.maneuvers).toHaveLength(2);
  });

  it("각 기동이 궤도를 1 km 이상 올리고 평균운동을 낮춘다", () => {
    for (const m of a.maneuvers) {
      expect(m.deltaSemiMajorKm).toBeGreaterThan(1);
      expect(m.deltaMeanMotion).toBeLessThan(0); // 상승 → 평균운동 감소
    }
  });

  it("검출 시점이 알려진 재부스트 날짜와 일치한다", () => {
    const days = a.maneuvers.map((m) => m.fromEpoch.slice(0, 10));
    expect(days).toEqual(["2026-06-10", "2026-07-01"]);
  });

  it("항력 잡음 대비 신뢰도가 압도적이다", () => {
    for (const m of a.maneuvers) expect(m.sigmaRatio).toBeGreaterThan(20);
  });
});

describe("경계 조건", () => {
  const base = (i: number, sma: number): Elset => ({
    epoch: new Date(Date.UTC(2026, 0, 1) + i * 6 * 3600_000).toISOString(),
    meanMotion: 15.5,
    semiMajorAxis: sma,
  });

  it("항력만 있는 이력에서는 기동을 만들어내지 않는다", () => {
    // 순수 감쇠 + 미세 잡음
    const els = Array.from({ length: 100 }, (_, i) => base(i, 6795 - i * 0.02 + Math.sin(i) * 0.005));
    expect(detectManeuvers(els).maneuvers).toHaveLength(0);
  });

  it("표본이 너무 적으면 빈 결과를 낸다", () => {
    expect(detectManeuvers([base(0, 6795), base(1, 6796)]).maneuvers).toHaveLength(0);
  });

  it("입력 순서가 뒤섞여도 결과가 같다", () => {
    const shuffled = [...real].reverse();
    const x = detectManeuvers(shuffled);
    expect(x.maneuvers.map((m) => m.fromEpoch)).toEqual(
      detectManeuvers(real).maneuvers.map((m) => m.fromEpoch)
    );
  });

  it("연속 상승 구간을 하나의 기동으로 묶는다", () => {
    // 6시간 간격 원소 3개에 걸쳐 상승하는 단일 기동
    const els = [
      ...Array.from({ length: 20 }, (_, i) => base(i, 6795 - i * 0.02)),
      base(20, 6795.6),
      base(21, 6796.2),
      ...Array.from({ length: 20 }, (_, i) => base(22 + i, 6796.2 - i * 0.02)),
    ];
    const m = detectManeuvers(els).maneuvers;
    expect(m).toHaveLength(1);
    expect(m[0].deltaSemiMajorKm).toBeGreaterThan(1);
  });
});
