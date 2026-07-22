import { NextResponse } from "next/server";
import { safeFetch } from "@/lib/server/safeFetch";

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

type Scene = { id: string; datetime: string; date: string; cloud: number | null; thumb: string | null; collection: string };

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

  const payload: Record<string, unknown> = {
    collections: [collection],
    bbox: bboxArr,
    datetime: `${from}/${to}`,
    limit,
    // 광학은 구름 적은 순, SAR은 최신순.
    sortby: isSar
      ? [{ field: "properties.datetime", direction: "desc" }]
      : [{ field: "properties.eo:cloud_cover", direction: "asc" }],
  };
  if (!isSar) payload.query = { "eo:cloud_cover": { lt: cloud } };

  try {
    const r = await safeFetch(STAC_URL, {
      method: "POST",
      body: JSON.stringify(payload),
      accept: "application/geo+json, application/json",
      headers: { "content-type": "application/json" },
      timeoutMs: 15_000,
    });
    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ ok: false, reason: `stac ${r.status}`, detail: t.slice(0, 300) }, { status: 200 });
    }
    const j = (await r.json()) as {
      features?: { id: string; collection?: string; properties?: Record<string, unknown>; assets?: Record<string, { href?: string }> }[];
    };
    const scenes: Scene[] = (j.features ?? []).map((f) => {
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
      };
    });
    return NextResponse.json({ ok: true, count: scenes.length, collection, bbox: bboxArr.join(","), scenes });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
