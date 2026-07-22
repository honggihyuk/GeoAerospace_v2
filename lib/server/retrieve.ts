// 지식 코퍼스 하이브리드 검색 (설계서 §4.3) — 의미검색(bge-m3 cosine) + 어휘부스트.
// /api/rag(개념 Q&A)와 /api/analyze-image(VLM 그라운딩)가 공유하는 검색 레인 ①.
// 저장소: pgvector(DATABASE_URL 설정 시) → 없으면 인메모리 폴백(KNOWLEDGE 상수).
import { KNOWLEDGE, type Chunk } from "@/lib/knowledge";
import { embed, cosine } from "@/lib/server/embed";
import { db, dbReady, toVector } from "@/lib/server/db";

const STOP = new Set(["뭐야", "무엇", "설명", "알려줘", "알려", "어떻게", "해줘", "보여줘", "이란", "란", "대해", "관해", "뭐", "얼마"]);

// 어휘 부스트 — 소규모 사실 코퍼스에서 키워드 매칭 강조.
export function keywords(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[?？.!,]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/(가|를|을|은|는|이|의|에|와|과|도|로|으로|야|냐|까|나요|가요|인가요|입니까|이야|예요|에요|이란|란)$/u, ""))
    .filter((t) => t.length >= 2 && !STOP.has(t));
}
function lexBonus(kw: string[], text: string): number {
  if (!kw.length) return 0;
  const t = text.toLowerCase();
  return kw.filter((k) => t.includes(k)).length / kw.length;
}

export type Ranked = { chunk: Chunk; score: number };

// ── 인메모리 폴백 (DB 미가용 시) ──────────────────────────────────────────────
let corpusVecs: number[][] | null = null;
let building: Promise<number[][]> | null = null;

async function corpus(): Promise<number[][]> {
  if (corpusVecs) return corpusVecs;
  if (!building) building = embed(KNOWLEDGE.map((c) => `${c.title}\n${c.text}`)).then((v) => (corpusVecs = v));
  return building;
}

async function retrieveMemory(question: string, qv: number[], kw: string[], topK: number): Promise<Ranked[]> {
  const vecs = await corpus();
  return KNOWLEDGE.map((c, i) => ({ chunk: c, score: cosine(qv, vecs[i]) + 0.45 * lexBonus(kw, `${c.title} ${c.text}`) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── pgvector 경로 ─────────────────────────────────────────────────────────────
// 개념 doc(knowledge_chunks)과 지역 요약카드(region_cards)를 함께 검색(레인 ①↔② 브리지).
// 카드는 title 앞에 "[지역카드]"를 붙여 회수 출처를 구분한다.
async function retrievePg(qv: number[], kw: string[], topK: number): Promise<Ranked[]> {
  // 벡터로 후보를 넉넉히 뽑고(<=> 코사인 거리 오름차순), JS에서 어휘부스트로 재랭크한다.
  const cand = Math.max(topK * 4, 10);
  const { rows } = await db().query<{ id: string; title: string; body: string; cos: number }>(
    `SELECT id, title, body, cos FROM (
       SELECT id, title, body, 1 - (embedding <=> $1::vector) AS cos
         FROM knowledge_chunks WHERE embedding IS NOT NULL
       UNION ALL
       SELECT id, '[지역카드] ' || place AS title, body, 1 - (embedding <=> $1::vector) AS cos
         FROM region_cards WHERE embedding IS NOT NULL
     ) q
     ORDER BY cos DESC
     LIMIT $2`,
    [toVector(qv), cand]
  );
  return rows
    .map((r) => ({
      chunk: { id: r.id, title: r.title, text: r.body } as Chunk,
      score: Number(r.cos) + 0.45 * lexBonus(kw, `${r.title} ${r.body}`),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/** 질문으로 코퍼스 top-K 청크 검색 (cosine + 0.45×어휘부스트). DB 우선, 실패 시 인메모리. */
export async function retrieve(question: string, topK = 3): Promise<Ranked[]> {
  const q = question.trim();
  if (!q) return [];
  const [qv] = await embed([q]);
  const kw = keywords(q);
  if (await dbReady()) {
    try {
      const pg = await retrievePg(qv, kw, topK);
      if (pg.length) return pg;
      // 행이 없으면(리인덱스 전) 인메모리로 폴백.
    } catch {
      /* 쿼리 실패 → 인메모리 폴백 */
    }
  }
  return retrieveMemory(q, qv, kw, topK);
}
