// Sentinel-1 SAR 후방산란 → 수치 통계(레인 ② 그라운딩). 래스터 픽셀을 LLM에 직접 넣을 수 없으므로
// 서버가 **저후방산란(수면·평활면 추정) 비율**로 환원한다(설계원칙: 계산=결정론 도구, LLM=서술).
//
// 원리: C-band VV 후방산란이 낮으면(어두우면) 잔잔한 수면·평활면일 확률이 높다. dataMask로 무자료(nodata)를
//   구분해 오집계를 막는다. ⚠️ 단일시점 저후방산란은 '수체/평활면 추정'이지 확정 침수가 아니다(라벨 정직).
//   자격증명(SENTINEL_HUB_*) 미설정이면 null → 호출측이 건너뜀.
import sharp from "sharp";

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";

let tokenCache: { token: string; exp: number } | null = null;

async function getToken(id: string, secret: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret });
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`oauth ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

// 밴드2 = [후방산란 0..255, dataMask*255]. dataMask=0(무자료)은 집계 제외해 nodata를 수체로 오판하지 않게.
const EVALSCRIPT = `//VERSION=3
function setup(){ return { input:["VV","dataMask"], output:{ bands:2, sampleType:"UINT8" } }; }
function evaluatePixel(s){
  var db = 10.0*Math.log(Math.max(s.VV,1e-6))/Math.LN10;
  var v = Math.max(0.0, Math.min(1.0, (db + 22.0)/22.0));
  return [ Math.round(v*255), s.dataMask*255 ];
}`;

// value < WATER_THRESH(≈ db < -17.3) → 저후방산란(수면·평활면 추정).
const WATER_THRESH = 55;

export type SarWaterStats = { waterPct: number; meanVal: number; validPct: number };

/** bbox의 Sentinel-1 VV 저후방산란 비율(최근 45일 모자이크). 미설정/실패/무자료면 null. */
export async function fetchSarWaterStats(bbox: [number, number, number, number]): Promise<SarWaterStats | null> {
  const id = process.env.SENTINEL_HUB_CLIENT_ID;
  const secret = process.env.SENTINEL_HUB_CLIENT_SECRET;
  if (!id || !secret) return null;
  const [w, s, e, n] = bbox;
  const width = 256;
  const height = Math.max(64, Math.min(512, Math.round((width * (n - s)) / (e - w))));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const token = await getToken(id, secret);
    const to = new Date();
    const from = new Date(to.getTime() - 45 * 86_400_000);
    const payload = {
      input: {
        bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
        data: [
          {
            type: "sentinel-1-grd",
            dataFilter: { timeRange: { from: from.toISOString(), to: to.toISOString() }, acquisitionMode: "IW" },
            processing: { backCoeff: "SIGMA0_ELLIPSOID" },
          },
        ],
      },
      output: { width, height, responses: [{ identifier: "default", format: { type: "image/png" } }] },
      evalscript: EVALSCRIPT,
    };
    const r = await fetch(PROCESS_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "image/png" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels; // 기대 2(Gray+Mask). 방어적으로 채널 수에 따라 마스크 위치 선택.
    let water = 0;
    let valid = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += ch) {
      const v = data[i];
      const mask = ch === 2 ? data[i + 1] : ch >= 4 ? data[i + 3] : 255;
      if (mask < 128) continue; // 무자료 제외
      valid++;
      sum += v;
      if (v < WATER_THRESH) water++;
    }
    if (!valid) return null;
    return { waterPct: (100 * water) / valid, meanVal: sum / valid, validPct: (100 * valid) / (info.width * info.height) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
