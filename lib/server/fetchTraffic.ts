// ITS 실시간 소통정보(trafficInfo) — 실측 통행속도(km/h). CCTV 프레임 VLM 판독의 "실증" 근거.
//   응답 item: roadName·speed(km/h)·travelTime·linkId·nodeId. 좌표 필드는 없어(표준노드링크 필요)
//   CCTV 근처 소규모 bbox의 링크를 도로별로 묶어, CCTV가 보는 도로(고속도로/이름일치)를 대표값으로.
//   키: ITS_API_KEY(실키는 JSON·bbox 반영) 없으면 데모키 "test"(XML·서울권 고정).
import { safeFetch } from "./safeFetch";

const BASE = "https://openapi.its.go.kr:9443/trafficInfo";

// 대표 도로 1개 + 인근 전체 요약.
export type TrafficNear = { road: string; roadSpeed: number; roadLinks: number; nearAvg: number; nearMin: number; nearMax: number };

type Row = { speed: number; road: string };

// 실키는 JSON({header,body:{items:[…]}}), 데모키는 XML(<response>…<item>) 반환 → 양쪽 파싱.
function parseRows(text: string): Row[] {
  const t = text.trimStart();
  const out: Row[] = [];
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(text) as { body?: { items?: unknown }; response?: { body?: { items?: unknown } } };
      const raw = j.body?.items ?? j.response?.body?.items ?? [];
      for (const o of (Array.isArray(raw) ? raw : [raw]) as { speed?: string | number; roadName?: string }[]) {
        const sp = Number(o?.speed);
        if (Number.isFinite(sp) && sp > 0) out.push({ speed: sp, road: (o?.roadName ?? "").trim() });
      }
    } catch {
      /* noop */
    }
  } else {
    for (const m of t.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const sp = Number(m[1].match(/<speed>([^<]*)<\/speed>/)?.[1]);
      const rd = (m[1].match(/<roadName>([^<]*)<\/roadName>/)?.[1] ?? "").trim();
      if (Number.isFinite(sp) && sp > 0) out.push({ speed: sp, road: rd });
    }
  }
  return out;
}

/** CCTV 좌표 근처 실측 통행속도 요약. hint=CCTV 도로명 키워드(예: '경부'). 없으면 null. */
export async function fetchTrafficNear(lon: number, lat: number, hint?: string, r = 0.012): Promise<TrafficNear | null> {
  const key = process.env.ITS_API_KEY ?? "test";
  const url = `${BASE}?apiKey=${encodeURIComponent(key)}&type=all&minX=${lon - r}&maxX=${lon + r}&minY=${lat - r}&maxY=${lat + r}&getType=json`;
  try {
    const res = await safeFetch(url, { accept: "application/json, text/xml", timeoutMs: 12_000 });
    if (!res.ok) return null;
    const rows = parseRows(await res.text());
    if (!rows.length) return null;

    // 인근 전체 요약.
    let nMin = Infinity, nMax = -Infinity, nSum = 0;
    for (const { speed } of rows) {
      if (speed < nMin) nMin = speed;
      if (speed > nMax) nMax = speed;
      nSum += speed;
    }

    // 도로별 평균.
    const byRoad = new Map<string, { sum: number; n: number }>();
    for (const { speed, road } of rows) {
      if (!road || road === "-") continue;
      const e = byRoad.get(road) ?? { sum: 0, n: 0 };
      e.sum += speed;
      e.n++;
      byRoad.set(road, e);
    }
    const roads = [...byRoad.entries()].map(([road, e]) => ({ road, avg: Math.round(e.sum / e.n), n: e.n })).sort((a, b) => b.n - a.n);
    if (!roads.length) return null;

    // 대표 도로: ① CCTV 도로명 힌트 일치 → ② 고속도로/고속화 → ③ 링크 최다.
    const h = (hint ?? "").replace(/선$|고속도로$/g, "").trim();
    const rep =
      (h && roads.find((r0) => r0.road.includes(h))) ||
      roads.find((r0) => /고속도로|고속화/.test(r0.road)) ||
      roads[0];

    return {
      road: rep.road,
      roadSpeed: rep.avg,
      roadLinks: rep.n,
      nearAvg: Math.round(nSum / rows.length),
      nearMin: nMin,
      nearMax: Math.round(nMax),
    };
  } catch {
    return null;
  }
}
