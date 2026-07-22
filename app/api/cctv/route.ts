import { NextResponse } from "next/server";
import { fetchCctv } from "@/lib/server/fetchCctv";

export const dynamic = "force-dynamic";

// GET /api/cctv?bbox=w,s,e,n → 전국 도로 CCTV 포인트(실좌표+HLS 스트림).
// ITS_API_KEY 있으면 전국·bbox 정확, 없으면 데모키 "test"(서울권 20개 고정, 무등록 실데이터).
export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "124.5,33.0,131.0,38.7").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  try {
    const { items, source, demo } = await fetchCctv(bbox);
    // demo(데모키)는 UI에서 "샘플/제한" 표기를 위해 sample 플래그로 넘긴다.
    return NextResponse.json({ ok: true, sample: demo, source, count: items.length, cctvs: items });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
