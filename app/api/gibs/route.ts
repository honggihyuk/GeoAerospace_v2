import { NextResponse } from "next/server";
import { GIBS_LAYERS } from "@/lib/gibs";
import { resolveDayDate } from "@/lib/server/fetchEarthImagery";

export const dynamic = "force-dynamic";

// GET /api/gibs — 사용 가능한 맥락영상 레이어 + 실제로 채워진 최신 날짜 (제안서 §4.7).
//
// 날짜를 서버가 정하는 이유: "UTC 오늘"을 그대로 요청하면 궤도 스와스가 아직 안 채워져
// 대부분 빈 영상이 온다(B1에서 실측). 저해상도 프로브로 채워진 날짜를 골라 알려준다.
// 타일 자체는 클라가 GIBS CDN에서 직접 받는다 — 서버를 경유하면 CDN 캐시를 버리게 된다.
export async function GET() {
  try {
    const date = await resolveDayDate();
    return NextResponse.json(
      { date, layers: GIBS_LAYERS },
      { headers: { "cache-control": "public, max-age=1800" } }
    );
  } catch (e) {
    // 날짜 해석에 실패해도 어제로 진행할 수 있게 한다 (보통 완전하다)
    const fallback = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    return NextResponse.json({ date: fallback, layers: GIBS_LAYERS, degraded: String(e) });
  }
}
