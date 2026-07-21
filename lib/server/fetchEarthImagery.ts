// 포토리얼 지구 텍스처 (고도화 구상 §B1) — NASA GIBS WMS 전지구 등장방형(equirectangular) 영상.
//
// 왜 WMTS 타일이 아니라 WMS인가: 3D 구(sphere)에는 타일 모자이크가 아니라 경위도 그대로인
// 단일 등장방형 텍스처가 필요하다. GIBS WMS GetMap은 BBOX=-180,-90,180,90 한 번으로 그것을 준다.
//
// 날짜 해석이 핵심: VIIRS 트루컬러는 궤도 스와스가 하루에 걸쳐 채워지므로 "UTC 오늘"을 그대로
// 요청하면 대부분 비어 있는 영상이 HTTP 200으로 온다(실측: 오늘 8KB vs 어제 134KB).
// → 저해상도 프로브로 바이트 수를 보고 "충분히 채워진" 최신 날짜를 고른 뒤 고해상도를 1회만 받는다.
import { safeFetch } from "./safeFetch";

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";

export type ImageryLayer = "day" | "dayprev" | "night" | "base";

export const GIBS_LAYER: Record<ImageryLayer, string> = {
  day: "VIIRS_SNPP_CorrectedReflectance_TrueColor", // 당일 트루컬러 (매일 갱신)
  // 결손 경도대를 메우는 1차 소스 = 하루 전 트루컬러.
  // 정적 베이스로 메우면 구름 유무 차이로 이음매가 그대로 드러나므로,
  // 같은 종류의 영상으로 메워야 연속적으로 보인다.
  dayprev: "VIIRS_SNPP_CorrectedReflectance_TrueColor",
  night: "VIIRS_Black_Marble", // 야간 도시광 (정적 합성 — TIME 생략 시 GIBS 기본값)
  // 갭 없는 정적 베이스. 당일 트루컬러는 궤도 스와스가 빠진 경도대가 생기므로
  // (실측 2026-07-19: -180°~-133.8°, 46°폭 결손) 이 베이스로 구멍을 메운다.
  // BlueMarble_NextGeneration은 결손 28%라 부적합 — ShadedRelief_Bathymetry 사용.
  base: "BlueMarble_ShadedRelief_Bathymetry",
};

/** 구 텍스처로 쓸 수 있는 폭 (높이 = 폭/2). 임의 값 허용 시 외부로 증폭되는 요청이 되므로 고정. */
export const ALLOWED_WIDTHS = [1024, 2048, 4096] as const;

const PROBE_W = 512;
const PROBE_MIN_BYTES = 12_000; // 이 미만 = 스와스 미수집(거의 빈 영상). 512×256 실측: 완전 ~37KB, 빈 영상 ~1KB
const MAX_LOOKBACK_DAYS = 4;

const DATE_TTL_MS = 30 * 60_000; // 날짜 재해석 주기
const IMG_TTL_MS = 6 * 60 * 60_000; // 영상 바이트 캐시

type Cached<T> = { v: T; ts: number };

let dayDate: Cached<string> | null = null;
const imgCache = new Map<string, Cached<{ body: ArrayBuffer; type: string; date: string }>>();

function wmsUrl(layer: string, width: number, time?: string): string {
  const p = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.1.1", // 1.1.1 = SRS + BBOX(lon,lat) — 1.3.0의 축순서 함정 회피
    REQUEST: "GetMap",
    SRS: "EPSG:4326",
    BBOX: "-180,-90,180,90",
    WIDTH: String(width),
    HEIGHT: String(Math.round(width / 2)),
    FORMAT: "image/jpeg",
    LAYERS: layer,
  });
  if (time) p.set("TIME", time);
  return `${WMS}?${p.toString()}`;
}

function utcDay(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `today - startBack` 이하에서 트루컬러가 (거의) 채워진 첫 UTC 날짜.
 * 바이트 수는 "완전히 빔"만 걸러내는 거친 지표라 결손 경도대는 통과한다.
 * 결손 자체는 클라 셰이더가 dayprev/base로 합성해 메운다.
 */
async function firstFilledDate(startBack: number): Promise<string | null> {
  for (let back = startBack; back <= startBack + MAX_LOOKBACK_DAYS; back++) {
    const date = utcDay(back);
    try {
      const r = await safeFetch(wmsUrl(GIBS_LAYER.day, PROBE_W, date), { timeoutMs: 15_000, accept: "image/jpeg" });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength >= PROBE_MIN_BYTES) return date;
    } catch {
      // 이 날짜는 건너뛰고 계속 소급
    }
  }
  return null;
}

/** 트루컬러가 실제로 채워진 가장 최신 UTC 날짜. 프로브 결과는 캐시한다. */
export async function resolveDayDate(): Promise<string> {
  if (dayDate && Date.now() - dayDate.ts < DATE_TTL_MS) return dayDate.v;
  const found = await firstFilledDate(0);
  if (found) {
    dayDate = { v: found, ts: Date.now() };
    return found;
  }
  // 전 프로브 실패 → 통상 완전한 어제로 낙관 진행 (캐시는 짧게 두어 곧 재시도)
  const fallback = utcDay(1);
  dayDate = { v: fallback, ts: Date.now() - DATE_TTL_MS + 60_000 };
  return fallback;
}

/** 결손 메움용 — 주 날짜보다 엄격히 이전인, 채워진 첫 날짜. */
async function resolvePrevDate(): Promise<string> {
  const primary = await resolveDayDate();
  const backOfPrimary = Math.round((Date.now() - Date.parse(`${primary}T00:00:00Z`)) / 86_400_000);
  return (await firstFilledDate(backOfPrimary + 1)) ?? utcDay(backOfPrimary + 1);
}

export async function fetchEarthImagery(
  layer: ImageryLayer,
  width: number
): Promise<{ body: ArrayBuffer; type: string; date: string }> {
  // 야간 도시광·베이스는 정적 → 날짜 해석 불필요
  const dated = layer === "day" || layer === "dayprev";
  const date = layer === "day" ? await resolveDayDate() : layer === "dayprev" ? await resolvePrevDate() : "static";
  const key = `${layer}:${width}:${date}`;

  const hit = imgCache.get(key);
  if (hit && Date.now() - hit.ts < IMG_TTL_MS) return hit.v;

  const r = await safeFetch(wmsUrl(GIBS_LAYER[layer], width, dated ? date : undefined), {
    timeoutMs: 60_000, // 4096×2048는 실측 ~6s
    accept: "image/jpeg",
  });
  if (!r.ok) throw new Error(`gibs ${r.status}`);

  const body = await r.arrayBuffer();
  if (body.byteLength < 1024) throw new Error("gibs: empty imagery");

  const v = { body, type: r.headers.get("content-type") ?? "image/jpeg", date };
  imgCache.set(key, { v, ts: Date.now() });
  return v;
}
