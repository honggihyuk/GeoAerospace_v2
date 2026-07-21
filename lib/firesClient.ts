// 화재 데이터 클라이언트 (제안서 §4.7 / P5.5).
//
// 로딩 전략은 제안서 §4.8-A "레이어 인식 지연 로딩"을 따른다 — 레이어를 켤 때 1회만
// 페치하고, 이후 필터가 바뀔 때만 다시 받는다. 전지구 응답이 260 KB라 매번 받으면 낭비다.
import { useEffect } from "react";
import { useStore } from "./store";

export type FireFilter = { minFrp?: number; minConfidence?: number; dayRange?: number; bbox?: string; region?: string };

export async function loadFires(f: FireFilter = {}): Promise<void> {
  const { setFires } = useStore.getState();
  setFires({ status: "loading" });
  const q = new URLSearchParams();
  if (f.bbox) q.set("bbox", f.bbox);
  if (f.minFrp != null) q.set("minFrp", String(f.minFrp));
  if (f.minConfidence != null) q.set("minConfidence", String(f.minConfidence));
  if (f.dayRange != null) q.set("dayRange", String(f.dayRange));

  try {
    const r = await fetch(`/api/fires?${q.toString()}`);
    const j = await r.json();
    if (!j || j.error || !Array.isArray(j.points)) throw new Error(j?.error ?? "bad response");
    setFires({
      points: j.points,
      source: j.source ?? "",
      total: j.summary?.total ?? j.points.length,
      sampled: !!j.summary?.sampled,
      maxFrp: j.summary?.maxFrp ?? 0,
      filter: f.minFrp != null || f.dayRange != null || f.region ? { minFrp: f.minFrp, dayRange: f.dayRange, region: f.region } : null,
      bbox: f.bbox ?? null,
      status: "ready",
    });
  } catch {
    setFires({ status: "error", points: [] });
  }
}

/** 레이어를 켜는 순간 1회 로드 (지연 로딩). */
export function useFiresLayer() {
  const on = useStore((s) => s.layers.fires);
  useEffect(() => {
    if (!on) return;
    const { fires } = useStore.getState();
    if (fires.status === "idle" || fires.status === "error") loadFires();
  }, [on]);
}
