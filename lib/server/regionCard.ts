// 레인 ①↔② 브리지: 관측(observations) → 지역 요약카드 텍스트.
// 카드를 임베딩해 region_cards에 저장하면 의미검색이 개념 doc과 함께 회수한다.
import { queryObservations, KIND_LABEL } from "./spatial";

export type RegionCard = {
  id: string;
  place: string;
  bbox: [number, number, number, number];
  body: string;
  kinds: Record<string, number>; // 종류별 관측 수
  generatedAt: string;
};

type Agg = { n: number; sum: number; max: number; min: number; unit: string; demo: boolean };

// 값 크기에 맞춘 자릿수 — ppm 가스(0.0x)는 뭉개지지 않게, µg/m³·MW(수십~수천)는 간결하게.
function fmt(v: number): number {
  const a = Math.abs(v);
  if (a >= 10) return Math.round(v);
  if (a >= 1) return Math.round(v * 10) / 10;
  return Math.round(v * 1000) / 1000;
}

/** 종류별 집계 → "라벨 최대 X·평균 Y unit(n건)" 조각. */
function statPhrase(kind: string, a: Agg): string {
  const label = KIND_LABEL[kind] ?? kind;
  const unit = a.unit ? ` ${a.unit}` : "";
  if (a.n === 0 || a.max === -Infinity) return `${label} ${a.n}건`;
  const demo = a.demo ? " ⚠합성데모(실측아님)" : "";
  // 침하는 음수(mm/yr)라 가장 빠른 침하 = min. 부호를 뒤집어 "침하속도"로 표기.
  if (kind === "subsidence") {
    return `${label} 최대 ${fmt(-a.min)}·평균 ${fmt(-a.sum / a.n)}${unit}(${a.n}건, 음수=침하)${demo}`;
  }
  return `${label} 최대 ${fmt(a.max)}·평균 ${fmt(a.sum / a.n)}${unit}(${a.n}건)${demo}`;
}

/** 지역의 관측을 집계해 요약카드를 만든다. observedAt 최신값도 카드에 남긴다. */
export async function buildRegionCard(place: string, bbox: [number, number, number, number]): Promise<RegionCard> {
  const generatedAt = new Date().toISOString();
  const obs = await queryObservations(bbox, { limit: 500 });

  const g = new Map<string, Agg>();
  let latest = "";
  for (const o of obs) {
    const e = g.get(o.kind) ?? { n: 0, sum: 0, max: -Infinity, min: Infinity, unit: o.unit ?? "", demo: false };
    e.n++;
    if (o.value != null) {
      e.sum += o.value;
      if (o.value > e.max) e.max = o.value;
      if (o.value < e.min) e.min = o.value;
    }
    if (!e.unit && o.unit) e.unit = o.unit;
    if (o.source.includes("demo")) e.demo = true;
    g.set(o.kind, e);
    if (o.observedAt && o.observedAt > latest) latest = o.observedAt;
  }

  const kinds: Record<string, number> = {};
  for (const [k, a] of g) kinds[k] = a.n;

  // 화재/화산 먼저, 지반침하, 그다음 대기질(가나다 정렬)로 카드 본문을 구성.
  const fireKinds = ["fire", "volcano"].filter((k) => g.has(k));
  const hasSubs = g.has("subsidence");
  const aqKinds = [...g.keys()].filter((k) => !fireKinds.includes(k) && k !== "subsidence").sort();

  const lines: string[] = [];
  lines.push(`지역 관측 요약카드 — ${place}. 관측 bbox ${bbox.join(",")}. 생성 ${generatedAt.slice(0, 10)}.`);
  if (fireKinds.length) lines.push(`화재·화산: ${fireKinds.map((k) => statPhrase(k, g.get(k)!)).join("; ")}.`);
  else lines.push("활성 화재 0건.");
  if (hasSubs) lines.push(`지반변위(InSAR): ${statPhrase("subsidence", g.get("subsidence")!)}.`);
  if (aqKinds.length) lines.push(`대기질(OpenAQ 최신): ${aqKinds.map((k) => statPhrase(k, g.get(k)!)).join("; ")}.`);
  if (latest) lines.push(`최신 관측시각 ${latest.slice(0, 16).replace("T", " ")}Z.`);
  if (obs.length === 0) lines.push("해당 영역 관측 데이터 없음.");

  const srcLabel = (s: string) =>
    s === "firms"
      ? "NASA FIRMS"
      : s === "openaq"
        ? "OpenAQ"
        : s === "insar-ngu"
          ? "InSAR Norway(NGU 실측)"
          : s.includes("insar")
            ? `${s}(InSAR${s.includes("demo") ? " 합성데모" : ""})`
            : s;
  const sources = new Set(obs.map((o) => o.source));
  lines.push(`데이터 출처: ${[...sources].map(srcLabel).join(", ") || "없음"}.`);

  return {
    id: `card:${place}`,
    place,
    bbox,
    body: lines.join(" "),
    kinds,
    generatedAt,
  };
}
