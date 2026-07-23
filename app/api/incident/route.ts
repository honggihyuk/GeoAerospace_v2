import { NextResponse } from "next/server";
import { fetchIncidents } from "@/lib/server/fetchIncidentUtic";

export const dynamic = "force-dynamic";

// GET /api/incident?bbox=w,s,e,n → UTIC 전국 실시간 돌발(사고·공사·통제 등) 포인트.
// UTIC_API_KEY 없거나 서버 IP 미등록이면 configured=false / 인증실패 사유 반환.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const raw = u.searchParams.get("bbox");
  let bbox: [number, number, number, number] | undefined;
  if (raw) {
    const p = raw.split(",").map(Number);
    if (p.length === 4 && p.every((n) => !Number.isNaN(n))) bbox = p as [number, number, number, number];
  }

  try {
    const { items, source, configured } = await fetchIncidents(bbox);
    return NextResponse.json({ ok: true, configured, source, count: items.length, incidents: items });
  } catch (e) {
    return NextResponse.json({ ok: false, configured: true, reason: String(e), incidents: [] }, { status: 200 });
  }
}
