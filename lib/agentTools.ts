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
      name: "filter_fires",
      description:
        "NASA FIRMS 활성 화재 탐지를 지역·기간·강도로 필터해 지도에 표시한다. 산불·화재·불·wildfire 관련 질의에 사용. FRP는 화재복사파워(MW)로 화재 강도를 뜻한다.",
      parameters: {
        type: "object",
        properties: {
          region: { type: "string", description: "지역명 (예: 캘리포니아, California, 호주, 시베리아). 생략하면 전지구" },
          day_range: { type: "number", description: "최근 며칠 (1~10, 기본 1)" },
          min_frp: { type: "number", description: "최소 화재복사파워 MW (예: 100 = 강한 화재만)" },
          min_confidence: { type: "number", description: "최소 신뢰도 0~100" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_layer",
      description:
        "NASA GIBS 위성영상을 지도에 맥락 배경으로 깐다. 산불 연기 확산, 지표 상태 등 '실제 영상으로 보여줘' 요청에 사용. 끄려면 layer=off.",
      parameters: {
        type: "object",
        properties: {
          layer: {
            type: "string",
            description:
              "truecolor=트루컬러(자연색, 연기 플룸), bands721=화재/연소흔 위색합성(연기 투과, 활성 화재가 붉게), truecolor-modis=MODIS 트루컬러, off=끄기",
          },
          date: { type: "string", description: "YYYY-MM-DD (생략하면 가장 최신 가용일)" },
        },
        required: ["layer"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_image",
      description:
        "지도에 깔린 위성영상을 비전 모델(VLM)로 해석한다. '연기가 어디로 번지나', '영상 설명해줘' 같이 영상 내용에 대한 해석을 요청할 때 사용. 수치가 아니라 시각적 판단이 필요할 때만.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "영상에 대해 물을 내용 (예: 연기 플룸의 방향과 규모는?)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_scenes",
      description:
        "STAC 카탈로그에서 특정 지역·기간의 위성영상 '장면'을 검색해 목록으로 보여준다. '어떤 장면이 있나', 'S2/SAR 장면 찾아줘', '구름 없는 영상 찾아줘'처럼 촬영된 장면을 조회할 때 사용. add_layer(배경 깔기)와 달리 촬영 날짜·구름비율 목록을 돌려준다.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "지역명 (예: 서울, 부산, 한반도). 생략하면 한반도" },
          collection: { type: "string", description: "s2=광학(Sentinel-2), sar=Sentinel-1 레이더, landsat. 기본 s2" },
          cloud: { type: "number", description: "최대 구름비율 % (광학만, 기본 20)" },
          days: { type: "number", description: "최근 며칠 범위 (기본 90)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_region",
      description:
        "특정 지역의 관측 상황을 종합 브리핑한다. 'OO 지역 상황/현황', 'OO 대기질 어때', 'OO 관측 요약'처럼 한 지역의 실측 관측(화재·대기질 등)을 묻는 질의에 사용. 지역의 화재·대기질을 실시간 수집해 요약카드로 답한다.",
      parameters: {
        type: "object",
        properties: {
          place: { type: "string", description: "지역명 (예: 서울, 부산, 대전)" },
        },
        required: ["place"],
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
          layer: { type: "string", enum: ["orbits", "groundTracks", "satellites", "aircraft", "terrain", "fires"], description: "궤도=orbits, 지상궤적=groundTracks, 위성=satellites, 항공기=aircraft, 3D지형=terrain, 산불=fires" },
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
    "3) 레이어(궤도/지상궤적/위성/항공기/3D지형/산불) 켜기·끄기 → toggle_layer",
    "4) 산불·화재 조회/필터 → filter_fires (지역은 region, 강도 조건은 min_frp MW)",
    "5) 위성영상·연기·실제 모습으로 보기 → add_layer (연기 확산은 bands721이 잘 보인다)",
    "6) 영상 내용 해석·설명 요청 → analyze_image (VLM). 수치 조회는 filter_fires 를 쓴다.",
    "7) 위성영상 '장면' 검색(어떤 장면 있나/S2·SAR 장면 찾아/구름 없는 영상 찾아) → search_scenes",
    "8) 지역 관측 브리핑(OO 지역 상황/현황, OO 대기질 어때, OO 관측 요약) → describe_region(place=지명)",
    "'서울','도쿄','파리' 같은 도시는 위성이 아니라 '장소'다 → 반드시 fly_to_place 를 쓴다.",
    "요청에 없는 도구는 호출하지 않는다. 답변은 한국어 한 문장.",
  ].join("\n");
}
