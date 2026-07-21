// 기동(maneuver) 감지 (고도화 §A3).
//
// 원리: 저궤도 물체의 반장축은 대기항력으로 단조 *감소*한다(평균운동은 증가).
// 추력을 쓰면 반장축이 급상승하고 평균운동이 급락한다 — 부호와 크기 모두 항력과 구분된다.
// ISS 실측(70일): 항력 +0.00015 rev/day/day vs 재부스트 Δn −0.005 ~ −0.006 (20~40배).
//
// 왜 중요한가: 기동이 일어나면 그 이전 TLE로 한 예측은 즉시 무효가 된다.
// 문서 §A1이 "km급 점프"로 분류한 오차원이며, 감지되면 원소를 재수집해야 한다.

export type Elset = {
  /** ISO UTC */
  epoch: string;
  /** rev/day */
  meanMotion: number;
  /** km */
  semiMajorAxis: number;
};

export type Maneuver = {
  /** 기동 구간 시작/끝 (관측된 두 원소의 epoch) */
  fromEpoch: string;
  toEpoch: string;
  /** 반장축 변화 (km, 양수 = 궤도 상승) */
  deltaSemiMajorKm: number;
  /** 평균운동 변화 (rev/day, 음수 = 상승) */
  deltaMeanMotion: number;
  /** 항력 기준선 대비 몇 배인지 — 신뢰도 지표 */
  sigmaRatio: number;
};

export type ManeuverAnalysis = {
  maneuvers: Maneuver[];
  /** 항력에 의한 통상 반장축 변화율 (km/일, 음수) */
  dragBaselineKmPerDay: number;
  sampleCount: number;
  spanDays: number;
};

/**
 * 반장축의 계단형 상승을 찾는다.
 *
 * 임계값을 고정 상수로 두지 않고 관측된 항력 잡음에서 유도한다 — 위성마다 고도·면적비가
 * 달라 항력 크기가 크게 다르기 때문이다(ISS와 정지궤도 위성에 같은 상수를 쓸 수 없다).
 */
export function detectManeuvers(
  elsets: readonly Elset[],
  opts: { minDeltaKm?: number; sigmaThreshold?: number } = {}
): ManeuverAnalysis {
  const minDeltaKm = opts.minDeltaKm ?? 0.15;
  const sigmaThreshold = opts.sigmaThreshold ?? 5;

  const sorted = [...elsets].sort((a, b) => Date.parse(a.epoch) - Date.parse(b.epoch));
  const n = sorted.length;
  if (n < 3) return { maneuvers: [], dragBaselineKmPerDay: 0, sampleCount: n, spanDays: 0 };

  const spanDays = (Date.parse(sorted[n - 1].epoch) - Date.parse(sorted[0].epoch)) / 86_400_000;

  // 구간별 반장축 변화율 (km/일)
  const rates: number[] = [];
  for (let i = 1; i < n; i++) {
    const dt = (Date.parse(sorted[i].epoch) - Date.parse(sorted[i - 1].epoch)) / 86_400_000;
    if (dt <= 0) {
      rates.push(0);
      continue;
    }
    rates.push((sorted[i].semiMajorAxis - sorted[i - 1].semiMajorAxis) / dt);
  }

  // 항력 기준선 = 감소 구간의 중앙값 (기동 구간은 양수라 자연히 제외된다).
  // 평균이 아니라 중앙값을 쓰는 이유: 기동 몇 건이 평균을 크게 오염시킨다.
  const decaying = rates.filter((r) => r < 0).sort((a, b) => a - b);
  const dragBaseline = decaying.length ? decaying[Math.floor(decaying.length / 2)] : 0;
  // 잡음 규모 = 감소 구간의 절대편차 중앙값(MAD) — 이상치에 강건하다
  const mad =
    decaying.length > 2
      ? median(decaying.map((r) => Math.abs(r - dragBaseline))) * 1.4826
      : Math.abs(dragBaseline) || 0.01;
  const noise = Math.max(mad, 1e-6);

  const maneuvers: Maneuver[] = [];
  let i = 0;
  while (i < n - 1) {
    const dA = sorted[i + 1].semiMajorAxis - sorted[i].semiMajorAxis;
    if (dA <= minDeltaKm) {
      i++;
      continue;
    }
    // 연속 구간을 하나의 기동으로 묶는다 (원소가 6시간 간격이라 한 기동이 여러 구간에 걸친다)
    let j = i + 1;
    while (j < n - 1 && sorted[j + 1].semiMajorAxis - sorted[j].semiMajorAxis > 0) j++;

    const totalDA = sorted[j].semiMajorAxis - sorted[i].semiMajorAxis;
    const dtDays = (Date.parse(sorted[j].epoch) - Date.parse(sorted[i].epoch)) / 86_400_000;
    const rate = dtDays > 0 ? totalDA / dtDays : totalDA;
    const sigma = Math.abs(rate - dragBaseline) / noise;

    if (totalDA > minDeltaKm && sigma >= sigmaThreshold) {
      maneuvers.push({
        fromEpoch: sorted[i].epoch,
        toEpoch: sorted[j].epoch,
        deltaSemiMajorKm: totalDA,
        deltaMeanMotion: sorted[j].meanMotion - sorted[i].meanMotion,
        sigmaRatio: sigma,
      });
    }
    i = j;
  }

  return { maneuvers, dragBaselineKmPerDay: dragBaseline, sampleCount: n, spanDays };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
