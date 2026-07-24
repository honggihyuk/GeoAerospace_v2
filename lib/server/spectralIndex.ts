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

const STAC_URL = "https://earth-search.aws.element84.com/v1/search";
const EPS = 1e-10;
/** 분모 하한 — 두 밴드 반사율 합이 이보다 작으면 그림자/무효로 보고 제외(반사율 0.001 = 0.1%). */
const MIN_DENOM = 1e-3;
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

/** 사각형 교차 면적 비율 — 래스터 I/O 없는 순수 기하(결정론적 장면 선택). */
function coverage(aoi: [number, number, number, number], item: number[]): number {
  const w = Math.max(0, Math.min(aoi[2], item[2]) - Math.max(aoi[0], item[0]));
  const h = Math.max(0, Math.min(aoi[3], item[3]) - Math.max(aoi[1], item[1]));
  const a = (aoi[2] - aoi[0]) * (aoi[3] - aoi[1]);
  return a > 0 ? (w * h) / a : 0;
}

/** 커버리지 최대 → 구름 최소 순. 같은 AOI면 항상 같은 장면을 고른다. */
function pickScene(features: Feature[], bbox: [number, number, number, number], need: string[]): Scene | null {
  const cands = features
    .filter((f) => need.every((b) => f.assets?.[b]?.href))
    .map((f) => ({
      id: f.id,
      date: String(f.properties.datetime ?? "").slice(0, 10),
      cloud: typeof f.properties["eo:cloud_cover"] === "number" ? (f.properties["eo:cloud_cover"] as number) : null,
      epsg: Number(f.properties["proj:epsg"] ?? 0),
      coverage: coverage(bbox, f.bbox),
      assets: f.assets,
    }))
    .filter((s) => s.epsg > 0 && s.coverage > 0);
  if (!cands.length) return null;
  cands.sort((x, y) => y.coverage - x.coverage || (x.cloud ?? 101) - (y.cloud ?? 101) || x.id.localeCompare(y.id));
  return cands[0];
}

type Band = { values: Float64Array; width: number; height: number; pixelM: number };

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
    // ⚠️ 오프셋(-0.1) 적용 시 어두운 픽셀(그림자·수면)은 반사율이 음수가 된다.
    //    음수를 그대로 두면 분모(a+b)가 0을 교차해 지수가 [-1,1]을 벗어나 폭발한다(실측 -1197).
    //    반사율은 물리적으로 ≥0이므로 0으로 클램프하면 |(a-b)/(a+b)| ≤ 1 이 수학적으로 보장된다.
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
  no_vegetation: "식생 없음(물·암반·인공구조물)",
  light_vegetation: "저밀도 식생(관목·초지·경작지)",
  dense_vegetation: "고밀도 식생(플랜테이션)",
  very_dense_vegetation: "초고밀도 식생(우림)",
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

/** bbox[w,s,e,n] 영역의 분광지수 통계. date 미지정 시 오늘 기준 과거 60일. */
export async function computeIndex(
  index: IndexName,
  bbox: [number, number, number, number],
  opts: { date?: string; maxCloud?: number } = {}
): Promise<IndexStats> {
  const { a, b, formula } = INDEX_BANDS[index];
  const features = await searchScenes(bbox, opts.date, opts.maxCloud ?? 30);
  if (!features.length) throw new Error("조건에 맞는 Sentinel-2 장면 없음(기간·구름 조건 확인)");
  const scene = pickScene(features, bbox, [a, b]);
  if (!scene) throw new Error(`장면에 필요한 밴드(${a}, ${b})가 없음`);

  const bandA = await readBand(scene.assets[a], scene.epsg, bbox);
  const bandB = await readBand(scene.assets[b], scene.epsg, bbox, { w: bandA.width, h: bandA.height });

  const n = bandA.values.length;
  const vals: number[] = [];
  const counts = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const va = bandA.values[i], vb = bandB.values[i];
    if (Number.isNaN(va) || Number.isNaN(vb)) continue;
    const denom = va + vb;
    if (denom <= MIN_DENOM) continue; // 두 밴드 모두 사실상 0(그림자·nodata 잔여) → 지수 의미 없음
    let v = (va - vb) / (denom + EPS);
    if (!Number.isFinite(v)) continue;
    v = Math.max(-1, Math.min(1, v)); // 수치 오차 대비 최종 가드
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
