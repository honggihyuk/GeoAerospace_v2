import { NextResponse } from "next/server";
import { fetchCctv } from "@/lib/server/fetchCctv";
import { fetchCctvUtic } from "@/lib/server/fetchCctvUtic";
import type { CctvItem } from "@/lib/server/fetchCctv";

export const dynamic = "force-dynamic";

// GET /api/cctv?bbox=w,s,e,n → 도로 CCTV 포인트(실좌표+스트림).
//   ITS(고속도로·국도, HLS 직접재생+VLM 판독) + UTIC(도심·지자체, JSP 플레이어 iframe)를 병합.
//   좌표 중복은 ITS 우선(재생·판독이 우월)으로 제거한다.
export async function GET(req: Request) {
  const u = new URL(req.url);
  const parts = (u.searchParams.get("bbox") ?? "124.5,33.0,131.0,38.7").split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ ok: false, reason: "bbox 형식 오류 (w,s,e,n)" }, { status: 200 });
  }
  const bbox = parts as [number, number, number, number];

  const [itsRes, uticRes] = await Promise.allSettled([fetchCctv(bbox), fetchCctvUtic(bbox)]);

  const its = itsRes.status === "fulfilled" ? itsRes.value : null;
  const utic = uticRes.status === "fulfilled" ? uticRes.value : null;
  if (!its && !utic) {
    return NextResponse.json({ ok: false, reason: String(itsRes.status === "rejected" ? itsRes.reason : "") }, { status: 200 });
  }

  // ITS 먼저 넣어 좌표 선점 → UTIC 중복분 제거.
  const items: CctvItem[] = [];
  const seen = new Set<string>();
  for (const list of [its?.items ?? [], utic?.items ?? []]) {
    for (const it of list) {
      const k = `${it.lon.toFixed(5)},${it.lat.toFixed(5)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
  }

  const sources = [its?.source, utic && utic.configured ? utic.source : null].filter(Boolean).join(" + ");
  // 한쪽 소스가 실패해도 나머지는 제공하되, 실패 사유는 감추지 않는다(조용한 0건 방지).
  const why = (e: unknown) => {
    const c = (e as { cause?: { code?: string; message?: string } })?.cause;
    return `${String(e)}${c ? ` [cause: ${c.code ?? c.message}]` : ""}`;
  };
  const errors: Record<string, string> = {};
  if (itsRes.status === "rejected") errors.its = why(itsRes.reason);
  if (uticRes.status === "rejected") errors.utic = why(uticRes.reason);
  else if (utic && !utic.configured) errors.utic = "UTIC_API_KEY 미설정";

  return NextResponse.json({
    ok: true,
    sample: its?.demo ?? false,
    source: sources || "—",
    count: items.length,
    counts: { its: its?.items.length ?? 0, utic: utic?.items.length ?? 0 },
    ...(Object.keys(errors).length ? { errors } : {}),
    cctvs: items,
  });
}
