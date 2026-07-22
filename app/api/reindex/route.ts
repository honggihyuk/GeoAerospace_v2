import { NextResponse } from "next/server";
import { KNOWLEDGE } from "@/lib/knowledge";
import { embed } from "@/lib/server/embed";
import { db, dbReady, toVector } from "@/lib/server/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // bge-m3로 코퍼스 전체 임베딩

// POST /api/reindex → KNOWLEDGE를 bge-m3로 임베딩해 pgvector(knowledge_chunks)에 upsert.
// 레인 ① 저장소를 인메모리에서 DB로 승격. 코퍼스 수정 후 1회 호출.
export async function POST() {
  if (!(await dbReady())) {
    return NextResponse.json({ ok: false, reason: "DB 미가용 (DATABASE_URL/컨테이너 확인)" }, { status: 200 });
  }
  try {
    const vecs = await embed(KNOWLEDGE.map((c) => `${c.title}\n${c.text}`));
    if (vecs.length !== KNOWLEDGE.length) throw new Error("임베딩 개수 불일치");

    const pool = db();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < KNOWLEDGE.length; i++) {
        const c = KNOWLEDGE[i];
        await client.query(
          `INSERT INTO knowledge_chunks (id, title, body, embedding)
           VALUES ($1, $2, $3, $4::vector)
           ON CONFLICT (id) DO UPDATE
             SET title = EXCLUDED.title, body = EXCLUDED.body, embedding = EXCLUDED.embedding`,
          [c.id, c.title, c.text, toVector(vecs[i])]
        );
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    const { rows } = await db().query<{ n: string }>("SELECT count(*)::text AS n FROM knowledge_chunks WHERE embedding IS NOT NULL");
    return NextResponse.json({ ok: true, indexed: KNOWLEDGE.length, rows: Number(rows[0]?.n ?? 0), dim: vecs[0]?.length ?? 0 });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
