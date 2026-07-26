import { NextResponse } from "next/server";
import { TOOLS } from "@/lib/agentTools";
import { ollamaChat } from "@/lib/server/llm";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST /api/agent { message } → Qwen3(Ollama) 도구호출 (2단계 라우팅).
//
// ⚠️ 왜 2단계인가(실측): qwen3:8b는 **도구 1개면 tool_calls 완벽**하지만 **12개 도구에선 오선택**한다
//   (think on/off 무관: "제주도로 이동"→fly_to_place("서울") 환각, "부산 상황"→fly_to_place("Korea")).
//   → ① 카테고리 분류(도구 없이 라벨 1개) → ② 그 카테고리 도구 1~2개만 제시해 tool-call.
//   작은 도구 표면 = 소형모델 신뢰성 회복. 정규식(resolveIntent)이 못 잡은 질의에만 클라가 호출한다.
const CATEGORIES: { id: string; desc: string; tools: string[] }[] = [
  { id: "navigate", desc: "도시·국가·지역 등 장소로 지도 이동", tools: ["fly_to_place"] },
  { id: "satellite", desc: "위성 이름/NORAD 번호로 추적·선택", tools: ["select_satellite"] },
  { id: "layer", desc: "레이어(궤도/지상궤적/위성/항공기/지형/산불) 켜기·끄기", tools: ["toggle_layer"] },
  { id: "fire", desc: "산불·화재 조회·필터", tools: ["filter_fires"] },
  { id: "imagery", desc: "위성영상 배경 오버레이(트루컬러/연기 등)", tools: ["add_layer"] },
  { id: "scene", desc: "촬영된 위성영상 '장면' 검색·목록", tools: ["search_scenes"] },
  { id: "region", desc: "지역 관측 상황/현황/대기질/교통 브리핑", tools: ["describe_region"] },
  { id: "spectral", desc: "지수 면적·비율(식생/수체/연소)", tools: ["spectral_index"] },
  { id: "change", desc: "두 날짜(YYYY-MM-DD) 사이 변화·산불피해·지수 증감", tools: ["change_detection", "compare_index"] },
  { id: "regionscan", desc: "넓은 지역 연 단위 장기 토지변화 광역 스캔(연도 2개)", tools: ["scan_region_change"] },
  { id: "analyze", desc: "지도 위 영상 내용 해석(VLM)", tools: ["analyze_image"] },
  { id: "knowledge", desc: "개념·용어·원리 등 순수 지식 질문(도구 불필요)", tools: [] },
];

// ①단계: 분류(도구 없이 라벨 1개). 소형모델도 분류는 안정적 — numPredict 짧게, 온도 0.
async function classify(message: string): Promise<string> {
  const sys =
    "다음 사용자 요청을 아래 카테고리 중 정확히 하나로 분류한다. 카테고리 id 한 단어만 출력한다(설명·문장 금지).\n" +
    CATEGORIES.map((c) => `- ${c.id}: ${c.desc}`).join("\n");
  const res = await ollamaChat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: message },
    ],
    think: false,
    temperature: 0,
    numPredict: 12,
    timeoutMs: 30_000,
  });
  const txt = (res.content || "").toLowerCase();
  return CATEGORIES.find((c) => txt.includes(c.id))?.id ?? "knowledge";
}

// ②단계 시스템 프롬프트 — 환각 방지: 지명/이름은 메시지에 나온 것만.
const STAGE2_SYS =
  "사용자 요청에 맞는 도구를 정확히 호출한다. 좌표·bbox·날짜는 시스템이 만드므로 지명·이름만 넘긴다. " +
  "**지명/이름은 사용자 메시지에 실제로 나온 것만** 쓴다(절대 지어내지 말 것). 요청과 무관하면 호출하지 않는다.";

export async function POST(req: Request) {
  let body: { message?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ toolCalls: [] });
  }
  const message = (body.message ?? "").trim();
  if (!message) return NextResponse.json({ toolCalls: [] });

  try {
    const category = await classify(message);
    const cat = CATEGORIES.find((c) => c.id === category);
    if (!cat || cat.tools.length === 0) return NextResponse.json({ toolCalls: [], category }); // 지식 등 → 클라 RAG

    // 그 카테고리 도구만(1~2개) 제시 → 소형모델이 신뢰성 있게 tool-call.
    const tools = TOOLS.filter((t) => cat.tools.includes((t as { function: { name: string } }).function.name));
    const res = await ollamaChat({
      messages: [
        { role: "system", content: STAGE2_SYS },
        { role: "user", content: message },
      ],
      tools,
      think: false,
      timeoutMs: 45_000,
    });
    if (!res.ok) return NextResponse.json({ toolCalls: [], category, error: res.reason });
    return NextResponse.json({ toolCalls: res.toolCalls, category });
  } catch (e) {
    return NextResponse.json({ toolCalls: [], error: String(e) });
  }
}
