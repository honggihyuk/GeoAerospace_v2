import { NextResponse } from "next/server";
import { safeFetch } from "@/lib/server/safeFetch";

export const dynamic = "force-dynamic";

// GET /api/geocode?q=  — Nominatim(OSM) 지오코딩 폴백 (SSRF 가드, 설계서 §4.5)
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "missing q" }, { status: 400 });
  try {
    const r = await safeFetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, 6000);
    if (!r.ok) return NextResponse.json({ error: `nominatim ${r.status}` });
    const j = (await r.json()) as Array<{ lat: string; lon: string }>;
    const hit = j[0];
    if (!hit) return NextResponse.json({ error: "not found" });
    return NextResponse.json({ lat: Number(hit.lat), lng: Number(hit.lon) });
  } catch (e) {
    return NextResponse.json({ error: String(e) });
  }
}
