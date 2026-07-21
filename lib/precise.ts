// 클라이언트 정밀 위치 소스 (고도화 §A3) — "정밀 ephemeris가 있으면 TLE 대신 쓴다".
//
// SGP4는 TLE epoch 시점에 이미 NASA OEM 대비 ~900 m 어긋나 있고(A2 실측), 거의 전부
// along-track이다. 정밀 ephemeris가 있는 위성은 그것을 직접 쓰면 그 오차가 사라진다.
//
// 프레임: OEM은 EME2000(J2000). 씬은 SGP4의 TEME 기준이므로 반드시 변환해야 한다.
// 두 프레임은 26년치 세차로 0.19~0.37°(6800 km에서 24~44 km) 어긋나 있다.
import { j2000ToTeme } from "./frames";

export type PreciseEphemeris = {
  norad: number;
  source: string;
  frame: string;
  /** ms UTC */
  t: number[];
  /** km, EME2000 */
  pos: number[][];
  /** km/s, EME2000 */
  vel: number[][];
};

export type Vec3 = { x: number; y: number; z: number };

const LAGRANGE_POINTS = 8;

/**
 * Lagrange 보간 후 TEME로 변환한 상태.
 * 창 밖이면 null → 호출부가 SGP4로 폴백한다.
 */
export function preciseStateTeme(e: PreciseEphemeris, date: Date): { position: Vec3; velocity: Vec3 } | null {
  const timeMs = date.getTime();
  const n = e.t.length;
  if (n < 2 || timeMs < e.t[0] || timeMs > e.t[n - 1]) return null;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (e.t[mid] <= timeMs) lo = mid;
    else hi = mid;
  }

  const k = Math.min(LAGRANGE_POINTS, n);
  let start = lo - (k >> 1) + 1;
  start = Math.max(0, Math.min(start, n - k));

  const x = (timeMs - e.t[start]) / 1000;
  const xs: number[] = [];
  for (let i = 0; i < k; i++) xs.push((e.t[start + i] - e.t[start]) / 1000);

  const p: [number, number, number] = [0, 0, 0];
  const v: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < k; i++) {
    let w = 1;
    for (let j = 0; j < k; j++) {
      if (j === i) continue;
      w *= (x - xs[j]) / (xs[i] - xs[j]);
    }
    for (let d = 0; d < 3; d++) {
      p[d] += w * e.pos[start + i][d];
      v[d] += w * e.vel[start + i][d];
    }
  }

  // J2000 → TEME (회전이므로 속도에도 같은 행렬을 적용한다.
  // 프레임 회전율(세차·장동)은 ~10⁻¹² rad/s 수준이라 속도 보정은 무시 가능.)
  const pt = j2000ToTeme(p, date);
  const vt = j2000ToTeme(v, date);
  return {
    position: { x: pt[0], y: pt[1], z: pt[2] },
    velocity: { x: vt[0], y: vt[1], z: vt[2] },
  };
}
