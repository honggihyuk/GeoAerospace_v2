import { NextResponse } from "next/server";
import { GIBS_LAYERS } from "@/lib/gibs";
import { safeFetch } from "@/lib/server/safeFetch";
import { resolveDayDate } from "@/lib/server/fetchEarthImagery";
import { retrieve } from "@/lib/server/retrieve";
import { queryObservations, summarizeObservations } from "@/lib/server/spatial";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // VLM 추론이 로컬에서 30~60s 걸린다

const OLLAMA = process.env.OLLAMA_URL ?? "http://localhost:11434";
// 제안서 §4.4는 HF GeoChat을 지목하지만 로컬 가용 모델로 대체한다.
// 원격 GeoChat 엔드포인트가 생기면 VLM_MODEL/VLM_URL로 바꿔 끼우면 된다.
const VLM = process.env.VLM_MODEL ?? "qwen2.5vl:7b";
const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";

/** 관심 영역만 잘라 받는다 — 타일 모자이크보다 질문에 맞는 화면을 만들 수 있다. */
function wmsUrl(layer: string, bbox: string, date: string, width: number): string {
  const [w, s, e, n] = bbox.split(",").map(Number);
  const aspect = Math.max(0.25, Math.min(4, (e - w) / Math.max(1e-6, n - s)));
  const p = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1", // SRS + BBOX(lon,lat) — 1.3.0 축순서 함정 회피
    REQUEST: "GetMap",
    SRS: "EPSG:4326",
    BBOX: bbox,
    WIDTH: String(width),
    HEIGHT: String(Math.max(128, Math.round(width / aspect))),
    FORMAT: "image/jpeg",
    LAYERS: layer,
    TIME: date,
  });
  return `${WMS}?${p.toString()}`;
}

// POST /api/analyze-image  { bbox, layer?, date?, question?, context? }
// GIBS 영상을 VLM으로 해석한다 (개발제안서 §4.4 / §4.7 3계층 중 3계층).
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      bbox?: string;
      layer?: string;
      date?: string;
      question?: string;
      /** FIRMS 수치 등 — 환각 억제용 그라운딩 */
      context?: string;
    };

    const bbox = body.bbox ?? "-180,-60,180,80";
    if (!/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(bbox)) {
      return NextResponse.json({ ok: false, reason: "bbox 형식 오류" }, { status: 200 });
    }

    const def = GIBS_LAYERS.find((l) => l.id === (body.layer ?? "truecolor")) ?? GIBS_LAYERS[0];
    const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : await resolveDayDate();

    const img = await safeFetch(wmsUrl(def.layer, bbox, date, 768), {
      timeoutMs: 60_000,
      accept: "image/jpeg",
    });
    if (!img.ok) throw new Error(`gibs ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    if (buf.byteLength < 2000) throw new Error("영상이 비어 있음 (해당 날짜/영역 미수집)");

    const question = body.question?.trim() || "이 위성영상에서 보이는 것을 설명해줘.";

    // 검색-증강 그라운딩(레인 ①): 질문+레이어로 개념 doc를 먼저 검색해 VLM에 주입한다.
    // VLM이 물리량의 의미(예: NO₂ 컬럼≠지상농도, LST≠기온)를 오해·환각하지 않도록 정의를 공급.
    // 검색 실패는 치명적이지 않다 — 그라운딩 없이 진행.
    let retrieved: { title: string; text: string }[] = [];
    try {
      const ranked = await retrieve(`${question} ${def.label}`, 2);
      retrieved = ranked.filter((r) => r.score > 0.3).map((r) => ({ title: r.chunk.title, text: r.chunk.text }));
    } catch {
      /* noop */
    }
    const knowledge = retrieved.length
      ? `참고 개념(아래 정의를 따를 것): ${retrieved.map((r) => `${r.title} — ${r.text}`).join(" / ")}`
      : "";

    // 레인 ② 공간검색: 이 bbox 안의 관측(FIRMS 등)을 공간DB에서 조회해 수치 그라운딩으로 주입.
    // 클라가 body.context를 안 줘도 DB에서 사실을 끌어오는 "검색-구동" 그라운딩(치명적이지 않음).
    let spatial = "";
    try {
      const [w, s, e, n] = bbox.split(",").map(Number);
      spatial = summarizeObservations(await queryObservations([w, s, e, n], { limit: 300 }));
    } catch {
      /* noop */
    }

    // 그라운딩: 수치는 관측 데이터(FIRMS 등)에서 온 사실이므로 모델이 지어내지 않도록 명시적으로 준다.
    const prompt = [
      `아래는 NASA GIBS ${def.label} 위성영상이다 (관측일 ${date}, 영역 ${bbox}).`,
      knowledge,
      spatial ? `참고 관측(공간DB 사실, 지어내지 말 것): ${spatial}` : "",
      body.context ? `참고 사실(관측 데이터, 반드시 이 수치를 따를 것): ${body.context}` : "",
      `질문: ${question}`,
      "영상에서 실제로 보이는 것만 근거로 3문장 이내 한국어로 답하고, 확실하지 않으면 모른다고 말할 것.",
    ]
      .filter(Boolean)
      .join("\n");

    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VLM,
        stream: false,
        messages: [{ role: "user", content: prompt, images: [buf.toString("base64")] }],
        options: { temperature: 0.2, num_predict: 220 },
      }),
      signal: AbortSignal.timeout(280_000),
    });
    if (!r.ok) throw new Error(`vlm ${r.status}`);
    const j = (await r.json()) as { message?: { content?: string } };
    const answer = (j.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    return NextResponse.json({
      ok: true,
      answer: answer || "영상을 해석하지 못했습니다.",
      model: VLM,
      layer: def.layer,
      date,
      bbox,
      imageBytes: buf.byteLength,
      sources: retrieved.map((r) => r.title), // 레인① 검색-증강에 쓰인 개념 doc
      spatial: spatial || undefined, // 레인② 공간검색 그라운딩 요약
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
