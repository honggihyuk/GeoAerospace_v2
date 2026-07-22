// Terrarium DEM 서버측 샘플러 — 좌표의 지형고도(m)를 조회한다.
// 용도: FIRMS 활성화재의 바다 오탐 제거(해수면 이하면 물로 판정). MapCanvas와 동일한
// AWS Terrarium 오픈 타일을 재사용한다. 타일 PNG를 sharp로 디코딩해 픽셀 고도를 읽는다.
//   Terrarium 인코딩: elevation(m) = (R*256 + G + B/256) - 32768
import sharp from "sharp";
import { safeFetch } from "./safeFetch";

const HOST = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium";
const Z = 9; // ≈305 m/px — 육지/바다 판별에 충분하고 타일 수가 적다
const N = 1 << Z; // 2^Z
const TILE = 256;

// 타일 원시 RGB 캐시 (요청 간 재사용, 프로세스 수명 동안).
const cache = new Map<string, { data: Buffer; w: number; h: number } | null>();

function lonToX(lon: number): number {
  return ((lon + 180) / 360) * N;
}
function latToY(lat: number): number {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N;
}

async function tile(tx: number, ty: number): Promise<{ data: Buffer; w: number; h: number } | null> {
  const key = `${tx}/${ty}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: { data: Buffer; w: number; h: number } | null = null;
  try {
    const r = await safeFetch(`${HOST}/${Z}/${tx}/${ty}.png`, { accept: "image/png", timeoutMs: 15_000 });
    if (r.ok) {
      const buf = Buffer.from(await r.arrayBuffer());
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      out = { data, w: info.width, h: info.height };
    }
  } catch {
    out = null; // 실패는 null → 호출측이 "고도 불명"으로 처리(오탐 필터에서 보존)
  }
  cache.set(key, out);
  return out;
}

/** 여러 좌표의 고도(m)를 조회. 타일을 좌표별로 묶어 한 번씩만 받는다. null=고도 불명. */
export async function sampleElevations(points: { lon: number; lat: number }[]): Promise<(number | null)[]> {
  // 필요한 타일 목록 수집.
  const need = new Map<string, { tx: number; ty: number }>();
  const meta = points.map((p) => {
    const fx = lonToX(p.lon);
    const fy = latToY(p.lat);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    need.set(`${tx}/${ty}`, { tx, ty });
    return { tx, ty, px: Math.min(TILE - 1, Math.floor((fx - tx) * TILE)), py: Math.min(TILE - 1, Math.floor((fy - ty) * TILE)) };
  });

  // 고유 타일을 병렬로 로드.
  const tiles = new Map<string, { data: Buffer; w: number; h: number } | null>();
  await Promise.all([...need.values()].map(async ({ tx, ty }) => tiles.set(`${tx}/${ty}`, await tile(tx, ty))));

  return meta.map((m) => {
    const t = tiles.get(`${m.tx}/${m.ty}`);
    if (!t) return null;
    const ch = 4; // ensureAlpha → RGBA
    const idx = (m.py * t.w + m.px) * ch;
    const R = t.data[idx];
    const G = t.data[idx + 1];
    const B = t.data[idx + 2];
    if (R === undefined || G === undefined || B === undefined) return null;
    return R * 256 + G + B / 256 - 32768;
  });
}
