import { NextResponse } from "next/server";
import { buildRegionCard } from "@/lib/server/regionCard";
import { embed } from "@/lib/server/embed";
import { db, dbReady, toVector } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST /api/cards/build { place, bbox } → 관측을 요약카드로 만들어 bge-m3 임베딩 후 region_cards upsert.
// 레인 ①↔② 브리지: 이후 의미검색(retrieve)이 개념 doc과 함께 이 카드를 회수한다.
export async function POST(req: Request) {
  if (!(await dbReady())) {
    return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });
  }
  let body: { place?: string; bbox?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }
  const place = (body.place ?? "").trim();
  if (!place) return NextResponse.json({ ok: false, reason: "place 필요" }, { status: 200 });
  const parts = (body.bbox ?? "").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  try {
    const card = await buildRegionCard(place, bbox);
    const [vec] = await embed([card.body]);
    if (!vec) throw new Error("임베딩 실패");

    await db().query(
      `INSERT INTO region_cards (id, place, footprint, body, embedding, generated_at)
       VALUES ($1, $2, ST_MakeEnvelope($3, $4, $5, $6, 4326), $7, $8::vector, $9)
       ON CONFLICT (id) DO UPDATE
         SET place = EXCLUDED.place, footprint = EXCLUDED.footprint, body = EXCLUDED.body,
             embedding = EXCLUDED.embedding, generated_at = EXCLUDED.generated_at`,
      [card.id, card.place, bbox[0], bbox[1], bbox[2], bbox[3], card.body, toVector(vec), card.generatedAt]
    );

    return NextResponse.json({ ok: true, id: card.id, place: card.place, kinds: card.kinds, body: card.body });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
