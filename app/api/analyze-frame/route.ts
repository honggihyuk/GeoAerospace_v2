import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 로컬 VLM 추론 10~40s

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const VLM = process.env.VLM_MODEL ?? "qwen2.5vl:7b";

// POST /api/analyze-frame { image: base64(JPEG), name? }
// CCTV 프레임을 VLM(qwen2.5vl)으로 판독 — 차량 혼잡도(원활/서행/정체) 정성 판단.
// 설계원칙: VLM은 픽셀 시각판단만(정확한 차량 대수는 VDS 교통량이 담당).
export async function POST(req: Request) {
  let body: { image?: string; name?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }
  const image = (body.image ?? "").replace(/^data:image\/\w+;base64,/, "");
  if (image.length < 100) return NextResponse.json({ ok: false, reason: "이미지 없음" }, { status: 200 });
  const name = body.name ? String(body.name).slice(0, 60) : "";

  const prompt = [
    `아래는 도로 CCTV의 실시간 캡처 이미지다${name ? ` (${name})` : ""}.`,
    "고속도로는 중앙분리대를 기준으로 화면 좌측과 우측이 서로 반대 방향이다.",
    "화면을 좌측 방향과 우측 방향으로 나눠 **각 방향의 차량 혼잡도를 따로** 판정하라.",
    "이미지에 방면 지명(예: 수원·광명)이 보이면 방향 이름으로 쓰고, 없으면 그냥 '좌측/우측'으로 표기하라.",
    "각 방향을 '원활/서행/정체' 중 하나로 판정하고 근거(차로 점유·차간 간격)를 한 문장으로.",
    "형식 예: '좌측(수원 방면): 정체 — 차로 대부분 점유. 우측(광명 방면): 원활 — 차간 넓음.'",
    "**방면 지명이 없어도 반드시 좌·우로 판정하라.** 한 방향만 보이면 그것만 판정하라.",
    "야간·저화질로 차량이 전혀 안 보일 때만 모른다고 하라.",
  ].join(" ");

  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VLM,
        stream: false,
        messages: [{ role: "user", content: prompt, images: [image] }],
        options: { temperature: 0.2, num_predict: 256 },
      }),
      signal: AbortSignal.timeout(280_000),
    });
    if (!r.ok) return NextResponse.json({ ok: false, reason: `vlm ${r.status}` }, { status: 200 });
    const j = (await r.json()) as { message?: { content?: string } };
    const answer = (j.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    return NextResponse.json({ ok: true, answer: answer || "분석 결과가 없습니다.", model: VLM });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
