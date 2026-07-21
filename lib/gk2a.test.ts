import { describe, expect, it } from "vitest";
import {
  convertCount,
  countToRadiance,
  ebtToBt,
  findChannel,
  GK2A_CHANNELS,
  isVnir,
  looksLikeCount,
  radianceToAlbedo,
  radianceToEbt,
} from "./gk2a";

describe("가이드 기준값 재현", () => {
  // 활용가이드 p38: "Count 값이 1562일 경우 Radiance는 560.587643, Albedo는 0.873533"
  // 어느 채널인지는 명시돼 있지 않으나, Albedo/Radiance = 0.0015582 로 VIS0.4의
  // Rad→Alb 계수(0.001558245)와 일치한다.
  const vis04 = findChannel("004")!;

  it("Count 1562 → Radiance 560.5876 (VIS0.4)", () => {
    const r = countToRadiance(1562, vis04);
    expect(r).toBeCloseTo(560.587643, 4);
  });

  it("Radiance → Albedo 0.873533", () => {
    const r = countToRadiance(1562, vis04);
    expect(radianceToAlbedo(r, vis04)).toBeCloseTo(0.873533, 5);
  });

  it("변환표 룩업 첫 행들과 일치한다 (선형식이 표를 재현하는지)", () => {
    // Calibration Table_WN 시트 VIS0.4 열: Count 0 → -7.270904541, Count 1 → -6.907358736
    expect(countToRadiance(0, vis04)).toBeCloseTo(-7.270904541, 8);
    expect(countToRadiance(1, vis04)).toBeCloseTo(-6.907358736, 8);
    expect(countToRadiance(2, vis04)).toBeCloseTo(-6.543812931, 8);
  });
});

describe("채널 카탈로그", () => {
  it("가이드 waveType 표의 16채널을 모두 담는다", () => {
    expect(GK2A_CHANNELS).toHaveLength(16);
    for (const wt of ["004", "005", "006", "008", "013", "016", "038", "063", "069", "073", "087", "096", "105", "112", "123", "133"]) {
      expect(findChannel(wt), wt).toBeDefined();
    }
  });

  it("채널별 격자간격이 가이드와 일치한다", () => {
    // 가시 0.64μm만 0.5km, 나머지 가시는 1.0km, 적외 계열은 2.0km
    expect(findChannel("006")!.gridKm).toBe(0.5);
    expect(findChannel("004")!.gridKm).toBe(1.0);
    expect(findChannel("008")!.gridKm).toBe(1.0);
    expect(findChannel("087")!.gridKm).toBe(2.0);
    expect(findChannel("038")!.gridKm).toBe(2.0);
  });

  it("단파적외 3.8μm가 화재 탐지 채널로 존재한다", () => {
    const sw = findChannel("038")!;
    expect(sw.kind).toBe("단파적외");
    expect(sw.wavenumber).toBeDefined(); // IR 계열이므로 휘도온도 변환 가능
  });

  it("VNIR만 Albedo를, IR 계열만 휘도온도를 갖는다", () => {
    for (const c of GK2A_CHANNELS) {
      if (isVnir(c)) {
        expect(c.albedoCoeff, c.name).toBeGreaterThan(0);
        expect(c.wavenumber, c.name).toBeUndefined();
      } else {
        expect(c.wavenumber, c.name).toBeGreaterThan(0);
        expect(c.c1, c.name).toBeDefined();
      }
    }
  });

  it("IR 채널의 gain은 음수다 (Count가 클수록 복사휘도가 작다)", () => {
    for (const c of GK2A_CHANNELS.filter((x) => !isVnir(x))) {
      expect(c.gain, c.name).toBeLessThan(0);
    }
  });
});

describe("휘도온도 변환", () => {
  const ir105 = findChannel("105")!; // 10.5μm — 지표온도 대표 채널

  it("지구 관측 범위에서 물리적으로 타당한 온도를 낸다", () => {
    // Count 범위를 훑어 200~330 K 구간이 실제로 나오는지
    const temps: number[] = [];
    for (let dn = 0; dn <= 8000; dn += 250) {
      const t = convertCount(dn, ir105, "BT");
      if (Number.isFinite(t)) temps.push(t);
    }
    const plausible = temps.filter((t) => t > 180 && t < 340);
    expect(plausible.length).toBeGreaterThan(5);
  });

  it("Te와 Tb가 서로 가깝다 (2차 보정은 작은 값)", () => {
    const r = countToRadiance(3000, ir105);
    const te = radianceToEbt(r, ir105);
    const tb = ebtToBt(te, ir105);
    expect(Math.abs(tb - te)).toBeLessThan(2); // 보정은 통상 1 K 미만
  });

  it("복사휘도가 커지면 온도도 오른다 (단조성)", () => {
    const a = radianceToEbt(10, ir105);
    const b = radianceToEbt(50, ir105);
    const c = radianceToEbt(120, ir105);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it("음수·0 복사휘도는 NaN을 낸다 (조용히 이상한 온도를 내지 않는다)", () => {
    expect(Number.isNaN(radianceToEbt(0, ir105))).toBe(true);
    expect(Number.isNaN(radianceToEbt(-5, ir105))).toBe(true);
  });

  it("VNIR 채널에 휘도온도를 요구하면 실패한다", () => {
    expect(() => radianceToEbt(100, findChannel("004")!)).toThrow();
  });

  it("IR 채널에 Albedo를 요구하면 실패한다", () => {
    expect(() => radianceToAlbedo(100, findChannel("105")!)).toThrow();
  });
});

describe("이중 변환 방지", () => {
  it("Count처럼 보이는 값을 판별한다", () => {
    expect(looksLikeCount(1562)).toBe(true);
    expect(looksLikeCount(0)).toBe(true);
    expect(looksLikeCount(16383)).toBe(true);
    // 가이드 응답 예시의 값 — 이미 물리량으로 보인다
    expect(looksLikeCount(89.75669860839844)).toBe(false);
    expect(looksLikeCount(3.291100025177002)).toBe(false);
    expect(looksLikeCount(-1)).toBe(false);
    expect(looksLikeCount(20000)).toBe(false);
  });
});
