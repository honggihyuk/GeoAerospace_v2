import { NextResponse } from "next/server";
import { resolveStreamUrl } from "@/lib/server/fetchCctvUtic";

export const dynamic = "force-dynamic";

// GET /api/cctv/stream?cctvid=... → UTIC 플레이어(JSP)로 302.
// 목록 응답에 키를 6천 건씩 싣지 않기 위해, 클릭 시점에만 서버가 키를 주입해 리다이렉트한다.
export async function GET(req: Request) {
  const cctvid = new URL(req.url).searchParams.get("cctvid");
  if (!cctvid) return NextResponse.json({ ok: false, reason: "cctvid 필요" }, { status: 400 });

  try {
    const url = await resolveStreamUrl(cctvid);
    if (!url) return NextResponse.json({ ok: false, reason: "알 수 없는 cctvid 또는 UTIC_API_KEY 미설정" }, { status: 404 });
    return NextResponse.redirect(url, 302);
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
