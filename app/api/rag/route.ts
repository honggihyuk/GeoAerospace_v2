import { NextResponse } from "next/server";
import { retrieve } from "@/lib/server/retrieve";

export const dynamic = "force-dynamic";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.AGENT_MODEL ?? "qwen3:8b";
const TOP_K = 3;

// POST /api/rag { question } → bge-m3 검색 + Qwen3 종합 (설계서 §4.3)
export async function POST(req: Request) {
  let question = "";
  try {
    question = ((await req.json()) as { question?: string }).question?.trim() ?? "";
  } catch {
    /* noop */
  }
  if (!question) return NextResponse.json({ answer: "질문을 입력해 주세요.", sources: [] });

  try {
    const ranked = await retrieve(question, TOP_K);

    const context = ranked.map((r, i) => `[${i + 1}] ${r.chunk.title}\n${r.chunk.text}`).join("\n\n");
    const sys =
      "너는 항공우주·궤도역학 전문 어시스턴트다. 아래 [근거]만 사용해 한국어로 2~4문장으로 정확하고 간결하게 답하라. 근거에 없으면 모른다고 답하라. 사고 과정은 출력하지 마라.";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `[근거]\n${context}\n\n[질문] ${question}` },
        ],
        think: false,
        stream: false,
        options: { temperature: 0.2 },
      }),
    }).finally(() => clearTimeout(timer));

    if (!r.ok) return NextResponse.json({ answer: `모델 오류(${r.status}).`, sources: ranked.map((x) => x.chunk.title) });
    const j = (await r.json()) as { message?: { content?: string } };
    return NextResponse.json({
      answer: (j.message?.content ?? "").trim() || "답변을 생성하지 못했습니다.",
      sources: ranked.map((x) => x.chunk.title),
    });
  } catch (e) {
    return NextResponse.json({ answer: "RAG 백본(Ollama)에 연결하지 못했습니다. Ollama 실행을 확인하세요.", sources: [], error: String(e) });
  }
}
