// ITS 실시간 소통정보(trafficInfo) + 표준노드링크(moct_link) 방면별 정밀 속도.
//   trafficInfo item: roadName·speed·linkId. moct_link: link_id·road_name·geom(5186)로 CCTV 근처
//   같은 도로 링크를 방위(bearing)로 두 방향 분리 → linkId로 trafficInfo 속도를 방향별로 매칭한다.
//   moct_link 미적재 시 노드ID 순서 휴리스틱으로 폴백.
import { safeFetch } from "./safeFetch";
import { db, dbReady } from "./db";

const BASE = "https://openapi.its.go.kr:9443/trafficInfo";

export type DirSpeed = { label: string; speed: number; links: number };
export type TrafficNear = { road: string; dirs: DirSpeed[]; nearAvg: number; precise: boolean };

type Row = { speed: number; road: string; link: string; s: string; e: string };

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
          out.push({ speed: sp, road: String(o?.roadName ?? "").trim(), link: String(o?.linkId ?? ""), s: String(o?.startNodeId ?? ""), e: String(o?.endNodeId ?? "") });
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
          link: b.match(/<linkId>([^<]*)<\/linkId>/)?.[1] ?? "",
          s: b.match(/<startNodeId>([^<]*)<\/startNodeId>/)?.[1] ?? "",
          e: b.match(/<endNodeId>([^<]*)<\/endNodeId>/)?.[1] ?? "",
        });
    }
  }
  return out;
}

const avg = (ns: number[]) => (ns.length ? Math.round(ns.reduce((a, b) => a + b, 0) / ns.length) : 0);

/** 방위(도) → 8방위 라벨. */
function cardinal(b: number): string {
  const d = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
  return d[Math.round(((b % 360) + 360) % 360 / 45) % 8] + "행";
}
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180); // 0~180

async function fetchRows(lon: number, lat: number, r: number): Promise<Row[]> {
  const key = process.env.ITS_API_KEY ?? "test";
  const url = `${BASE}?apiKey=${encodeURIComponent(key)}&type=all&minX=${lon - r}&maxX=${lon + r}&minY=${lat - r}&maxY=${lat + r}&getType=json`;
  const res = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 12_000 });
  if (!res.ok) return [];
  return parseRows(await res.text());
}

// 표준노드링크로 CCTV 근처 같은 도로 링크를 두 방향으로 분리.
async function roadDirs(lon: number, lat: number): Promise<{ road: string; groups: { bearing: number; links: Set<string> }[] } | null> {
  try {
    const { rows } = await db().query<{ road_name: string; link_id: string; bearing: number }>(
      `WITH c AS (SELECT ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326),5186) g),
            nr AS (SELECT road_name FROM moct_link ORDER BY geom <-> (SELECT g FROM c) LIMIT 1)
       SELECT link_id, road_name, degrees(ST_Azimuth(ST_StartPoint(geom),ST_EndPoint(geom))) bearing
         FROM moct_link
        WHERE road_name = (SELECT road_name FROM nr)
          AND ST_DWithin(geom,(SELECT g FROM c),1000)
        ORDER BY geom <-> (SELECT g FROM c) LIMIT 30`,
      [lon, lat]
    );
    if (!rows.length) return null;
    const road = rows[0].road_name;
    const base = Number(rows[0].bearing);
    const gA = { bearing: base, links: new Set<string>() };
    const gB = { bearing: (base + 180) % 360, links: new Set<string>() };
    for (const r of rows) {
      (angDiff(Number(r.bearing), base) < 90 ? gA : gB).links.add(r.link_id);
    }
    const groups = [gA, gB].filter((g) => g.links.size);
    return { road, groups };
  } catch {
    return null; // moct_link 미적재 등
  }
}

/** CCTV 근처 방면별 실측 속도. moct_link 있으면 정밀(방위+linkId), 없으면 노드ID 휴리스틱. */
export async function fetchTrafficNear(lon: number, lat: number, hint?: string, r = 0.012): Promise<TrafficNear | null> {
  let rows: Row[];
  try {
    rows = await fetchRows(lon, lat, r);
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const nearAvg = avg(rows.map((x) => x.speed));
  const speedByLink = new Map(rows.map((x) => [x.link, x.speed] as const));

  // ① 정밀: 표준노드링크로 방향 분리 + linkId 매칭.
  if (await dbReady()) {
    const rd = await roadDirs(lon, lat);
    if (rd && rd.groups.length) {
      const dirs: DirSpeed[] = [];
      for (const g of rd.groups) {
        const speeds: number[] = [];
        for (const lid of g.links) {
          const s = speedByLink.get(lid);
          if (s != null) speeds.push(s);
        }
        if (speeds.length) dirs.push({ label: cardinal(g.bearing), speed: avg(speeds), links: speeds.length });
      }
      if (dirs.length) {
        dirs.sort((a, b) => a.speed - b.speed);
        return { road: rd.road, dirs, nearAvg, precise: true };
      }
    }
  }

  // ② 폴백: 도로명 힌트 대표도로 + 노드ID 순서로 두 방향 근사.
  const byRoad = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.road || row.road === "-") continue;
    (byRoad.get(row.road) ?? byRoad.set(row.road, []).get(row.road)!).push(row);
  }
  const roads = [...byRoad.entries()].map(([road, rs]) => ({ road, rows: rs, n: rs.length })).sort((a, b) => b.n - a.n);
  if (!roads.length) return null;
  const h = (hint ?? "").replace(/선$|고속도로$/g, "").trim();
  const rep = (h && roads.find((x) => x.road.includes(h))) || roads.find((x) => /고속도로|고속화/.test(x.road)) || roads[0];
  const a: number[] = [];
  const b: number[] = [];
  for (const row of rep.rows) (row.s && row.e && row.s < row.e ? a : b).push(row.speed);
  const dirs: DirSpeed[] = [];
  if (a.length) dirs.push({ label: "방향①", speed: avg(a), links: a.length });
  if (b.length) dirs.push({ label: "방향②", speed: avg(b), links: b.length });
  dirs.sort((x, y) => x.speed - y.speed);
  return { road: rep.road, dirs, nearAvg, precise: false };
}
