import { describe, expect, it } from "vitest";
import { gk2aParams, gridBounds, lonLatToGrid } from "./lcc";
import { albedoPalette, firePalette, padBounds, rasterizeGrid, thermalPalette } from "./gk2aRaster";

// 가이드 응답 예시의 GK2A 격자 메타
const P = gk2aParams({ gridKm: 2.0, x0: 62.0, y0: 331.0 });
const XDIM = 320;
const YDIM = 396;
const BOUNDS = padBounds(gridBounds(XDIM, YDIM, P), 0.5);

/** 전부 base 값이고, 지정한 경위도 한 곳만 spike인 격자. */
function gridWithLandmark(lon: number, lat: number, base = 280, spike = 999) {
  const g: number[][] = Array.from({ length: YDIM }, () => new Array<number>(XDIM).fill(base));
  const { nx, ny } = lonLatToGrid(lon, lat, P);
  g[ny - 1][nx - 1] = spike; // 1-based 격자번호 → 0-based 배열
  return g;
}

/** 래스터에서 가장 밝은(alpha가 아닌 특정 채널 최대) 픽셀의 경위도. */
function brightestLonLat(r: ReturnType<typeof rasterizeGrid>, channel = 0) {
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let j = 0; j < r.height; j++) {
    for (let i = 0; i < r.width; i++) {
      const v = r.rgba[(j * r.width + i) * 4 + channel];
      if (v > best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  return {
    lon: r.bounds.west + ((bi + 0.5) / r.width) * (r.bounds.east - r.bounds.west),
    lat: r.bounds.north - ((bj + 0.5) / r.height) * (r.bounds.north - r.bounds.south),
  };
}

describe("재투영 기하 — 표식이 제 위치에 찍히는가", () => {
  // 이 절이 이 파일의 핵심이다. 여기가 틀리면 한반도가 엉뚱한 곳에 그려진다.
  const cases = [
    { name: "서울", lon: 126.978, lat: 37.5665 },
    { name: "부산", lon: 129.075, lat: 35.1796 },
    { name: "제주", lon: 126.5312, lat: 33.4996 },
    { name: "강릉", lon: 128.8961, lat: 37.7519 },
  ];

  for (const c of cases) {
    it(`${c.name} 격자 표식이 ${c.name} 좌표에 나타난다`, () => {
      const grid = gridWithLandmark(c.lon, c.lat);
      const r = rasterizeGrid(grid, P, BOUNDS, 400, 400, {
        // spike만 빨갛게, 배경은 투명 — 최대 탐색이 명확해진다
        palette: (v) => (v > 900 ? [255, 0, 0, 255] : [0, 0, 0, 0]),
        bilinear: false, // 표식이 번지지 않도록 최근접
      });
      const found = brightestLonLat(r);
      // 출력 픽셀 크기(약 0.02°)와 2km 격자(약 0.02°)를 합쳐 0.1° 이내면 정확하다
      expect(Math.abs(found.lon - c.lon), `lon ${found.lon}`).toBeLessThan(0.1);
      expect(Math.abs(found.lat - c.lat), `lat ${found.lat}`).toBeLessThan(0.1);
    });
  }

  it("서로 다른 지점은 서로 다른 픽셀에 찍힌다 (전부 같은 곳으로 뭉개지지 않는다)", () => {
    const seen = new Set<string>();
    for (const c of cases) {
      const r = rasterizeGrid(gridWithLandmark(c.lon, c.lat), P, BOUNDS, 400, 400, {
        palette: (v) => (v > 900 ? [255, 0, 0, 255] : [0, 0, 0, 0]),
        bilinear: false,
      });
      const f = brightestLonLat(r);
      seen.add(`${f.lon.toFixed(2)},${f.lat.toFixed(2)}`);
    }
    expect(seen.size).toBe(cases.length);
  });
});

describe("래스터 기본 동작", () => {
  const flat = Array.from({ length: YDIM }, () => new Array<number>(XDIM).fill(250));

  it("격자 범위 안이 실제로 채워진다", () => {
    const r = rasterizeGrid(flat, P, BOUNDS, 200, 200, { palette: () => [1, 2, 3, 255] });
    expect(r.filled).toBeGreaterThan(0);
    // 격자가 bbox의 상당 부분을 덮어야 한다 (LCC 부채꼴이라 100%는 아니다)
    expect(r.filled / (200 * 200)).toBeGreaterThan(0.5);
  });

  it("격자 밖은 투명하다", () => {
    // 격자에서 멀리 떨어진 영역(태평양 한가운데)
    const far = { west: 160, south: 0, east: 170, north: 10 };
    const r = rasterizeGrid(flat, P, far, 64, 64, { palette: () => [255, 255, 255, 255] });
    expect(r.filled).toBe(0);
  });

  it("결측값(NaN)은 투명 처리된다", () => {
    const g = flat.map((row) => [...row]);
    for (let y = 0; y < YDIM; y++) for (let x = 0; x < XDIM; x++) g[y][x] = NaN;
    const r = rasterizeGrid(g, P, BOUNDS, 100, 100, { palette: () => [255, 255, 255, 255] });
    expect(r.filled).toBe(0);
  });

  it("이중선형 보간이 최근접보다 매끄럽다", () => {
    // 서→동 선형 경사 격자
    const ramp = Array.from({ length: YDIM }, () => Array.from({ length: XDIM }, (_, x) => (x / XDIM) * 100));
    const mk = (bilinear: boolean) =>
      rasterizeGrid(ramp, P, BOUNDS, 300, 60, {
        palette: (v) => [Math.round(v * 2.55), 0, 0, 255],
        bilinear,
      });
    const step = (r: ReturnType<typeof rasterizeGrid>) => {
      let jumps = 0;
      const j = 30;
      for (let i = 1; i < r.width; i++) {
        const a = r.rgba[(j * r.width + i - 1) * 4];
        const b = r.rgba[(j * r.width + i) * 4];
        if (Math.abs(b - a) > 3) jumps++;
      }
      return jumps;
    };
    expect(step(mk(true))).toBeLessThanOrEqual(step(mk(false)));
  });

  it("잘못된 입력은 조용히 넘어가지 않고 실패한다", () => {
    expect(() => rasterizeGrid(flat, P, BOUNDS, 0, 10, { palette: () => [0, 0, 0, 0] })).toThrow();
    expect(() => rasterizeGrid([], P, BOUNDS, 10, 10, { palette: () => [0, 0, 0, 0] })).toThrow();
  });
});

describe("팔레트", () => {
  it("적외 팔레트는 찬 곳을 밝게 낸다 (기상 관례)", () => {
    const pal = thermalPalette(190, 300);
    const cold = pal(200); // 높은 구름
    const warm = pal(295); // 지표
    expect(cold[0]).toBeGreaterThan(warm[0]);
    expect(cold[3]).toBeGreaterThan(warm[3]); // 구름이 더 불투명
  });

  it("적외 팔레트 휘도가 온도에 대해 단조롭다 (영상이 뒤집혀 읽히면 안 된다)", () => {
    const pal = thermalPalette(190, 300);
    const lum = (c: [number, number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    let prev = Infinity;
    for (let k = 190; k <= 300; k += 5) {
      const l = lum(pal(k));
      expect(l, `${k}K`).toBeLessThanOrEqual(prev + 1e-6); // 온도↑ → 휘도↓
      prev = l;
    }
  });

  it("반사도 팔레트는 값이 클수록 밝다", () => {
    const pal = albedoPalette();
    expect(pal(80)[0]).toBeGreaterThan(pal(20)[0]);
    expect(pal(0)[3]).toBe(0); // 반사 없음 → 투명
  });

  it("화재 팔레트는 임계 이하를 완전히 숨긴다", () => {
    const pal = firePalette(300, 340);
    expect(pal(280)[3]).toBe(0);
    expect(pal(299.9)[3]).toBe(0);
    expect(pal(330)[3]).toBeGreaterThan(0);
    // 뜨거울수록 붉어진다 (녹색 성분 감소)
    expect(pal(340)[1]).toBeLessThan(pal(305)[1]);
  });
});

describe("경계 여유", () => {
  it("LCC 부채꼴 모서리가 잘리지 않도록 넓힌다", () => {
    const raw = gridBounds(XDIM, YDIM, P);
    const pad = padBounds(raw, 0.5);
    expect(pad.west).toBeLessThan(raw.west);
    expect(pad.north).toBeGreaterThan(raw.north);
    expect(pad.north).toBeLessThanOrEqual(90);
  });
});
