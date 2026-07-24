// 광역 토지 변화 스캔 (AWS scan_region_change 이식) — Clay v1.5 지구관측 임베딩 코사인 유사도.
//   두 시점(연-월)의 **같은 셀(cell_id) 임베딩을 조인**해 코사인 유사도를 재고, 낮을수록 변화가 크다.
//   픽셀 연산이 아니라 1.28km 셀 단위라 주/국가 규모를 초 단위로 훑는다(픽셀 변화탐지의 상위 계층).
//
//   데이터: LGND 공개 Clay 임베딩(GeoParquet, 256차원, CC BY 4.0)
//     data.source.coop/clay/lgnd-embeddings/monthly-aggregated/.../geohash={gh}/year={y}/month={m}/
//   ⚠️ 파티션 하나가 ~240MB라 다운+파싱에 시점당 ~26초. maxDuration을 넉넉히.
//   ⚠️ 캘리브레이션: AWS 고정 상수(SIM_HIGH 0.90)는 콜로라도 야생지 기준이라 도시가 많은 지역에선
//      안정지역도 변화로 과대보고된다(실측: 서울 코사인 중앙값 0.794 → 32%가 점수>0.5).
//      → **지역 자체 분포의 백분위수로 정규화**하는 적응형 방식을 쓴다(문서의 compute_adaptive_thresholds 취지).
import { readParquet } from "parquet-wasm";
import { tableFromIPC } from "apache-arrow";
import { isAllowedHost } from "./safeFetch";

const BASE = "https://data.source.coop/clay";
const PREFIX = "lgnd-embeddings/monthly-aggregated/model_version=v1.5/collection=sentinel-2-l2a/chip_size=1280m/dims=256";
/** 코사인 이 값 미만은 구름/눈/nodata 아티팩트로 보고 폐기(AWS ARTIFACT_SIM_FLOOR). */
const ARTIFACT_FLOOR = 0.3;

/** WGS84 → geohash precision-2 (base32 비트 인터리빙). Clay 파티션 키. */
export function geohash2(lat: number, lon: number): string {
  const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  let la = [-90, 90], lo = [-180, 180], hash = "", bits = 0, ch = 0, even = true;
  while (hash.length < 2) {
    if (even) {
      const m = (lo[0] + lo[1]) / 2;
      if (lon > m) { ch = (ch << 1) | 1; lo[0] = m; } else { ch <<= 1; lo[1] = m; }
    } else {
      const m = (la[0] + la[1]) / 2;
      if (lat > m) { ch = (ch << 1) | 1; la[0] = m; } else { ch <<= 1; la[1] = m; }
    }
    even = !even;
    if (++bits === 5) { hash += B32[ch]; bits = 0; ch = 0; }
  }
  return hash;
}

/** bbox를 덮는 precision-2 지오해시들(경계에 걸치면 여러 개). */
export function geohashesForBbox(bbox: [number, number, number, number]): string[] {
  const set = new Set<string>();
  const [w, s, e, n] = bbox;
  // precision-2 셀은 ~1250km라 관심 AOI(≤수백km)는 보통 1~4개. 모서리·중심 샘플로 충분.
  for (const la of [s, (s + n) / 2, n]) for (const lo of [w, (w + e) / 2, e]) set.add(geohash2(la, lo));
  return [...set];
}

async function firstParquetKey(gh: string, ym: string): Promise<string | null> {
  const prefix = `${PREFIX}/geohash=${gh}/year=${ym.slice(0, 4)}/month=${ym.slice(5)}/`;
  const r = await fetch(`${BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1`);
  if (!r.ok) return null;
  const t = await r.text();
  return t.match(/<Key>([^<]+)<\/Key>/)?.[1] ?? null;
}

type Cell = { v: Float32Array; cx: number; cy: number };

// 파티션(gh:ym)당 **전체 셀 맵**을 캐시한다 — bbox는 스캔 시 필터하므로 같은 지오해시의 다른 AOI가
// 재다운로드(240MB/26s) 없이 재사용된다. ⚠️ 하나가 ~240MB라 LRU 2개로 제한(≈480MB).
const CACHE_MAX = 2;
const partCache = new Map<string, Map<string, Cell>>();

async function loadPartition(gh: string, ym: string): Promise<Map<string, Cell>> {
  const ck = `${gh}:${ym}`;
  const hit = partCache.get(ck);
  if (hit) {
    partCache.delete(ck);
    partCache.set(ck, hit); // LRU 갱신
    return hit;
  }
  const key = await firstParquetKey(gh, ym);
  const out = new Map<string, Cell>();
  if (key) {
    const url = `${BASE}/${key}`;
    if (!isAllowedHost(url)) throw new Error(`허용되지 않은 호스트: ${url}`);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const table = tableFromIPC(readParquet(buf).intoIPCStream());
    const cid = table.getChild("cell_id")!;
    const bb = table.getChild("bbox")!;
    const emb = table.getChild("embedding")!;
    for (let i = 0; i < table.numRows; i++) {
      const b = bb.get(i) as { xmin: number; ymin: number; xmax: number; ymax: number };
      out.set(cid.get(i) as string, { v: Float32Array.from(emb.get(i) as number[]), cx: (b.xmin + b.xmax) / 2, cy: (b.ymin + b.ymax) / 2 });
    }
  }
  partCache.set(ck, out);
  while (partCache.size > CACHE_MAX) partCache.delete(partCache.keys().next().value!);
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

const pctile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);

export type RegionChangeCell = { cx: number; cy: number; sim: number; score: number };
export type RegionChangeResult = {
  bbox: [number, number, number, number];
  from: string;
  to: string;
  geohashes: string[];
  joined_cells: number;
  cell_km: number;
  cosine_median: number;
  /** 적응형 임계값 — 이 지역 분포에서 "변화"로 본 코사인 상한(p10). */
  sim_threshold: number;
  changed_cells: number;
  changed_area_km2: number;
  top: RegionChangeCell[];
  cells: RegionChangeCell[];
  note: string;
};

/**
 * bbox 광역 변화 스캔. from/to = "YYYY-MM"(월 단위, peak-season 권장).
 * 적응형: 코사인 분포의 하위 꼬리(변화)를 이 지역 자체의 p10~중앙값으로 정규화한다.
 */
export async function scanRegionChange(
  bbox: [number, number, number, number],
  from: string,
  to: string,
  opts: { topN?: number; maxCells?: number } = {}
): Promise<RegionChangeResult> {
  const ghs = geohashesForBbox(bbox);
  const [w, s, e, n] = bbox;
  const inBox = (c: Cell) => c.cx >= w && c.cx <= e && c.cy >= s && c.cy <= n;

  // 파티션(전체 셀)을 캐시에서/다운로드로 얻고, 조인은 bbox 안 셀만.
  const pairs: { cx: number; cy: number; sim: number }[] = [];
  let hadFrom = false, hadTo = false;
  for (const gh of ghs) {
    const A = await loadPartition(gh, from);
    const B = await loadPartition(gh, to);
    if (A.size) hadFrom = true;
    if (B.size) hadTo = true;
    for (const [id, a] of A) {
      if (!inBox(a)) continue;
      const b = B.get(id);
      if (!b) continue;
      const sim = cosine(a.v, b.v);
      if (sim < ARTIFACT_FLOOR) continue; // 구름/눈 아티팩트
      pairs.push({ cx: a.cx, cy: a.cy, sim });
    }
  }
  if (!hadFrom || !hadTo) throw new Error(`임베딩 파티션 없음(${from} 또는 ${to}) — 2017-01~2026-04 월 단위만 존재`);
  if (!pairs.length) throw new Error("두 시점에 공통으로 존재하는 셀이 없습니다");

  const simsSorted = pairs.map((p) => p.sim).sort((x, y) => x - y);
  const median = pctile(simsSorted, 0.5);
  // 적응형 임계값: 하위 10%(가장 많이 변한 셀들)의 상한을 "변화 시작점"으로.
  const simThresh = pctile(simsSorted, 0.1);
  // score = (중앙값 - sim) / (중앙값 - simThresh), [0,1]. 이 지역 기준 상대 변화.
  const denom = Math.max(1e-6, median - simThresh);
  const cells: RegionChangeCell[] = pairs.map((p) => ({
    cx: Math.round(p.cx * 1e4) / 1e4,
    cy: Math.round(p.cy * 1e4) / 1e4,
    sim: Math.round(p.sim * 1e3) / 1e3,
    score: Math.max(0, Math.min(1, (median - p.sim) / denom)),
  }));
  cells.sort((a, b) => b.score - a.score);

  const CELL_KM = 1.28;
  const changed = cells.filter((c) => c.score >= 0.7);
  const maxCells = opts.maxCells ?? 5000;
  return {
    bbox,
    from,
    to,
    geohashes: ghs,
    joined_cells: pairs.length,
    cell_km: CELL_KM,
    cosine_median: Math.round(median * 1e3) / 1e3,
    sim_threshold: Math.round(simThresh * 1e3) / 1e3,
    changed_cells: changed.length,
    changed_area_km2: Math.round(changed.length * CELL_KM * CELL_KM * 10) / 10,
    top: cells.slice(0, opts.topN ?? 15),
    cells: cells.slice(0, maxCells),
    note: "Clay v1.5 임베딩 코사인 유사도(1.28km 셀). 적응형 임계값(지역 분포 p10~중앙값)으로 정규화.",
  };
}
