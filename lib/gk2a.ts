// 천리안위성 2A호(GK2A) 채널 카탈로그 + Count↔물리량 변환 (제안서_GK2A §K1).
//
// API는 값을 Count(DN)로 줄 수 있고, 그대로 쓰면 물리적으로 무의미하다.
// 변환표(20190415_GK-2A_AMI_Conversion_Table_v3.0.zip, 3.7 MB)를 뜯어보니
// 16,384행 룩업테이블이 아니라 **선형 계수**로 완전히 재현된다:
//     Radiance = DN2Rad_Gain × Count + DN2Rad_Offset
// Count 0·1을 표와 대조해 일치를 확인했으므로, 3.7 MB 자산을 들이지 않고
// 계수만 내장한다. (원본: 국가기상위성센터 NMSC 배포)
//
// 채널·격자간격 출처: 활용가이드 p35~36 waveType 표.
import { gk2aParams, lonLatToGrid } from "./lcc";

/** 유닛 코드 — API `unitType` 파라미터와 동일. */
export type UnitType = "R" | "A" | "EBT" | "BT";

export type ChannelKind = "가시" | "근적외" | "단파적외" | "적외" | "수증기";

export type Gk2aChannel = {
  /** API waveType 코드 */
  waveType: string;
  /** 변환표상의 채널명 */
  name: string;
  kind: ChannelKind;
  /** 중심 파장 (μm) */
  wavelengthUm: number;
  /** 격자간격 (km) — 채널마다 다르다 */
  gridKm: number;
  /** Radiance = gain × Count + offset */
  gain: number;
  offset: number;
  /** VNIR 전용: Albedo = Radiance × albedoCoeff */
  albedoCoeff?: number;
  /** IR 전용: 중심 파수 (cm⁻¹) */
  wavenumber?: number;
  /** IR 전용: Tb = c0 + c1·Te + c2·Te² */
  c0?: number;
  c1?: number;
  c2?: number;
};

// 가이드 p35~36의 waveType 표 × 변환표 계수 시트를 결합.
export const GK2A_CHANNELS: Gk2aChannel[] = [
  // 가시 (VNIR)
  { waveType: "004", name: "VIS0.4", kind: "가시", wavelengthUm: 0.4702, gridKm: 1.0, gain: 0.363545805215835, offset: -7.27090454101562, albedoCoeff: 0.001558245 },
  { waveType: "005", name: "VIS0.5", kind: "가시", wavelengthUm: 0.5086, gridKm: 1.0, gain: 0.343625485897064, offset: -6.87249755859375, albedoCoeff: 0.0016595767 },
  { waveType: "006", name: "VIS0.6", kind: "가시", wavelengthUm: 0.6394, gridKm: 0.5, gain: 0.154856294393539, offset: -6.19424438476562, albedoCoeff: 0.001924484 },
  { waveType: "008", name: "VIS0.8", kind: "가시", wavelengthUm: 0.863, gridKm: 1.0, gain: 0.0457241721451282, offset: -3.65792846679687, albedoCoeff: 0.0032723873 },
  // 근적외
  { waveType: "013", name: "NIR1.3", kind: "근적외", wavelengthUm: 1.374, gridKm: 2.0, gain: 0.0346878096461296, offset: -1.38751220703125, albedoCoeff: 0.0087081313 },
  { waveType: "016", name: "NIR1.6", kind: "근적외", wavelengthUm: 1.6092, gridKm: 2.0, gain: 0.0498007982969284, offset: -0.996017456054687, albedoCoeff: 0.0129512876 },
  // 단파적외 — 화재 탐지 핵심 채널
  { waveType: "038", name: "IR3.8", kind: "단파적외", wavelengthUm: 3.8, gridKm: 2.0, gain: -0.00108296517282724, offset: 17.699987411499, wavenumber: 2612.67737352111, c0: -0.447843939824124, c1: 1.00065568090389, c2: -6.33824089912448e-8 },
  // 수증기
  { waveType: "063", name: "IR6.3", kind: "수증기", wavelengthUm: 6.3, gridKm: 2.0, gain: -0.0108914673328399, offset: 44.1777038574218, wavenumber: 1617.60924253134, c0: -1.76279494011147, c1: 1.00414910562278, c2: -9.8331091431938e-7 },
  { waveType: "069", name: "IR6.9", kind: "수증기", wavelengthUm: 6.9, gridKm: 2.0, gain: -0.00818779878318309, offset: 66.7480773925781, wavenumber: 1441.57542876017, c0: -0.334311414359106, c1: 1.00097359874468, c2: -4.94603070252304e-7 },
  { waveType: "073", name: "IR7.3", kind: "수증기", wavelengthUm: 7.3, gridKm: 2.0, gain: -0.0096982717514038, offset: 79.0608520507812, wavenumber: 1365.24999202444, c0: -0.0613124859696595, c1: 1.00019008722941, c2: -1.05863656750499e-7 },
  // 적외
  { waveType: "087", name: "IR8.7", kind: "적외", wavelengthUm: 8.7, gridKm: 2.0, gain: -0.0144806550815701, offset: 118.050903320312, wavenumber: 1164.94939285634, c0: -0.141418528203155, c1: 1.00052232906885, c2: -3.6287276076109e-7 },
  { waveType: "096", name: "IR9.6", kind: "적외", wavelengthUm: 9.6, gridKm: 2.0, gain: -0.0178435463458299, offset: 145.464874267578, wavenumber: 1039.96021677611, c0: -0.114017728158198, c1: 1.00047380585402, c2: -3.74931509928403e-7 },
  { waveType: "105", name: "IR10.5", kind: "적외", wavelengthUm: 10.5, gridKm: 2.0, gain: -0.0198196955025196, offset: 161.580139160156, wavenumber: 966.153383926055, c0: -0.142866448475177, c1: 1.00064069572049, c2: -5.50443294960498e-7 },
  { waveType: "112", name: "IR11.2", kind: "적외", wavelengthUm: 11.2, gridKm: 2.0, gain: -0.0216744858771562, offset: 176.713439941406, wavenumber: 891.71305730126, c0: -0.249111718496148, c1: 1.00121166873756, c2: -1.13167964011665e-6 },
  { waveType: "123", name: "IR12.3", kind: "적외", wavelengthUm: 12.3, gridKm: 2.0, gain: -0.023379972204566, offset: 190.649627685546, wavenumber: 810.60900787123, c0: -0.458113885722738, c1: 1.00245520975535, c2: -2.53064314720476e-6 },
  { waveType: "133", name: "IR13.3", kind: "적외", wavelengthUm: 13.3, gridKm: 2.0, gain: -0.0243037566542625, offset: 198.224365234375, wavenumber: 753.590621482278, c0: -0.0938521568527657, c1: 1.00053982112966, c2: -5.94913715312849e-7 },
];

export function findChannel(waveType: string): Gk2aChannel | undefined {
  return GK2A_CHANNELS.find((c) => c.waveType === waveType);
}

/** 이 채널이 VNIR(가시·근적외)인가 — Albedo가 정의되는 채널. */
export function isVnir(c: Gk2aChannel): boolean {
  return c.albedoCoeff !== undefined;
}

// ── 변환 ────────────────────────────────────────────────────────────────────

/** Count(DN) → Radiance. VNIR은 W/m²·sr·μm, IR은 mW/m²/sr/cm⁻¹. */
export function countToRadiance(count: number, c: Gk2aChannel): number {
  return c.gain * count + c.offset;
}

/** Radiance → Albedo(%). VNIR 전용. */
export function radianceToAlbedo(radiance: number, c: Gk2aChannel): number {
  if (c.albedoCoeff === undefined) throw new Error(`${c.name}: Albedo는 가시·근적외 채널에만 정의된다`);
  return radiance * c.albedoCoeff;
}

// 변환표 'coeff.& equation_WN' 시트에 명시된 물리상수
const PLANCK_C1 = 1.1910428681415875e-16; // 2hc²
const PLANCK_C2 = 0.014387769599838155; // hc/k

/**
 * Radiance → 유효휘도온도 Te (K). IR 전용.
 *   Te = (hc/k · ν') / ln( 2hc²·ν'³ / (R·10⁻⁵) + 1 ),  ν' = ν × 100  [m⁻¹]
 * 10⁻⁵는 mW/m²/sr/cm⁻¹ → SI 환산 계수다(가이드 식 그대로).
 */
export function radianceToEbt(radiance: number, c: Gk2aChannel): number {
  if (c.wavenumber === undefined) throw new Error(`${c.name}: 휘도온도는 적외 계열에만 정의된다`);
  if (!(radiance > 0)) return NaN; // 음수/0 복사휘도는 물리적으로 온도로 환산되지 않는다
  const nu = c.wavenumber * 100;
  return (PLANCK_C2 * nu) / Math.log((PLANCK_C1 * nu ** 3) / (radiance * 1e-5) + 1);
}

/** Te → 휘도온도 Tb (K). 채널별 2차 보정. */
export function ebtToBt(te: number, c: Gk2aChannel): number {
  if (c.c0 === undefined || c.c1 === undefined || c.c2 === undefined) {
    throw new Error(`${c.name}: Tb 보정계수가 없다`);
  }
  return c.c0 + c.c1 * te + c.c2 * te * te;
}

/**
 * Count → 요청한 단위. API `unitType`과 1:1 대응.
 *
 * 주의: API가 이미 물리량으로 변환해 줄 수도 있다(응답 예시의 89.756…는 Count로 보기 어렵다).
 * 그 경우 이 함수를 통과시키면 **이중 변환**이 된다 — 호출부가 원시 Count인지 확인해야 한다.
 * `looksLikeCount()`로 1차 판별할 수 있다.
 */
export function convertCount(count: number, c: Gk2aChannel, unit: UnitType): number {
  const r = countToRadiance(count, c);
  if (unit === "R") return r;
  if (unit === "A") return radianceToAlbedo(r, c);
  const te = radianceToEbt(r, c);
  return unit === "EBT" ? te : ebtToBt(te, c);
}

/**
 * 값이 원시 Count처럼 보이는지 거친 판별.
 * Count는 비음수 정수이고 비트수(11~14)에 따라 최대 16383이다.
 * 확정 판별은 불가능하므로(정수 물리량도 있을 수 있다) 경고용으로만 쓴다.
 */
export function looksLikeCount(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 16383;
}

/**
 * 이 지점이 GK2A 관측 격자 안인가.
 * **위성서비스는 남한만 제공한다**(가이드 p39) — 북한·국외 질의는 빈 값을 0으로
 * 채우지 말고 "미제공"으로 답해야 한다.
 */
export function isInsideGrid(
  lon: number,
  lat: number,
  meta: { gridKm: number; xdim: number; ydim: number; x0: number; y0: number }
): boolean {
  const p = gk2aParams(meta);
  const { nx, ny } = lonLatToGrid(lon, lat, p);
  return nx >= 1 && ny >= 1 && nx <= meta.xdim && ny <= meta.ydim;
}
