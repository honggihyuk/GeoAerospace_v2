import { describe, expect, it } from "vitest";
import {
  gk2aParams,
  gridBounds,
  gridToLonLat,
  KMA_GRID_5KM,
  lonLatToGrid,
  lonLatToXY,
  reshapeGrid,
  xyToLonLat,
} from "./lcc";

// 가이드(p39)가 명시한 기준값 — 이 두 줄이 이 파일의 존재 이유다.
//   a.out 1 59 125            → lon = 126.929810, lat = 37.488201
//   a.out 0 126.929810 37.488201 → X = 59, Y = 125
const REF = { nx: 59, ny: 125, lon: 126.92981, lat: 37.488201 };

describe("가이드 기준값 재현", () => {
  it("격자 → 위경도가 기준값과 1e-5° 이내로 일치한다", () => {
    const { lon, lat } = gridToLonLat(REF.nx, REF.ny, KMA_GRID_5KM);
    // 원본 C는 float라 6자리에서 끊긴다. 배정밀도와의 차이는 ~1e-6°(≈0.1 m).
    expect(Math.abs(lon - REF.lon), `lon ${lon}`).toBeLessThan(1e-5);
    expect(Math.abs(lat - REF.lat), `lat ${lat}`).toBeLessThan(1e-5);
  });

  it("위경도 → 격자가 기준 격자번호를 낸다", () => {
    expect(lonLatToGrid(REF.lon, REF.lat, KMA_GRID_5KM)).toEqual({ nx: REF.nx, ny: REF.ny });
  });

  it("투영 상수가 알려진 값과 맞는다", () => {
    // slat 30/60에서 원뿔상수 sn ≈ 0.7155668
    const { x } = lonLatToXY(KMA_GRID_5KM.olon, KMA_GRID_5KM.olat, KMA_GRID_5KM);
    // 기준경도·기준위도는 정의상 기준점 X좌표에 놓인다
    expect(x).toBeCloseTo(KMA_GRID_5KM.xo, 6);
  });
});

describe("왕복 변환", () => {
  // 남한 전역 (위성서비스는 남한만 제공)
  const pts = [
    { lon: 126.978, lat: 37.5665, name: "서울" },
    { lon: 129.075, lat: 35.1796, name: "부산" },
    { lon: 126.5312, lat: 33.4996, name: "제주" },
    { lon: 128.6014, lat: 35.8714, name: "대구" },
    { lon: 130.9057, lat: 37.4844, name: "울릉도" },
  ];

  it("위경도 → XY → 위경도가 원점으로 돌아온다", () => {
    for (const p of pts) {
      const { x, y } = lonLatToXY(p.lon, p.lat, KMA_GRID_5KM);
      const back = xyToLonLat(x, y, KMA_GRID_5KM);
      expect(Math.abs(back.lon - p.lon), p.name).toBeLessThan(1e-9);
      expect(Math.abs(back.lat - p.lat), p.name).toBeLessThan(1e-9);
    }
  });

  it("정수 격자 왕복은 격자 한 칸 안에 머문다", () => {
    for (const p of pts) {
      const g = lonLatToGrid(p.lon, p.lat, KMA_GRID_5KM);
      const c = gridToLonLat(g.nx, g.ny, KMA_GRID_5KM);
      const g2 = lonLatToGrid(c.lon, c.lat, KMA_GRID_5KM);
      expect(g2, p.name).toEqual(g);
    }
  });
});

describe("격자 규약", () => {
  it("격자는 1-based다 (0-based로 착각하면 한 칸씩 밀린다)", () => {
    const a = gridToLonLat(1, 1, KMA_GRID_5KM);
    const b = xyToLonLat(0, 0, KMA_GRID_5KM);
    expect(a).toEqual(b);
    // 그리고 (1,1)과 (2,2)는 서로 달라야 한다
    expect(gridToLonLat(2, 2, KMA_GRID_5KM).lon).not.toBeCloseTo(a.lon, 6);
  });

  it("동쪽으로 갈수록 nx가, 북쪽으로 갈수록 ny가 커진다", () => {
    const base = lonLatToGrid(127, 36, KMA_GRID_5KM);
    expect(lonLatToGrid(128, 36, KMA_GRID_5KM).nx).toBeGreaterThan(base.nx);
    expect(lonLatToGrid(127, 37, KMA_GRID_5KM).ny).toBeGreaterThan(base.ny);
  });

  it("격자 간격이 실제로 5 km에 대응한다", () => {
    const a = gridToLonLat(60, 125, KMA_GRID_5KM);
    const b = gridToLonLat(61, 125, KMA_GRID_5KM);
    // 위도 37.5°에서 경도 1° ≈ 88.3 km
    const km = Math.hypot((b.lon - a.lon) * 88.3, (b.lat - a.lat) * 111.0);
    expect(km).toBeGreaterThan(4.5);
    expect(km).toBeLessThan(5.5);
  });
});

describe("GK2A 위성 격자", () => {
  // 가이드 응답 예시: gridKm 2.0, xdim 320, ydim 396, x0 62.0, y0 331.0
  const p = gk2aParams({ gridKm: 2.0, x0: 62.0, y0: 331.0 });

  it("응답 메타의 x0/y0를 그대로 쓴다 (상수로 박으면 조용히 어긋난다)", () => {
    expect(p.xo).toBe(62.0);
    expect(p.yo).toBe(331.0);
    expect(p.grid).toBe(2.0);
  });

  it("격자 범위가 남한을 감싼다", () => {
    const b = gridBounds(320, 396, p);
    // 위성서비스는 남한만 제공 — 제주(33.5N)~고성(38.4N), 백령(124.6E)~독도(131.9E)
    expect(b.south).toBeLessThan(33.5);
    expect(b.north).toBeGreaterThan(38.4);
    expect(b.west).toBeLessThan(124.6);
    expect(b.east).toBeGreaterThan(131.9);
  });

  it("2 km 격자에서 한 칸이 약 2 km다", () => {
    const a = gridToLonLat(160, 200, p);
    const b = gridToLonLat(161, 200, p);
    const km = Math.hypot((b.lon - a.lon) * 88.3, (b.lat - a.lat) * 111.0);
    expect(km).toBeGreaterThan(1.7);
    expect(km).toBeLessThan(2.3);
  });
});

describe("격자 배열 복원", () => {
  it("행 우선으로 복원한다", () => {
    // xdim=3, ydim=2 → [[1,2,3],[4,5,6]]
    expect(reshapeGrid([1, 2, 3, 4, 5, 6], 3, 2)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("첫 행·첫 열을 빠뜨리지 않는다 (가이드 C 예제는 1-based 루프라 누락된다)", () => {
    const g = reshapeGrid([9, 1, 1, 1], 2, 2);
    expect(g[0][0]).toBe(9); // 원본 루프를 그대로 옮기면 이 값이 비어버린다
  });

  it("값이 부족하면 조용히 넘어가지 않고 실패한다", () => {
    expect(() => reshapeGrid([1, 2, 3], 2, 2)).toThrow();
    expect(() => reshapeGrid([1], 0, 1)).toThrow();
  });

  it("가이드 응답 크기(320×396)를 처리한다", () => {
    const flat = Array.from({ length: 320 * 396 }, (_, i) => i % 256);
    const g = reshapeGrid(flat, 320, 396);
    expect(g).toHaveLength(396);
    expect(g[0]).toHaveLength(320);
    expect(g[395][319]).toBe((320 * 396 - 1) % 256);
  });
});
