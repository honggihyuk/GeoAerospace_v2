import { NextResponse } from "next/server";
import { TOOLS, systemPrompt } from "@/lib/agentTools";

export const dynamic = "force-dynamic";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.AGENT_MODEL ?? "qwen3:8b";

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

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt(ctx) },
          { role: "user", content: message },
        ],
        tools: TOOLS,
        think: true, // Qwen3는 thinking으로 학습된 도구호출 → 켜야 도구선택 정확 (§4.5)
        stream: false,
        options: { temperature: 0.1 },
      }),
    }).finally(() => clearTimeout(timer));

    if (!r.ok) {
      return NextResponse.json({ content: `모델 서버 오류(${r.status}). Ollama가 실행 중인지 확인하세요.`, toolCalls: [] });
    }
    const j = (await r.json()) as { message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] } };
    const toolCalls = (j.message?.tool_calls ?? []).map((t) => ({ name: t.function.name, args: t.function.arguments }));
    return NextResponse.json({ content: j.message?.content ?? "", toolCalls });
  } catch (e) {
    return NextResponse.json({
      content: "에이전트 백본(Ollama Qwen3)에 연결하지 못했습니다. `ollama serve` 및 `qwen3:8b` 설치를 확인하세요.",
      toolCalls: [],
      error: String(e),
    });
  }
}
