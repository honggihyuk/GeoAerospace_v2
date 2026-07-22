import { NextResponse } from "next/server";
import sharp from "sharp";

export const dynamic = "force-dynamic";

// VWorld 정사영상(Satellite) 프록시 — WMTS 타일을 bbox 로 스티치해 단일 PNG 반환.
// 클라가 큐브 상면 색으로 샘플. 키는 서버 env 에만.
//
// VWorld 키는 도메인 제한(Referer 검사)이라 서버 fetch 에 Referer 를 등록 도메인으로 실어야 통과한다.
// 키 발급(무료): vworld.kr 가입 → 인증키 발급(활용 도메인에 localhost 등록) →
//   .env.local 에 VWORLD_KEY=..., (필요 시) VWORLD_DOMAIN=http://localhost:3000

const Z = 8; // 줌: 한반도 ~20 타일, 610 m/px (8 km 셀에 충분)
const wmtsUrl = (key: string, y: number, x: number) => `https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/${Z}/${y}/${x}.jpeg`;

const lngToPx = (lng: number) => ((lng + 180) / 360) * Math.pow(2, Z) * 256;
const latToPx = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, Z) * 256;
};

export async function GET(req: Request) {
  const key = process.env.VWORLD_KEY;
  if (!key) return NextResponse.json({ error: "VWorld 미설정", need: ["VWORLD_KEY"] }, { status: 501 });
  const domain = process.env.VWORLD_DOMAIN ?? "http://localhost:3000";

  const u = new URL(req.url);
  const bbox = (u.searchParams.get("bbox") ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((n) => Number.isNaN(n))) return NextResponse.json({ error: "bad bbox" }, { status: 400 });
  const [west, south, east, north] = bbox;
  const outW = Math.min(1024, Math.max(64, Number(u.searchParams.get("w") ?? 512)));

  const pxW = lngToPx(west);
  const pxE = lngToPx(east);
  const pxN = latToPx(north);
  const pxS = latToPx(south);
  const x0 = Math.floor(pxW / 256);
  const x1 = Math.floor(pxE / 256);
  const y0 = Math.floor(pxN / 256);
  const y1 = Math.floor(pxS / 256);
  const numX = x1 - x0 + 1;
  const numY = y1 - y0 + 1;
  if (numX < 1 || numY < 1 || numX * numY > 80) return NextResponse.json({ error: "bbox range invalid" }, { status: 400 });

  try {
    const composites: { input: Buffer; left: number; top: number }[] = [];
    let firstErr: unknown = null;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const r = await fetch(wmtsUrl(key, ty, tx), { headers: { Referer: domain } });
        const buf = Buffer.from(await r.arrayBuffer());
        const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        if (!r.ok || (!isJpeg && !isPng)) {
          // 실제 매직바이트로 판별 — VWorld 오류(키/도메인/URL)면 응답 내용을 진단용으로 노출
          if (!firstErr)
            firstErr = {
              tileStatus: r.status,
              contentType: r.headers.get("content-type") ?? "",
              bytes: buf.length,
              head: buf.subarray(0, 16).toString("hex"),
              sample: buf.subarray(0, 220).toString("utf8"),
              triedUrl: wmtsUrl("KEY", ty, tx),
              referer: domain,
            };
          continue;
        }
        composites.push({ input: buf, left: (tx - x0) * 256, top: (ty - y0) * 256 });
      }
    if (composites.length === 0) return NextResponse.json({ error: "vworld 타일 없음", diag: firstErr }, { status: 502 });

    // .png() 필수 — 없으면 raw 픽셀이 나와 다음 sharp() 가 "unsupported image format" 으로 실패.
    const stitched = await sharp({ create: { width: numX * 256, height: numY * 256, channels: 3, background: { r: 8, g: 12, b: 20 } } })
      .composite(composites)
      .png()
      .toBuffer();

    const left = Math.max(0, Math.round(pxW - x0 * 256));
    const top = Math.max(0, Math.round(pxN - y0 * 256));
    const wReg = Math.max(1, Math.min(numX * 256 - left, Math.round(pxE - pxW)));
    const hReg = Math.max(1, Math.min(numY * 256 - top, Math.round(pxS - pxN)));
    const outH = Math.max(64, Math.round((outW * (north - south)) / (east - west)));
    const out = await sharp(stitched).extract({ left, top, width: wReg, height: hReg }).resize(outW, outH, { fit: "fill" }).png().toBuffer();
    return new NextResponse(new Uint8Array(out), { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
