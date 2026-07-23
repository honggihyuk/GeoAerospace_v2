import { NextResponse } from "next/server";
import { fetchTrafficNear } from "@/lib/server/fetchTraffic";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 로컬 VLM 추론 10~40s

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
const VLM = process.env.VLM_MODEL ?? "qwen2.5vl:7b";

// POST /api/analyze-frame { image: base64(JPEG), name?, lon?, lat? }
// CCTV 프레임을 VLM(qwen2.5vl)으로 판독 — 차량 혼잡도(원활/서행/정체) 정성 판단.
// 설계원칙: VLM은 픽셀 시각판단만. lon/lat 있으면 ITS 실측 통행속도로 "실증" 근거 보강.
export async function POST(req: Request) {
  let body: { image?: string; name?: string; lon?: number; lat?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, reason: "잘못된 요청" }, { status: 200 });
  }
  const image = (body.image ?? "").replace(/^data:image\/\w+;base64,/, "");
  if (image.length < 100) return NextResponse.json({ ok: false, reason: "이미지 없음" }, { status: 200 });
  const name = body.name ? String(body.name).slice(0, 60) : "";

  // 실증 근거: CCTV 좌표 근처 실측 통행속도. 카메라명 [경부선] 같은 도로 힌트로 대표 도로를 잡는다.
  const hint = name.match(/\[([^\]]+)\]/)?.[1];
  const traffic =
    typeof body.lon === "number" && typeof body.lat === "number" ? await fetchTrafficNear(body.lon, body.lat, hint) : null;
  // 속도 → 대략 등급(고속도로 80/40 기준, 일반도로 30/15 기준). VLM 판정의 기준선.
  const speedLevel = (road: string, s: number) => {
    const hw = /고속도로|고속화/.test(road);
    const hi = hw ? 80 : 30;
    const mid = hw ? 40 : 15;
    return s >= hi ? "대체로 원활" : s >= mid ? "대체로 서행" : "대체로 정체";
  };
  const trafficLine = traffic
    ? `[인근 실측] ${traffic.road} 통행속도 약 ${traffic.roadSpeed} km/h → ${speedLevel(traffic.road, traffic.roadSpeed)}. 이 실측을 기준선으로 삼고, 방면별 차이는 영상으로만 보정하라.`
    : "";

  const prompt = [
    `아래는 도로 CCTV 실시간 캡처다${name ? ` (카메라명: ${name})` : ""}.`,
    trafficLine,
    "방향 나누기: 왕복 도로면 중앙분리대(가드레일)를 경계로 좌/우 차도를 나눈다. 카메라명에 IC·램프·터널·진출입이 있거나 차도가 하나만 보이면 단방향이니 방향을 하나만 판정하고 없는 방향을 지어내지 마라. 화면 가장자리 방면 지명(예: 부산/서울)과 차량 앞면(접근)/뒷면(멀어짐)으로 각 차도의 방면을 정하라.",
    "혼잡도는 오직 차량 밀도·흐름으로 보되, **위 실측 속도가 이 도로의 기본 상태다.** 실측이 '원활'이면, 화면에 한 방향의 차량이 여러 차로를 꽉 메우고 멈춰있는 **명백한 정체**가 보이지 않는 한 **양쪽 다 원활**로 판정하라. 차량 몇 대나 애매한 차이로 한쪽을 정체·서행이라고 하지 마라.",
    "**차량이 중앙분리대에 가깝다/멀다 하는 위치는 혼잡도와 전혀 무관하니 근거로 절대 쓰지 마라.** 양쪽 흐름이 비슷하면 둘 다 같은 등급으로 판정하라.",
    "출력: 방면별로 한 줄, 근거는 '차량 밀도/흐름'으로만 짧게. 예: '부산 방면: 원활 — 차량 드문드문 빠른 흐름. 서울 방면: 원활 — 차간 넓음.'",
    "사고 과정은 출력하지 말고 최종 판정만. 야간·저화질로 차량이 안 보이면 모른다고 하라.",
  ]
    .filter(Boolean)
    .join(" ");

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
    return NextResponse.json({ ok: true, answer: answer || "분석 결과가 없습니다.", model: VLM, traffic });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
