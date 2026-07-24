// P4 에이전트 실행기 + P3 RAG 라우팅 (클라이언트).
// 지도 명령 = 결정론적 그라운딩(빠름), 그 외 질문 = /api/rag (bge-m3 + Qwen3).
import { useStore } from "./store";
import { mapBus } from "./mapBus";
import { computeOrbit, currentPosition } from "./orbit";
import { geocodePlace, geocodeArea, findCity } from "./geo";
import { loadFires } from "./firesClient";
import { findGibsLayer } from "./gibs";
import { KOREA_BBOX } from "./koreaCube";

type ToolCall = { name: string; args: Record<string, unknown> };

/** analyze_image 결과를 replyFor로 넘기기 위한 임시 보관. */
let lastVlmAnswer = "";

/** search_scenes(STAC) 결과를 replyFor로 넘기기 위한 임시 보관. */
let lastStac: { count: number; collection: string; scenes: { date: string; cloud: number | null }[] } | null = null;

/** describe_region 브리핑 결과를 replyFor로 넘기기 위한 임시 보관. */
let lastRegion: { answer: string; sources: string[] } | null = null;

/** spectral_index(NDVI/NDWI/NBR) 통계를 replyFor로 넘기기 위한 임시 보관. */
type SpectralStats = {
  index: string;
  place: string;
  scene: { date: string; cloud: number | null; coverage_pct: number };
  grid: { pixel_m: number };
  area_km2: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  classes: { name: string; label: string; area_m2: number; percentage: number }[];
};
let lastSpectral: SpectralStats | null = null;

/** change_detection 결과를 replyFor로 넘기기 위한 임시 보관. */
type ChangeStats = {
  place: string;
  from: { date: string };
  to: { date: string };
  area_km2: number;
  valid_fraction: number;
  dnbr_valid_fraction: number;
  warning: string | null;
  composite: { mean: number; changed_area_m2: number; classes: { label: string; percentage: number }[] };
  dnbr: { mean: number; burned_area_m2: number; classes: { label: string; percentage: number }[] } | null;
};
let lastChange: ChangeStats | null = null;

/** compare_index(지수 2시점 면적 비교) 결과 보관. */
type CompareStats = {
  index: string;
  place: string;
  from: { scene: { date: string } };
  to: { scene: { date: string } };
  delta: { name: string; label: string; from_m2: number; to_m2: number; diff_m2: number; diff_pct: number | null }[];
  warning: string | null;
};
let lastCompare: CompareStats | null = null;

/** scan_region_change(Clay 임베딩 광역 변화) 결과 보관. */
type RegionScanStats = {
  place: string; from: string; to: string; joined_cells: number; cell_km: number;
  cosine_median: number; changed_cells: number; changed_area_km2: number;
  top: { cx: number; cy: number; score: number; sim: number }[];
  cells: { cx: number; cy: number; score: number }[];
};
let lastRegionScan: RegionScanStats | null = null;

// 광역 변화 스캔 의도 — "광역/전역/스캔" 또는 연 단위 변화 + 장소. 월 정밀 아닌 연 규모.
const REGIONSCAN_RE = /광역|전역|스캔|scan|토지\s*변화|개발\s*추이|도시화|장기\s*변화/i;

// 변화 탐지 의도 — 두 날짜(YYYY-MM-DD)가 있어야 성립한다(사건 전/후를 시스템이 임의로 못 정함).
const CHANGE_RE = /변화|전후|피해\s*(면적|규모|정도)|dnbr|연소\s*심각도|비교/i;

// 분광지수 의도 — 반드시 산불(FIRMS) 분기보다 먼저 판정한다.
//   "산불 보여줘"는 FIRMS 포인트지만 "산불 피해 면적"은 NBR(연소 정도) 이므로,
//   NBR 트리거는 피해/흔적/연소처럼 **명시적 단어**가 있을 때만 걸리게 좁힌다.
const NDVI_RE = /ndvi|식생|녹지|초목|산림\s*(면적|비율|분포)|숲\s*(면적|비율|분포)/i;
const NDWI_RE = /ndwi|수체|수면|물\s*(면적|비율)|호수\s*면적|저수(량|율)/i;
const NBR_RE = /nbr|연소\s*(지수|정도|도)|화상|소실\s*면적|산불\s*(피해|흔적|자국)|탄\s*(정도|면적)/i;

const ANALYSIS_RE = /설명|해석|분석|어디로|어느 방향|확산|규모|번지|얼마나 심각|판단|보이는|알려줘/;
const IMAGERY_RE = /위성\s*영상|영상으로|맥락\s*영상|연기|스모크|트루컬러|truecolor|bands\s*721|실제\s*모습|가시광/i;
const NONPLACE = /궤도|지상\s*궤적|위성|항공|비행|레이어|지형|영상|화재|산불|고도|속도|주기/;

/** 수치가 많아 자연어 서술이 도움 되는 도구 — 서술은 덧붙일 뿐 수치를 대체하지 않는다. */
const NARRATE_TOOLS = new Set(["spectral_index", "change_detection", "compare_index"]);

/** 결정론 수치 → 자연스러운 문장. 실패하면 null(서술 없이 수치만 보여준다 — 절대 막지 않는다). */
async function narrate(facts: string): Promise<string | null> {
  try {
    const r = await fetch("/api/narrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ facts }),
    });
    const j = (await r.json()) as { ok?: boolean; text?: string };
    return j.ok && j.text?.trim() ? j.text.trim() : null;
  } catch {
    return null;
  }
}

// 결정론적 의도 해석 (설계서 §4.5 그라운딩) — 소형 로컬 모델의 도구선택 변동성 보정.
function resolveIntent(msg: string): ToolCall[] | null {
  const m = msg.toLowerCase();

  // 1) 위성 (특정 이름/NORAD)
  const satKeys: [RegExp, string][] = [
    [/\biss\b|zarya|국제우주정거장|우주정거장/, "ISS"],
    [/starlink|스타링크/, "STARLINK"],
    // GK2A를 KOMPSAT보다 먼저 본다. 실시간 TLE가 붙으면 이름이 "GEO-KOMPSAT-2A"가 되어
    // 'kompsat' 부분일치로 KOMPSAT-3A 대신 GK2A가 잡히는 혼선이 생긴다.
    [/gk-?2a|천리안|geo-?kompsat/, "43823"],
    [/kompsat|아리랑|콤샛/, "KOMPSAT-3"],
    [/noaa|노아/, "NOAA"],
  ];
  for (const [re, q] of satKeys) if (re.test(m)) return [{ name: "select_satellite", args: { query: q } }];
  const norad = m.match(/\b(\d{4,6})\b/);
  if (norad && /(추적|선택|위성|트래킹)/.test(msg)) return [{ name: "select_satellite", args: { query: norad[1] } }];

  // 2) 레이어 토글 (켜/끄 동사가 있을 때만)
  const onOff = /(켜|표시|보이게|활성|on)/.test(msg) ? true : /(꺼|끄|숨|비활성|제거|off)/.test(msg) ? false : null;

  // 2-000) 광역 토지변화 스캔(Clay 임베딩) — 연도 2개(YYYY) + 광역/스캔 의도. 픽셀 탐지보다 먼저.
  {
    const years = msg.match(/(20\d{2})/g) ?? [];
    if (REGIONSCAN_RE.test(msg) && years.length >= 2) {
      const cityHit = findCity(msg);
      const near = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{1,24}?)\s*(?:의|지역|일대|토지|변화|개발|도시화)/);
      const place = cityHit ?? (near && !NONPLACE.test(near[1]) ? near[1].trim() : undefined);
      if (place) {
        const ys = [...years].map(Number).sort((a, b) => a - b);
        return [{ name: "scan_region_change", args: { place, fromY: ys[0], toY: ys[ys.length - 1] } }];
      }
    }
  }

  // 2-00) 날짜 2개(YYYY-MM-DD)가 명시된 두 시점 질의 — 분광지수보다 먼저.
  //   ⚠️ 라우팅 충돌 해소: **특정 지수(NDVI/NDWI)를 명시하면 지수 면적 비교(compare_index)**,
  //      NBR·산불피해·변화처럼 지수를 안 짚으면 변화 탐지(change_detection, dNBR).
  //      dNBR 자체가 전후 NBR 차이라 산불엔 change_detection이 맞고, "수면·식생이 얼마나
  //      늘고 줄었나"는 compare_index가 맞다.
  {
    const dates = msg.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    if (dates.length >= 2) {
      const cityHit = findCity(msg);
      const near = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{1,24}?)\s*(?:의|지역|일대|산불|화재|변화|피해|수면|수체|식생|녹지|호수)/);
      const place = cityHit ?? (near && !NONPLACE.test(near[1]) ? near[1].trim() : undefined);
      const [d1, d2] = [...dates].sort();
      // NDVI/NDWI 명시(단, NBR은 제외 — NBR/연소는 change_detection으로) → 지수 비교
      const cmpIndex = !NBR_RE.test(msg) && NDWI_RE.test(msg) ? "ndwi" : !NBR_RE.test(msg) && NDVI_RE.test(msg) ? "ndvi" : null;
      if (place && cmpIndex) return [{ name: "compare_index", args: { index: cmpIndex, place, from: d1, to: d2 } }];
      if (place && (CHANGE_RE.test(msg) || NBR_RE.test(msg))) return [{ name: "change_detection", args: { place, from: d1, to: d2 } }];
    }
  }

  // 2-0) 분광지수(NDVI/NDWI/NBR) — 산불 분기보다 먼저. Sentinel-2 결정론 통계.
  //   장소가 있어야 bbox를 만들 수 있다(§4.3 환각 방지 — bbox는 지오코딩으로 시스템이 생성).
  {
    const index = NBR_RE.test(msg) ? "nbr" : NDWI_RE.test(msg) ? "ndwi" : NDVI_RE.test(msg) ? "ndvi" : null;
    if (index) {
      const cityHit = findCity(msg);
      const near = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{1,20}?)\s*(?:의|지역|일대|시|근처)?\s*(?:식생|녹지|초목|산림|숲|수체|수면|물|호수|저수|연소|화상|소실|산불|ndvi|ndwi|nbr)/i);
      const place = cityHit ?? (near && !NONPLACE.test(near[1]) ? near[1].trim() : undefined);
      if (place) return [{ name: "spectral_index", args: { index, place } }];
    }
  }

  // 2-a) 산불은 토글보다 먼저 판정한다.
  // "표시해줘"의 '표시'가 켜기 동사라, 아래 layerMap에 fires를 넣으면
  // "캘리포니아 산불 FRP 100MW 이상 표시해줘" 같은 질의가 단순 토글로 가로채인다.
  // 끄기일 때만 토글이고, 그 외에는 항상 filter_fires(레이어도 함께 켜짐)로 보낸다.
  if (/산불|화재|불난|wildfire|fire/i.test(msg)) {
    if (onOff === false) return [{ name: "toggle_layer", args: { layer: "fires", visible: false } }];
    const frp = msg.match(/(\d+)\s*(?:mw|MW)/);
    const days = msg.match(/(\d+)\s*일/);
    const region = msg.match(/([가-힣A-Za-z ]{2,20}?)\s*(?:지역|에서|의)?\s*(?:산불|화재)/);
    const chain: ToolCall[] = [
      {
        name: "filter_fires",
        args: {
          ...(region && !NONPLACE.test(region[1]) ? { region: region[1].trim() } : {}),
          ...(frp ? { min_frp: Number(frp[1]) } : {}),
          ...(days ? { day_range: Number(days[1]) } : {}),
        },
      },
    ];
    // fire-analyst 서브에이전트 (제안서 §4.5/§4.7) — 산불 질의를 3계층으로 오케스트레이션한다.
    //   1계층 FIRMS 포인트: "어디서 얼마나 강하게" (위 filter_fires)
    //   2계층 GIBS 래스터:  맥락 영상 (연기 플룸은 트루컬러, 연소흔은 bands721)
    //   3계층 VLM:          영상 해석 — 수치로는 안 나오는 "확산 방향·규모"
    const wantsImagery = IMAGERY_RE.test(msg);
    const wantsAnalysis = ANALYSIS_RE.test(msg);
    if (wantsImagery || wantsAnalysis) {
      chain.push({
        name: "add_layer",
        args: { layer: /연소흔|번짐|피해|burn|bands/i.test(msg) ? "bands721" : "truecolor" },
      });
    }
    if (wantsAnalysis) {
      chain.push({ name: "analyze_image", args: { question: msg } });
    }
    return chain;
  }

  // 2-a2) STAC 장면 검색 (레인 ③) — 촬영된 '장면' 목록 조회.
  //   add_layer(GIBS 배경 오버레이)와 구분: '장면' 또는 검색동사(찾/검색/목록/조회/있)가 있을 때만.
  //   반드시 IMAGERY_RE(add_layer) 분기보다 먼저 판정한다 — "위성영상 찾아줘"가 오버레이로 새는 것 방지.
  if (/장면|scene\b/i.test(msg) || /(sentinel|센티넬|s-?[12]\b|sar|레이더|위성\s*영상).{0,12}(찾|검색|목록|조회|리스트|있)/i.test(msg)) {
    const isSar = /\bsar\b|sentinel-?1|s-?1\b|레이더/i.test(msg);
    const cloudM = msg.match(/구름\s*(\d+)|cloud\s*(\d+)/i);
    const daysM = msg.match(/(\d+)\s*일/);
    const FILLER = /구름|없는|최근|최신|이번|오늘|어제|내일|촬영|찍은|캡처|무슨|어떤|있는|위성|영상|장면/;
    const city = findCity(msg);
    const near = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{1,20}?)\s*(?:지역|일대|상공|근처|의)?\s*(?:위성\s*영상|장면|scene)/i);
    const place = city ?? (near && !NONPLACE.test(near[1]) && !FILLER.test(near[1]) ? near[1].trim() : undefined);
    return [
      {
        name: "search_scenes",
        args: {
          ...(place ? { place } : {}),
          collection: isSar ? "sar" : "s2",
          ...(cloudM ? { cloud: Number(cloudM[1] ?? cloudM[2]) } : {}),
          ...(daysM ? { days: Number(daysM[1]) } : {}),
        },
      },
    ];
  }

  // 2-b) 영상 해석 단독 요청
  if (ANALYSIS_RE.test(msg) && IMAGERY_RE.test(msg)) {
    return [{ name: "analyze_image", args: { question: msg } }];
  }

  // 2-c) 위성영상 맥락 오버레이 (산불과 무관한 단독 요청)
  if (IMAGERY_RE.test(msg)) {
    if (onOff === false || /영상.*(꺼|끄|해제|제거)/.test(msg)) return [{ name: "add_layer", args: { layer: "off" } }];
    const layer = /bands\s*721|연소흔|위색/i.test(msg) ? "bands721" : /modis/i.test(msg) ? "truecolor-modis" : "truecolor";
    return [{ name: "add_layer", args: { layer } }];
  }

  if (onOff !== null) {
    const layerMap: [RegExp, string][] = [
      [/지상\s*궤적/, "groundTracks"],
      [/궤도/, "orbits"],
      [/항공기|비행기|항공/, "aircraft"],
      [/지형|terrain/, "terrain"],
      [/위성/, "satellites"],
    ];
    for (const [re, layer] of layerMap) if (re.test(msg)) return [{ name: "toggle_layer", args: { layer, visible: onOff } }];
  }

  // 2-e) 지역 관측 브리핑 (온디맨드) — 장소 + 상황/대기질/관측 의도.
  //   반드시 아래 fly_to_place(도시명만 있으면 이동) 보다 먼저 판정한다.
  //   "서울 대기질 어때"는 이동이 아니라 브리핑 — DESCRIBE_RE가 있을 때만 가로챈다.
  {
    const DESCRIBE_RE = /상황|현황|브리핑|브리프|대기질|공기\s*질|미세먼지|관측\s*요약|모니터링|리포트|어때|어떤가|어떻나/;
    const FILLER = /구름|없는|최근|최신|이번|오늘|어제|내일|무슨|어떤|있는|위성|영상|장면|상황|현황|대기질|미세먼지|관측/;
    const cityHit = findCity(msg);
    const near = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{1,20}?)\s*(?:지역|일대|시|의|근처)?\s*(?:상황|현황|브리핑|대기질|공기|미세먼지|관측|모니터링)/);
    const placeCand = cityHit ?? (near && !NONPLACE.test(near[1]) && !FILLER.test(near[1]) ? near[1].trim() : undefined);
    if (placeCand && DESCRIBE_RE.test(msg)) {
      return [{ name: "describe_region", args: { place: placeCand, question: msg } }];
    }
  }

  // 3) 장소 — 알려진 도시
  const city = findCity(msg);
  if (city) return [{ name: "fly_to_place", args: { place: city } }];

  // 4) 장소 — 이동 동사 패턴 (미지의 도시는 지오코딩)
  const mv = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{0,24}?)\s*(?:으로|로|에)\s*(?:이동|가줘|가자|이동해|이동시켜|날아가|비행)/);
  if (mv && !NONPLACE.test(mv[1])) return [{ name: "fly_to_place", args: { place: mv[1].trim() } }];
  const ov = msg.match(/([가-힣A-Za-z][가-힣A-Za-z ]{0,24}?)\s*상공/);
  if (ov && !NONPLACE.test(ov[1])) return [{ name: "fly_to_place", args: { place: ov[1].trim() } }];

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
    // NORAD 번호 완전일치를 먼저 본다 — 이름 부분일치는 "KOMPSAT"처럼 겹칠 수 있다
    const sat = st.sats.find((s) => String(s.noradId) === q) ?? st.sats.find((s) => s.name.toLowerCase().includes(q));
    if (!sat) return null;
    st.select(sat.noradId);
    const o = computeOrbit(sat);
    const p = o ? currentPosition(o.satrec) : null;
    if (p) mapBus.flyTo(p[0], p[1], 3.2);
    return `select_satellite(${sat.name})`;
  }
  if (name === "filter_fires") {
    const region = args.region ? String(args.region) : undefined;
    // 지역명이 있으면 지오코딩해 bbox를 만든다 — 좌표는 모델이 아니라 시스템이 만든다(§4.3 환각 방지)
    let bbox: string | undefined;
    if (region) {
      const g = await geocodePlace(region);
      if (g) {
        const [lng, lat] = g; // geocodePlace는 [lng, lat] 튜플을 낸다
        const pad = 6; // 도시 좌표를 지역 규모 bbox로 확장
        bbox = [lng - pad, Math.max(-90, lat - pad), lng + pad, Math.min(90, lat + pad)].join(",");
        mapBus.flyTo(lng, lat, 4);
      }
    }
    // 순서 주의: 먼저 필터 로드를 걸어 status를 "loading"으로 만든 뒤 레이어를 켠다.
    // 반대로 하면 toggleLayer가 지연 로딩 훅(useFiresLayer)을 깨워 *필터 없는* 전지구
    // 로드가 동시에 돌고, 늦게 끝난 쪽이 이겨 필터가 사라진다.
    const pending = loadFires({
      region,
      bbox,
      minFrp: typeof args.min_frp === "number" ? args.min_frp : undefined,
      minConfidence: typeof args.min_confidence === "number" ? args.min_confidence : undefined,
      dayRange: typeof args.day_range === "number" ? args.day_range : undefined,
    });
    if (!st.layers.fires) st.toggleLayer("fires");
    await pending;
    return `filter_fires(${region ?? "global"}${args.min_frp ? `, frp>=${args.min_frp}` : ""})`;
  }
  if (name === "add_layer") {
    const raw = String(args.layer ?? "").trim();
    if (/^(off|없음|끄기|해제)$/i.test(raw)) {
      st.setGibs(null);
      return "add_layer(off)";
    }
    const def = findGibsLayer(raw);
    if (!def) return null;
    // 날짜는 서버가 정한다 — "오늘"은 스와스가 덜 채워져 대부분 빈 영상이다(B1 실측)
    let date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : "";
    if (!date) {
      try {
        const r = await fetch("/api/gibs");
        date = (await r.json())?.date ?? "";
      } catch {
        /* 아래 폴백 */
      }
    }
    if (!date) date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    st.setGibs({ layerId: def.id, date });
    return `add_layer(${def.layer}, TIME=${date})`;
  }
  if (name === "analyze_image") {
    const f = st.fires;
    const g = st.gibs;
    // 영상 해석은 지금 화면에 깔린 것과 같은 레이어·날짜여야 의미가 있다.
    //
    // 영역은 조회 bbox가 아니라 *실제 탐지점*을 감싸도록 좁힌다.
    // 지오코딩한 지역 bbox(12°≈1300km)를 768px로 받으면 픽셀당 ~1.7km라
    // 연기 플룸이 물리적으로 보이지 않는다(실측: VLM이 연기를 못 찾고 구름이라 답함).
    let bbox = f.bbox ?? "-125,32,-114,42";
    const pts = f.points.filter((p) => p.kind === "fire");
    if (pts.length > 0) {
      const lats = pts.map((p) => p.lat);
      const lons = pts.map((p) => p.lon);
      // 최소 0.6° 폭은 확보 — 너무 좁으면 맥락(주변 지형·바람)이 사라진다
      const pad = 0.35;
      const s0 = Math.min(...lats) - pad;
      const n0 = Math.max(...lats) + pad;
      const w0 = Math.min(...lons) - pad;
      const e0 = Math.max(...lons) + pad;
      const cx = (w0 + e0) / 2;
      const cy = (s0 + n0) / 2;
      const halfW = Math.max(0.3, (e0 - w0) / 2);
      const halfH = Math.max(0.3, (n0 - s0) / 2);
      bbox = [cx - halfW, Math.max(-90, cy - halfH), cx + halfW, Math.min(90, cy + halfH)]
        .map((v) => v.toFixed(4))
        .join(",");
    }
    // 그라운딩: FIRMS 수치를 함께 넘겨 모델이 개수를 지어내지 못하게 한다.
    const context =
      f.status === "ready" && f.total > 0
        ? `이 영역에 FIRMS 활성 화재 탐지 ${f.total}건, 최대 FRP ${f.maxFrp}MW${f.filter?.minFrp ? ` (FRP ${f.filter.minFrp}MW 이상만 집계)` : ""}.`
        : undefined;
    try {
      const r = await fetch("/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          layer: g?.layerId ?? "truecolor",
          date: g?.date,
          question: typeof args.question === "string" && args.question.trim() ? args.question : undefined,
          context,
        }),
      });
      const j = (await r.json()) as { ok?: boolean; answer?: string; model?: string; reason?: string };
      if (!j.ok) return null;
      lastVlmAnswer = j.answer ?? "";
      return `analyze_image(${j.model})`;
    } catch {
      return null;
    }
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
  if (name === "spectral_index") {
    const index = String(args.index ?? "ndvi");
    const place = String(args.place ?? "").trim();
    if (!place) return null;
    // bbox는 시스템이 생성(§4.3 환각 방지). 지오코더의 **실제 경계**를 쓰되 API 상한 1°로 클램프.
    const area = await geocodeArea(place, 1.0);
    if (!area) return null;
    const g = area.center;
    const bbox = area.bbox.map((n) => n.toFixed(4)).join(",");
    try {
      // place를 넘기면 서버가 **실제 폴리곤으로 클리핑**한다(사각형보다 훨씬 정확 —
      // 센트럴파크 실측: 면적 9.09→3.09km²(실제 3.41), 초고밀도 식생 55.4→90.2%).
      const r = await fetch(`/api/spectral?index=${encodeURIComponent(index)}&place=${encodeURIComponent(place)}`);
      const j = (await r.json()) as { ok?: boolean; reason?: string } & Omit<SpectralStats, "place">;
      if (!j.ok) {
        lastSpectral = null;
        return null;
      }
      lastSpectral = { ...(j as unknown as SpectralStats), place };
      // 같은 bbox의 컬러맵 PNG를 오버레이로 — 수치와 그림을 함께 본다.
      useStore.getState().setSpectral({
        index: index as "ndvi" | "ndwi" | "nbr",
        place,
        bbox: area.bbox,
        url: `/api/spectral/image?index=${encodeURIComponent(index)}&bbox=${bbox}`,
        date: lastSpectral.scene?.date ?? "",
        opacity: 0.75,
      });
      mapBus.flyTo(g[0], g[1], 9.5); // 분석 영역이 보이도록 확대
      return `spectral_index(${index}, ${place})`;
    } catch {
      lastSpectral = null;
      return null;
    }
  }

  if (name === "change_detection") {
    const place = String(args.place ?? "").trim();
    const from = String(args.from ?? "");
    const to = String(args.to ?? "");
    if (!place || !from || !to) return null;
    // 변화 탐지는 지수 6회 읽기라 비용이 커 상한이 더 좁다(/api/change 0.5°).
    const area = await geocodeArea(place, 0.5);
    if (!area) return null;
    const g = area.center;
    const bbox = area.bbox.map((n) => n.toFixed(4)).join(",");
    try {
      const r = await fetch(`/api/change?bbox=${bbox}&from=${from}&to=${to}`);
      const j = (await r.json()) as { ok?: boolean } & Omit<ChangeStats, "place">;
      if (!j.ok) {
        lastChange = null;
        return null;
      }
      lastChange = { ...(j as unknown as ChangeStats), place };
      // dNBR 유효비율이 더 높으면 dNBR을, 아니면 합성을 띄운다(볼 수 있는 쪽을 보여준다).
      const layer = (lastChange.dnbr_valid_fraction ?? 0) >= (lastChange.valid_fraction ?? 0) ? "dnbr" : "composite";
      useStore.getState().setSpectral({
        index: layer === "dnbr" ? "dnbr" : "change",
        place,
        bbox: area.bbox,
        url: `/api/change/image?bbox=${bbox}&from=${from}&to=${to}&layer=${layer}`,
        date: `${from} → ${to}`,
        opacity: 0.8,
      });
      mapBus.flyTo(g[0], g[1], 9);
      return `change_detection(${place}, ${from}→${to})`;
    } catch {
      lastChange = null;
      return null;
    }
  }

  if (name === "scan_region_change") {
    const place = String(args.place ?? "").trim();
    const fromY = Number(args.fromY), toY = Number(args.toY);
    if (!place || !fromY || !toY) return null;
    // 광역 스캔이라 넓은 AOI를 잡는다(상한 5°). peak-season 7월(북반구)로 고정.
    const area = await geocodeArea(place, 3.0, 0.3);
    if (!area) return null;
    const bbox = area.bbox.map((n) => n.toFixed(4)).join(",");
    try {
      const r = await fetch(`/api/region-change?bbox=${bbox}&from=${fromY}-07&to=${toY}-07`);
      const j = (await r.json()) as { ok?: boolean } & Omit<RegionScanStats, "place">;
      if (!j.ok) {
        lastRegionScan = null;
        return null;
      }
      lastRegionScan = { ...(j as unknown as RegionScanStats), place };
      useStore.getState().setRegionChange({ place, from: `${fromY}-07`, to: `${toY}-07`, cells: lastRegionScan.cells });
      mapBus.flyTo(area.center[0], area.center[1], 8);
      return `scan_region_change(${place}, ${fromY}→${toY})`;
    } catch {
      lastRegionScan = null;
      return null;
    }
  }

  if (name === "compare_index") {
    const index = String(args.index ?? "ndwi");
    const place = String(args.place ?? "").trim();
    const from = String(args.from ?? "");
    const to = String(args.to ?? "");
    if (!place || !from || !to) return null;
    try {
      // place를 넘기면 서버가 지오코딩+폴리곤 클리핑까지 처리한다(호수·공원 경계).
      const r = await fetch(`/api/spectral/compare?index=${encodeURIComponent(index)}&place=${encodeURIComponent(place)}&from=${from}&to=${to}`);
      const j = (await r.json()) as { ok?: boolean } & Omit<CompareStats, "place">;
      if (!j.ok) {
        lastCompare = null;
        return null;
      }
      lastCompare = { ...(j as unknown as CompareStats), place };
      // 지도는 최신 시점(to)의 지수 오버레이를 띄운다 — 비교 diff 오버레이는 추후.
      const area = await geocodeArea(place, 1.0);
      if (area) {
        const bbox = area.bbox.map((n) => n.toFixed(4)).join(",");
        useStore.getState().setSpectral({
          index: index as "ndvi" | "ndwi" | "nbr",
          place,
          bbox: area.bbox,
          url: `/api/spectral/image?index=${encodeURIComponent(index)}&bbox=${bbox}&date=${to}`,
          date: `${from} vs ${to}`,
          opacity: 0.75,
        });
        mapBus.flyTo(area.center[0], area.center[1], 9);
      }
      return `compare_index(${index}, ${place}, ${from}↔${to})`;
    } catch {
      lastCompare = null;
      return null;
    }
  }

  if (name === "search_scenes") {
    const place = String(args.place ?? "").trim();
    // bbox 는 지명을 지오코딩해 시스템이 만든다(§4.3 환각 방지). 지명 없으면 한반도 기본.
    let bbox = [KOREA_BBOX.west, KOREA_BBOX.south, KOREA_BBOX.east, KOREA_BBOX.north].join(",");
    let center: [number, number] | null = null;
    if (place) {
      const g = await geocodePlace(place);
      if (g) {
        center = g;
        const pad = 0.7; // 도시 좌표를 장면 검색용 소규모 bbox로 확장
        bbox = [g[0] - pad, Math.max(-90, g[1] - pad), g[0] + pad, Math.min(90, g[1] + pad)].join(",");
      }
    }
    try {
      const r = await fetch("/api/stac", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          collection: typeof args.collection === "string" ? args.collection : "s2",
          ...(typeof args.cloud === "number" ? { cloud: args.cloud } : {}),
          ...(typeof args.days === "number" ? { days: args.days } : {}),
        }),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        count?: number;
        collection?: string;
        scenes?: { date: string; cloud: number | null }[];
      };
      if (!j.ok) return null;
      lastStac = { count: j.count ?? 0, collection: j.collection ?? "sentinel-2-l2a", scenes: j.scenes ?? [] };
      if (center) mapBus.flyTo(center[0], center[1], 4.5);
      return `search_scenes(${place || "한반도"}, ${j.count ?? 0})`;
    } catch {
      return null;
    }
  }
  if (name === "describe_region") {
    const place = String(args.place ?? "").trim();
    if (!place) return null;
    const g = await geocodePlace(place);
    if (!g) return null;
    const pad = 0.35; // 도시 규모 bbox(≈39km) — 시가지 관측소·화재를 감싼다
    const bbox = [g[0] - pad, Math.max(-90, g[1] - pad), g[0] + pad, Math.min(90, g[1] + pad)].join(",");
    mapBus.flyTo(g[0], g[1], 5);
    try {
      const r = await fetch("/api/region/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place, bbox, question: typeof args.question === "string" ? args.question : undefined }),
      });
      const j = (await r.json()) as { ok?: boolean; answer?: string; sources?: string[] };
      if (!j.ok || !j.answer) return null;
      lastRegion = { answer: j.answer, sources: j.sources ?? [] };
      return `describe_region(${place})`;
    } catch {
      return null;
    }
  }
  return null;
}

const LAYER_KO: Record<string, string> = { orbits: "궤도", groundTracks: "지상궤적", satellites: "위성", aircraft: "항공기", terrain: "3D 지형", fires: "산불" };

function replyFor(tc: ToolCall, done: string | null): string {
  if (!done) return "요청을 처리하지 못했습니다. 다시 시도해 주세요.";
  if (tc.name === "fly_to_place") return `${tc.args.place}(으)로 이동했습니다.`;
  if (tc.name === "fly_to") return "해당 좌표로 이동했습니다.";
  if (tc.name === "select_satellite") {
    const st = useStore.getState();
    const s = st.sats.find((x) => x.noradId === st.selectedNorad);
    return `${s?.name ?? tc.args.query} 추적을 시작합니다.`;
  }
  if (tc.name === "filter_fires") {
    const f = useStore.getState().fires;
    if (f.status === "error") return "산불 데이터를 가져오지 못했습니다.";
    const where = tc.args.region ? `${tc.args.region} 지역에서 ` : "";
    const cond = tc.args.min_frp ? `FRP ${tc.args.min_frp}MW 이상 ` : "";
    const more = f.sampled ? ` (전체 ${f.total.toLocaleString()}건 중 ${f.points.length}건 표시)` : "";
    return `${where}${cond}활성 화재 ${f.total.toLocaleString()}건을 지도에 표시했습니다${more}. 최대 FRP ${f.maxFrp}MW.`;
  }
  if (tc.name === "add_layer") {
    const g = useStore.getState().gibs;
    if (!g) return "위성영상 오버레이를 껐습니다.";
    const def = findGibsLayer(g.layerId);
    return `${def?.label ?? g.layerId} 영상을 ${g.date} 기준으로 깔았습니다. ${def?.hint ?? ""}`.trim();
  }
  if (tc.name === "analyze_image") {
    return lastVlmAnswer ? `[영상 해석] ${lastVlmAnswer}` : "영상을 해석하지 못했습니다.";
  }
  if (tc.name === "search_scenes") {
    if (!lastStac || lastStac.count === 0) return "해당 조건의 장면을 찾지 못했습니다. 기간을 늘리거나 구름 조건을 완화해 보세요.";
    const kind = lastStac.collection.includes("sentinel-1")
      ? "Sentinel-1(SAR)"
      : lastStac.collection.includes("landsat")
        ? "Landsat"
        : "Sentinel-2";
    const top = lastStac.scenes
      .slice(0, 5)
      .map((s) => `${s.date}${s.cloud != null ? ` (구름 ${s.cloud}%)` : ""}`)
      .join(", ");
    return `${kind} 장면 ${lastStac.count}건을 찾았습니다. 최적 순: ${top}.`;
  }
  if (tc.name === "change_detection") {
    const c = lastChange;
    if (!c) return "변화 탐지에 실패했습니다. 두 시점 모두 구름 적은 장면이 있어야 합니다.";
    const head = `[${c.place}] 변화 탐지 — ${c.from.date} → ${c.to.date} · 분석 ${c.area_km2.toFixed(1)} km²`;
    const comp = `합성 변화 평균 ${c.composite.mean.toFixed(3)} · 변화면적 ${(c.composite.changed_area_m2 / 1e6).toFixed(1)} km²`;
    const lines = [head, comp];
    if (c.dnbr) {
      lines.push(`dNBR(연소) 평균 ${c.dnbr.mean.toFixed(3)} · 연소면적 ${(c.dnbr.burned_area_m2 / 1e6).toFixed(1)} km²`);
      for (const x of c.dnbr.classes.filter((x) => x.percentage > 0).slice(0, 4)) {
        lines.push(`· ${x.label} ${x.percentage.toFixed(1)}%`);
      }
    }
    // ⚠️ 저품질을 숨기지 않는다 — 유효 픽셀이 적으면 수치가 편향됐을 수 있음을 그대로 전달.
    if (c.warning) lines.push(`⚠️ ${c.warning}`);
    return lines.join("\n");
  }
  if (tc.name === "scan_region_change") {
    const c = lastRegionScan;
    if (!c) return "광역 변화 스캔에 실패했습니다. 해당 지역·연도의 Clay 임베딩(2017~2026 월단위)이 있어야 합니다.";
    const lines = [
      `[${c.place}] 광역 토지변화 스캔 — ${c.from} → ${c.to} · ${c.cell_km}km 셀 ${c.joined_cells}개`,
      `변화 셀 ${c.changed_cells}개 · 변화면적 약 ${c.changed_area_km2} km² (코사인 중앙값 ${c.cosine_median})`,
    ];
    // 변화 핫스팟 좌표 상위 몇 개(지도에서 어디를 볼지).
    for (const t of c.top.slice(0, 4)) lines.push(`· 핫스팟 @ ${t.cy.toFixed(3)}, ${t.cx.toFixed(3)} (변화점수 ${t.score.toFixed(2)})`);
    lines.push("⚠️ Clay 임베딩 상대 변화(적응형 임계값). 절대 면적이 아니라 '이 지역 내 상대적으로 많이 변한 곳'입니다.");
    return lines.join("\n");
  }
  if (tc.name === "compare_index") {
    const c = lastCompare;
    if (!c) return "두 시점 비교에 실패했습니다. 두 날짜 모두 구름 적은 장면이 있어야 합니다.";
    const KO: Record<string, string> = { ndvi: "NDVI 식생", ndwi: "NDWI 수분", nbr: "NBR 연소" };
    const lines = [`[${c.place}] ${KO[c.index] ?? c.index} 2시점 비교 — ${c.from.scene.date} → ${c.to.scene.date}`];
    // 유의미한 클래스만(면적 증감 0.01km² 이상). 수체(SCL) 등 권장 지표가 앞에 온다.
    for (const x of c.delta.filter((d) => Math.abs(d.diff_m2) >= 1e4)) {
      const dir = x.diff_m2 >= 0 ? "▲" : "▼";
      const pct = x.diff_pct == null ? "" : ` (${dir}${Math.abs(x.diff_pct).toFixed(1)}%)`;
      lines.push(`· ${x.label}: ${(x.from_m2 / 1e6).toFixed(2)} → ${(x.to_m2 / 1e6).toFixed(2)} km² ${dir}${Math.abs(x.diff_m2 / 1e6).toFixed(2)}${pct}`);
    }
    if (c.warning) lines.push(`⚠️ ${c.warning}`);
    return lines.join("\n");
  }
  if (tc.name === "spectral_index") {
    const s = lastSpectral;
    if (!s) return "분광지수를 계산하지 못했습니다. 구름이 적은 기간이 없거나 장면을 찾지 못했을 수 있습니다.";
    const KO: Record<string, string> = { ndvi: "NDVI 식생지수", ndwi: "NDWI 수분지수", nbr: "NBR 연소지수" };
    const cloud = s.scene.cloud != null ? ` · 구름 ${s.scene.cloud.toFixed(1)}%` : "";
    const head = `[${s.place}] ${KO[s.index] ?? s.index} — Sentinel-2 ${s.scene.date}${cloud}`;
    const body = `분석 ${s.area_km2.toFixed(2)} km² (${s.grid.pixel_m}m 격자) · 평균 ${s.mean.toFixed(3)} · 중앙값 ${s.median.toFixed(3)}`;
    // 비율 큰 순으로 정렬해 핵심부터 읽히게.
    const lines = [...s.classes]
      .sort((a, b) => b.percentage - a.percentage)
      .filter((c) => c.percentage > 0)
      .map((c) => `· ${c.label} ${c.percentage.toFixed(1)}% (${(c.area_m2 / 1e6).toFixed(2)} km²)`);
    return [head, body, ...lines].join("\n");
  }
  if (tc.name === "describe_region") {
    return lastRegion?.answer || "지역 관측 브리핑을 생성하지 못했습니다.";
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
      // 도구 연쇄 — FIRMS 포인트 위에 GIBS 맥락영상을 얹는 식(제안서 §4.7)
      const tools: string[] = [];
      const replies: string[] = [];
      for (const tc of forced) {
        const done = await execTool(tc);
        if (done) tools.push(done);
        replies.push(replyFor(tc, done));
      }
      let content = replies.join(" ");
      // 수치가 많은 도구는 Qwen이 **서술만** 덧붙인다(계산 금지).
      //   실측: temp 0.1 + num_ctx 고정 + "수치 변경 금지" 프롬프트로 5회 반복에서 지어낸 수치 0건.
      //   그래도 라벨-수치 짝을 틀릴 여지는 있으므로 **원본 수치 블록을 아래에 그대로 남긴다**
      //   → 서술이 어긋나도 사용자가 원본으로 검증 가능(설계원칙: 결정론 수치가 진실).
      //   ⚠️ 품질 경고(유효 픽셀 부족 등)가 붙은 결과는 **서술하지 않는다** — 신뢰할 수 없는 수치를
      //      매끄러운 문장으로 감싸면 경고를 읽지 않은 사용자가 사실로 받아들인다(실측에서 확인).
      if (forced.some((t) => NARRATE_TOOLS.has(t.name)) && content.trim() && !content.includes("⚠️")) {
        const narration = await narrate(content);
        if (narration) content = `${narration}\n\n${content}`;
      }
      useStore.getState().pushChat({
        role: "assistant",
        content,
        tools: tools.length ? tools : undefined,
      });
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

