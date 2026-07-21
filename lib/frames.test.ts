import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/frames_fixture.json";
import { j2000ToTeme, julianCenturiesTT, nutation, temeToJ2000 } from "./frames";

// 기준값은 Skyfield(IAU 전항 구현)로 생성한 실제 ISS TLE 전파 결과다.
// teme = sgp4 원출력, j2000 = 같은 순간의 GCRS 좌표.
type Sample = { utc: string; teme: number[]; j2000: number[] };
const samples = fixture as Sample[];

const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe("TEME ↔ J2000 변환", () => {
  it("기준 표본이 존재한다", () => {
    expect(samples.length).toBeGreaterThanOrEqual(10);
  });

  it("Skyfield 기준값과 50 m 이내로 일치한다", () => {
    for (const s of samples) {
      const got = temeToJ2000(s.teme as [number, number, number], new Date(s.utc));
      const errM = dist(got as number[], s.j2000) * 1000;
      expect(errM, `${s.utc}: ${errM.toFixed(1)} m`).toBeLessThan(50);
    }
  });

  it("변환 없이 비교하면 수십 km 어긋난다 (변환이 필수임을 보인다)", () => {
    // 이 값이 작아지면 테스트가 무의미해진 것이므로 하한도 함께 검사한다.
    for (const s of samples) {
      expect(dist(s.teme, s.j2000)).toBeGreaterThan(15); // km
    }
  });

  it("회전이므로 벡터 크기를 보존한다", () => {
    for (const s of samples) {
      const got = temeToJ2000(s.teme as [number, number, number], new Date(s.utc));
      expect(norm(got as number[])).toBeCloseTo(norm(s.teme), 6);
    }
  });

  it("역변환이 원래 좌표로 되돌린다", () => {
    for (const s of samples) {
      const there = temeToJ2000(s.teme as [number, number, number], new Date(s.utc));
      const back = j2000ToTeme(there, new Date(s.utc));
      expect(dist(back as number[], s.teme) * 1000).toBeLessThan(1e-6); // µm
    }
  });
});

describe("장동·시간 인자", () => {
  it("J2000 기원에서 T=0 근처다", () => {
    expect(julianCenturiesTT(new Date("2000-01-01T12:00:00Z"))).toBeCloseTo(0, 5);
  });

  it("장동 크기가 알려진 범위 안이다 (Δψ ≲ 20″, Δε ≲ 10″)", () => {
    const AS = Math.PI / (180 * 3600);
    for (const s of samples) {
      const n = nutation(julianCenturiesTT(new Date(s.utc)));
      expect(Math.abs(n.dpsi) / AS).toBeLessThan(20);
      expect(Math.abs(n.deps) / AS).toBeLessThan(10);
      // 평균 황도경사 ≈ 23.44°
      expect((n.eps0 * 180) / Math.PI).toBeCloseTo(23.44, 1);
    }
  });
});
