import { NextResponse } from "next/server";
import { detectManeuvers } from "@/lib/maneuvers";
import { fetchElsetHistory } from "@/lib/server/fetchHistory";
import { isConfigured } from "@/lib/server/spacetrack";

export const dynamic = "force-dynamic";

// GET /api/maneuvers?norad=25544 — TLE 이력에서 기동 감지 (고도화 A3).
export async function GET(req: Request) {
  const norad = Number(new URL(req.url).searchParams.get("norad") ?? 25544);
  if (!Number.isInteger(norad) || norad <= 0) {
    return NextResponse.json({ available: false, reason: "잘못된 NORAD" }, { status: 200 });
  }
  if (!isConfigured()) {
    // 이력은 Space-Track에만 있다. 자격증명이 없으면 이 기능은 비활성.
    return NextResponse.json({ available: false, reason: "Space-Track 자격증명 미설정" }, { status: 200 });
  }

  try {
    const elsets = await fetchElsetHistory(norad);
    if (elsets.length < 3) {
      return NextResponse.json({ available: false, reason: "이력 표본 부족", norad }, { status: 200 });
    }
    const a = detectManeuvers(elsets);
    const last = a.maneuvers.at(-1) ?? null;
    return NextResponse.json({
      available: true,
      norad,
      ...a,
      last,
      /** 마지막 기동 이후 경과일 — 예측 신뢰도 판단용 */
      daysSinceLast: last ? (Date.now() - Date.parse(last.toEpoch)) / 86_400_000 : null,
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e), norad }, { status: 200 });
  }
}
