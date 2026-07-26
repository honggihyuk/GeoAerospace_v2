// 레인 ①↔② 브리지: 관측(observations) → 지역 요약카드 텍스트.
// 카드를 임베딩해 region_cards에 저장하면 의미검색이 개념 doc과 함께 회수한다.
// 융합: 관측(화재·대기질·침하)에 더해 **지형(Terrarium DEM)** 과 **도로교통(ITS 돌발+소통)** 을
//       한 카드로 합성 → LLM이 다중소스를 교차 추론(예: 산악 저지대 침수구간에 통제 겹침)한다.
import { queryObservations, KIND_LABEL } from "./spatial";
import { sampleElevations } from "./demSample";
import { fetchIncidentsIts } from "./fetchIncidentIts";
import { fetchTrafficNear } from "./fetchTraffic";
import { fetchSarWaterStats } from "./sarStats";

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

// ── 지형 융합: Terrarium DEM 격자 샘플 → 표고·기복·평균경사·지형유형 한 줄. ─────────────
// 전역 Terrarium(z9, 305m 실측)이라 한반도 밖도 동작. 실패/수역이면 null.
async function terrainSummary(bbox: [number, number, number, number]): Promise<{ line: string; source: string; lowElevFrac: number } | null> {
  const [w, s, e, n] = bbox;
  const G = 18; // 18×18=324점 — z9 타일 몇 장으로 충분, 경사 분류엔 넉넉.
  const pts: { lon: number; lat: number }[] = [];
  for (let j = 0; j < G; j++) {
    const lat = s + (j / (G - 1)) * (n - s);
    for (let i = 0; i < G; i++) pts.push({ lon: w + (i / (G - 1)) * (e - w), lat });
  }
  let elev: (number | null)[];
  try {
    elev = await sampleElevations(pts);
  } catch {
    return null;
  }
  const land = elev.filter((v): v is number => v != null && v > -10);
  const validN = elev.filter((v) => v != null).length;
  if (!validN || land.length < G * G * 0.1) return null; // 대부분 수역/불명 → 지형 요약 생략
  const mn = Math.min(...land);
  const mx = Math.max(...land);
  const mean = land.reduce((a, b) => a + b, 0) / land.length;
  const relief = mx - mn;

  // 평균경사(%) — 내부 격자점의 중앙차분 기울기 크기. 격자 간격을 미터로 환산.
  const cLat = (s + n) / 2;
  const dxm = ((e - w) / (G - 1)) * 111_320 * Math.cos((cLat * Math.PI) / 180);
  const dym = ((n - s) / (G - 1)) * 110_540;
  let sg = 0;
  let sc = 0;
  const at = (i: number, j: number) => elev[j * G + i];
  for (let j = 1; j < G - 1; j++)
    for (let i = 1; i < G - 1; i++) {
      const c = at(i, j), l = at(i - 1, j), r = at(i + 1, j), u = at(i, j - 1), d = at(i, j + 1);
      if (c == null || l == null || r == null || u == null || d == null) continue;
      const gx = (r - l) / (2 * dxm);
      const gy = (d - u) / (2 * dym);
      sg += Math.hypot(gx, gy);
      sc++;
    }
  const slopePct = sc ? (sg / sc) * 100 : 0;
  const terr = relief < 100 && slopePct < 3 ? "평지" : relief < 500 && slopePct < 10 ? "구릉지" : "산악";
  const waterNote = validN - land.length > validN * 0.3 ? " (해안/수역 포함)" : "";
  // 저지대(≤20m) 비율 — SAR 저후방산란과 융합해 침수 취약도를 추정하는 데 쓴다.
  const lowElevFrac = land.filter((v) => v <= 20).length / land.length;
  return {
    line: `지형(Terrarium 30m): 표고 ${Math.round(mn)}~${Math.round(mx)} m·평균 ${Math.round(mean)} m, 기복 ${Math.round(relief)} m, 평균경사 ${slopePct.toFixed(1)}% — ${terr}, 저지대(≤20m) ${Math.round(lowElevFrac * 100)}%${waterNote}.`,
    source: "AWS Terrarium DEM(실측 지형고도)",
    lowElevFrac,
  };
}

// ── SAR 융합: Sentinel-1 저후방산란(수면·평활면 추정) 비율 한 줄. 미설정/실패면 null. ─────────
async function sarWaterSummary(bbox: [number, number, number, number]): Promise<{ line: string; source: string; waterPct: number } | null> {
  const st = await fetchSarWaterStats(bbox);
  if (!st) return null;
  return {
    line: `SAR(Sentinel-1 VV, 최근45일): 저후방산란(수면·평활면 추정) ${st.waterPct.toFixed(0)}% · 평균레벨 ${Math.round(st.meanVal)}/255 · 유효 ${st.validPct.toFixed(0)}%.`,
    source: "Sentinel-1 GRD(Copernicus DataSpace)",
    waterPct: st.waterPct,
  };
}

// ── 교통 융합: ITS 실시간 돌발 종류별 집계 + bbox 중심 대표 소통속도. 한반도 밖이면 null. ──
const INCIDENT_LABEL: Record<string, string> = { accident: "사고", construction: "공사", control: "통제", event: "행사", weather: "기상", other: "기타" };
async function trafficSummary(bbox: [number, number, number, number]): Promise<{ line: string; source: string } | null> {
  const [w, s, e, n] = bbox;
  const cLon = (w + e) / 2;
  const cLat = (s + n) / 2;
  if (!(cLon > 123 && cLon < 132.5 && cLat > 32.5 && cLat < 39.5)) return null; // ITS=한반도 전용

  let incidentLine = "";
  let source = "ITS 국가교통정보센터";
  try {
    const { items, source: src, sample } = await fetchIncidentsIts(bbox);
    // 데모키는 bbox 무시(전국 고정) → bbox로 직접 필터. 실키는 이미 bbox 범위.
    const use = items.filter((it) => it.lon >= w && it.lon <= e && it.lat >= s && it.lat <= n);
    if (use.length) {
      const byKind: Record<string, number> = {};
      for (const it of use) byKind[it.kind] = (byKind[it.kind] ?? 0) + 1;
      const parts = Object.entries(byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, c]) => `${INCIDENT_LABEL[k] ?? k} ${c}`)
        .join("·");
      const important = use
        .filter((it) => it.important)
        .slice(0, 3)
        .map((it) => `${it.road ? it.road + " " : ""}${it.title}`.slice(0, 40));
      incidentLine = `실시간 돌발 ${use.length}건(${parts})${important.length ? `. 주요: ${important.join("; ")}` : ""}`;
      source = src + (sample ? " ⚠데모키(전국고정)" : "");
    } else {
      incidentLine = "실시간 돌발 0건";
    }
  } catch {
    /* 돌발 실패 → 소통만이라도 */
  }

  let speedLine = "";
  try {
    const t = await fetchTrafficNear(cLon, cLat);
    if (t && t.dirs.length) {
      const slow = t.dirs[0]; // 느린 방면부터 정렬됨
      const second = t.dirs[1] ? `·${t.dirs[1].label} ${t.dirs[1].speed}km/h` : "";
      speedLine = ` 소통: ${t.road} ${slow.label} ${slow.speed}km/h${second}(${t.precise ? "방면별 실측" : "근사"}).`;
    }
  } catch {
    /* 소통 실패 → 돌발만 */
  }

  if (!incidentLine && !speedLine) return null;
  return { line: `도로교통(UTIC/ITS): ${incidentLine || "돌발 불명"}.${speedLine}`, source };
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
  // incident(돌발)은 아래 trafficSummary가 종류별로 상세 서술 → 여기 일반 집계에선 제외(중복 방지).
  const aqKinds = [...g.keys()].filter((k) => !fireKinds.includes(k) && k !== "subsidence" && k !== "incident").sort();

  const lines: string[] = [];
  lines.push(`지역 관측 요약카드 — ${place}. 관측 bbox ${bbox.join(",")}. 생성 ${generatedAt.slice(0, 10)}.`);
  if (fireKinds.length) lines.push(`화재·화산: ${fireKinds.map((k) => statPhrase(k, g.get(k)!)).join("; ")}.`);
  else lines.push("활성 화재 0건.");
  if (hasSubs) lines.push(`지반변위(InSAR): ${statPhrase("subsidence", g.get("subsidence")!)}.`);
  if (aqKinds.length) lines.push(`대기질(OpenAQ 최신): ${aqKinds.map((k) => statPhrase(k, g.get(k)!)).join("; ")}.`);
  if (latest) lines.push(`최신 관측시각 ${latest.slice(0, 16).replace("T", " ")}Z.`);
  if (obs.length === 0) lines.push("활성 관측(화재·대기질·침하) 데이터 없음.");

  // 지형·SAR·교통 융합(best-effort, 병렬) — 한쪽 실패가 카드를 막지 않게 격리.
  const extraSources: string[] = [];
  const [terrain, sar, traffic] = await Promise.all([
    terrainSummary(bbox).catch(() => null),
    sarWaterSummary(bbox).catch(() => null),
    trafficSummary(bbox).catch(() => null),
  ]);
  if (terrain) {
    lines.push(terrain.line);
    extraSources.push(terrain.source);
  }
  if (sar) {
    lines.push(sar.line);
    extraSources.push(sar.source);
  }
  // 침수 취약도 융합 — 저지대(DEM) × 저후방산란(SAR)이 함께 높으면 침수·상시수체 가능 구간.
  //   ⚠️ 단일시점 추정(확정 아님) — 정밀 판정엔 강우 전후 SAR 변화가 필요함을 명시.
  if (terrain && sar && terrain.lowElevFrac >= 0.25 && sar.waterPct >= 15) {
    lines.push(
      `침수 취약도(융합): 저지대(≤20m) ${Math.round(terrain.lowElevFrac * 100)}% × SAR 저후방산란 ${Math.round(sar.waterPct)}% — 침수·상시수체 가능 구간. 정밀 판정엔 강우 전후 SAR 변화 필요.`
    );
  }
  if (traffic) {
    lines.push(traffic.line);
    extraSources.push(traffic.source);
  }

  const srcLabel = (s: string) =>
    s === "firms"
      ? "NASA FIRMS"
      : s === "openaq"
        ? "OpenAQ"
        : s === "its"
          ? "ITS 돌발(관측적재)"
          : s === "insar-ngu"
            ? "InSAR Norway(NGU 실측)"
            : s.includes("insar")
              ? `${s}(InSAR${s.includes("demo") ? " 합성데모" : ""})`
              : s;
  const sources = [...new Set(obs.map((o) => o.source))].map(srcLabel);
  lines.push(`데이터 출처: ${[...sources, ...extraSources].join(", ") || "없음"}.`);

  return {
    id: `card:${place}`,
    place,
    bbox,
    body: lines.join(" "),
    kinds,
    generatedAt,
  };
}
