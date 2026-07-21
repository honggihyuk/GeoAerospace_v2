import { NextResponse } from "next/server";
import { findChannel, convertCount, looksLikeCount, type UnitType } from "@/lib/gk2a";
import { gk2aParams, gridBounds } from "@/lib/lcc";
import { safeFetch } from "@/lib/server/safeFetch";

export const dynamic = "force-dynamic";

// GET /api/gk2a?waveType=105&unitType=BT&dateTime=YYYYMMDDHHmm
// 천리안위성 2A호 한반도 격자 (제안서_GK2A §K1 렌더링 계층).
//
// KMA_SERVICE_KEY가 있으면 실데이터, 없으면 **합성 데이터**를 낸다.
// 합성은 `synthetic: true`로 명시하며, 클라이언트는 이를 UI에 그대로 표기해야 한다 —
// 합성값을 실측처럼 보여주면 이 프로젝트가 A2/A4에서 세운 정직성 원칙을 어긴다.

const KMA_BASE = "https://apis.data.go.kr/1360000/WthrSatlitInfoService";

/** 가이드 응답 예시 기준 격자 메타. 실응답이 오면 그 값으로 대체된다. */
const DEFAULT_META = { gridKm: 2.0, xdim: 320, ydim: 396, x0: 62.0, y0: 331.0 };

const OP: Record<string, string> = {
  가시: "getGk2aViAll",
  근적외: "getGk2aNrAll",
  단파적외: "getGk2aSwAll",
  적외: "getGk2aIrAll",
  수증기: "getGk2aWvAll",
};

/**
 * 관측 가능한 최신 시각. API는 **2일 전 ~ 6시간 전**만 준다(가이드 p35).
 * 여유를 두고 7시간 전에서 2분 격자에 맞춰 내린다.
 */
function latestObservableKst(): string {
  const t = new Date(Date.now() - 7 * 3600_000);
  const kst = new Date(t.getTime() + 9 * 3600_000); // API 시간기준은 KST
  kst.setUTCMinutes(Math.floor(kst.getUTCMinutes() / 2) * 2, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}${p(kst.getUTCMonth() + 1)}${p(kst.getUTCDate())}${p(kst.getUTCHours())}${p(kst.getUTCMinutes())}`;
}

/**
 * 합성 격자 — 키가 없을 때 렌더링 경로를 증명하기 위한 것.
 * 실제 관측이 아니며 기상학적 의미가 없다. 지형을 흉내 내지 않고
 * 위도 경사 + 이동하는 구름 덩어리만 만든다(무엇이 합성인지 명확하도록).
 */
function syntheticGrid(xdim: number, ydim: number, unit: UnitType, seedMin: number): number[][] {
  const p = gk2aParams(DEFAULT_META);
  const phase = (seedMin / 180) * Math.PI * 2;
  const g: number[][] = [];
  for (let y = 0; y < ydim; y++) {
    const row = new Array<number>(xdim);
    for (let x = 0; x < xdim; x++) {
      // 남쪽이 따뜻한 기본 경사
      const latFrac = 1 - y / ydim;
      let v = 300 - 22 * latFrac;
      // 이동하는 구름 두 덩어리 (차가움)
      for (const [cx, cy, r, amp] of [
        [xdim * (0.35 + 0.18 * Math.cos(phase)), ydim * (0.42 + 0.1 * Math.sin(phase)), 55, 78],
        [xdim * (0.68 + 0.12 * Math.sin(phase * 0.7)), ydim * (0.66 + 0.08 * Math.cos(phase)), 38, 55],
      ] as const) {
        const d = Math.hypot(x - cx, y - cy) / r;
        if (d < 1) v -= amp * Math.exp(-d * d * 2.5);
      }
      row[x] = unit === "A" ? Math.max(0, (300 - v) * 1.6) : v;
    }
    g.push(row);
  }
  void p;
  return g;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const waveType = u.searchParams.get("waveType") ?? "105";
  const unitType = (u.searchParams.get("unitType") ?? "BT") as UnitType;
  const ch = findChannel(waveType);
  if (!ch) return NextResponse.json({ ok: false, reason: `알 수 없는 waveType: ${waveType}` }, { status: 200 });

  const dateTime = u.searchParams.get("dateTime") ?? latestObservableKst();
  const key = process.env.KMA_SERVICE_KEY ?? "";

  const meta = { ...DEFAULT_META, gridKm: ch.gridKm };
  const bounds = gridBounds(meta.xdim, meta.ydim, gk2aParams(meta));

  if (!key) {
    const seed = Number(dateTime.slice(-4)) || 0;
    return NextResponse.json({
      ok: true,
      synthetic: true,
      reason: "KMA_SERVICE_KEY 미설정 — 렌더링 경로 검증용 합성 데이터",
      channel: ch.name,
      waveType,
      unitType,
      dateTime,
      meta,
      bounds,
      grid: syntheticGrid(meta.xdim, meta.ydim, unitType, seed),
    });
  }

  try {
    const q = new URLSearchParams({
      serviceKey: key,
      dataType: "JSON",
      numOfRows: "1",
      pageNo: "1",
      dateTime,
      waveType,
      unitType,
    });
    const r = await safeFetch(`${KMA_BASE}/${OP[ch.kind]}?${q}`, { timeoutMs: 30_000, accept: "application/json" });
    if (!r.ok) throw new Error(`kma ${r.status}`);
    const j = (await r.json()) as {
      response?: {
        header?: { resultCode?: string; resultMsg?: string };
        body?: { items?: { item?: unknown } };
      };
    };
    const code = j.response?.header?.resultCode;
    if (code && code !== "00" && code !== "0") {
      throw new Error(`KMA ${code}: ${j.response?.header?.resultMsg ?? ""}`);
    }

    // 실측: items.item은 **배열**로 온다(가이드 XML 예시만 보면 객체로 오해하기 쉽다).
    // 객체로 가정하면 value가 undefined가 되어 격자가 통째로 비는데, 그 증상이
    // "값 부족" 에러로만 나타나 원인을 찾기 어렵다.
    const rawItem = j.response?.body?.items?.item;
    const item = (Array.isArray(rawItem) ? rawItem[0] : rawItem ?? {}) as Record<string, unknown>;
    const xdim = Number(item.xdim) || meta.xdim;
    const ydim = Number(item.ydim) || meta.ydim;
    const gridKm = Number(item.gridKm) || meta.gridKm;
    const x0 = Number(item.x0) || meta.x0;
    const y0 = Number(item.y0) || meta.y0;

    const raw = String(item.value ?? "");
    const flat = raw.split(",").map(Number).filter(Number.isFinite);
    if (flat.length < xdim * ydim) throw new Error(`격자 값 부족 (필요 ${xdim * ydim}, 실제 ${flat.length})`);

    // API가 Count를 주는지 물리량을 주는지 응답마다 다를 수 있다(가이드 §2-4 vs 응답 예시).
    // 표본을 보고 판단하며, 확실하지 않으면 변환하지 않고 그대로 둔다.
    const sample = flat.slice(0, 500);
    const isCount = sample.every(looksLikeCount);
    const values = isCount ? flat.map((c) => convertCount(c, ch, unitType)) : flat;

    const m2 = { gridKm, xdim, ydim, x0, y0 };
    const grid: number[][] = [];
    for (let y = 0; y < ydim; y++) grid.push(values.slice(y * xdim, (y + 1) * xdim));

    return NextResponse.json({
      ok: true,
      synthetic: false,
      channel: ch.name,
      waveType,
      unitType,
      dateTime,
      converted: isCount,
      meta: m2,
      bounds: gridBounds(xdim, ydim, gk2aParams(m2)),
      grid,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, reason: String(e), dateTime, channel: ch.name }, { status: 200 });
  }
}
