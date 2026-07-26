import { NextResponse } from "next/server";
import { sampleElevations } from "@/lib/server/demSample";

export const dynamic = "force-dynamic";

// 실측 지형고도 격자 프록시 — bbox 위 nx×ny 격자점의 **실측 고도(m)** 를 Int16 바이너리로 반환.
// 한반도 지형 메시(큐브샛 관측)의 정점 변위에 쓰인다.
//
// 왜 서버인가: 기존엔 클라의 map.queryTerrainElevation() 으로 고도를 샘플했는데, 이는 **현재 화면 줌**의
// 로드된 지형 타일에서만 읽어 flyTo(zoom 4.6) 상태에선 사실상 z≈4~6(2.5~10km) 로 뭉개진 값이었다.
// 여기서는 AWS Terrarium z=9(≈305m/px) 타일을 서버가 직접 디코딩해 격자점마다 실측 고도를 샘플한다
// → 화면 줌과 무관하게 일관된 305m급 실측. (Copernicus DEM GLO-30/90 은 남한이 정부 제한 nodata.)
// 타일은 demSample 내부 캐시로 요청 간 재사용된다.

const MAX_CELLS = 200_000; // 320×360=115,200 을 여유 있게 수용, 폭주 방지 상한

export async function GET(req: Request) {
  const u = new URL(req.url);
  const bbox = (u.searchParams.get("bbox") ?? "125.5,33.9,129.7,38.7").split(",").map(Number);
  if (bbox.length !== 4 || bbox.some((n) => Number.isNaN(n))) return NextResponse.json({ error: "bad bbox" }, { status: 400 });
  const [west, south, east, north] = bbox;
  const nx = Math.min(1024, Math.max(2, Math.round(Number(u.searchParams.get("nx") ?? 320))));
  const ny = Math.min(1024, Math.max(2, Math.round(Number(u.searchParams.get("ny") ?? 360))));
  if (nx * ny > MAX_CELLS) return NextResponse.json({ error: "grid too large" }, { status: 400 });

  // 격자점 경위도 — koreaCube.cellLngLat 와 동일한 edge-to-edge 배치(정점 = 격자 교점).
  const pts: { lon: number; lat: number }[] = new Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const lat = south + (y / (ny - 1)) * (north - south);
    for (let x = 0; x < nx; x++) {
      pts[y * nx + x] = { lon: west + (x / (nx - 1)) * (east - west), lat };
    }
  }

  try {
    const elev = await sampleElevations(pts); // (number|null)[] — null=고도 불명(타일 실패)

    // ── 1) raw 격자 (NaN=바다/불명) ──────────────────────────────────────────
    const raw = new Float64Array(nx * ny);
    for (let i = 0; i < raw.length; i++) {
      const m = elev[i];
      raw[i] = m == null ? NaN : m;
    }

    // ── 2) 고립 스파이크 despike ─────────────────────────────────────────────
    // z=9 Terrarium 은 드물게 손상 픽셀이 있다(예: 이웃 전부 ~0m인데 홀로 3072m). 유효 이웃
    // (상하좌우) 대비 800m 넘게 솟은 셀만 이웃 중앙값으로 대체한다(실제 봉우리는 넘지 않음).
    const clean = new Float64Array(nx * ny);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        let v = raw[i];
        if (Number.isNaN(v)) {
          clean[i] = NaN;
          continue;
        }
        const nb: number[] = [];
        if (x > 0 && !Number.isNaN(raw[i - 1])) nb.push(raw[i - 1]);
        if (x < nx - 1 && !Number.isNaN(raw[i + 1])) nb.push(raw[i + 1]);
        if (y > 0 && !Number.isNaN(raw[i - nx])) nb.push(raw[i - nx]);
        if (y < ny - 1 && !Number.isNaN(raw[i + nx])) nb.push(raw[i + nx]);
        if (nb.length >= 3) {
          const nmax = Math.max(...nb);
          if (v - nmax > 800) {
            nb.sort((a, b) => a - b);
            v = nb[nb.length >> 1]; // 이웃 중앙값
          }
        }
        clean[i] = v;
      }
    }

    // ── 3) 육지 인식 스무딩 ──────────────────────────────────────────────────
    // 최근접 점 샘플(305m DEM → 1.3km 격자)은 고주파 지터를 낳고, 과장하면 "바늘 스파이크"가 된다.
    // 3×3 가우시안([1,2,1;2,4,2;1,2,1]) 2패스로 지터를 깎되 산맥 형상은 유지한다. 바다(NaN)는
    // 가중치에서 제외 → 해안선으로 값이 새지 않는다(육지끼리만 평균).
    const GW = [1, 2, 1, 2, 4, 2, 1, 2, 1];
    const SMOOTH_PASSES = 2;
    let cur = clean;
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const next = new Float64Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (Number.isNaN(cur[i])) {
            next[i] = NaN;
            continue;
          }
          let sw = 0;
          let sv = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              const val = cur[yy * nx + xx];
              if (Number.isNaN(val)) continue;
              const w = GW[(dy + 1) * 3 + (dx + 1)];
              sv += w * val;
              sw += w;
            }
          }
          next[i] = sw > 0 ? sv / sw : cur[i];
        }
      }
      cur = next;
    }

    // ── 4) Int16 패킹 ([-500,9000] 클램프, NaN=바다 센티넬 -9999 → 클라가 메시서 제외) ──
    const out = new Int16Array(nx * ny);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number.isNaN(cur[i]) ? -9999 : Math.max(-500, Math.min(9000, Math.round(cur[i])));
    }
    const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "content-type": "application/octet-stream",
        "x-grid-nx": String(nx),
        "x-grid-ny": String(ny),
        "cache-control": "public, max-age=86400",
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
