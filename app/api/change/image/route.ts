import sharp from "sharp";
import { computeChangeGrids } from "@/lib/server/changeDetection";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/change/image?bbox=w,s,e,n&from=&to=&layer=composite|dnbr&cloud=
//   변화 결과를 컬러맵 PNG로. 무효 픽셀(구름·그늘)은 투명이라 배경 지도가 비친다.
type Stop = { t: number; rgb: [number, number, number] };

// 합성 변화: 녹(안정) → 황 → 적(변화). AWS의 rdylgn_r 계열.
const RAMP_CHANGE: Stop[] = [
  { t: 0, rgb: [26, 152, 80] },
  { t: 0.3, rgb: [166, 217, 106] },
  { t: 0.5, rgb: [255, 255, 191] },
  { t: 0.7, rgb: [253, 174, 97] },
  { t: 1, rgb: [215, 48, 39] },
];
// dNBR: 청(식생 회복) → 회(무변화) → 황 → 적(고심각도 연소)
const RAMP_DNBR: Stop[] = [
  { t: 0, rgb: [46, 130, 189] },
  { t: 0.25, rgb: [222, 235, 247] },
  { t: 0.45, rgb: [255, 255, 191] },
  { t: 0.7, rgb: [253, 141, 60] },
  { t: 1, rgb: [165, 15, 21] },
];

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

export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  const layer = (u.searchParams.get("layer") ?? "composite").toLowerCase();
  const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n)) || !isDate(from) || !isDate(to)) {
    return new Response("bad request", { status: 400 });
  }
  const bbox = parts as [number, number, number, number];
  if (bbox[2] - bbox[0] > 0.5 || bbox[3] - bbox[1] > 0.5) return new Response("AOI too large (max 0.5deg)", { status: 400 });

  const cloudRaw = Number(u.searchParams.get("cloud"));
  try {
    const { grids, result } = await computeChangeGrids(bbox, from!, to!, {
      maxCloud: Number.isFinite(cloudRaw) ? cloudRaw : 40,
    });
    const vals = layer === "dnbr" ? grids.dnbr : grids.composite;
    // 표시 범위 — 합성은 0~0.5(AWS rescale), dNBR은 -0.5~1.3(USGS 구간을 담게)
    const [lo, hi] = layer === "dnbr" ? [-0.5, 1.3] : [0, 0.5];
    const ramp = layer === "dnbr" ? RAMP_DNBR : RAMP_CHANGE;
    const span = hi - lo;

    const rgba = Buffer.alloc(grids.width * grids.height * 4);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v === null) continue; // 투명
      const [r, g, b] = sample(ramp, (v - lo) / span);
      const o = i * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = 205;
    }
    const png = await sharp(rgba, { raw: { width: grids.width, height: grids.height, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toBuffer();

    return new Response(new Uint8Array(png), {
      headers: {
        "content-type": "image/png",
        "x-from-scene": grids.fromScene,
        "x-to-scene": grids.toScene,
        "x-valid-fraction": String(result.valid_fraction),
        "cache-control": "private, max-age=600",
      },
    });
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
}
