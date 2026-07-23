// 신호개방 클라이언트 — 인천·대구 신호제어 교차로(기반정보). 정적이라 레이어 켤 때 1회 로드.
import { useEffect } from "react";
import { useStore, type SignalPoint } from "./store";

export async function loadSignals(): Promise<void> {
  const { setSignal } = useStore.getState();
  setSignal({ status: "loading" });
  try {
    const r = await fetch(`/api/signal`);
    const j = (await r.json()) as {
      ok?: boolean;
      configured?: boolean;
      source?: string;
      reason?: string;
      intersections?: SignalPoint[];
    };
    if (!j.ok) {
      setSignal({ status: "error", points: [], configured: j.configured ?? true, reason: j.reason ?? "조회 실패" });
      return;
    }
    setSignal({
      points: Array.isArray(j.intersections) ? j.intersections : [],
      source: j.source ?? "",
      configured: j.configured ?? true,
      reason: j.configured === false ? "DATA_GO_KR_SIGNAL_KEY 미설정(data.go.kr 서비스키 필요)" : null,
      status: "ready",
    });
  } catch {
    setSignal({ status: "error", points: [], reason: "네트워크 오류" });
  }
}

/** 레이어를 켜는 순간 1회 로드. */
export function useSignalLayer() {
  const on = useStore((s) => s.layers.signal);
  useEffect(() => {
    if (!on) return;
    const { signal } = useStore.getState();
    if (signal.status === "idle" || signal.status === "error") loadSignals();
  }, [on]);
}
