import { NextResponse } from "next/server";
import { KNOWLEDGE } from "@/lib/knowledge";
import { embed, cosine } from "@/lib/server/embed";

export const dynamic = "force-dynamic";

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.AGENT_MODEL ?? "qwen3:8b";
const TOP_K = 3;

const STOP = new Set(["뭐야", "무엇", "설명", "알려줘", "알려", "어떻게", "해줘", "보여줘", "이란", "란", "대해", "관해", "뭐", "얼마"]);

// 어휘 부스트 (하이브리드 검색, 설계서 §4.3) — 소규모 사실 코퍼스에서 키워드 매칭 강조.
function keywords(q: string): string[] {
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

// 코퍼스 임베딩 캐시 (최초 요청 시 1회 계산)
let corpusVecs: number[][] | null = null;
let building: Promise<number[][]> | null = null;

async function corpus(): Promise<number[][]> {
  if (corpusVecs) return corpusVecs;
  if (!building) building = embed(KNOWLEDGE.map((c) => `${c.title}\n${c.text}`)).then((v) => (corpusVecs = v));
  return building;
}

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
    const vecs = await corpus();
    const [qv] = await embed([question]);
    const kw = keywords(question);
    const ranked = KNOWLEDGE.map((c, i) => ({ c, score: cosine(qv, vecs[i]) + 0.45 * lexBonus(kw, `${c.title} ${c.text}`) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);

    const context = ranked.map((r, i) => `[${i + 1}] ${r.c.title}\n${r.c.text}`).join("\n\n");
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

    if (!r.ok) return NextResponse.json({ answer: `모델 오류(${r.status}).`, sources: ranked.map((x) => x.c.title) });
    const j = (await r.json()) as { message?: { content?: string } };
    return NextResponse.json({
      answer: (j.message?.content ?? "").trim() || "답변을 생성하지 못했습니다.",
      sources: ranked.map((x) => x.c.title),
    });
  } catch (e) {
    return NextResponse.json({ answer: "RAG 백본(Ollama)에 연결하지 못했습니다. Ollama 실행을 확인하세요.", sources: [], error: String(e) });
  }
}
