import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Sentinel-1 SAR 프록시 (Copernicus Data Space Ecosystem / Sentinel Hub Process API).
// 한반도 bbox 의 C-band VV 후방산란을 8-bit PNG 로 반환 → 클라가 큐브 색으로 샘플.
// 자격증명은 서버 env 에만 둔다(클라 노출 금지). 미설정 시 501 → 클라는 고도 램프로 폴백.
//
// 키 발급(무료): dataspace.copernicus.eu 가입 → Dashboard > User Settings > OAuth clients
//   → client_id / client_secret 를 .env.local 에 SENTINEL_HUB_CLIENT_ID / _SECRET 로.

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

// Sentinel-1 GRD VV(선형) → dB → 0..255. 도시·구조물은 밝게, 잔잔한 수면은 어둡게.
const EVALSCRIPT = `//VERSION=3
function setup(){ return { input:["VV"], output:{ bands:1, sampleType:"UINT8" } }; }
function evaluatePixel(s){
  var db = 10.0*Math.log(Math.max(s.VV,1e-6))/Math.LN10;
  var v = Math.max(0.0, Math.min(1.0, (db + 22.0)/22.0));
  return [ Math.round(v*255) ];
}`;

export async function GET(req: Request) {
  const id = process.env.SENTINEL_HUB_CLIENT_ID;
  const secret = process.env.SENTINEL_HUB_CLIENT_SECRET;
  if (!id || !secret) {
    return NextResponse.json(
      { error: "SAR 미설정", need: ["SENTINEL_HUB_CLIENT_ID", "SENTINEL_HUB_CLIENT_SECRET"] },
      { status: 501 }
    );
  }

  const u = new URL(req.url);
  const bbox = (u.searchParams.get("bbox") ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((n) => Number.isNaN(n))) return NextResponse.json({ error: "bad bbox" }, { status: 400 });
  const w = Math.min(1024, Math.max(64, Number(u.searchParams.get("w") ?? 512)));
  const h = Math.max(64, Math.round((w * (bbox[3] - bbox[1])) / (bbox[2] - bbox[0])));

  try {
    const token = await getToken(id, secret);
    const to = new Date();
    const from = new Date(to.getTime() - 45 * 86_400_000); // 최근 45일 모자이크
    const payload = {
      input: {
        bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
        data: [
          {
            type: "sentinel-1-grd",
            dataFilter: { timeRange: { from: from.toISOString(), to: to.toISOString() }, acquisitionMode: "IW" },
            // 지형보정(orthorectify+GAMMA0_TERRAIN)은 느려 타임아웃 유발 → 색 시각화엔 불필요.
            // 타원체 기준 SIGMA0(정사보정 없음)로 빠르고 안정적으로.
            processing: { backCoeff: "SIGMA0_ELLIPSOID" },
          },
        ],
      },
      output: { width: w, height: h, responses: [{ identifier: "default", format: { type: "image/png" } }] },
      evalscript: EVALSCRIPT,
    };
    const r = await fetch(PROCESS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "image/png" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ error: `process ${r.status}`, detail: t.slice(0, 400) }, { status: 502 });
    }
    // ReadableStream 패스스루는 Next dev 에서 불안정 → 버퍼로 반환.
    const buf = await r.arrayBuffer();
    return new NextResponse(buf, {
      headers: { "content-type": "image/png", "content-length": String(buf.byteLength), "cache-control": "public, max-age=3600" },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
