// TLE 이력 수집 (고도화 §A3 기동 감지) — Space-Track gp_history.
//
// gp_history는 객체별 *과거* 원소 전체를 준다(class/gp는 최신 1건만).
// 기동은 원소 간 반장축 계단 상승으로 나타나므로 이력이 있어야 감지할 수 있다.
//
// ⚠️ 정책(계정 정지 사건 2026-07-24): gp_history는 220M행짜리 "일회성 과거조회" 전용이다.
//   절대 폴링/스케줄/루프로 호출하지 말 것 — **사용자 액션당 1회**만, 그리고 강캐시(24h)로 보호한다.
//   레이트리밋(클래스별 1회/시간)·붐비는구간 회피는 spacetrackFetch 관문이 강제한다.
import { spacetrackFetch, isConfigured } from "./spacetrack";
import type { Elset } from "@/lib/maneuvers";

const BASE = "https://www.space-track.org";
const TTL_MS = 24 * 60 * 60 * 1000; // 이력은 느리게 변함 + gp_history 폴리시 → 24h 강캐시

const cache = new Map<number, { v: Elset[]; ts: number }>();

/** 최근 `days`일치 원소 이력. 자격증명 미설정/비활성이면 빈 배열. 폴링 금지(온디맨드 전용). */
export async function fetchElsetHistory(norad: number, days = 70): Promise<Elset[]> {
  if (!isConfigured()) return [];
  const hit = cache.get(norad);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.v;

  const url =
    `${BASE}/basicspacedata/query/class/gp_history/NORAD_CAT_ID/${norad}` +
    `/EPOCH/%3Enow-${days}/orderby/EPOCH%20asc/format/json`;
  const r = await spacetrackFetch(url, { kind: "gp_history", accept: "application/json", timeoutMs: 40_000 });

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
