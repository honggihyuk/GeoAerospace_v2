// 기상청 Lambert Conformal Conic 좌표 변환 (제안서_GK2A §K1).
//
// 천리안위성 2A호(GK2A) 격자자료는 LCC 투영이고 현 플랫폼은 전부 WGS84 경위도라,
// 이 변환이 없으면 위성 격자를 지도에 올릴 수 없다. 그리고 좌표 변환은 틀려도
// "그럴듯한" 값이 나오는 종류의 코드다 — 반드시 기준값으로 고정해야 한다.
//
// 출처: 「기상청 위성자료(경량화) 조회서비스 Open API 활용가이드」 p39~47의 C 예제를 이식.
// 검증: 가이드가 제시한 기준값 X=59,Y=125 ↔ 126.929810°E, 37.488201°N (lcc.test.ts).

export type LccParams = {
  /** 지구반경 (km) */
  Re: number;
  /** 격자간격 (km) */
  grid: number;
  /** 표준위도 1 (deg) */
  slat1: number;
  /** 표준위도 2 (deg) */
  slat2: number;
  /** 기준점 경도 (deg) */
  olon: number;
  /** 기준점 위도 (deg) */
  olat: number;
  /** 기준점 X좌표 (격자) */
  xo: number;
  /** 기준점 Y좌표 (격자) */
  yo: number;
};

/**
 * 기상청 표준 격자(동네예보 5 km).
 * 가이드 C 예제가 쓰는 값이며, 기준값 검증도 이 설정으로 이뤄진다.
 */
export const KMA_GRID_5KM: LccParams = {
  Re: 6371.00877,
  grid: 5.0,
  slat1: 30,
  slat2: 60,
  olon: 126,
  olat: 38,
  xo: 210 / 5.0,
  yo: 675 / 5.0,
};

/**
 * GK2A 위성 격자 파라미터를 응답 메타로부터 만든다.
 *
 * 주의: 기준점 X,Y(x0,y0)는 **응답 메시지의 값을 그대로 써야 한다.**
 * 가이드가 "변경될 수 있음"이라고 명시했으므로 상수로 박으면 조용히 어긋난다.
 */
export function gk2aParams(meta: { gridKm: number; x0: number; y0: number }): LccParams {
  return {
    Re: 6371.00877,
    grid: meta.gridKm,
    slat1: 30,
    slat2: 60,
    olon: 126,
    olat: 38,
    xo: meta.x0,
    yo: meta.y0,
  };
}

const PI = Math.PI;
const DEGRAD = PI / 180;
const RADDEG = 180 / PI;

/** 파라미터에서 파생되는 투영 상수. 격자마다 한 번만 계산하면 된다. */
type Proj = { re: number; sn: number; sf: number; ro: number; olonRad: number; xo: number; yo: number };

const cache = new WeakMap<LccParams, Proj>();

function project(p: LccParams): Proj {
  const hit = cache.get(p);
  if (hit) return hit;

  const re = p.Re / p.grid;
  const slat1 = p.slat1 * DEGRAD;
  const slat2 = p.slat2 * DEGRAD;
  const olonRad = p.olon * DEGRAD;
  const olat = p.olat * DEGRAD;

  let sn = Math.tan(PI * 0.25 + slat2 * 0.5) / Math.tan(PI * 0.25 + slat1 * 0.5);
  sn = Math.log(Math.cos(slat1) / Math.cos(slat2)) / Math.log(sn);
  let sf = Math.tan(PI * 0.25 + slat1 * 0.5);
  sf = Math.pow(sf, sn) * Math.cos(slat1) / sn;
  let ro = Math.tan(PI * 0.25 + olat * 0.5);
  ro = (re * sf) / Math.pow(ro, sn);

  const v: Proj = { re, sn, sf, ro, olonRad, xo: p.xo, yo: p.yo };
  cache.set(p, v);
  return v;
}

/**
 * 위경도 → 격자 좌표 (실수). 정수 격자 번호가 필요하면 `lonLatToGrid`를 쓴다.
 */
export function lonLatToXY(lon: number, lat: number, p: LccParams): { x: number; y: number } {
  const { re, sn, sf, ro, olonRad, xo, yo } = project(p);
  let ra = Math.tan(PI * 0.25 + lat * DEGRAD * 0.5);
  ra = (re * sf) / Math.pow(ra, sn);
  let theta = lon * DEGRAD - olonRad;
  if (theta > PI) theta -= 2 * PI;
  if (theta < -PI) theta += 2 * PI;
  theta *= sn;
  return { x: ra * Math.sin(theta) + xo, y: ro - ra * Math.cos(theta) + yo };
}

/**
 * 격자 좌표(실수) → 위경도.
 *
 * 원본 C의 `if (sn<0.0) -ra;` 와 `if(xn<0.0) -theta;` 는 값을 버리는 **무연산**이다
 * (널리 배포된 KMA 샘플의 알려진 특이점). 기준값을 재현하려면 그 동작을 그대로 따라야 하므로
 * 여기서도 부호를 뒤집지 않는다. 표준위도가 30/60(양수)인 한 sn>0이라 실제 영향은 없다.
 */
export function xyToLonLat(x: number, y: number, p: LccParams): { lon: number; lat: number } {
  const { re, sn, sf, ro, olonRad, xo, yo } = project(p);
  const xn = x - xo;
  const yn = ro - y + yo;
  const ra = Math.sqrt(xn * xn + yn * yn);

  let alat = Math.pow((re * sf) / ra, 1 / sn);
  alat = 2 * Math.atan(alat) - PI * 0.5;

  let theta: number;
  if (Math.abs(xn) <= 0) theta = 0;
  else if (Math.abs(yn) <= 0) theta = PI * 0.5;
  else theta = Math.atan2(xn, yn);

  return { lon: (theta / sn + olonRad) * RADDEG, lat: alat * RADDEG };
}

// ── 1-based 정수 격자 (가이드 map_conv 규약) ────────────────────────────────
//
// 가이드의 격자 번호는 **1부터 시작**한다. 0-based로 착각하면 한 칸씩 밀리는데,
// 5 km 격자에서 한 칸은 5 km라 지도에서 눈에 띄지 않고 조용히 틀린다.

/** 위경도 → 1-based 정수 격자 번호. */
export function lonLatToGrid(lon: number, lat: number, p: LccParams): { nx: number; ny: number } {
  const { x, y } = lonLatToXY(lon, lat, p);
  // 원본: (int)(x1 + 1.5) — 반올림 후 1-based로 올리는 것과 같다
  return { nx: Math.floor(x + 1.5), ny: Math.floor(y + 1.5) };
}

/** 1-based 정수 격자 번호 → 위경도(격자 중심). */
export function gridToLonLat(nx: number, ny: number, p: LccParams): { lon: number; lat: number } {
  return xyToLonLat(nx - 1, ny - 1, p);
}

// ── 격자 배열 복원 ──────────────────────────────────────────────────────────

/**
 * API가 주는 1차원 값 배열을 2차원 격자로 복원한다 (가이드 p37).
 *
 * 행 우선(row-major): `data[y][x] = flat[x + y*xdim]`.
 * 가이드의 C 예제는 1-based 루프로 쓰여 있어 그대로 옮기면 첫 행·열이 빠진다 —
 * 0-based로 정규화해 이식했다.
 */
export function reshapeGrid(flat: readonly number[], xdim: number, ydim: number): number[][] {
  if (xdim <= 0 || ydim <= 0) throw new Error("reshapeGrid: 격자 크기가 잘못됨");
  if (flat.length < xdim * ydim) {
    throw new Error(`reshapeGrid: 값이 부족하다 (필요 ${xdim * ydim}, 실제 ${flat.length})`);
  }
  const out: number[][] = new Array(ydim);
  for (let y = 0; y < ydim; y++) {
    const row = new Array<number>(xdim);
    for (let x = 0; x < xdim; x++) row[x] = flat[x + y * xdim];
    out[y] = row;
  }
  return out;
}

/**
 * 격자 배열의 지리 경계(대략). LCC는 사각 격자가 경위도상 사각형이 아니므로
 * 네 모서리를 변환해 감싸는 bbox를 만든다 — 지도 오버레이 배치용 근사다.
 */
export function gridBounds(
  xdim: number,
  ydim: number,
  p: LccParams
): { west: number; south: number; east: number; north: number } {
  const corners = [
    gridToLonLat(1, 1, p),
    gridToLonLat(xdim, 1, p),
    gridToLonLat(1, ydim, p),
    gridToLonLat(xdim, ydim, p),
  ];
  const lons = corners.map((c) => c.lon);
  const lats = corners.map((c) => c.lat);
  return {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats),
  };
}
