import { NextResponse } from "next/server";
import { retrieve } from "@/lib/server/retrieve";
import { ollamaChat, fitToBudget } from "@/lib/server/llm";

export const dynamic = "force-dynamic";

const TOP_K = 3;
/** [근거] 블록 상한 — num_ctx 안에 확실히 들어가게. 초과분은 흔적을 남기고 자른다. */
const CONTEXT_BUDGET = 12_000;

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

    const context = fitToBudget(ranked.map((r, i) => `[${i + 1}] ${r.chunk.title}\n${r.chunk.text}`).join("\n\n"), CONTEXT_BUDGET);
    const sys =
      "너는 항공우주·궤도역학 전문 어시스턴트다. 아래 [근거]만 사용해 한국어로 2~4문장으로 정확하고 간결하게 답하라. 근거에 없으면 모른다고 답하라. 사고 과정은 출력하지 마라.";

    const res = await ollamaChat({
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `[근거]\n${context}\n\n[질문] ${question}` },
      ],
    });
    const sources = ranked.map((x) => x.chunk.title);
    if (!res.ok) return NextResponse.json({ answer: res.reason ?? "답변을 생성하지 못했습니다.", sources });
    return NextResponse.json({
      answer: res.content || "답변을 생성하지 못했습니다.",
      sources,
      promptTokens: res.promptTokens,
    });
  } catch (e) {
    return NextResponse.json({ answer: "RAG 백본(Ollama)에 연결하지 못했습니다. Ollama 실행을 확인하세요.", sources: [], error: String(e) });
  }
}
