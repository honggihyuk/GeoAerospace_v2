import { NextResponse } from "next/server";
import { fetchIncidentsIts } from "@/lib/server/fetchIncidentIts";

export const dynamic = "force-dynamic";

// GET /api/incident?bbox=w,s,e,n → 전국 실시간 돌발(사고·공사·통제) 포인트.
// 소스: ITS 국가교통정보센터 eventInfo — 기존 ITS_API_KEY(없으면 데모키 "test")로 서버 IP 등록 불필요.
//   (경찰청 UTIC imsOpenData는 key+서버IP 인증이라 배포가 까다로워 ITS로 실동작 — lib/server/fetchIncidentUtic.ts 참고)
export async function GET(req: Request) {
  const u = new URL(req.url);
  const raw = u.searchParams.get("bbox");
  let bbox: [number, number, number, number] | undefined;
  if (raw) {
    const p = raw.split(",").map(Number);
    if (p.length === 4 && p.every((n) => !Number.isNaN(n))) bbox = p as [number, number, number, number];
  }

  try {
    const { items, source, configured, sample } = await fetchIncidentsIts(bbox);
    return NextResponse.json({ ok: true, configured, sample, source, count: items.length, incidents: items });
  } catch (e) {
    return NextResponse.json({ ok: false, configured: true, reason: String(e), incidents: [] }, { status: 200 });
  }
}
