// 정밀 ephemeris (고도화 §A2/§A3) — NASA가 발행하는 ISS 운영 궤도(CCSDS OEM).
//
// 배경: 고도화 문서 A2는 "TLE→osculating 변환 후 수치적분 → 시간당 sub-100 m"를 제안하지만,
// 수치적분은 초기 상태보다 정확해질 수 없다. 실측 결과 SGP4는 TLE epoch 시점에 이미
// NASA OEM 대비 677 m 어긋나 있고(거의 전부 along-track), 이 오차는 TLE 자체에 들어 있어
// 어떤 적분기로도 제거되지 않는다. 게다가 TLE 평균원소는 SGP4 이론에 종속적이라
// 다른 힘모델로 적분하면 오히려 불일치가 커진다.
//
// 따라서 sub-100 m를 원한다면 정밀 ephemeris를 "직접 쓰는" 수밖에 없다. 이 모듈이 그 경로다.
// 프레임: OEM은 EME2000(J2000). SGP4의 TEME와 0.19~0.37°(24~44 km) 어긋나므로
// 비교·활용 시 lib/frames.ts의 변환을 반드시 거쳐야 한다.
import { safeFetch } from "./safeFetch";

const ISS_OEM_URL =
  "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt";

/** 이 소스가 커버하는 위성. ISS 외에는 공개 정밀 ephemeris가 없다. */
export const PRECISE_EPHEMERIS_NORAD = 25544;

const TTL_MS = 6 * 60 * 60 * 1000; // NASA는 하루 1~2회 갱신

export type Ephemeris = {
  /** ms 단위 UTC */
  t: number[];
  /** km, EME2000 */
  pos: [number, number, number][];
  /** km/s, EME2000 */
  vel: [number, number, number][];
  meta: { objectName: string; refFrame: string; timeSystem: string; creationDate: string; source: string };
};

let cache: { v: Ephemeris; ts: number } | null = null;

function parseOem(text: string): Ephemeris {
  const t: number[] = [];
  const pos: [number, number, number][] = [];
  const vel: [number, number, number][] = [];
  const meta = {
    objectName: "",
    refFrame: "",
    timeSystem: "",
    creationDate: "",
    source: "NASA/JSC OEM",
  };

  let inData = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!inData) {
      const m = /^([A-Z_]+)\s*=\s*(.+)$/.exec(line);
      if (m) {
        if (m[1] === "OBJECT_NAME") meta.objectName = m[2].trim();
        else if (m[1] === "REF_FRAME") meta.refFrame = m[2].trim();
        else if (m[1] === "TIME_SYSTEM") meta.timeSystem = m[2].trim();
        else if (m[1] === "CREATION_DATE") meta.creationDate = m[2].trim();
      }
      if (line === "META_STOP") inData = true;
      continue;
    }
    if (line.startsWith("COMMENT")) continue;
    const p = line.split(/\s+/);
    if (p.length < 7) continue;
    const ms = Date.parse(p[0].endsWith("Z") ? p[0] : `${p[0]}Z`);
    if (!Number.isFinite(ms)) continue;
    const n = p.slice(1, 7).map(Number);
    if (n.some((x) => !Number.isFinite(x))) continue;
    t.push(ms);
    pos.push([n[0], n[1], n[2]]);
    vel.push([n[3], n[4], n[5]]);
  }
  if (t.length < 2) throw new Error("OEM: 표본 부족");
  return { t, pos, vel, meta };
}

export async function fetchIssEphemeris(): Promise<Ephemeris> {
  if (cache && Date.now() - cache.ts < TTL_MS) return cache.v;
  const r = await safeFetch(ISS_OEM_URL, { timeoutMs: 45_000, accept: "text/plain" });
  if (!r.ok) throw new Error(`oem ${r.status}`);
  const v = parseOem(await r.text());
  cache = { v, ts: Date.now() };
  return v;
}

export type State = { pos: [number, number, number]; vel: [number, number, number] };

/** 보간 차수 — ephemeris 보간의 표준 관행(8~10점 Lagrange). */
const LAGRANGE_POINTS = 8;

/**
 * Lagrange 보간 (위치·속도 각각) — OEM 표본은 4분 간격이다.
 *
 * 차수 선택 근거: 3차 Hermite(2점)는 이 간격에서 고유 오차가 R·N⁴h⁴/384 ≈ 95 m다.
 * 우리가 재려는 SGP4 오차가 수백 m 규모라 그 정도 보간 오차는 결과를 오염시킨다.
 * 8점 Lagrange는 (Nh)⁸/8!·R ≈ 5 mm 수준으로 떨어져 측정에 영향을 주지 않는다.
 * 격자점에서는 표본값을 정확히 재현한다.
 */
export function interpolate(e: Ephemeris, timeMs: number): State | null {
  const { t, pos, vel } = e;
  const n = t.length;
  if (timeMs < t[0] || timeMs > t[n - 1]) return null; // 외삽 금지

  // 이진 탐색으로 구간 찾기
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= timeMs) lo = mid;
    else hi = mid;
  }

  // 대상 구간을 감싸도록 창을 중앙 정렬하고, 양 끝에서는 안쪽으로 밀어 넣는다.
  const k = Math.min(LAGRANGE_POINTS, n);
  let start = lo - (k >> 1) + 1;
  start = Math.max(0, Math.min(start, n - k));

  // 시간 축은 초 단위 상대값으로 — ms 절대값을 쓰면 부동소수 정밀도가 무너진다.
  const x = (timeMs - t[start]) / 1000;
  const xs: number[] = [];
  for (let i = 0; i < k; i++) xs.push((t[start + i] - t[start]) / 1000);

  const p: [number, number, number] = [0, 0, 0];
  const v: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < k; i++) {
    let w = 1;
    for (let j = 0; j < k; j++) {
      if (j === i) continue;
      w *= (x - xs[j]) / (xs[i] - xs[j]);
    }
    for (let d = 0; d < 3; d++) {
      p[d] += w * pos[start + i][d];
      v[d] += w * vel[start + i][d];
    }
  }
  return { pos: p, vel: v };
}

/** RIC(radial / in-track / cross-track) 분해. 기준 궤도(ref)의 국소 좌표계 기준. */
export function ricDecompose(
  diff: readonly [number, number, number],
  refPos: readonly [number, number, number],
  refVel: readonly [number, number, number]
): { radial: number; alongTrack: number; crossTrack: number; total: number } {
  const nrm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
  const rn = nrm(refPos);
  const rHat = [refPos[0] / rn, refPos[1] / rn, refPos[2] / rn];
  const c = [
    refPos[1] * refVel[2] - refPos[2] * refVel[1],
    refPos[2] * refVel[0] - refPos[0] * refVel[2],
    refPos[0] * refVel[1] - refPos[1] * refVel[0],
  ];
  const cn = nrm(c);
  const cHat = [c[0] / cn, c[1] / cn, c[2] / cn];
  const iHat = [
    cHat[1] * rHat[2] - cHat[2] * rHat[1],
    cHat[2] * rHat[0] - cHat[0] * rHat[2],
    cHat[0] * rHat[1] - cHat[1] * rHat[0],
  ];
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return {
    radial: dot(rHat, diff),
    alongTrack: dot(iHat, diff),
    crossTrack: dot(cHat, diff),
    total: nrm(diff),
  };
}
