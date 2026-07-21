import { NextResponse } from "next/server";
import * as satellite from "satellite.js";
import { temeToJ2000 } from "@/lib/frames";
import {
  fetchIssEphemeris,
  interpolate,
  PRECISE_EPHEMERIS_NORAD,
  ricDecompose,
} from "@/lib/server/fetchEphemeris";
import { fetchTleByIds } from "@/lib/server/fetchTle";

export const dynamic = "force-dynamic";

// GET /api/precision?norad=25544
// SGP4 예측을 NASA 정밀 ephemeris와 대조해 *실측* 오차를 낸다 (고도화 A2/A4).
// 모델 추정치(나이 × 상수)가 아니라 관측 가능한 실제 차이다.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const norad = Number(url.searchParams.get("norad") ?? PRECISE_EPHEMERIS_NORAD);

  if (norad !== PRECISE_EPHEMERIS_NORAD) {
    return NextResponse.json(
      { available: false, reason: "이 위성에 대한 공개 정밀 ephemeris가 없음", norad },
      { status: 200 }
    );
  }

  try {
    const [eph, tle] = await Promise.all([fetchIssEphemeris(), fetchTleByIds([norad])]);
    const def = tle.sats.find((s) => s.noradId === norad);
    if (!def) throw new Error("TLE 없음");

    const satrec = satellite.twoline2satrec(def.tle1, def.tle2);
    const now = Date.now();

    // 현재 시각 + 앞으로 며칠간의 오차 성장 곡선
    const samples: Array<{ hours: number; total: number; radial: number; alongTrack: number; crossTrack: number }> = [];
    for (const hours of [0, 6, 12, 24, 48, 72, 120, 168]) {
      const when = new Date(now + hours * 3600_000);
      const truth = interpolate(eph, when.getTime());
      if (!truth) continue;
      const pv = satellite.propagate(satrec, when);
      if (!pv?.position || typeof pv.position === "boolean") continue;

      // SGP4는 TEME → 정밀 ephemeris(J2000)와 같은 프레임으로 옮긴다.
      // 이 변환을 빠뜨리면 세차만으로 24~44 km 어긋난다.
      const p = temeToJ2000([pv.position.x, pv.position.y, pv.position.z], when);
      const diff: [number, number, number] = [
        p[0] - truth.pos[0],
        p[1] - truth.pos[1],
        p[2] - truth.pos[2],
      ];
      const ric = ricDecompose(diff, truth.pos, truth.vel);
      samples.push({ hours, ...ric });
    }

    if (samples.length === 0) throw new Error("ephemeris 구간 밖");

    const nowErr = samples[0];
    // 오차 성장률 (선형 회귀, km/일)
    let growthKmPerDay = 0;
    if (samples.length >= 2) {
      const n = samples.length;
      const mx = samples.reduce((a, s) => a + s.hours, 0) / n;
      const my = samples.reduce((a, s) => a + s.total, 0) / n;
      const num = samples.reduce((a, s) => a + (s.hours - mx) * (s.total - my), 0);
      const den = samples.reduce((a, s) => a + (s.hours - mx) ** 2, 0);
      growthKmPerDay = den ? (num / den) * 24 : 0;
    }

    return NextResponse.json({
      available: true,
      norad,
      measuredErrorKm: nowErr.total,
      ric: { radial: nowErr.radial, alongTrack: nowErr.alongTrack, crossTrack: nowErr.crossTrack },
      growthKmPerDay,
      samples,
      reference: {
        source: eph.meta.source,
        object: eph.meta.objectName,
        frame: eph.meta.refFrame,
        creationDate: eph.meta.creationDate,
        coverage: [new Date(eph.t[0]).toISOString(), new Date(eph.t[eph.t.length - 1]).toISOString()],
      },
      tleSource: tle.source,
      fetchedAt: now,
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: String(e), norad }, { status: 200 });
  }
}
