// InSAR Norway (NGU) — 실측 Sentinel-1 지반운동 (레인 ②). 무인증 공개 API.
//   https://insar.ngu.no/api-docs/  — 비동기 쿼리: POST query?bbox → poll query-state → download CSV.
// mean_velocity = 연평균 LoS 변위(mm/yr, 음수=위성에서 멀어짐≈침하). PS 밀도가 높아
// coherence 필터 + bbox 클리핑 + 다운샘플로 관측점을 수백 개로 줄여 적재한다.
//   ⚠️ 커버리지 = 노르웨이 (한반도 미포함). 실측 InSAR 파이프라인 검증·시연용.
import { safeFetch } from "./safeFetch";
import zlib from "node:zlib";
import type { InsarPoint } from "./ingest";

const BASE = "https://insar.ngu.no/insar-api";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type State = { state?: string; complete?: boolean; csv?: string[] };

async function startQuery(dataset: string, bbox: string): Promise<string | null> {
  const r = await safeFetch(`${BASE}/${dataset}/query?bbox=${bbox}`, { method: "POST", accept: "application/json", timeoutMs: 20_000 });
  if (!r.ok) return null;
  const t = await r.text();
  try {
    const id = (JSON.parse(t) as { id?: string }).id;
    return id && id !== "Notfound" ? id : null;
  } catch {
    return null;
  }
}

async function pollComplete(id: string, maxMs = 90_000): Promise<State | null> {
  const deadline = Date.now() + maxMs;
  await sleep(2000); // 직후 폴링은 "Not found"가 나므로 소폭 대기
  while (Date.now() < deadline) {
    const r = await safeFetch(`${BASE}/query-state?id=${id}`, { accept: "application/json", timeoutMs: 15_000 });
    if (r.ok) {
      try {
        const j = JSON.parse(await r.text()) as State;
        if (j.complete) return j;
      } catch {
        /* "Not found" 등 비-JSON → 계속 폴링 */
      }
    }
    await sleep(2500);
  }
  return null;
}

async function downloadCsv(id: string, name: string): Promise<string> {
  const r = await safeFetch(`${BASE}/query-download?id=${id}&csv=${encodeURIComponent(name)}`, { accept: "text/csv", timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`download ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf); // fetch가 미해제한 경우 대비
  return buf.toString("utf8");
}

function colIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name);
}

/** CSV → InSAR 변위점 (bbox 클리핑 + coherence 필터 + 균등 다운샘플). */
function parseCsv(text: string, bbox: [number, number, number, number], minCoh: number, maxPoints: number): InsarPoint[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  const iLon = colIndex(head, "longitude");
  const iLat = colIndex(head, "latitude");
  const iVel = colIndex(head, "mean_velocity");
  const iCoh = colIndex(head, "temporal_coherence");
  if (iLon < 0 || iLat < 0 || iVel < 0) return [];
  const [w, s, e, n] = bbox;

  const pts: InsarPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    const c = l.split(",");
    const lon = Number(c[iLon]);
    const lat = Number(c[iLat]);
    const vel = Number(c[iVel]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(vel)) continue;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (iCoh >= 0 && minCoh > 0) {
      const coh = Number(c[iCoh]);
      if (Number.isFinite(coh) && coh < minCoh) continue;
    }
    pts.push({ lon, lat, velocity: vel, observedAt: null });
  }

  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out: InsarPoint[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

export type NguResult = { points: InsarPoint[]; dataset: string; rawPoints: number };

/** bbox 안의 InSAR Norway 실측 변위점을 가져온다. dataset은 list-datasets에서 선택(트랙별). */
export async function fetchInsarNorway(
  bbox: [number, number, number, number],
  opts: { dataset?: string; minCoherence?: number; maxPoints?: number } = {}
): Promise<NguResult> {
  const dataset = opts.dataset ?? "rs2_bergen_asc_s1";
  const minCoh = opts.minCoherence ?? 0.7;
  const maxPoints = Math.min(2000, Math.max(1, opts.maxPoints ?? 600));
  const bboxStr = bbox.join(",");

  const id = await startQuery(dataset, bboxStr);
  if (!id) throw new Error(`InSAR Norway 쿼리 실패 (dataset=${dataset})`);
  const state = await pollComplete(id);
  if (!state) throw new Error("InSAR Norway 쿼리 타임아웃");
  const csvs = state.csv ?? [];
  if (!csvs.length) return { points: [], dataset, rawPoints: 0 };

  let all: InsarPoint[] = [];
  for (const name of csvs.slice(0, 4)) {
    const text = await downloadCsv(id, name);
    all = all.concat(parseCsv(text, bbox, minCoh, maxPoints));
  }
  // 여러 타일 합쳐 다시 상한 적용.
  let points = all;
  if (points.length > maxPoints) {
    const step = points.length / maxPoints;
    points = Array.from({ length: maxPoints }, (_, i) => all[Math.floor(i * step)]);
  }
  return { points, dataset, rawPoints: all.length };
}
