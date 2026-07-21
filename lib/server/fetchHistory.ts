// TLE 이력 수집 (고도화 §A3 기동 감지) — Space-Track gp_history.
//
// gp_history는 객체별 *과거* 원소 전체를 준다(class/gp는 최신 1건만).
// 기동은 원소 간 반장축 계단 상승으로 나타나므로 이력이 있어야 감지할 수 있다.
import { safeFetch } from "./safeFetch";
import { getSessionCookie, isConfigured } from "./spacetrack";
import type { Elset } from "@/lib/maneuvers";

const BASE = "https://www.space-track.org";
const TTL_MS = 6 * 60 * 60 * 1000; // 이력은 자주 바뀌지 않는다 (레이트리밋 보호)

const cache = new Map<number, { v: Elset[]; ts: number }>();

/** 최근 `days`일치 원소 이력. 자격증명이 없으면 빈 배열. */
export async function fetchElsetHistory(norad: number, days = 70): Promise<Elset[]> {
  if (!isConfigured()) return [];
  const hit = cache.get(norad);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.v;

  const cookie = await getSessionCookie();
  const url =
    `${BASE}/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${norad}` +
    `/EPOCH/%3Enow-${days}/orderby/EPOCH%20asc/format/json`;
  const r = await safeFetch(url, { headers: { cookie }, timeoutMs: 40_000, accept: "application/json" });
  if (!r.ok) throw new Error(`gp_history ${r.status}`);

  const rows = (await r.json()) as Array<Record<string, string>>;
  const out: Elset[] = [];
  for (const x of rows) {
    const mm = Number(x.MEAN_MOTION);
    const sma = Number(x.SEMIMAJOR_AXIS);
    if (!x.EPOCH || !Number.isFinite(mm) || !Number.isFinite(sma)) continue;
    out.push({ epoch: `${x.EPOCH.slice(0, 19)}Z`, meanMotion: mm, semiMajorAxis: sma });
  }
  cache.set(norad, { v: out, ts: Date.now() });
  return out;
}
