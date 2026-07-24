import { NextResponse } from "next/server";
import { safeFetch } from "@/lib/server/safeFetch";
import { bboxCoverage, type Bbox } from "@/lib/server/geoUtil";

export const dynamic = "force-dynamic";

// STAC 장면 검색 (레인 ③, 설계서 §4.8 STAC 채택) — Element84 earth-search v1(무인증).
// bbox·기간·구름비율로 조건에 맞는 위성영상 장면(Item)을 찾아 목록으로 반환한다.
// "픽셀을 임베딩"하는 대신 장면 메타데이터를 카탈로그 쿼리로 검색하는 검색 레인.
const STAC_URL = "https://earth-search.aws.element84.com/v1/search";

// 사용자 별칭 → STAC 컬렉션 id.
const COLLECTIONS: Record<string, string> = {
  s2: "sentinel-2-l2a",
  optical: "sentinel-2-l2a",
  s1: "sentinel-1-grd",
  sar: "sentinel-1-grd",
  landsat: "landsat-c2-l2",
};

type Scene = {
  id: string;
  datetime: string;
  date: string;
  cloud: number | null;
  thumb: string | null;
  collection: string;
  /** AOI를 얼마나 덮는가(%) — 래스터 I/O 없는 순수 기하. 장면 선택의 결정론성 근거. */
  coverage_pct: number;
};

// POST /api/stac { bbox: "w,s,e,n", collection?, days?, from?, to?, cloud?, limit? }
export async function POST(req: Request) {
  let body: { bbox?: string; collection?: string; days?: number; from?: string; to?: string; cloud?: number; limit?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }

  const bboxArr = (body.bbox ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (bboxArr.length !== 4 || bboxArr.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류" }, { status: 200 });
  }

  const collection = COLLECTIONS[(body.collection ?? "s2").toLowerCase()] ?? body.collection ?? "sentinel-2-l2a";
  const isSar = collection.includes("sentinel-1");
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 8)));
  const cloud = typeof body.cloud === "number" ? Math.min(100, Math.max(0, body.cloud)) : 20;

  // 기간: from/to 명시 우선, 아니면 최근 days일(기본 90 — 구름필터로 걸러질 여지 확보).
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const to = isDate(body.to) ? `${body.to}T23:59:59Z` : new Date().toISOString();
  const from = isDate(body.from)
    ? `${body.from}T00:00:00Z`
    : new Date(Date.now() - Math.max(1, Number(body.days ?? 90)) * 86_400_000).toISOString();

  type Feature = { id: string; bbox?: number[]; collection?: string; properties?: Record<string, unknown>; assets?: Record<string, { href?: string }> };

  const search = async (cloudLimit: number): Promise<Feature[]> => {
    const payload: Record<string, unknown> = {
      collections: [collection],
      bbox: bboxArr,
      datetime: `${from}/${to}`,
      // 커버리지로 재정렬하므로 후보를 넉넉히 받는다(limit는 최종 반환 수).
      limit: Math.max(limit, 50),
      sortby: isSar
        ? [{ field: "properties.datetime", direction: "desc" }]
        : [{ field: "properties.eo:cloud_cover", direction: "asc" }],
    };
    if (!isSar) payload.query = { "eo:cloud_cover": { lt: cloudLimit } };

    const r = await safeFetch(STAC_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      accept: "application/geo+json, application/json",
      headers: { "content-type": "application/json" },
      timeoutMs: 15_000,
    });
    if (!r.ok) throw new Error(`stac ${r.status}`);
    return ((await r.json()) as { features?: Feature[] }).features ?? [];
  };

  try {
    // 구름 재시도 — 결과가 없으면 한도를 올려 한 번 더(AWS 패턴). SAR은 구름 개념이 없어 1회만.
    let feats = await search(cloud);
    let usedCloud = cloud;
    if (!feats.length && !isSar && cloud < 80) {
      usedCloud = 80;
      feats = await search(usedCloud);
    }

    const scenes: Scene[] = feats.map((f) => {
      const dt = String(f.properties?.datetime ?? "");
      const cc = f.properties?.["eo:cloud_cover"];
      const thumb = f.assets?.thumbnail?.href ?? f.assets?.["rendered_preview"]?.href ?? null;
      return {
        id: f.id,
        datetime: dt,
        date: dt.slice(0, 10),
        cloud: typeof cc === "number" ? Math.round(cc) : null,
        thumb,
        collection: f.collection ?? collection,
        coverage_pct: Math.round(bboxCoverage(bboxArr as Bbox, f.bbox ?? []) * 1000) / 10,
      };
    });

    // 결정론적 정렬 — 커버리지 최대 → (광학)구름 최소 / (SAR)최신 → id 타이브레이크.
    // AOI가 같으면 항상 같은 순서·같은 1순위가 나온다(재현성).
    scenes.sort(
      (a, b) =>
        b.coverage_pct - a.coverage_pct ||
        (isSar ? b.datetime.localeCompare(a.datetime) : (a.cloud ?? 101) - (b.cloud ?? 101)) ||
        a.id.localeCompare(b.id)
    );

    // count는 **반환한 장면 수**를 유지한다(에이전트 응답이 이 값을 그대로 인용).
    // 커버리지 재정렬용으로 더 많이 받았을 뿐이므로 후보 수는 별도 필드로 알린다.
    const top = scenes.slice(0, limit);
    return NextResponse.json({
      ok: true,
      count: top.length,
      candidates: scenes.length,
      collection,
      bbox: bboxArr.join(","),
      cloud_used: isSar ? null : usedCloud,
      scenes: top,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
