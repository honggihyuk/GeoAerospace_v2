import { NextResponse } from "next/server";
import { fetchIssEphemeris, PRECISE_EPHEMERIS_NORAD } from "@/lib/server/fetchEphemeris";

export const dynamic = "force-dynamic";

// GET /api/ephemeris?norad=25544&hours=8
// 정밀 ephemeris를 클라가 쓸 수 있게 시간 창으로 잘라 보낸다 (고도화 A3).
//
// 왜 전체(15일, 718 KB)를 안 보내는가: 렌더에 필요한 건 현재 전후 몇 시간뿐이다.
// 창을 자르면 수십 KB로 줄어 초기 로딩을 막지 않는다.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const norad = Number(url.searchParams.get("norad") ?? PRECISE_EPHEMERIS_NORAD);
  const hours = Math.min(24, Math.max(1, Number(url.searchParams.get("hours") ?? 8)));

  if (norad !== PRECISE_EPHEMERIS_NORAD) {
    return NextResponse.json({ available: false, norad }, { status: 200 });
  }

  try {
    const e = await fetchIssEphemeris();
    const now = Date.now();
    const from = now - hours * 3600_000;
    const to = now + hours * 3600_000;

    const t: number[] = [];
    const pos: number[][] = [];
    const vel: number[][] = [];
    for (let i = 0; i < e.t.length; i++) {
      if (e.t[i] < from || e.t[i] > to) continue;
      t.push(e.t[i]);
      pos.push(e.pos[i].map((v) => Math.round(v * 1e6) / 1e6));
      vel.push(e.vel[i].map((v) => Math.round(v * 1e9) / 1e9));
    }
    if (t.length < 8) {
      return NextResponse.json({ available: false, reason: "창 안 표본 부족", norad }, { status: 200 });
    }

    return NextResponse.json({
      available: true,
      norad,
      frame: e.meta.refFrame, // EME2000 — 클라에서 TEME로 변환해야 한다
      source: e.meta.source,
      creationDate: e.meta.creationDate,
      t,
      pos,
      vel,
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e), norad }, { status: 200 });
  }
}
