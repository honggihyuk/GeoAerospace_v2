import { NextResponse } from "next/server";
import { ingestClayPartition } from "@/lib/server/ingestClay";
import { geohashesForBbox } from "@/lib/server/regionChange";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 파티션 240MB 다운로드 + 233k행 삽입

// GET /api/ingest/clay?gh=wy&ym=2024-07   또는  ?bbox=w,s,e,n&ym=2024-07 (bbox 커버 지오해시 자동)
//   Clay 임베딩 파티션을 pgvector에 적재(멱등). 최초 1회만 무겁고, 이후 스캔은 DB 코사인.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ym = u.searchParams.get("ym");
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return NextResponse.json({ ok: false, reason: "ym=YYYY-MM 필수" }, { status: 200 });

  let ghs: string[];
  const ghParam = u.searchParams.get("gh");
  if (ghParam) {
    ghs = [ghParam];
  } else {
    const parts = (u.searchParams.get("bbox") ?? "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      return NextResponse.json({ ok: false, reason: "gh 또는 bbox(w,s,e,n) 필요" }, { status: 200 });
    }
    ghs = geohashesForBbox(parts as [number, number, number, number]);
  }

  try {
    const results = [];
    for (const gh of ghs) results.push(await ingestClayPartition(gh, ym));
    return NextResponse.json({ ok: true, ym, results });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e) }, { status: 200 });
  }
}
