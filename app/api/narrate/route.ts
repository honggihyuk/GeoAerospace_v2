import { NextResponse } from "next/server";
import { ollamaChat, fitToBudget } from "@/lib/server/llm";

export const dynamic = "force-dynamic";

// POST /api/narrate { facts, topic? } → 결정론 수치를 자연스러운 한국어 문장으로 서술.
//
// 설계원칙 유지: **계산은 하지 않는다.** LLM은 이미 확정된 수치를 읽기 좋게 풀어쓸 뿐이고,
// 호출부는 이 서술 아래에 원본 수치 블록을 그대로 붙여 검증 가능하게 남긴다.
//   실측(qwen3:8b, temp 0.1, num_ctx 16384): 동일 입력 5회 반복에서 **지어낸 수치 0건**.
//   단 라벨-수치 짝을 틀릴 여지는 남으므로 원본 블록 병기는 필수.
const SYS =
  "너는 위성관측 서술 어시스턴트다. 아래 [수치]만 사용해 한국어 2~3문장으로 자연스럽게 풀어 설명하라. " +
  "수치는 절대 바꾸거나 새로 만들지 말고 [수치]에 있는 값만 그대로 인용하라. 직접 계산하지 마라. " +
  "추측이나 원인 해석을 덧붙이지 마라. 사고 과정은 출력하지 마라.";

export async function POST(req: Request) {
  let body: { facts?: string; topic?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }
  const facts = (body.facts ?? "").trim();
  if (!facts) return NextResponse.json({ ok: false, reason: "facts 필요" }, { status: 200 });

  const res = await ollamaChat({
    messages: [
      { role: "system", content: SYS },
      { role: "user", content: `[수치]\n${fitToBudget(facts, 6000, "수치")}` },
    ],
    temperature: 0.1, // 서술 전용 — 창작 억제
    timeoutMs: 60_000,
  });
  if (!res.ok) return NextResponse.json({ ok: false, reason: res.reason }, { status: 200 });
  return NextResponse.json({ ok: true, text: res.content, promptTokens: res.promptTokens });
}
