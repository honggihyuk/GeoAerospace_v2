// 도로 CCTV 클라이언트 — 레이어 켤 때 1회 지연 로딩(산불 패턴, §4.8-A).
import { useEffect } from "react";
import { useStore, type CctvPoint } from "./store";
import { KOREA_BBOX } from "./koreaCube";

const KOREA = [KOREA_BBOX.west, KOREA_BBOX.south, KOREA_BBOX.east, KOREA_BBOX.north].join(",");

export async function loadCctv(bbox: string = KOREA): Promise<void> {
  const { setCctv } = useStore.getState();
  setCctv({ status: "loading" });
  try {
    const r = await fetch(`/api/cctv?bbox=${bbox}`);
    const j = (await r.json()) as { ok?: boolean; sample?: boolean; source?: string; cctvs?: CctvPoint[] };
    if (!j.ok || !Array.isArray(j.cctvs)) throw new Error("bad response");
    setCctv({ points: j.cctvs, source: j.source ?? "", sample: !!j.sample, status: "ready" });
  } catch {
    setCctv({ status: "error", points: [] });
  }
}

/** 레이어를 켜는 순간 1회 로드. */
export function useCctvLayer() {
  const on = useStore((s) => s.layers.cctv);
  useEffect(() => {
    if (!on) return;
    const { cctv } = useStore.getState();
    if (cctv.status === "idle" || cctv.status === "error") loadCctv();
  }, [on]);
}

/** 카메라 아이콘(캔버스 → 데이터URL). deck.gl IconLayer mask 틴트용 흰 실루엣. */
export function makeCctvIcon(size = 64): string | null {
  if (typeof document === "undefined") return null;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const s = size / 64;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  // 카메라 몸체(둥근 사각형)
  const bx = 12 * s, by = 22 * s, bw = 34 * s, bh = 24 * s, r = 5 * s;
  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + bw, by, bx + bw, by + bh, r);
  ctx.arcTo(bx + bw, by + bh, bx, by + bh, r);
  ctx.arcTo(bx, by + bh, bx, by, r);
  ctx.arcTo(bx, by, bx + bw, by, r);
  ctx.closePath();
  ctx.fill();
  // 렌즈(원) — 가운데를 뚫어 카메라처럼
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(bx + bw / 2, by + bh / 2, 6.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  // 렌즈 테두리
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(bx + bw / 2, by + bh / 2, 6.5 * s, 0, Math.PI * 2);
  ctx.stroke();
  // 지시선(핀)
  ctx.lineWidth = 2.4 * s;
  ctx.beginPath();
  ctx.moveTo(size / 2, by + bh);
  ctx.lineTo(size / 2, 58 * s);
  ctx.stroke();
  return cv.toDataURL();
}
