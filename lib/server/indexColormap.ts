// 분광지수 격자 → 컬러맵 PNG. TiTiler 없이 소형 AOI를 직접 렌더한다.
//   AWS는 TiTiler(Lambda)로 범용 타일링을 하지만(ARCHITECTURE-ko.md §3.5), 우리는 AOI가 작아
//   서버에서 PNG 한 장을 만들어 maplibre image 소스로 올리는 편이 훨씬 단순하다.
//   (docs 미구현의 "COG 오버레이 롤백"은 범용 타일링 문제였고, 소형 AOI 단일 이미지는 해당 없음)
import sharp from "sharp";
import type { IndexName } from "./spectralIndex";

type Stop = { t: number; rgb: [number, number, number] };

/**
 * 지수별 컬러맵(AWS 매핑과 동일 계열).
 *   ndvi → rdylgn  (적=무식생, 녹=고밀도)
 *   ndwi → blues   (연=건조, 청=수체)
 *   nbr  → spectral(적=고심각도 연소, 녹=미연소)
 * t는 정규화 위치 0~1.
 */
const RAMPS: Record<IndexName, Stop[]> = {
  ndvi: [
    { t: 0.0, rgb: [165, 0, 38] },
    { t: 0.25, rgb: [244, 109, 67] },
    { t: 0.5, rgb: [255, 255, 191] },
    { t: 0.75, rgb: [166, 217, 106] },
    { t: 1.0, rgb: [0, 104, 55] },
  ],
  ndwi: [
    { t: 0.0, rgb: [247, 251, 255] },
    { t: 0.5, rgb: [107, 174, 214] },
    { t: 1.0, rgb: [8, 48, 107] },
  ],
  nbr: [
    { t: 0.0, rgb: [158, 1, 66] },
    { t: 0.25, rgb: [244, 109, 67] },
    { t: 0.5, rgb: [255, 255, 191] },
    { t: 0.75, rgb: [102, 194, 165] },
    { t: 1.0, rgb: [50, 136, 189] },
  ],
};

/** 표시 범위 — 지수별로 의미 있는 구간에 색을 몰아준다(전 구간 -1~1은 대비가 죽는다). */
const RANGE: Record<IndexName, [number, number]> = {
  ndvi: [0, 1], // 음수는 물/인공물 — 하한에 붙임
  ndwi: [-1, 1],
  nbr: [-1, 1],
};

function sample(ramp: Stop[], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i].t) {
      const a = ramp[i - 1], b = ramp[i];
      const f = (x - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f),
      ];
    }
  }
  return ramp[ramp.length - 1].rgb;
}

/** 지수 격자 → RGBA PNG. NaN(무효/구름/nodata)은 **투명**으로 남겨 지도 배경이 비친다. */
export async function renderIndexPng(
  index: IndexName,
  values: Float64Array,
  width: number,
  height: number,
  alpha = 200
): Promise<Buffer> {
  const ramp = RAMPS[index];
  const [lo, hi] = RANGE[index];
  const span = hi - lo || 1;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const o = i * 4;
    if (Number.isNaN(v)) continue; // alpha 0 = 투명
    const [r, g, b] = sample(ramp, (v - lo) / span);
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = alpha;
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
