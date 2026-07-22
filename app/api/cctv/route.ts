import { NextResponse } from "next/server";
import { fetchCctv, isCctvConfigured, type CctvItem } from "@/lib/server/fetchCctv";

export const dynamic = "force-dynamic";

// GET /api/cctv?bbox=w,s,e,n → 전국 도로 CCTV 포인트(좌표+스트림).
// ITS_API_KEY 있으면 실데이터, 없으면 좌표 검증용 샘플(실제 CCTV 위치, 스트림 없음).
//
// 샘플 좌표는 실제 ITS CCTV 위치라 지도 정합을 바로 확인할 수 있다.
// (안현분기점은 사용자 스크린샷의 실제 좌표 37.43248,126.80789 그대로.)
const SAMPLE: CctvItem[] = [
  { id: "sample:안현분기점", name: "[제2경인선]안현분기점1 (샘플)", lon: 126.80789, lat: 37.43248, url: null, format: "HLS" },
  { id: "sample:서울요금소", name: "[경부선]서울요금소 (샘플)", lon: 127.0526, lat: 37.2461, url: null, format: "HLS" },
  { id: "sample:신갈JC", name: "[영동선]신갈분기점 (샘플)", lon: 127.1042, lat: 37.2829, url: null, format: "HLS" },
  { id: "sample:회덕JC", name: "[경부선]회덕분기점 (샘플)", lon: 127.4331, lat: 36.4169, url: null, format: "HLS" },
  { id: "sample:동대구", name: "[경부선]동대구 (샘플)", lon: 128.6288, lat: 35.8797, url: null, format: "HLS" },
  { id: "sample:구서IC", name: "[경부선]구서나들목 (샘플)", lon: 129.0925, lat: 35.2562, url: null, format: "HLS" },
  { id: "sample:강릉JC", name: "[영동선]강릉분기점 (샘플)", lon: 128.8601, lat: 37.7215, url: null, format: "HLS" },
  { id: "sample:광주요금소", name: "[호남선]광주요금소 (샘플)", lon: 126.9082, lat: 35.1949, url: null, format: "HLS" },
];

function inBbox(it: CctvItem, b: [number, number, number, number]) {
  return it.lon >= b[0] && it.lon <= b[2] && it.lat >= b[1] && it.lat <= b[3];
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "124.5,33.0,131.0,38.7").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  if (!isCctvConfigured()) {
    // 키 없음 → 좌표 검증용 샘플(bbox 필터). 실데이터는 ITS_API_KEY 필요.
    const items = SAMPLE.filter((it) => inBbox(it, bbox));
    return NextResponse.json({
      ok: true,
      sample: true,
      source: "샘플 좌표 (실데이터는 ITS_API_KEY 필요 · its.go.kr 무료 발급)",
      count: items.length,
      cctvs: items,
    });
  }

  try {
    const { items, source } = await fetchCctv(bbox);
    return NextResponse.json({ ok: true, sample: false, source, count: items.length, cctvs: items });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
