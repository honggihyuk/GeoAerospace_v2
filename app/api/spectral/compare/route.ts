import { NextResponse } from "next/server";
import { compareIndex, type IndexName } from "@/lib/server/spectralIndex";
import { resolveAoi } from "@/lib/server/aoi";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// GET /api/spectral/compare?index=ndwi&(place=|bbox=)&from=YYYY-MM-DD&to=YYYY-MM-DD&cloud=
//   같은 AOI를 두 시점으로 비교 — 클래스별 면적 증감(예: 가뭄 전후 수체 면적).
//   변화 탐지(/api/change)가 "무엇이든 바뀐 정도"라면, 이건 "특정 지수가 얼마나 늘고 줄었나"다.
const VALID: IndexName[] = ["ndvi", "ndwi", "nbr"];

export async function GET(req: Request) {
  const u = new URL(req.url);
  const index = (u.searchParams.get("index") ?? "ndwi").toLowerCase() as IndexName;
  if (!VALID.includes(index)) return NextResponse.json({ ok: false, reason: `index는 ${VALID.join("|")}` }, { status: 200 });

  // place를 주면 서버가 지오코딩해 실제 폴리곤으로 클리핑(호수·공원처럼 불규칙 경계에 유용).
  const aoi = await resolveAoi(u.searchParams.get("place"), u.searchParams.get("bbox"), 1.0);
  if ("error" in aoi) return NextResponse.json({ ok: false, reason: aoi.error }, { status: 200 });

  const isDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if (!isDate(from) || !isDate(to)) return NextResponse.json({ ok: false, reason: "from·to는 YYYY-MM-DD 필수" }, { status: 200 });
  if (from! >= to!) return NextResponse.json({ ok: false, reason: "from이 to보다 앞서야 합니다" }, { status: 200 });

  const cloudRaw = Number(u.searchParams.get("cloud"));
  try {
    const res = await compareIndex(index, aoi.bbox, from!, to!, {
      maxCloud: Number.isFinite(cloudRaw) ? cloudRaw : 30,
      polygon: aoi.polygon ?? undefined,
    });
    return NextResponse.json({ ok: true, place: aoi.name, clipped: !!aoi.polygon, ...res });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
