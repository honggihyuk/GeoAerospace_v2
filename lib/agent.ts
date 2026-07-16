// P4 에이전트 실행기 (클라이언트) — /api/agent(Qwen3) 호출 후 도구를 지도/스토어에 실행.
import { useStore } from "./store";
import { mapBus } from "./mapBus";
import { computeOrbit, currentPosition } from "./orbit";
import { geocodePlace, findCity } from "./geo";

type ToolCall = { name: string; args: Record<string, unknown> };

// 결정론적 의도 해석 (설계서 §4.5 그라운딩) — 메시지에서 의도를 확정 추출.
// 소형 로컬 모델(Qwen3-8B)의 도구선택 변동성을 보정하는 검증 레이어.
function resolveIntent(msg: string): ToolCall | null {
  const m = msg.toLowerCase();

  // 1) 위성 (특정 이름/NORAD) — 가장 구체적이므로 먼저
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
  const onOff = /(켜|표시|보이|활성|on)/.test(msg) ? true : /(꺼|끄|숨|비활성|제거|off)/.test(msg) ? false : null;
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

  // 3) 장소 (알려진 도시가 포함되면)
  const city = findCity(msg);
  if (city) return { name: "fly_to_place", args: { place: city } };

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

  // 모델이 좌표를 직접 넘긴 경우도 허용(하위호환)
  if (name === "fly_to" && typeof args.lat === "number" && typeof args.lng === "number") {
    const zoom = typeof args.zoom === "number" ? Math.min(6, Math.max(1, args.zoom)) : 3.5;
    mapBus.flyTo(args.lng, args.lat, zoom);
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
    } else {
      st.toggleLayer(layer);
    }
    return `toggle_layer(${layer}${typeof want === "boolean" ? `=${want}` : ""})`;
  }

  return null;
}

export async function runAgent(text: string) {
  const s0 = useStore.getState();
  const msg = text.trim();
  if (!msg || s0.agentBusy) return;

  s0.pushChat({ role: "user", content: msg });
  s0.setBusy(true);
  try {
    const st = useStore.getState();
    const context = {
      selected: st.sats.find((x) => x.noradId === st.selectedNorad)?.name ?? "none",
      aircraft: st.aircraftCount,
      satellites: st.sats.map((x) => x.name),
      layers: st.layers,
    };
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, context }),
    });
    const j = (await r.json()) as { content?: string; toolCalls?: ToolCall[] };
    const executed: string[] = [];

    // 그라운딩: 메시지에서 의도가 확정되면 그것을 우선(모델 오분류 보정), 아니면 모델 도구호출 사용
    const forced = resolveIntent(msg);
    const calls = forced ? [forced] : j.toolCalls ?? [];
    for (const tc of calls) {
      const done = await execTool(tc);
      if (done) executed.push(done);
    }
    const content = (j.content ?? "").trim() || (executed.length ? "완료했습니다." : "요청을 이해하지 못했습니다.");
    useStore.getState().pushChat({ role: "assistant", content, tools: executed.length ? executed : undefined });
  } catch (e) {
    useStore.getState().pushChat({ role: "assistant", content: "에이전트 오류: " + String(e) });
  } finally {
    useStore.getState().setBusy(false);
  }
}
