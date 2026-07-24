// Ollama 호출 단일 창구 — 컨텍스트/온도/타임아웃 정책을 한 곳에서 강제한다.
//
// ⚠️ 존재 이유(실측): Ollama는 `num_ctx` 미지정 시 서버 기본값으로 프롬프트를 **조용히 앞에서 잘라낸다**.
//    qwen3:8b는 40,960 토큰을 지원하는데 미지정 시 2,050 토큰에서 절단되는 것을 확인했고,
//    그 결과 [근거]가 통째로 사라져 모델이 파라미터 기억으로 **지어냈다**(마커 회수 실패 → "42" 환각).
//    "근거만 사용해 답하라" 설계는 근거가 실제로 들어가야만 성립하므로 num_ctx를 항상 명시한다.
//
// 설계원칙: 계산은 결정론 도구가 하고 LLM은 반환값을 서술만 한다 → 온도는 낮게 고정(기본 0.1).
const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
export const AGENT_MODEL = process.env.AGENT_MODEL ?? "qwen3:8b";

/** 컨텍스트 창(토큰). qwen3:8b 한도 40960 내에서 VRAM과 균형. 환경변수로 조정 가능. */
export const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 16384);

/**
 * VLM 컨텍스트 창. qwen2.5vl:7b 한도는 128k지만 이미지 KV 캐시가 무거워 보수적으로 잡는다.
 * (기본값 생략 시 ≈2k에서 잘려 주입한 관측이 사라지는 건 텍스트와 동일)
 */
export const VLM_NUM_CTX = Number(process.env.OLLAMA_VLM_NUM_CTX ?? 8192);

/** 서술 작업 기본 온도 — 수치를 창작하지 않게 낮게 고정. */
const DEFAULT_TEMP = 0.1;

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: string[] };

export type ChatResult = {
  ok: boolean;
  content: string;
  /** 실제로 모델이 읽은 프롬프트 토큰 수 — 절단 감지에 쓴다. */
  promptTokens?: number;
  reason?: string;
};

/**
 * 근거 블록을 예산에 맞춘다. **잘릴 때는 반드시 흔적을 남긴다** —
 * 조용한 절단이 환각의 원인이므로, 잘렸다는 사실이 프롬프트와 로그 양쪽에 보여야 한다.
 */
export function fitToBudget(text: string, maxChars: number, label = "근거"): string {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n…(${label} ${cut.toLocaleString()}자 생략됨 — 예산 초과)`;
}

type ChatOpts = {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
  /** Qwen3는 thinking으로 학습된 도구호출 → 도구 사용 시 true 권장(§4.5). */
  think?: boolean;
  tools?: unknown[];
  timeoutMs?: number;
};

/** Ollama /api/chat 단일 창구. options는 여기서만 조립한다. */
export async function ollamaChat(o: ChatOpts): Promise<ChatResult & { toolCalls: { name: string; args: Record<string, unknown> }[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 60_000);
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: o.model ?? AGENT_MODEL,
        messages: o.messages,
        ...(o.tools ? { tools: o.tools } : {}),
        think: o.think ?? false,
        stream: false,
        options: {
          temperature: o.temperature ?? DEFAULT_TEMP,
          num_ctx: o.numCtx ?? NUM_CTX, // ⚠️ 절대 생략 금지 — 생략하면 조용히 잘린다
          ...(o.numPredict ? { num_predict: o.numPredict } : {}),
        },
      }),
    });
    if (!r.ok) return { ok: false, content: "", toolCalls: [], reason: `모델 오류(${r.status})` };
    const j = (await r.json()) as {
      message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
      prompt_eval_count?: number;
    };
    // Qwen3가 think를 남기는 경우가 있어 방어적으로 제거.
    const content = (j.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return {
      ok: true,
      content,
      promptTokens: j.prompt_eval_count,
      toolCalls: (j.message?.tool_calls ?? []).map((t) => ({ name: t.function.name, args: t.function.arguments })),
    };
  } catch (e) {
    return { ok: false, content: "", toolCalls: [], reason: String(e) };
  } finally {
    clearTimeout(timer);
  }
}
