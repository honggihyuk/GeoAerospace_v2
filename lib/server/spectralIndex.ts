// Sentinel-2 분광지수(NDVI/NDWI/NBR) — STAC 검색 → COG 윈도우 읽기 → 지수·면적 통계.
//   설계원칙(결정론 = 숫자): 계산은 전부 여기서 하고 LLM은 반환값을 서술만 한다.
//   AWS geospatial-agent(ARCHITECTURE-ko.md §3)의 지수 정의·분류·면적 산출을 이식하되 아래를 교정했다.
//
//   ⚠️ 교정 1 — 스케일/오프셋: S2 L2A는 baseline 04.00부터 reflectance = DN*0.0001 - 0.1.
//      오프셋은 **덧셈**이라 (a-b)/(a+b)에서 분모가 상쇄되지 않는다. 원시 DN으로 계산하면 편향된다
//      (AWS 원본 ndvi_utils.py:76이 이 버그). STAC 자산의 scale/offset을 읽어 반드시 적용한다.
//   ⚠️ 교정 2 — nodata: DN 0은 nodata인데 스케일 적용하면 -0.1이라 유효값처럼 보인다 → 변환 전에 마스킹.
//   ⚠️ 교정 3 — 분모 0 보호: eps를 더한다(AWS는 NaN 마스킹에만 의존).
//   ⚠️ 해상도 정합: NBR은 nir08(B8A,20m)+swir22(B12,20m). 10m nir를 쓰면 격자가 어긋난다.
import { fromUrl } from "geotiff";
import proj4 from "proj4";
import { safeFetch, isAllowedHost } from "./safeFetch";
import { bboxCoverage } from "./geoUtil";

const STAC_URL = "https://earth-search.aws.element84.com/v1/search";
const EPS = 1e-10;
/** 분모 하한 — 두 밴드 반사율 합이 이보다 작으면 그림자/무효로 보고 제외(반사율 0.001 = 0.1%). */
const MIN_DENOM = 1e-3;
/**
 * 밝은 쪽 밴드의 최소 반사율. 두 밴드가 **모두 어두우면** 정규화 지수는 의미가 없고
 * 클램프로 인한 가짜 ±1만 남는다(지형그늘에서 NBR 중앙값 0.998로 연소 신호가 뒤집힌 실측).
 * 반대로 한쪽만 0이고 다른 쪽이 밝으면(울창한 식생의 적색 흡수, 수체의 NIR 흡수) 지수는 옳다.
 */
const MIN_BRIGHT = 0.02;
/** 출력 격자 한 변 상한 — 메모리/시간 제한(512² = 26만 픽셀). */
const MAX_PX = 512;

export type IndexName = "ndvi" | "ndwi" | "nbr";

/** 지수별 밴드쌍 — 값 = (a-b)/(a+b). res가 같은 밴드끼리만 짝짓는다. */
const INDEX_BANDS: Record<IndexName, { a: string; b: string; res: 10 | 20; formula: string }> = {
  ndvi: { a: "nir", b: "red", res: 10, formula: "(NIR B08 - Red B04)/(NIR + Red)" },
  ndwi: { a: "green", b: "nir", res: 10, formula: "(Green B03 - NIR B08)/(Green + NIR)" },
  nbr: { a: "nir08", b: "swir22", res: 20, formula: "(NIR08 B8A - SWIR2 B12)/(NIR08 + SWIR2)" },
};

export type Scene = { id: string; date: string; cloud: number | null; epsg: number; coverage: number; assets: Record<string, StacAsset> };
type StacAsset = { href: string; "raster:bands"?: { scale?: number; offset?: number; nodata?: number }[]; bands?: { scale?: number; offset?: number; nodata?: number }[] };
type Feature = { id: string; bbox: number[]; properties: Record<string, unknown>; assets: Record<string, StacAsset> };

export type IndexStats = {
  index: IndexName;
  formula: string;
  scene: { id: string; date: string; cloud: number | null; coverage_pct: number; epsg: number };
  grid: { width: number; height: number; pixel_m: number };
  valid_pixels: number;
  area_km2: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  classes: { name: string; label: string; pixels: number; area_m2: number; percentage: number }[];
};

/** EPSG(326xx/327xx) → proj4 UTM 정의. */
function utmDef(epsg: number): string {
  const north = epsg >= 32601 && epsg <= 32660;
  const zone = north ? epsg - 32600 : epsg - 32700;
  return `+proj=utm +zone=${zone} ${north ? "" : "+south "}+datum=WGS84 +units=m +no_defs`;
}

/** STAC 검색 — 기준일로부터 과거 days일. 결과 없으면 구름 한도를 올려 재시도(AWS 패턴). */
async function searchScenes(bbox: [number, number, number, number], dateStr: string | undefined, maxCloud: number, days = 60): Promise<Feature[]> {
  const end = dateStr ? new Date(`${dateStr}T23:59:59Z`) : new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  const body = (cloud: number) => ({
    collections: ["sentinel-2-l2a"],
    bbox,
    datetime: `${start.toISOString()}/${end.toISOString()}`,
    query: { "eo:cloud_cover": { lt: cloud } },
    limit: 50,
  });
  for (const cloud of [maxCloud, 80]) {
    const r = await safeFetch(STAC_URL, {
      method: "POST",
      body: JSON.stringify(body(cloud)),
      headers: { "content-type": "application/json" },
      accept: "application/geo+json, application/json",
      timeoutMs: 20_000,
    });
    if (!r.ok) throw new Error(`STAC ${r.status}`);
    const j = (await r.json()) as { features?: Feature[] };
    if (j.features?.length) return j.features;
    if (cloud === 80) break;
  }
  return [];
}

/**
 * 커버리지 최대 → (nearDate 지정 시)목표일 근접 → 구름 최소 순. 같은 입력이면 항상 같은 장면.
 * ⚠️ nearDate는 변화 탐지에 필수다 — 구름만 보고 고르면 "사건 직후"를 원해도 몇 주 전 장면이
 *    선택돼 계절 변화가 사건 신호를 덮는다(실측: 2월 vs 4월 비교에서 개엽이 연소를 상쇄).
 */
function pickScene(features: Feature[], bbox: [number, number, number, number], need: string[], nearDate?: string): Scene | null {
  const cands = features
    .filter((f) => need.every((b) => f.assets?.[b]?.href))
    .map((f) => ({
      id: f.id,
      date: String(f.properties.datetime ?? "").slice(0, 10),
      cloud: typeof f.properties["eo:cloud_cover"] === "number" ? (f.properties["eo:cloud_cover"] as number) : null,
      epsg: Number(f.properties["proj:epsg"] ?? 0),
      coverage: bboxCoverage(bbox, f.bbox),
      assets: f.assets,
    }))
    .filter((s) => s.epsg > 0 && s.coverage > 0);
  if (!cands.length) return null;
  const target = nearDate ? new Date(`${nearDate}T00:00:00Z`).getTime() : 0;
  const gap = (d: string) => (nearDate ? Math.abs(new Date(`${d}T00:00:00Z`).getTime() - target) : 0);
  cands.sort(
    (x, y) =>
      y.coverage - x.coverage ||
      gap(x.date) - gap(y.date) ||
      (x.cloud ?? 101) - (y.cloud ?? 101) ||
      x.id.localeCompare(y.id)
  );
  return cands[0];
}

type Band = { values: Float64Array; width: number; height: number; pixelM: number };

/**
 * AOI(bbox)만으로 출력 격자를 정한다 — 밴드 해상도와 무관하게 항상 동일.
 * 긴 변을 MAX_PX에 맞추고 **미터 기준 종횡비를 보존**한다(위도가 높을수록 경도 1°가 짧아지므로
 * 도(degree) 종횡비로 계산하면 찌그러진다).
 */
function targetGrid(epsg: number, bbox: [number, number, number, number]): { w: number; h: number; pixelM: number } {
  const def = utmDef(epsg);
  const [x0, y0] = proj4("EPSG:4326", def, [bbox[0], bbox[1]]) as number[];
  const [x1, y1] = proj4("EPSG:4326", def, [bbox[2], bbox[3]]) as number[];
  const wM = Math.abs(x1 - x0);
  const hM = Math.abs(y1 - y0);
  const aspect = hM > 0 ? wM / hM : 1;
  const w = aspect >= 1 ? MAX_PX : Math.max(1, Math.round(MAX_PX * aspect));
  const h = aspect >= 1 ? Math.max(1, Math.round(MAX_PX / aspect)) : MAX_PX;
  return { w, h, pixelM: wM / w };
}

/**
 * SCL(Scene Classification Layer)에서 **버릴** 클래스.
 *   0 nodata · 1 saturated · 3 cloud shadow · 8/9 cloud(중/고확률) · 10 thin cirrus · 11 snow/ice
 * ⚠️ 특히 **눈(11)** 이 중요하다 — 눈은 SWIR2가 극히 낮아 NBR이 0.8대로 치솟는다. 마스킹하지 않으면
 *    "적설 → 융설"이 dNBR에서 **식생 회복으로 오독**된다(실측: 울진 3/15 장면 NBR 중앙값 0.82,
 *    dNBR 평균 −0.35로 연소 신호가 완전히 뒤집혔다).
 */
// ⚠️ 2(dark/지형그늘)는 **넣지 않는다** — 겨울 산악(저태양고도) 장면은 그늘이 40%에 달해
//    유효면적이 0.08km²까지 붕괴한다(실측). 어두운 픽셀의 가짜 지수값은 음수 반사율을
//    NaN으로 버리는 처리(readBand)가 이미 제거하므로 여기서 또 버릴 필요가 없다.
const SCL_DROP = new Set([0, 1, 3, 8, 9, 10, 11]);

/** SCL 밴드(20m, 범주형)를 목표 격자로 읽는다. 범주형이라 최근접 리샘플이어야 한다(geotiff 기본값). */
async function readScl(asset: StacAsset, epsg: number, bbox: [number, number, number, number], w: number, h: number): Promise<Uint8Array | null> {
  try {
    if (!isAllowedHost(asset.href)) return null;
    const def = utmDef(epsg);
    const [x0, y0] = proj4("EPSG:4326", def, [bbox[0], bbox[1]]) as number[];
    const [x1, y1] = proj4("EPSG:4326", def, [bbox[2], bbox[3]]) as number[];
    const tiff = await fromUrl(asset.href);
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const W = img.getWidth(), H = img.getHeight();
    const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const left = cl(Math.floor((Math.min(x0, x1) - ox) / rx), 0, W - 1);
    const right = cl(Math.ceil((Math.max(x0, x1) - ox) / rx), left + 1, W);
    const top = cl(Math.floor((Math.max(y0, y1) - oy) / ry), 0, H - 1);
    const bottom = cl(Math.ceil((Math.min(y0, y1) - oy) / ry), top + 1, H);
    const rasters = (await img.readRasters({ window: [left, top, right, bottom], width: w, height: h })) as unknown as ArrayLike<number>[];
    return Uint8Array.from(rasters[0] as unknown as number[]);
  } catch {
    return null; // SCL 없거나 실패 → 마스킹 없이 진행(기존 동작)
  }
}

/**
 * COG에서 AOI 창만 Range 요청으로 읽는다(전체 밴드 다운로드 없음).
 * outW/outH를 강제하면 두 밴드의 격자가 정확히 정렬된다.
 */
async function readBand(asset: StacAsset, epsg: number, bbox: [number, number, number, number], force?: { w: number; h: number }): Promise<Band> {
  if (!isAllowedHost(asset.href)) throw new Error(`허용되지 않은 호스트: ${asset.href}`);
  const [minX, minY, maxX, maxY] = bbox;
  const def = utmDef(epsg);
  const [x0, y0] = proj4("EPSG:4326", def, [minX, minY]) as number[];
  const [x1, y1] = proj4("EPSG:4326", def, [maxX, maxY]) as number[];
  const west = Math.min(x0, x1), east = Math.max(x0, x1), south = Math.min(y0, y1), north = Math.max(y0, y1);

  const tiff = await fromUrl(asset.href);
  const img = await tiff.getImage();
  const [ox, oy] = img.getOrigin();
  const [rx, ry] = img.getResolution(); // ry는 음수(북→남)
  const W = img.getWidth(), H = img.getHeight();

  const cl = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const left = cl(Math.floor((west - ox) / rx), 0, W - 1);
  const right = cl(Math.ceil((east - ox) / rx), left + 1, W);
  const top = cl(Math.floor((north - oy) / ry), 0, H - 1);
  const bottom = cl(Math.ceil((south - oy) / ry), top + 1, H);

  const pxW = right - left, pxH = bottom - top;
  // ⚠️ 출력 격자는 **호출부가 AOI 기준으로 정해 강제**한다. 밴드 해상도(10m/20m)에 따라 각자
  //    정하면 NDVI(512x512)와 NBR(443x512)처럼 격자가 어긋나 변화 탐지에서 픽셀이 대응하지 않는다.
  const outW = force?.w ?? Math.max(1, Math.min(MAX_PX, pxW));
  const outH = force?.h ?? Math.max(1, Math.min(MAX_PX, pxH));

  const rasters = (await img.readRasters({ window: [left, top, right, bottom], width: outW, height: outH })) as unknown as (Uint16Array | Float32Array)[];
  const raw = rasters[0];

  // 스케일/오프셋 + nodata 마스킹. nodata(0)는 변환 전에 걸러야 한다(-0.1로 둔갑 방지).
  const meta = (asset["raster:bands"] ?? asset.bands ?? [{}])[0] ?? {};
  const scale = typeof meta.scale === "number" ? meta.scale : 1;
  const offset = typeof meta.offset === "number" ? meta.offset : 0;
  const nodata = typeof meta.nodata === "number" ? meta.nodata : 0;

  const values = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const dn = raw[i];
    if (dn === nodata) {
      values[i] = NaN;
      continue;
    }
    // ⚠️ 오프셋(-0.1) 적용 시 반사율이 음수로 내려가는 픽셀이 있다. 처리 규칙이 까다롭다:
    //    ① 그대로 두면 분모(a+b)가 0을 교차해 지수가 폭발한다(실측 -1197).
    //    ② 음수를 전부 NaN으로 버려도 안 된다 — 울창한 수관은 적색광을 거의 다 흡수해 반사율이
    //       0 근처라 **가장 건강한 식생이 통째로 지워진다**(실측: 센트럴 파크가 전부 투명,
    //       서울 초고밀도 식생 55.6%→20.6%).
    //    → 0으로 클램프한다. 한 밴드만 0이어도 다른 밴드가 밝으면 지수 ±1은 **물리적으로 옳다**
    //      (울창한 식생 NDVI≈1). 어두운 픽셀에서 생기는 가짜 ±1은 아래 MIN_BRIGHT가 걸러낸다.
    values[i] = Math.max(0, dn * scale + offset);
  }
  // 데시메이션 반영 유효 픽셀 크기(면적 산출용)
  const pixelM = Math.abs(rx) * (pxW / outW);
  return { values, width: outW, height: outH, pixelM };
}

/** 지수별 분류 구간(AWS 정의). NDWI는 실제 구현대로 0.1 이진 — 독스트링 불일치를 답습하지 않는다. */
function classify(index: IndexName, v: number): string {
  if (index === "ndvi") return v <= 0 ? "no_vegetation" : v <= 0.5 ? "light_vegetation" : v <= 0.7 ? "dense_vegetation" : "very_dense_vegetation";
  if (index === "ndwi") return v > 0.1 ? "water" : "non_water";
  return v > 0.1 ? "unburned" : v >= -0.1 ? "moderate_severity" : "high_severity";
}
const CLASS_LABEL: Record<string, string> = {
  // ⚠️ AWS 원본 라벨은 전 지구 기준(플랜테이션/우림)이라 한반도 낙엽수림에 붙으면 오해를 부른다.
  //    구간(NDVI 임계값)은 그대로 두고 표현만 중립화한다.
  no_vegetation: "식생 없음(물·나지·시가지)",
  light_vegetation: "저밀도 식생(초지·경작지·성긴 수목)",
  dense_vegetation: "고밀도 식생",
  very_dense_vegetation: "초고밀도 식생(울창한 수관)",
  water: "수체",
  non_water: "비수체",
  unburned: "미연소(건강 식생)",
  moderate_severity: "중간 심각도",
  high_severity: "고심각도(연소)",
};
const CLASS_ORDER: Record<IndexName, string[]> = {
  ndvi: ["no_vegetation", "light_vegetation", "dense_vegetation", "very_dense_vegetation"],
  ndwi: ["water", "non_water"],
  nbr: ["unburned", "moderate_severity", "high_severity"],
};

/** 픽셀별 지수 격자. 무효 픽셀은 NaN — 통계·PNG 렌더가 공유한다. */
export type IndexGrid = {
  values: Float64Array;
  width: number;
  height: number;
  pixelM: number;
  scene: Scene;
};

/** bbox 영역의 지수 격자 계산(통계·이미지 공통 경로). date 미지정 시 오늘 기준 과거 60일. */
export async function computeIndexGrid(
  index: IndexName,
  bbox: [number, number, number, number],
  opts: { date?: string; maxCloud?: number; days?: number; preferNearestDate?: boolean } = {}
): Promise<IndexGrid> {
  const { a, b } = INDEX_BANDS[index];
  // ⚠️ days는 변화 탐지에서 중요하다 — 창이 넓으면 "이후" 날짜로 조회해도 사건 **이전** 장면이
  //    선택돼 변화가 0으로 나온다. 호출부가 사건 전후를 확실히 가르도록 좁힐 수 있게 열어둔다.
  const features = await searchScenes(bbox, opts.date, opts.maxCloud ?? 30, opts.days ?? 60);
  if (!features.length) throw new Error("조건에 맞는 Sentinel-2 장면 없음(기간·구름 조건 확인)");
  const scene = pickScene(features, bbox, [a, b], opts.preferNearestDate ? opts.date : undefined);
  if (!scene) throw new Error(`장면에 필요한 밴드(${a}, ${b})가 없음`);

  // AOI 기준 공통 격자 — 밴드 해상도·지수 종류와 무관하게 항상 같은 크기라야
  // 두 시점/여러 지수의 픽셀이 지리적으로 대응한다(변화 탐지의 전제).
  const tg = targetGrid(scene.epsg, bbox);
  const [bandA, bandB, scl] = await Promise.all([
    readBand(scene.assets[a], scene.epsg, bbox, { w: tg.w, h: tg.h }),
    readBand(scene.assets[b], scene.epsg, bbox, { w: tg.w, h: tg.h }),
    scene.assets.scl ? readScl(scene.assets.scl, scene.epsg, bbox, tg.w, tg.h) : Promise.resolve(null),
  ]);

  const n = bandA.values.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // 구름·그림자·눈은 지수를 심하게 왜곡하므로 먼저 버린다(SCL 없으면 기존대로 진행).
    if (scl && SCL_DROP.has(scl[i])) {
      values[i] = NaN;
      continue;
    }
    const va = bandA.values[i], vb = bandB.values[i];
    const denom = va + vb;
    // 무효(nodata·그림자·분모 0)는 NaN — 통계에서 제외되고 PNG에선 투명해진다.
    if (Number.isNaN(va) || Number.isNaN(vb) || denom <= MIN_DENOM || Math.max(va, vb) < MIN_BRIGHT) {
      values[i] = NaN;
      continue;
    }
    const v = (va - vb) / (denom + EPS);
    values[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : NaN;
  }
  return { values, width: tg.w, height: tg.h, pixelM: tg.pixelM, scene };
}

/** bbox[w,s,e,n] 영역의 분광지수 통계. */
export async function computeIndex(
  index: IndexName,
  bbox: [number, number, number, number],
  opts: { date?: string; maxCloud?: number } = {}
): Promise<IndexStats> {
  const { formula } = INDEX_BANDS[index];
  const g = await computeIndexGrid(index, bbox, opts);
  const scene = g.scene;
  const bandA = { width: g.width, height: g.height, pixelM: g.pixelM };

  const vals: number[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < g.values.length; i++) {
    const v = g.values[i];
    if (Number.isNaN(v)) continue;
    vals.push(v);
    const c = classify(index, v);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  if (!vals.length) throw new Error("유효 픽셀 없음(전부 nodata/구름일 수 있음)");

  const pixelArea = bandA.pixelM * bandA.pixelM;
  const sorted = [...vals].sort((x, y) => x - y);
  const sum = vals.reduce((s, v) => s + v, 0);
  const total = vals.length;

  return {
    index,
    formula,
    scene: { id: scene.id, date: scene.date, cloud: scene.cloud, coverage_pct: Math.round(scene.coverage * 1000) / 10, epsg: scene.epsg },
    grid: { width: bandA.width, height: bandA.height, pixel_m: Math.round(bandA.pixelM * 10) / 10 },
    valid_pixels: total,
    area_km2: Math.round((total * pixelArea) / 1000) / 1000,
    min: Math.round(sorted[0] * 1e4) / 1e4,
    max: Math.round(sorted[total - 1] * 1e4) / 1e4,
    mean: Math.round((sum / total) * 1e4) / 1e4,
    median: Math.round(sorted[Math.floor(total / 2)] * 1e4) / 1e4,
    classes: CLASS_ORDER[index].map((name) => {
      const px = counts.get(name) ?? 0;
      return {
        name,
        label: CLASS_LABEL[name],
        pixels: px,
        area_m2: Math.round(px * pixelArea),
        percentage: Math.round((px / total) * 1000) / 10,
      };
    }),
  };
}
