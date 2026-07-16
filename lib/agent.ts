// P4 에이전트 실행기 + P3 RAG 라우팅 (클라이언트).
// 지도 명령 = 결정론적 그라운딩(빠름), 그 외 질문 = /api/rag (bge-m3 + Qwen3).
import { useStore } from "./store";
import { mapBus } from "./mapBus";
import { computeOrbit, currentPosition } from "./orbit";
import { geocodePlace, findCity } from "./geo";

type ToolCall = { name: string; args: Record<string, unknown> };

const NONPLACE = /궤도|지상\s*궤적|위성|항공|비행|레이어|지형|영상|화재|산불|고도|속도|주기/;

// 결정론적 의도 해석 (설계서 §4.5 그라운딩) — 소형 로컬 모델의 도구선택 변동성 보정.
function resolveIntent(msg: string): ToolCall | null {
  const m = msg.toLowerCase();

  // 1) 위성 (특정 이름/NORAD)
  const satKeys: [RegExp, string][] = [
    [/\biss\b|zarya|국제우주정거장|우주정거장/, "ISS"],
    [/starlink|스타링크/, "STARLINK"],
    [/kompsat|아리랑|콤샛/, "KOMPSAT"],
    [/noaa|노아/, "NOAA"],
  ];
  for (const [re, q] of satKeys) if (re.test(m)) return { name: "select_satellite", args: { query: q } };
  const norad = m.match(/\b(\d{4,6})\b/);
  if (norad && /(추적|선택|위성|트래킹)/.test(msg)) return { name: "select_satellite", args: { query: norad[1] } };

  // 2) 레이어 토글 (켜/끄 동사가 있을 때만)
  const onOff = /(켜|표시|보이게|활성|on)/.test(msg) ? true : /(꺼|끄|숨|비활성|제거|off)/.test(msg) ? false : null;
  if (onOff !== null) {
    const layerMap: [RegExp, string][] = [
      [/지상\s*궤적/, "groundTracks"],
      [/궤도/, "orbits"],
      [/항공기|비행기|항공/, "aircraft"],
      [/지형|terrain/, "terrain"],
      [/위성/, "satellites"],
    ];
    for (const [re, layer] of layerMap) if (re.test(msg)) return { name: "toggle_layer", args: { layer, visible: onOff } };
  }

  // 3) 장소 — 알려진 도시
  const city = findCity(msg);
  if (city) return { name: "fly_to_place", args: { place: city } };

  // 4) 장소 — 이동 동사 패턴 (미지의 도시는 지오코딩)
  const mv = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{0,24}?)\s*(?:으로|로|에)\s*(?:이동|가줘|가자|이동해|이동시켜|날아가|비행)/);
  if (mv && !NONPLACE.test(mv[1])) return { name: "fly_to_place", args: { place: mv[1].trim() } };
  const ov = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{0,24}?)\s*상공/);
  if (ov && !NONPLACE.test(ov[1])) return { name: "fly_to_place", args: { place: ov[1].trim() } };

  return null;
}

async function execTool(tc: ToolCall): Promise<string | null> {
  const st = useStore.getState();
  const { name, args } = tc;

  if (name === "fly_to_place") {
    const place = String(args.place ?? args.query ?? "").trim();
    if (!place) return null;
    const c = await geocodePlace(place);
    if (!c) return null;
    mapBus.flyTo(c[0], c[1], 3.6);
    return `fly_to_place(${place})`;
  }
  if (name === "fly_to" && typeof args.lat === "number" && typeof args.lng === "number") {
    mapBus.flyTo(args.lng, args.lat, typeof args.zoom === "number" ? Math.min(6, Math.max(1, args.zoom)) : 3.5);
    return `fly_to(${args.lat.toFixed(2)}, ${args.lng.toFixed(2)})`;
  }
  if (name === "select_satellite") {
    const q = String(args.query ?? args.name ?? "").toLowerCase().trim();
    if (!q) return null;
    const sat = st.sats.find((s) => s.name.toLowerCase().includes(q) || String(s.noradId) === q);
    if (!sat) return null;
    st.select(sat.noradId);
    const o = computeOrbit(sat);
    const p = o ? currentPosition(o.satrec) : null;
    if (p) mapBus.flyTo(p[0], p[1], 3.2);
    return `select_satellite(${sat.name})`;
  }
  if (name === "toggle_layer") {
    const layer = String(args.layer ?? "") as keyof typeof st.layers;
    if (!(layer in st.layers)) return null;
    const want = args.visible;
    if (typeof want === "boolean") {
      if (st.layers[layer] !== want) st.toggleLayer(layer);
    } else st.toggleLayer(layer);
    return `toggle_layer(${layer}${typeof want === "boolean" ? `=${want}` : ""})`;
  }
  return null;
}

const LAYER_KO: Record<string, string> = { orbits: "궤도", groundTracks: "지상궤적", satellites: "위성", aircraft: "항공기", terrain: "3D 지형" };

function replyFor(tc: ToolCall, done: string | null): string {
  if (!done) return "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
  if (tc.name === "fly_to_place") return `${tc.args.place}(으)로 이동했습니다.`;
  if (tc.name === "fly_to") return "해당 좌표로 이동했습니다.";
  if (tc.name === "select_satellite") {
    const st = useStore.getState();
    const s = st.sats.find((x) => x.noradId === st.selectedNorad);
    return `${s?.name ?? tc.args.query} 추적을 시작합니다.`;
  }
  if (tc.name === "toggle_layer") {
    const v = tc.args.visible;
    const ko = LAYER_KO[String(tc.args.layer)] ?? String(tc.args.layer);
    return `${ko} 레이어를 ${v === false ? "껐습니다" : v === true ? "켰습니다" : "전환했습니다"}.`;
  }
  return "완료했습니다.";
}

export async function runAgent(text: string) {
  const s0 = useStore.getState();
  const msg = text.trim();
  if (!msg || s0.agentBusy) return;

  s0.pushChat({ role: "user", content: msg });
  s0.setBusy(true);
  try {
    // 지도 명령 → 결정론적 실행 (빠름)
    const forced = resolveIntent(msg);
    if (forced) {
      const done = await execTool(forced);
      useStore.getState().pushChat({ role: "assistant", content: replyFor(forced, done), tools: done ? [done] : undefined });
      return;
    }
    // 그 외 → 지식 질문 RAG (bge-m3 + Qwen3, §4.3)
    const r = await fetch("/api/rag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: msg }),
    });
    const j = (await r.json()) as { answer?: string; sources?: string[] };
    useStore.getState().pushChat({
      role: "assistant",
      content: j.answer ?? "답변을 가져오지 못했습니다.",
      tools: j.sources?.length ? j.sources.map((s) => `근거: ${s}`) : undefined,
    });
  } catch (e) {
    useStore.getState().pushChat({ role: "assistant", content: "에이전트 오류: " + String(e) });
  } finally {
    useStore.getState().setBusy(false);
  }
}
