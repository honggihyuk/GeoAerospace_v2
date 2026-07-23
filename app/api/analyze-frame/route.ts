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
    "왕복 고속도로는 중앙분리대(가드레일)를 경계로 양쪽 차도가 서로 반대 방향이다.",
    "**곡선 구간에서는 중앙분리대가 화면 중앙 수직이 아니라 비스듬하다 — 화면을 반으로 자르지 말고 실제 분리대를 경계로 양쪽 차도를 나눠라.**",
    "이미지 가장자리·모서리에 방면 지명과 화살표(예: 부산·서울, 신갈·판교)가 적혀 있으면 그것을 읽어 각 차도의 진행 방면을 정하라.",
    "그런 다음 각 방면의 차량 혼잡도를 '원활/서행/정체' 중 하나로 판정하고 근거(차로 점유·차간 간격)를 한 문장으로.",
    "**방면 지명이 보이면 반드시 그 이름으로 보고하라**(괄호에 좌/우 병기). 형식 예: '부산 방면(좌측): 정체 — 차로 대부분 점유. 서울 방면(우측): 원활 — 차간 넓음.'",
    "지명이 전혀 안 보일 때만 '좌측/우측'으로 표기하라. 야간·저화질로 차량이 안 보이면 모른다고 하라.",
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
