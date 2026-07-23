// ITS 실시간 소통정보(trafficInfo) — 실측 통행속도(km/h). CCTV 프레임 VLM 판독의 "실증" 근거.
//   item: roadName·speed·startNodeId·endNodeId·linkId. 같은 도로에서 start↔end가 뒤바뀐 링크 쌍이
//   서로 반대 방향이다 → 노드 순서로 두 방향을 갈라 방향별 평균속도를 낸다(방면 이름은 노드좌표 필요→미제공).
//   키: ITS_API_KEY(실키=JSON·bbox 반영) 없으면 데모키 "test"(XML·서울권 고정).
import { safeFetch } from "./safeFetch";

const BASE = "https://openapi.its.go.kr:9443/trafficInfo";

export type DirSpeed = { speed: number; links: number };
export type TrafficNear = {
  road: string;
  roadSpeed: number;
  roadLinks: number;
  dirs: DirSpeed[]; // 대표 도로의 방향별 평균속도(1=단방향, 2=양방향). 오름차순 정렬.
  nearAvg: number;
};

type Row = { speed: number; road: string; s: string; e: string };

// 실키는 JSON({header,body:{items:[…]}}), 데모키는 XML → 양쪽 파싱.
function parseRows(text: string): Row[] {
  const t = text.trimStart();
  const out: Row[] = [];
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { body?: { items?: unknown }; response?: { body?: { items?: unknown } } };
      const raw = j.body?.items ?? j.response?.body?.items ?? [];
      for (const o of (Array.isArray(raw) ? raw : [raw]) as Record<string, string | number>[]) {
        const sp = Number(o?.speed);
        if (Number.isFinite(sp) && sp > 0)
          out.push({ speed: sp, road: String(o?.roadName ?? "").trim(), s: String(o?.startNodeId ?? ""), e: String(o?.endNodeId ?? "") });
      }
    } catch {
      /* noop */
    }
  } else {
    for (const m of t.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const b = m[1];
      const sp = Number(b.match(/<speed>([^<]*)<\/speed>/)?.[1]);
      if (Number.isFinite(sp) && sp > 0)
        out.push({
          speed: sp,
          road: (b.match(/<roadName>([^<]*)<\/roadName>/)?.[1] ?? "").trim(),
          s: b.match(/<startNodeId>([^<]*)<\/startNodeId>/)?.[1] ?? "",
          e: b.match(/<endNodeId>([^<]*)<\/endNodeId>/)?.[1] ?? "",
        });
    }
  }
  return out;
}

function avg(ns: number[]): number {
  return ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : 0;
}

/** CCTV 좌표 근처 실측 통행속도 + 대표 도로 방향별 속도. hint=CCTV 도로명 키워드('경부'). */
export async function fetchTrafficNear(lon: number, lat: number, hint?: string, r = 0.012): Promise<TrafficNear | null> {
  const key = process.env.ITS_API_KEY ?? "test";
  const url = `${BASE}?apiKey=${encodeURIComponent(key)}&type=all&minX=${lon - r}&maxX=${lon + r}&minY=${lat - r}&maxY=${lat + r}&getType=json`;
  try {
    const res = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 12_000 });
    if (!res.ok) return null;
    const rows = parseRows(await res.text());
    if (!rows.length) return null;

    const nearAvg = avg(rows.map((x) => x.speed));

    // 도로별 링크 그룹.
    const byRoad = new Map<string, Row[]>();
    for (const row of rows) {
      if (!row.road || row.road === "-") continue;
      (byRoad.get(row.road) ?? byRoad.set(row.road, []).get(row.road)!).push(row);
    }
    const roads = [...byRoad.entries()].map(([road, rs]) => ({ road, rows: rs, n: rs.length })).sort((a, b) => b.n - a.n);
    if (!roads.length) return null;

    // 대표 도로: ① CCTV 도로명 힌트 일치 → ② 고속도로 → ③ 링크 최다.
    const h = (hint ?? "").replace(/선$|고속도로$/g, "").trim();
    const rep =
      (h && roads.find((r0) => r0.road.includes(h))) || roads.find((r0) => /고속도로|고속화/.test(r0.road)) || roads[0];

    // 대표 도로 링크를 방향으로 분리: start<end 를 A방향, 그 외를 B방향(노드ID 순서로 일관 분리).
    const dirA: number[] = [];
    const dirB: number[] = [];
    for (const row of rep.rows) {
      if (row.s && row.e && row.s < row.e) dirA.push(row.speed);
      else dirB.push(row.speed);
    }
    const dirs: DirSpeed[] = [];
    if (dirA.length) dirs.push({ speed: avg(dirA), links: dirA.length });
    if (dirB.length) dirs.push({ speed: avg(dirB), links: dirB.length });
    dirs.sort((a, b) => a.speed - b.speed); // 느린 방향 먼저

    return { road: rep.road, roadSpeed: avg(rep.rows.map((x) => x.speed)), roadLinks: rep.rows.length, dirs, nearAvg };
  } catch {
    return null;
  }
}
