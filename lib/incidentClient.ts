// UTIC 실시간 돌발 클라이언트 — 레이어 켤 때 1회 지연 로딩(산불·CCTV 패턴, §4.8-A).
// 돌발은 실시간이라 이후 3분 주기로 갱신한다(레이어가 켜져 있는 동안).
import { useEffect } from "react";
import { useStore, type IncidentPoint } from "./store";
import { KOREA_BBOX } from "./koreaCube";

const KOREA = [KOREA_BBOX.west, KOREA_BBOX.south, KOREA_BBOX.east, KOREA_BBOX.north].join(",");
const REFRESH_MS = 180_000;

export async function loadIncidents(bbox: string = KOREA): Promise<void> {
  const { setIncident } = useStore.getState();
  setIncident({ status: "loading" });
  try {
    const r = await fetch(`/api/incident?bbox=${bbox}`);
    const j = (await r.json()) as {
      ok?: boolean;
      configured?: boolean;
      source?: string;
      reason?: string;
      incidents?: IncidentPoint[];
    };
    if (!j.ok) {
      setIncident({ status: "error", points: [], configured: j.configured ?? true, reason: j.reason ?? "조회 실패" });
      return;
    }
    setIncident({
      points: Array.isArray(j.incidents) ? j.incidents : [],
      source: j.source ?? "",
      configured: j.configured ?? true,
      reason: j.configured === false ? "UTIC_API_KEY 미설정(서버 IP 등록 필요)" : null,
      status: "ready",
    });
  } catch {
    setIncident({ status: "error", points: [], reason: "네트워크 오류" });
  }
}

/** 레이어를 켜는 동안 즉시 로드 + 3분 주기 갱신(실시간 돌발). */
export function useIncidentLayer() {
  const on = useStore((s) => s.layers.incident);
  useEffect(() => {
    if (!on) return;
    const { incident } = useStore.getState();
    if (incident.status === "idle" || incident.status === "error") loadIncidents();
    const t = setInterval(() => {
      if (useStore.getState().layers.incident) loadIncidents();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [on]);
}
