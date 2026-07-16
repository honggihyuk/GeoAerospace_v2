// P4 에이전트 도구 정의 + 시스템 프롬프트 (설계서 §4.5 / §7.5)
// 로컬 개발: Ollama Qwen3-8B (§4.5-0.6). 지도 조작 도구는 클라이언트가 실행.

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "fly_to_place",
      description: "도시·국가·지역 등 지명으로 지도를 이동한다. 위성이 아니라 지구상의 장소일 때 사용. 좌표는 시스템이 변환하므로 지명 문자열만 넘긴다.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "지명 (예: 서울, Tokyo, 뉴욕, 파리)" },
        },
        required: ["place"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "select_satellite",
      description: "위성을 추적 대상으로 선택하고 그 위성 위치로 이동한다.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "위성 이름 일부 또는 NORAD 번호 (예: ISS, STARLINK, KOMPSAT, NOAA, 25544)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toggle_layer",
      description: "지도 레이어를 켜거나 끈다.",
      parameters: {
        type: "object",
        properties: {
          layer: { type: "string", enum: ["orbits", "groundTracks", "satellites", "aircraft", "terrain"], description: "궤도=orbits, 지상궤적=groundTracks, 위성=satellites, 항공기=aircraft, 3D지형=terrain" },
          visible: { type: "boolean", description: "표시 여부 (생략 시 토글)" },
        },
        required: ["layer"],
      },
    },
  },
];

export function systemPrompt(ctx: { selected: string; aircraft: number; satellites: string[]; layers: Record<string, boolean> }): string {
  void ctx;
  return [
    "너는 지도 관제 어시스턴트다. 사용자 요청에 맞는 도구를 정확히 하나 호출한다.",
    "규칙:",
    "1) 도시·나라 등 지명으로 이동/보기 → fly_to_place(place=그 지명 그대로)",
    "2) 위성 이름(ISS, STARLINK, KOMPSAT, NOAA)으로 추적/선택 → select_satellite(query=그 이름)",
    "3) 레이어(궤도/지상궤적/위성/항공기/3D지형) 켜기·끄기 → toggle_layer",
    "'서울','도쿄','파리' 같은 도시는 위성이 아니라 '장소'다 → 반드시 fly_to_place 를 쓴다.",
    "요청에 없는 도구는 호출하지 않는다. 답변은 한국어 한 문장.",
  ].join("\n");
}
