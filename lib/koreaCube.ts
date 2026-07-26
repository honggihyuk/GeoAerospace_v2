// 한반도 지형 그리드 (큐브샛 관측) — bbox·격자·색 유틸.
// 더블클릭한 큐브샛이 대한민국을 "관측"하면, 지도가 격자 정점으로 세분되어
// 각 정점이 **실측 고도**(Terrarium 30m급, 서버 z=9 샘플)만큼 변위된 연속 지형 메시가 된다.
// (구버전은 4.6km 큐브 블록이었다 → 320×360 정점 heightmap 메시로 고도화.)
// 표면 색은 SAR 후방산란 / VWorld 정사영상 / 고도 램프 중 선택.

export const KOREA_BBOX = { west: 125.5, south: 33.9, east: 129.7, north: 38.7 } as const;
export type Bbox = { west: number; south: number; east: number; north: number };

export const KOREA_CENTER: [number, number] = [
  (KOREA_BBOX.west + KOREA_BBOX.east) / 2,
  (KOREA_BBOX.south + KOREA_BBOX.north) / 2,
];

// 지형 메시 격자 — 320×360 = 115,200 정점(≈1.3km 셀). 구버전 100×120(4.6km 큐브) 대비
// 선형 ~2.8배·면적 ~9.6배 정밀. 실측 DEM(z=9, 305m)보다 촘촘하지 않아 계단 없이 부드럽다.
export const GRID_NX = 320;
export const GRID_NY = 360;

// 지형 렌더 튜닝 (rebuildTerrain 사용) — 한곳에 모음.
// 수직 과장. 18→14→7 로 낮춤: 실측 데이터 판독에 유용하도록 왜곡을 줄여 지형 비율을 더 충실히.
// 참고 스케일 — 실축척≈1(한반도는 거의 평평), 은은≈4, 현재 7(판독용), 극적≈14. 값 하나만 바꾸면 됨.
export const MESH_EXAG = 7;
// 이 고도 이하 정점 = 바다 → 메시에서 제외(육지·섬만). Terrarium 실측: 얕은 황해 −20~−60m,
// 해안 전이대 −10~+10m. 여유 있게 −8 → 해안·갯벌·간척지는 남기고 진짜 바다만 컷.
export const SEA_LEVEL_M = -8;

/** 고도(m)·색(rgb) 셀 배열. row-major (y*nx + x), y: 남→북, x: 서→동. */
export type KoreaGrid = {
  bbox: Bbox;
  nx: number;
  ny: number;
  heights: Float32Array; // m (실측 고도, 과장 전)
  colors: Uint8Array; // rgb, length nx*ny*3
};

/** 정점(격자 교점) 경위도. x∈[0,nx-1], y∈[0,ny-1] 를 bbox 전 구간에 고르게 배치. */
export function cellLngLat(x: number, y: number): [number, number] {
  const lng = KOREA_BBOX.west + (x / (GRID_NX - 1)) * (KOREA_BBOX.east - KOREA_BBOX.west);
  const lat = KOREA_BBOX.south + (y / (GRID_NY - 1)) * (KOREA_BBOX.north - KOREA_BBOX.south);
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
