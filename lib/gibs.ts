// NASA GIBS 맥락영상 카탈로그 (개발제안서 §4.7 / P5.5).
//
// 역할 분리 원칙(§4.3): GIBS=시각화(래스터 타일), FIRMS=분석/필터(벡터 포인트).
// 산불 질의에서 FIRMS 포인트가 "어디서 얼마나 강하게"를 답하면,
// GIBS 래스터가 그 아래 깔려 "무슨 일이 벌어지는지"(연기 플룸·연소흔)를 보여준다.
//
// WMTS RESTful 형식 (제안서 §4.7 명시):
//   …/wmts/epsg3857/best/{Layer}/default/{Time}/{TileMatrixSet}/{z}/{y}/{x}.{fmt}

export const GIBS_WMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

export type GibsLayer = {
  id: string;
  label: string;
  /** GIBS 레이어 식별자 */
  layer: string;
  tileMatrixSet: string;
  format: "jpg" | "png";
  /**
   * 이 TileMatrixSet의 최대 줌. 실측: Level9는 z10에서 HTTP 400을 낸다.
   * MapLibre 소스에 maxzoom을 주지 않으면 확대 시 400이 쏟아지므로 반드시 지정한다.
   */
  maxZoom: number;
  /** 날짜별 영상인지 (정적 레이어는 false) */
  temporal: boolean;
  hint: string;
};

export const GIBS_LAYERS: GibsLayer[] = [
  {
    id: "truecolor",
    label: "트루컬러 (VIIRS)",
    layer: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxZoom: 9,
    temporal: true,
    hint: "육안에 가까운 자연색. 연기 플룸 확인용",
  },
  {
    id: "truecolor-modis",
    label: "트루컬러 (MODIS Terra)",
    layer: "MODIS_Terra_CorrectedReflectance_TrueColor",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxZoom: 9,
    temporal: true,
    hint: "VIIRS와 다른 통과 시각 — 결손 보완용",
  },
  {
    id: "bands721",
    label: "화재/연소흔 (Bands 7-2-1)",
    layer: "MODIS_Terra_CorrectedReflectance_Bands721",
    tileMatrixSet: "GoogleMapsCompatible_Level9",
    format: "jpg",
    maxZoom: 9,
    temporal: true,
    hint: "단파적외 위색합성 — 활성 화재는 붉게, 연소흔은 적갈색. 연기를 투과",
  },
];

export function findGibsLayer(idOrName: string): GibsLayer | undefined {
  const q = idOrName.trim().toLowerCase();
  return (
    GIBS_LAYERS.find((l) => l.id === q) ??
    GIBS_LAYERS.find((l) => l.layer.toLowerCase() === q) ??
    GIBS_LAYERS.find((l) => l.label.toLowerCase().includes(q) || l.layer.toLowerCase().includes(q))
  );
}

/** MapLibre raster 소스용 타일 URL 템플릿. */
export function gibsTileUrl(l: GibsLayer, date: string): string {
  const time = l.temporal ? date : "default";
  return `${GIBS_WMTS}/${l.layer}/default/${time}/${l.tileMatrixSet}/{z}/{y}/{x}.${l.format}`;
}
