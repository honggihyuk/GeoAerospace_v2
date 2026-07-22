// 한반도 큐브 그리드 (큐브샛 관측 데모) — bbox·격자·색 유틸.
// 더블클릭한 큐브샛이 대한민국을 "관측"하면, 지도가 격자 셀(=큐브 단위)로 세분되어
// 각 셀이 DEM 고도만큼 돋은 3D 박스가 된다. 색은 SAR 후방산란(가능 시) 또는 고도 램프.

export const KOREA_BBOX = { west: 125.5, south: 33.9, east: 129.7, north: 38.7 } as const;
export type Bbox = { west: number; south: number; east: number; north: number };

export const KOREA_CENTER: [number, number] = [
  (KOREA_BBOX.west + KOREA_BBOX.east) / 2,
  (KOREA_BBOX.south + KOREA_BBOX.north) / 2,
];

export const GRID_NX = 100;
export const GRID_NY = 120;

// 큐브 렌더 튜닝 (rebuildGrid 사용) — 쉽게 조정하도록 한곳에 모음.
export const CUBE_EXAG = 30; // 고도 과장 배율(지리산 1.9 km → 57 km)
export const CUBE_GAP = 0.9; // 셀 채움 비율(간격) — 1에 가까울수록 촘촘
export const CUBE_MIN_M = 700; // 최소 큐브 높이(m) — 평지도 얇은 슬랩으로 보이게
// 이 고도 이하 셀 = 바다 → 숨김. Terrarium 실측: 얕은 황해 −20~−60m, 해안 전이대 −10~+10m.
// 여유 있게 −8 → 해안·갯벌·간척지는 남기고 진짜 바다만 컷.
export const SEA_LEVEL_M = -8;

/** 고도(m)·색(rgb) 셀 배열. row-major (y*nx + x), y: 남→북, x: 서→동. */
export type KoreaGrid = {
  bbox: Bbox;
  nx: number;
  ny: number;
  heights: Float32Array; // m
  colors: Uint8Array; // rgb, length nx*ny*3
};

/** 셀 중심 경위도. */
export function cellLngLat(x: number, y: number): [number, number] {
  const lng = KOREA_BBOX.west + ((x + 0.5) / GRID_NX) * (KOREA_BBOX.east - KOREA_BBOX.west);
  const lat = KOREA_BBOX.south + ((y + 0.5) / GRID_NY) * (KOREA_BBOX.north - KOREA_BBOX.south);
  return [lng, lat];
}

/** 고도(m) → 지형 색 (바다 남색 → 저지 녹 → 산지 갈 → 고봉 흰). SAR 미가용 시 폴백. */
export function elevationColor(m: number): [number, number, number] {
  if (m <= 0) return [26, 51, 92];
  const t = Math.min(1, m / 1600);
  if (t < 0.4) {
    const k = t / 0.4;
    return [Math.round(60 + 45 * k), Math.round(120 + 45 * k), Math.round(72 - 22 * k)];
  }
  if (t < 0.8) {
    const k = (t - 0.4) / 0.4;
    return [Math.round(105 + 90 * k), Math.round(165 - 45 * k), Math.round(50 + 8 * k)];
  }
  const k = (t - 0.8) / 0.2;
  return [Math.round(195 + 60 * k), Math.round(120 + 130 * k), Math.round(58 + 190 * k)];
}
