// 정밀 좌표 프레임 변환 (고도화 §A2) — TEME ↔ J2000(EME2000/GCRF).
//
// 왜 필요한가: SGP4는 TEME(True Equator, Mean Equinox of date) 좌표를 낸다.
// NASA OEM 같은 정밀 ephemeris는 EME2000(J2000)이다. J2000 이후 26년치 세차만으로도
// 두 프레임은 0.19~0.37° 어긋나 있고, 이는 6800 km 고도에서 24~44 km에 해당한다.
// 즉 변환 없이 두 좌표를 비교하면 결과가 전부 무의미하다.
//
// 구현: IAU-76 세차 + IAU-80 장동(상위 20항) + 분점방정식.
// 절단 오차는 ~0.02" (6800 km에서 1 m 미만)로, 목표 정밀도에 비해 충분히 작다.
// Skyfield(전항 구현) 기준값에 대해 테스트로 검증한다.

const ASEC2RAD = Math.PI / (180 * 3600);
const DEG2RAD = Math.PI / 180;

/** UTC Date → TT 기준 J2000 율리우스 세기. TAI-UTC = 37 s (2017년 이후). */
export function julianCenturiesTT(utc: Date): number {
  const jdUtc = utc.getTime() / 86400000 + 2440587.5;
  const jdTt = jdUtc + (37 + 32.184) / 86400;
  return (jdTt - 2451545.0) / 36525;
}

// IAU-80 장동 계열 상위 20항.
// [l, l', F, D, Ω, Δψ(0.1 mas), Δψ·T, Δε(0.1 mas), Δε·T]
const NUTATION: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
  [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
  [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
  [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
  [0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
  [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
  [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
  [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
  [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
  [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
  [-1, 0, 0, 2, 0, 158, 0, -1, 0],
  [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
  [-1, 0, 2, 0, 2, 123, 0, -53, 0],
  [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
  [0, 0, 0, 2, 0, 63, 0, -2, 0],
  [-1, 0, 2, 2, 2, -59, 0, 26, 0],
  [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
  [1, 0, 2, 0, 1, -51, 0, 27, 0],
  [2, 0, 0, -2, 0, 48, 0, 1, 0],
  [-2, 0, 2, 0, 1, 46, 0, -24, 0],
];

export type Nutation = { dpsi: number; deps: number; eps0: number; eps: number; eqeq: number };

/** IAU-80 장동 + 평균 황도경사 + 분점방정식 (모두 rad). */
export function nutation(T: number): Nutation {
  const rev = 1296000; // 1 회전 = 360° (arcsec)
  const l = (485866.733 + (1325 * rev + 715922.633) * T + 31.31 * T * T + 0.064 * T ** 3) * ASEC2RAD;
  const lp = (1287099.804 + (99 * rev + 1292581.224) * T - 0.577 * T * T - 0.012 * T ** 3) * ASEC2RAD;
  const F = (335778.877 + (1342 * rev + 295263.137) * T - 13.257 * T * T + 0.011 * T ** 3) * ASEC2RAD;
  const D = (1072261.307 + (1236 * rev + 1105601.328) * T - 6.891 * T * T + 0.019 * T ** 3) * ASEC2RAD;
  const Om = (450160.28 - (5 * rev + 482890.539) * T + 7.455 * T * T + 0.008 * T ** 3) * ASEC2RAD;

  let dpsi = 0;
  let deps = 0;
  for (const [nl, nlp, nF, nD, nOm, a, at, b, bt] of NUTATION) {
    const arg = nl * l + nlp * lp + nF * F + nD * D + nOm * Om;
    dpsi += (a + at * T) * Math.sin(arg);
    deps += (b + bt * T) * Math.cos(arg);
  }
  dpsi *= 1e-4 * ASEC2RAD; // 0.1 mas → rad
  deps *= 1e-4 * ASEC2RAD;

  const eps0 = (84381.448 - 46.815 * T - 0.00059 * T * T + 0.001813 * T ** 3) * ASEC2RAD;
  const eps = eps0 + deps;
  // 분점방정식(1982) — 1997년 이후 채택된 보정항 포함
  const eqeq = dpsi * Math.cos(eps) + 0.00264 * ASEC2RAD * Math.sin(Om) + 0.000063 * ASEC2RAD * Math.sin(2 * Om);
  return { dpsi, deps, eps0, eps, eqeq };
}

export type Mat3 = [number, number, number, number, number, number, number, number, number];

// 좌표 프레임 회전 (Vallado 규약): 벡터가 아니라 축을 돌린다.
function rot1(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [1, 0, 0, 0, c, s, 0, -s, c];
}
function rot2(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}
function rot3(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}
function mul(A: Mat3, B: Mat3): Mat3 {
  const M = new Array(9).fill(0) as number[];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
      M[i * 3 + j] = s;
    }
  return M as Mat3;
}
function transpose(A: Mat3): Mat3 {
  return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
}
export function applyMat(M: Mat3, v: readonly [number, number, number]): [number, number, number] {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
}

/** IAU-76 세차 행렬 (J2000 → MOD). */
export function precession(T: number): Mat3 {
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * ASEC2RAD;
  const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * ASEC2RAD;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * ASEC2RAD;
  return mul(mul(rot3(-z), rot2(theta)), rot3(-zeta));
}

/** 장동 행렬 (MOD → TOD). */
export function nutationMatrix(n: Nutation): Mat3 {
  return mul(mul(rot1(-n.eps), rot3(-n.dpsi)), rot1(n.eps0));
}

/** TEME → J2000(EME2000). r_J2000 = Pᵀ · Nᵀ · R3(-Eqeq) · r_TEME */
export function temeToJ2000Matrix(utc: Date): Mat3 {
  const T = julianCenturiesTT(utc);
  const n = nutation(T);
  const P = precession(T);
  const N = nutationMatrix(n);
  return mul(mul(transpose(P), transpose(N)), rot3(-n.eqeq));
}

/** J2000(EME2000) → TEME. 위 변환의 역(전치). */
export function j2000ToTemeMatrix(utc: Date): Mat3 {
  return transpose(temeToJ2000Matrix(utc));
}

export function temeToJ2000(v: readonly [number, number, number], utc: Date): [number, number, number] {
  return applyMat(temeToJ2000Matrix(utc), v);
}

export function j2000ToTeme(v: readonly [number, number, number], utc: Date): [number, number, number] {
  return applyMat(j2000ToTemeMatrix(utc), v);
}

export { DEG2RAD, ASEC2RAD };
