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
  const trafficLine = traffic
    ? `참고(인근 실측): ${traffic.road} 통행속도 약 ${traffic.roadSpeed} km/h. 방향이 섞인 인근값이니 참고만 하고 방면 판정은 영상 관찰을 우선하라.`
    : "";

  const prompt = [
    `아래는 도로 CCTV의 실시간 캡처 이미지다${name ? ` (카메라명: ${name})` : ""}.`,
    "[1] 먼저 단방향인지 양방향인지 판단하라. 카메라명에 'IC·분기·진출·진입·램프·터널'이 있거나 화면에 차도가 하나만 보이면 단방향이다 — 이때는 방향을 하나만 판정하고 **없는 반대 방향을 지어내지 마라.** 중앙분리대(가드레일)를 사이에 두고 양쪽에 차량이 흐를 때만 양방향으로 본다.",
    "[2] 방향(방면) 확정: 화면 가장자리의 방면 지명·화살표(예: 부산/서울, 용인)를 읽어라. 그리고 **차량의 앞면(전조등·앞 번호판)이 보이면 카메라로 접근하는 방향, 뒷면(후미등)이 보이면 멀어지는 방향**이다 — 이 앞/뒤 단서와 지명 위치가 일치하도록 방면을 배정하라. 억지로 '좌=A, 우=B'로 고정하지 마라.",
    "[3] 곡선 구간에서는 중앙분리대가 비스듬하니 화면을 반으로 자르지 말고 실제 분리대를 경계로 나눠라.",
    "[4] 각 (실재하는) 방향을 '원활/서행/정체'로 판정하고 근거(차로 점유·차간)를 한 문장으로.",
    "형식(양방향): '부산 방면(좌): 정체 — …. 서울 방면(우): 원활 — ….' / 형식(단방향): '용인 방면: 원활 — ….'",
    "야간·저화질로 차량이 안 보이면 모른다고 하라.",
    trafficLine,
    "**[1]~[4] 사고 과정은 절대 출력하지 말고, 최종 판정 문장(방면별 한 줄)만 간결히 답하라.**",
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
