// 두 시점 변화 탐지 (Tier 1 — 분광지수 가중 합성) + dNBR 연소 심각도.
//   AWS geospatial-agent(ARCHITECTURE-ko.md §4.3)의 Tier 1을 이식. Tier 2(iMAD)는 SVD/CCA·χ²가
//   필요해 Node에선 비용 대비 효용이 낮아 생략했다(문서 권고와 별개로 의도적 결정).
//
//   ⚠️ dNBR을 함께 내는 이유: **절대 NBR로 연소를 판정하는 건 약하다.** 물·시가지·나지도 NBR이
//      음수라 "고심각도"로 잡힌다(실측: 최근 화재가 없던 강릉에서 2.3%). 산불 피해는 화재 전후
//      차이인 dNBR = NBR(전) - NBR(후) 로 봐야 한다. AWS가 이벤트 전/후 날짜를 브래킷하도록
//      프롬프트로 강제하는 이유(config.py:71-87)가 이것이다.
import { computeIndexGrid, type IndexName } from "./spectralIndex";

/** Tier 1 가중치(AWS INDEX_WEIGHTS). BSI(0.35)는 4밴드 혼합해상도라 v1에서 제외 — 총가중치로 정규화되므로 스케일은 유지된다. */
const WEIGHTS: Partial<Record<IndexName, number>> = { ndvi: 0.35, ndwi: 0.15, nbr: 0.15 };

/** 합성 변화 점수 구간(AWS CHANGE_THRESHOLDS). */
const CHANGE_CLASSES: { name: string; label: string; min: number; max: number }[] = [
  { name: "none", label: "변화 없음", min: -Infinity, max: 0.05 },
  { name: "low", label: "낮음", min: 0.05, max: 0.15 },
  { name: "moderate", label: "중간", min: 0.15, max: 0.3 },
  { name: "high", label: "높음", min: 0.3, max: Infinity },
];

/** dNBR 연소 심각도(USGS 표준 구간). */
const DNBR_CLASSES: { name: string; label: string; min: number; max: number }[] = [
  { name: "regrowth", label: "식생 회복", min: -Infinity, max: -0.1 },
  { name: "unburned", label: "미연소", min: -0.1, max: 0.1 },
  { name: "low", label: "저심각도", min: 0.1, max: 0.27 },
  { name: "moderate_low", label: "중저심각도", min: 0.27, max: 0.44 },
  { name: "moderate_high", label: "중고심각도", min: 0.44, max: 0.66 },
  { name: "high", label: "고심각도", min: 0.66, max: Infinity },
];

export type ClassStat = { name: string; label: string; pixels: number; area_m2: number; percentage: number };
export type ChangeResult = {
  bbox: [number, number, number, number];
  from: { date: string; scenes: Record<string, string> };
  to: { date: string; scenes: Record<string, string> };
  grid: { width: number; height: number; pixel_m: number };
  indices_used: IndexName[];
  valid_pixels: number;
  area_km2: number;
  /** 유효 픽셀 비율 0~1 — 구름·그늘 마스킹 후 남은 비율. 낮으면 통계를 신뢰하면 안 된다. */
  valid_fraction: number;
  warning: string | null;
  composite: { mean: number; max: number; changed_area_m2: number; classes: ClassStat[] };
  dnbr: { mean: number; max: number; burned_area_m2: number; classes: ClassStat[] } | null;
  note: string;
};

function classifyBy(defs: { name: string; label: string; min: number; max: number }[], v: number): string {
  for (const d of defs) if (v >= d.min && v < d.max) return d.name;
  return defs[defs.length - 1].name;
}

function tally(
  defs: { name: string; label: string; min: number; max: number }[],
  values: (number | null)[],
  pixelArea: number
): ClassStat[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (const v of values) {
    if (v === null) continue;
    total++;
    const c = classifyBy(defs, v);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return defs.map((d) => {
    const px = counts.get(d.name) ?? 0;
    return {
      name: d.name,
      label: d.label,
      pixels: px,
      area_m2: Math.round(px * pixelArea),
      percentage: total ? Math.round((px / total) * 1000) / 10 : 0,
    };
  });
}

/**
 * bbox 영역의 두 시점 변화. from/to는 각각 그 날짜 기준 과거 60일에서 장면을 고른다.
 * 같은 bbox·같은 출력 격자로 리샘플하므로 두 시점 픽셀이 지리적으로 대응한다.
 */
export async function computeChange(
  bbox: [number, number, number, number],
  fromDate: string,
  toDate: string,
  opts: { maxCloud?: number; windowDays?: number } = {}
): Promise<ChangeResult> {
  const indices = Object.keys(WEIGHTS) as IndexName[];
  const cloud = opts.maxCloud ?? 40;
  const WINDOW_DAYS = opts.windowDays ?? 30; // 좁은 창으로 사건 전후를 확실히 가른다

  // 6회 COG 읽기를 병렬로(지수 3 × 시점 2).
  const grids = await Promise.all(
    indices.flatMap((idx) => [
      computeIndexGrid(idx, bbox, { date: fromDate, maxCloud: cloud, days: WINDOW_DAYS, preferNearestDate: true }).then((g) => ({ idx, when: "from" as const, g })),
      computeIndexGrid(idx, bbox, { date: toDate, maxCloud: cloud, days: WINDOW_DAYS, preferNearestDate: true }).then((g) => ({ idx, when: "to" as const, g })),
    ])
  );

  const get = (idx: IndexName, when: "from" | "to") => grids.find((x) => x.idx === idx && x.when === when)!.g;

  // 격자 정합 확인 — 같은 bbox·같은 해상도면 동일해야 한다. 어긋나면 조용히 틀린 결과가 나오므로 즉시 실패.
  const base = get(indices[0], "from");
  for (const { idx, when, g } of grids) {
    if (g.width !== base.width || g.height !== base.height) {
      throw new Error(`격자 불일치(${idx}/${when}: ${g.width}x${g.height} ≠ ${base.width}x${base.height}) — 지수별 해상도 차이`);
    }
  }

  const n = base.values.length;
  const pixelArea = base.pixelM * base.pixelM;
  const totalW = indices.reduce((s, i) => s + (WEIGHTS[i] ?? 0), 0);

  const composite: (number | null)[] = new Array(n).fill(null);
  const dnbr: (number | null)[] = new Array(n).fill(null);
  let compSum = 0, compMax = 0, compCount = 0, changedPx = 0;
  let dnbrSum = 0, dnbrMax = -Infinity, dnbrCount = 0, burnedPx = 0;

  const nbrFrom = get("nbr", "from").values;
  const nbrTo = get("nbr", "to").values;

  for (let i = 0; i < n; i++) {
    // 합성: Σ w|Δ| / Σw. 한 지수라도 무효면 그 지수는 빠지고 가중치도 빠진다(스케일 유지).
    let acc = 0, wsum = 0;
    for (const idx of indices) {
      const a = get(idx, "from").values[i];
      const b = get(idx, "to").values[i];
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      const w = WEIGHTS[idx] ?? 0;
      acc += w * Math.abs(b - a);
      wsum += w;
    }
    // 가중치 절반 이상이 살아있을 때만 신뢰(구름 낀 픽셀이 한 지수만으로 판정되는 것 방지).
    if (wsum >= totalW * 0.5) {
      const v = Math.min(1, acc / wsum);
      composite[i] = v;
      compSum += v;
      compMax = Math.max(compMax, v);
      compCount++;
      if (v >= 0.05) changedPx++;
    }
    // dNBR = NBR(전) - NBR(후). 양수 = 연소.
    const a = nbrFrom[i], b = nbrTo[i];
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      const d = a - b;
      dnbr[i] = d;
      dnbrSum += d;
      dnbrMax = Math.max(dnbrMax, d);
      dnbrCount++;
      if (d >= 0.27) burnedPx++; // 중저심각도 이상을 "연소"로 집계
    }
  }

  if (!compCount) throw new Error("유효 픽셀 없음(두 시점 모두 구름/nodata일 수 있음)");

  const sceneOf = (when: "from" | "to") =>
    Object.fromEntries(indices.map((i) => [i, `${get(i, when).scene.id} (${get(i, when).scene.date})`]));

  return {
    bbox,
    from: { date: fromDate, scenes: sceneOf("from") },
    to: { date: toDate, scenes: sceneOf("to") },
    grid: { width: base.width, height: base.height, pixel_m: Math.round(base.pixelM * 10) / 10 },
    indices_used: indices,
    valid_pixels: compCount,
    area_km2: Math.round((compCount * pixelArea) / 1000) / 1000,
    valid_fraction: Math.round((compCount / n) * 1000) / 1000,
    // ⚠️ 조용한 저품질 결과 금지 — 유효 픽셀이 적으면 남은 픽셀이 편향돼 통계가 무의미하다
    //    (실측: 겨울 산악 장면은 지형그늘·구름으로 2%만 남아 dNBR 부호가 뒤집혔다).
    warning:
      compCount / n < 0.3
        ? `유효 픽셀 ${Math.round((compCount / n) * 100)}%뿐 — 구름·그늘로 대부분 마스킹됨. 다른 날짜(구름 적은 시기)로 재시도 권장. 이 수치는 신뢰하지 말 것.`
        : null,
    composite: {
      mean: Math.round((compSum / compCount) * 1e4) / 1e4,
      max: Math.round(compMax * 1e4) / 1e4,
      changed_area_m2: Math.round(changedPx * pixelArea),
      classes: tally(CHANGE_CLASSES, composite, pixelArea),
    },
    dnbr: dnbrCount
      ? {
          mean: Math.round((dnbrSum / dnbrCount) * 1e4) / 1e4,
          max: Math.round(dnbrMax * 1e4) / 1e4,
          burned_area_m2: Math.round(burnedPx * pixelArea),
          classes: tally(DNBR_CLASSES, dnbr, pixelArea),
        }
      : null,
    note: "합성=Σw|Δ지수|/Σw (NDVI .35, NDWI .15, NBR .15; BSI 미포함). dNBR=NBR(전)-NBR(후), 양수가 연소.",
  };
}
