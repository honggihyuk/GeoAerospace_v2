// GK2A 격자 로딩 + 텍스처화 (제안서_GK2A 렌더링 계층).
//
// 서버에서 받은 LCC 격자를 브라우저에서 등장방형으로 재투영해 THREE 텍스처로 만든다.
// 재투영을 서버가 아니라 클라에서 하는 이유: 팔레트·채널을 바꿀 때마다 왕복하지 않고
// 같은 격자로 즉시 다시 칠할 수 있다(격자 320×396 = 127k 값, 전송 후 캐시).
import { useEffect } from "react";
import * as THREE from "three";
import { findChannel, isVnir } from "./gk2a";
import { gk2aParams } from "./lcc";
import { albedoPalette, firePalette, padBounds, rasterizeGrid, thermalPalette } from "./gk2aRaster";
import { useStore } from "./store";

export type RasterOut = { texture: THREE.Texture; bounds: [number, number, number, number] };

/** 채널·단위에 맞는 팔레트를 고른다. */
function paletteFor(waveType: string, unitType: string) {
  const ch = findChannel(waveType);
  if (!ch) return thermalPalette();
  if (unitType === "A") return albedoPalette();
  // 단파적외 3.8μm는 화재 강조 — 고온 화소만 드러낸다
  if (ch.waveType === "038") return firePalette();
  if (isVnir(ch)) return albedoPalette();
  return thermalPalette();
}

/**
 * 격자 → THREE 텍스처. 실패하면 null.
 * 출력 해상도는 격자 해상도에 맞춰 잡는다 — 더 키워도 정보가 늘지 않는다.
 */
export function gridToTexture(
  grid: number[][],
  meta: { gridKm: number; xdim: number; ydim: number; x0: number; y0: number },
  bounds: { west: number; south: number; east: number; north: number },
  waveType: string,
  unitType: string
): RasterOut | null {
  if (typeof document === "undefined") return null;
  const p = gk2aParams(meta);
  const b = padBounds(bounds, 0.4);
  // 경도 폭에 맞춰 가로를 잡고 세로는 비율 유지
  const width = 1024;
  const height = Math.max(
    128,
    Math.round((width * (b.north - b.south)) / Math.max(1e-6, b.east - b.west))
  );

  const r = rasterizeGrid(grid, p, b, width, height, { palette: paletteFor(waveType, unitType) });
  if (r.filled === 0) return null; // 격자와 경계가 어긋남 — 조용히 빈 텍스처를 붙이지 않는다

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // ImageData 생성자 대신 createImageData를 쓴다 — 최신 TS의 타입드배열 제네릭과
  // ImageData 시그니처가 어긋나고, 이쪽이 캔버스 컨텍스트와도 일관된다.
  const img = ctx.createImageData(width, height);
  img.data.set(r.rgba);
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { texture: tex, bounds: [b.west, b.south, b.east, b.north] };
}

export async function loadGk2a(waveType = "105", unitType = "BT"): Promise<void> {
  const { setGk2a } = useStore.getState();
  setGk2a({ status: "loading", waveType, unitType });
  try {
    const r = await fetch(`/api/gk2a?waveType=${waveType}&unitType=${unitType}`);
    const j = await r.json();
    if (!j?.ok || !Array.isArray(j.grid)) throw new Error(j?.reason ?? "bad response");
    setGk2a({
      status: "ready",
      channel: j.channel,
      waveType: j.waveType,
      unitType: j.unitType,
      dateTime: j.dateTime,
      synthetic: !!j.synthetic,
      bounds: j.bounds,
      grid: j.grid,
      meta: j.meta,
    });
  } catch {
    setGk2a({ status: "error", grid: null });
  }
}

/**
 * 2분 간격 시계열 수집 (제안서_GK2A §K2).
 *
 * 프레임을 **순차로** 받는다. 병렬로 던지면 30 TPS 제한에 걸릴 뿐 아니라
 * 실패 프레임이 섞여 시계열에 구멍이 생긴다. 한 프레임이 실패하면 그 프레임만
 * 건너뛰고 계속한다 — 시계열은 몇 장 빠져도 여전히 유용하다.
 *
 * @param count    프레임 수
 * @param stepMin  간격(분). GK2A 관측 주기가 2분이라 2의 배수여야 의미가 있다.
 */
export async function loadGk2aSeries(
  waveType = "105",
  unitType = "BT",
  count = 12,
  stepMin = 2
): Promise<void> {
  const { setGk2a } = useStore.getState();
  setGk2a({ status: "loading", waveType, unitType, series: [], frameIndex: 0, seriesProgress: 0, playing: false });

  // 가장 최신 관측 가능 시각을 서버에서 받아 기준으로 삼는다(6시간 지연 규칙은 서버가 안다)
  let baseKst = "";
  try {
    const r0 = await fetch(`/api/gk2a?waveType=${waveType}&unitType=${unitType}`);
    const j0 = await r0.json();
    if (!j0?.ok) throw new Error(j0?.reason ?? "base frame 실패");
    baseKst = j0.dateTime;
    setGk2a({
      channel: j0.channel,
      dateTime: j0.dateTime,
      synthetic: !!j0.synthetic,
      bounds: j0.bounds,
      meta: j0.meta,
      grid: j0.grid,
    });
  } catch {
    setGk2a({ status: "error" });
    return;
  }

  // KST 문자열 → 분 단위 가감
  const shift = (kst: string, deltaMin: number): string => {
    const y = +kst.slice(0, 4), mo = +kst.slice(4, 6), d = +kst.slice(6, 8);
    const h = +kst.slice(8, 10), mi = +kst.slice(10, 12);
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi) + deltaMin * 60_000);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
  };

  const frames: { dateTime: string; grid: number[][] }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const dt = shift(baseKst, -i * stepMin);
    try {
      const r = await fetch(`/api/gk2a?waveType=${waveType}&unitType=${unitType}&dateTime=${dt}`);
      const j = await r.json();
      if (j?.ok && Array.isArray(j.grid)) frames.push({ dateTime: j.dateTime, grid: j.grid });
    } catch {
      // 이 프레임만 건너뛴다
    }
    setGk2a({ seriesProgress: (count - i) / count, series: [...frames] });
  }

  setGk2a({
    status: frames.length ? "ready" : "error",
    series: frames,
    frameIndex: Math.max(0, frames.length - 1),
    seriesProgress: 1,
    playing: frames.length > 1,
    ...(frames.length ? { grid: frames[frames.length - 1].grid, dateTime: frames[frames.length - 1].dateTime } : {}),
  });
}

/** 시계열 재생 — 프레임을 순환시킨다. */
export function useGk2aPlayback(fps = 4) {
  const playing = useStore((s) => s.gk2a.playing);
  const n = useStore((s) => s.gk2a.series.length);
  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => {
      const st = useStore.getState();
      const next = (st.gk2a.frameIndex + 1) % st.gk2a.series.length;
      const f = st.gk2a.series[next];
      st.setGk2a({ frameIndex: next, grid: f.grid, dateTime: f.dateTime });
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [playing, n, fps]);
}

/**
 * GK2A를 선택하면 격자를 자동으로 불러온다.
 * "위성을 클릭하면 그 위성이 보는 화면을 보여준다"는 흐름의 진입점.
 */
export const GK2A_NORAD = 43823;

export function useGk2aOnSelect() {
  const selected = useStore((s) => s.selectedNorad);
  useEffect(() => {
    const st = useStore.getState();
    if (selected !== GK2A_NORAD) {
      // 다른 위성으로 옮기면 위성 시점에서 빠져나온다
      if (st.povNorad != null) st.setPov(null);
      return;
    }
    // 선택 경로(클릭/에이전트/HUD)와 무관하게 동일하게 동작해야 한다.
    // 클릭 핸들러에만 두면 "천리안2A 추적해줘" 같은 명령에서 시점이 바뀌지 않는다.
    st.setPov(GK2A_NORAD);
    if (st.gk2a.status === "idle" || st.gk2a.status === "error") loadGk2a(st.gk2a.waveType, st.gk2a.unitType);
  }, [selected]);
}
