// GK2A LCC 격자 → 등장방형(equirectangular) 래스터 재투영 (제안서_GK2A §K1 렌더링 계층).
//
// 왜 재투영이 필요한가: 위성 격자는 Lambert Conformal Conic이고, 3D 지구 구는
// 등장방형 텍스처(uv = 경위도 선형)로 감긴다. 두 좌표계가 달라 격자를 그대로 얹으면
// 한반도가 엉뚱한 곳에 찍힌다.
//
// 방향 주의: **역방향 매핑**으로 계산한다. 격자 셀을 출력으로 "밀어내면"(forward)
// 구멍과 겹침이 생긴다. 출력 픽셀마다 경위도를 구해 격자에서 값을 "당겨온다"(inverse).
import { lonLatToXY, type LccParams } from "./lcc";

export type LonLatBounds = { west: number; south: number; east: number; north: number };

export type RasterOptions = {
  /** 값 → 색. RGBA 0~255. 값이 없으면 alpha 0을 반환해 투명 처리. */
  palette: (v: number) => [number, number, number, number];
  /** 격자 밖 또는 결측을 나타내는 값 (기본: NaN만 결측) */
  isMissing?: (v: number) => boolean;
  /** 이중선형 보간 (기본 true). false면 최근접 — 범주형 자료에 쓴다. */
  bilinear?: boolean;
};

export type RasterResult = {
  width: number;
  height: number;
  /** RGBA, 행 우선, 행 0 = 북쪽 (일반 이미지 규약) */
  rgba: Uint8ClampedArray;
  bounds: LonLatBounds;
  /** 실제로 값이 채워진 픽셀 수 — 0이면 격자와 bounds가 어긋난 것이다 */
  filled: number;
};

/**
 * LCC 격자를 경위도 bbox 위의 RGBA 래스터로 재투영한다.
 *
 * @param grid  `grid[y][x]` — reshapeGrid()의 출력 (0-based)
 * @param p     격자의 LCC 파라미터 (응답 메타의 x0/y0를 반드시 반영할 것)
 */
export function rasterizeGrid(
  grid: readonly (readonly number[])[],
  p: LccParams,
  bounds: LonLatBounds,
  width: number,
  height: number,
  opts: RasterOptions
): RasterResult {
  if (width <= 0 || height <= 0) throw new Error("rasterizeGrid: 출력 크기가 잘못됨");
  const ydim = grid.length;
  const xdim = ydim > 0 ? grid[0].length : 0;
  if (xdim === 0 || ydim === 0) throw new Error("rasterizeGrid: 빈 격자");

  const missing = opts.isMissing ?? ((v: number) => !Number.isFinite(v));
  const bilinear = opts.bilinear !== false;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let filled = 0;

  const lonSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;

  for (let j = 0; j < height; j++) {
    // 행 0 = 북쪽. 픽셀 중심(+0.5)을 쓴다 — 모서리를 쓰면 반 픽셀 밀린다.
    const lat = bounds.north - ((j + 0.5) / height) * latSpan;
    for (let i = 0; i < width; i++) {
      const lon = bounds.west + ((i + 0.5) / width) * lonSpan;

      // 경위도 → LCC 실수 격자좌표. lonLatToXY는 0-based 실수를 낸다
      // (1-based 정수 격자번호 nx는 x = nx-1에 대응).
      const { x, y } = lonLatToXY(lon, lat, p);

      const v = bilinear ? sampleBilinear(grid, x, y, xdim, ydim, missing) : sampleNearest(grid, x, y, xdim, ydim, missing);
      const o = (j * width + i) * 4;
      if (v === null) {
        rgba[o + 3] = 0; // 격자 밖 → 투명
        continue;
      }
      const [r, g, b, a] = opts.palette(v);
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
      if (a > 0) filled++;
    }
  }

  return { width, height, rgba, bounds, filled };
}

function sampleNearest(
  grid: readonly (readonly number[])[],
  x: number,
  y: number,
  xdim: number,
  ydim: number,
  missing: (v: number) => boolean
): number | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= xdim || yi >= ydim) return null;
  const v = grid[yi][xi];
  return missing(v) ? null : v;
}

function sampleBilinear(
  grid: readonly (readonly number[])[],
  x: number,
  y: number,
  xdim: number,
  ydim: number,
  missing: (v: number) => boolean
): number | null {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= xdim || y1 >= ydim) {
    // 가장자리는 보간할 이웃이 없으므로 최근접으로 떨어뜨린다
    return sampleNearest(grid, x, y, xdim, ydim, missing);
  }
  const v00 = grid[y0][x0];
  const v10 = grid[y0][x1];
  const v01 = grid[y1][x0];
  const v11 = grid[y1][x1];
  // 하나라도 결측이면 보간이 오염되므로 최근접으로 물러선다
  if (missing(v00) || missing(v10) || missing(v01) || missing(v11)) {
    return sampleNearest(grid, x, y, xdim, ydim, missing);
  }
  const fx = x - x0;
  const fy = y - y0;
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}

// ── 팔레트 ──────────────────────────────────────────────────────────────────

/** 값을 0~1로 정규화하며 범위 밖은 잘라낸다. */
function norm(v: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
}

/**
 * 적외 휘도온도 팔레트 (K).
 * 기상 관례를 따른다 — **차가울수록 밝게**. 높은 구름(찬 구름정상)이 희게 보여야
 * 위성영상으로 읽힌다. 온도가 낮은 쪽이 흰색, 지표(따뜻함)는 투명에 가깝게.
 */
export function thermalPalette(minK = 190, maxK = 300) {
  return (v: number): [number, number, number, number] => {
    const t = 1 - norm(v, minK, maxK); // 0=따뜻(지표) 1=차가움(높은 구름)
    // 휘도는 t에 대해 단조 증가해야 한다. 지표에 밝은 난색(예: R=255)을 쓰면
    // "차가울수록 밝다"가 깨져 영상이 뒤집혀 읽힌다.
    // 적외 영상은 **회색조**여야 계기 자료로 읽힌다. 난색을 섞으면 지구 텍스처 위에서
    // "붙여넣은 갈색 판"처럼 보인다(실측). 색상은 회색 하나로 두고 밝기·불투명도로만 말한다.
    //
    // 불투명도 설계: 따뜻한 지표는 옅게(아래 실사가 비치도록), 찬 구름정상은 진하게.
    // 그래야 "구름이 얹힌" 것처럼 읽히고 사각 영역이 통째로 도드라지지 않는다.
    const g = Math.round(28 + 227 * Math.pow(t, 0.85));
    const a = Math.round(45 + 210 * Math.pow(t, 1.35));
    // 아주 찬 구름정상(대류운)만 살짝 푸른 기 — 기상 관례
    return [g, g, Math.min(255, g + (t > 0.85 ? 22 : 0)), a];
  };
}

/** 가시·근적외 반사도(Albedo, %) 팔레트 — 밝을수록 반사가 강하다(구름·설빙). */
export function albedoPalette(minA = 0, maxA = 100) {
  return (v: number): [number, number, number, number] => {
    const t = norm(v, minA, maxA);
    const g = Math.round(255 * Math.sqrt(t)); // 감마 보정 — 선형이면 대부분 어둡게 보인다
    return [g, g, g, Math.round(255 * Math.min(1, t * 1.6))];
  };
}

/**
 * 단파적외 3.8μm 화재 강조 팔레트.
 * 고온 화소만 붉게 드러내고 나머지는 투명 — "어디가 타고 있나"만 보여준다.
 */
export function firePalette(bgK = 300, hotK = 340) {
  return (v: number): [number, number, number, number] => {
    if (v < bgK) return [0, 0, 0, 0];
    const t = norm(v, bgK, hotK);
    return [255, Math.round(210 - 190 * t), Math.round(60 - 55 * t), Math.round(120 + 135 * t)];
  };
}

/**
 * 격자를 감싸는 경위도 bbox에 여유를 준다.
 * LCC 격자는 경위도상 사각형이 아니라 부채꼴이라, 딱 맞춘 bbox는 모서리를 자른다.
 */
export function padBounds(b: LonLatBounds, deg = 0.5): LonLatBounds {
  return {
    west: b.west - deg,
    south: Math.max(-90, b.south - deg),
    east: b.east + deg,
    north: Math.min(90, b.north + deg),
  };
}
