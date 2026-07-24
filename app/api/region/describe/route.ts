import { NextResponse } from "next/server";
import { ingestFires, ingestOpenAQ } from "@/lib/server/ingest";
import { buildRegionCard } from "@/lib/server/regionCard";
import { retrieve } from "@/lib/server/retrieve";
import { embed } from "@/lib/server/embed";
import { db, dbReady, toVector } from "@/lib/server/db";
import { ollamaChat, fitToBudget } from "@/lib/server/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

// 카드 신선도 TTL(분). 이 시간 내 카드는 재인제스트 없이 재사용 → 반복 질의 즉답.
const CARD_TTL_MIN = Number(process.env.CARD_TTL_MIN ?? 30);

// POST /api/region/describe { place, bbox, question?, refresh? }
// 온디맨드 지역 브리핑: 관측 인제스트(best-effort) → 요약카드 생성·임베딩 → 개념 검색 → LLM 종합.
// 레인 ①(개념·카드)+②(공간관측)를 한 번에 묶는 오케스트레이션. TTL 내 카드는 재사용.
export async function POST(req: Request) {
  if (!(await dbReady())) return NextResponse.json({ ok: false, reason: "DB 미가용" }, { status: 200 });

  let body: { place?: string; bbox?: string; question?: string; refresh?: boolean };
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
    // 1) 카드 신선도 검사 — TTL 내면 재인제스트·재생성을 건너뛰고 기존 카드를 재사용.
    const cardId = `card:${place}`;
    let cardBody: string;
    let counts: Record<string, number> = {};
    let reused = false;
    const fresh = await db().query<{ body: string; age_min: number }>(
      `SELECT body, extract(epoch from (now() - generated_at)) / 60 AS age_min FROM region_cards WHERE id = $1`,
      [cardId]
    );
    if (!body.refresh && fresh.rows[0] && fresh.rows[0].age_min < CARD_TTL_MIN) {
      cardBody = fresh.rows[0].body;
      reused = true;
    } else {
      // 관측 최신화(best-effort — 한쪽 실패가 브리핑을 막지 않게 격리) → 카드 생성 + 임베딩 upsert.
      await Promise.allSettled([ingestFires(bbox, 3), ingestOpenAQ(bbox, 15)]);
      const card = await buildRegionCard(place, bbox);
      cardBody = card.body;
      counts = card.kinds;
      const [vec] = await embed([card.body]);
      if (vec) {
        await db().query(
          `INSERT INTO region_cards (id, place, footprint, body, embedding, generated_at)
           VALUES ($1, $2, ST_MakeEnvelope($3,$4,$5,$6,4326), $7, $8::vector, $9)
           ON CONFLICT (id) DO UPDATE
             SET place=EXCLUDED.place, footprint=EXCLUDED.footprint, body=EXCLUDED.body,
                 embedding=EXCLUDED.embedding, generated_at=EXCLUDED.generated_at`,
          [card.id, card.place, bbox[0], bbox[1], bbox[2], bbox[3], card.body, toVector(vec), card.generatedAt]
        );
      }
    }

    // 3) 관련 개념 doc 검색(카드 자신은 제외) → 그라운딩 보강.
    const question = (body.question ?? `${place} 지역 관측 상황`).trim();
    const concepts = (await retrieve(question, 4)).filter((r) => !r.chunk.id.startsWith("card:")).slice(0, 2);
    const conceptCtx = concepts.map((c) => `- ${c.chunk.title}: ${c.chunk.text}`).join("\n");

    // 4) LLM 종합 — 카드(실측 관측)를 우선 근거로, 수치를 지어내지 말 것.
    const sys =
      "너는 지역 관측 브리핑 어시스턴트다. 아래 [관측카드]의 실측 수치를 근거로 한국어 3~4문장으로 요약하라. " +
      "카드에 없는 수치는 지어내지 말고, [개념]은 용어 해석에만 참고하라. 사고 과정은 출력하지 마라.";
    // 관측카드(실측)를 개념보다 우선 보존 — 카드가 잘리면 브리핑이 근거를 잃는다.
    const user =
      `[관측카드]\n${fitToBudget(cardBody, 10_000, "관측카드")}\n\n` +
      `[개념]\n${fitToBudget(conceptCtx || "(없음)", 4_000, "개념")}\n\n[질문] ${question}`;

    const res = await ollamaChat({
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      timeoutMs: 120_000,
    });
    const answer = res.content;

    return NextResponse.json({
      ok: true,
      place,
      reused, // TTL 내 기존 카드 재사용 여부
      answer: answer || cardBody, // LLM 실패 시 카드 원문이라도 반환
      card: cardBody,
      counts,
      sources: [`[지역카드] ${place}`, ...concepts.map((c) => c.chunk.title)],
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
