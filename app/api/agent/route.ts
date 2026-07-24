import { NextResponse } from "next/server";
import { TOOLS, systemPrompt } from "@/lib/agentTools";
import { ollamaChat } from "@/lib/server/llm";

export const dynamic = "force-dynamic";

type Ctx = { selected: string; aircraft: number; satellites: string[]; layers: Record<string, boolean> };

// POST /api/agent  { message, context } → Qwen3(Ollama) 도구호출 (설계서 §4.5, 로컬 §4.5-0.6)
export async function POST(req: Request) {
  let body: { message?: string; context?: Ctx };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ content: "잘못된 요청입니다.", toolCalls: [] });
  }
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ content: "", toolCalls: [] });

  const ctx: Ctx = body.context ?? { selected: "none", aircraft: 0, satellites: [], layers: {} };

  const res = await ollamaChat({
    messages: [
      { role: "system", content: systemPrompt(ctx) },
      { role: "user", content: message },
    ],
    tools: TOOLS,
    think: true, // Qwen3는 thinking으로 학습된 도구호출 → 켜야 도구선택 정확 (§4.5)
  });

  if (!res.ok) {
    return NextResponse.json({
      content: "에이전트 백본(Ollama Qwen3)에 연결하지 못했습니다. `ollama serve` 및 `qwen3:8b` 설치를 확인하세요.",
      toolCalls: [],
      error: res.reason,
    });
  }
  return NextResponse.json({ content: res.content, toolCalls: res.toolCalls, promptTokens: res.promptTokens });
}
