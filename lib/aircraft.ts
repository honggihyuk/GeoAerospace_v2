// 클라이언트 항공 유틸 (설계서 §4.2) — dead-reckoning 보간 + 아이콘.
export type Aircraft = {
  hex: string;
  callsign: string;
  lon: number;
  lat: number;
  alt: number; // ft
  gs: number; // knots
  track: number; // deg
  category: "commercial" | "private" | "jet" | "mil";
};

export type AircraftSnapshot = { data: Aircraft[]; source: string; fetchedAt: number };

export async function loadAircraft(): Promise<AircraftSnapshot> {
  try {
    const r = await fetch("/api/aircraft", { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    const j = (await r.json()) as { aircraft?: Aircraft[]; source?: string };
    return { data: j.aircraft ?? [], source: j.source ?? "unknown", fetchedAt: Date.now() };
  } catch {
    return { data: [], source: "error", fetchedAt: Date.now() };
  }
}

const R_EARTH = 6371; // km

/** 대권 전진: (lon,lat)에서 bearing 방향으로 distKm 이동한 지점. */
function destination(lon: number, lat: number, distKm: number, bearingDeg: number): [number, number] {
  const d = distKm / R_EARTH;
  const br = (bearingDeg * Math.PI) / 180;
  const la1 = (lat * Math.PI) / 180;
  const lo1 = (lon * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return [(((lo2 * 180) / Math.PI + 540) % 360) - 180, (la2 * 180) / Math.PI];
}

/** 마지막 수집 시각 이후 경과분만큼 heading·속도로 위치를 추정(추측 항법). */
export function deadReckon(snap: AircraftSnapshot, now = Date.now()) {
  const dtSec = Math.max(0, (now - snap.fetchedAt) / 1000);
  return snap.data.map((a) => {
    if (a.gs > 0 && dtSec > 0) {
      const distKm = (a.gs * 0.514444 * dtSec) / 1000; // kt→m/s→km
      const [lon, lat] = destination(a.lon, a.lat, distKm, a.track);
      return { ...a, lon, lat };
    }
    return a;
  });
}

/** 위쪽(북)을 향한 비행기 실루엣 아이콘 데이터 URL. IconLayer mask 틴트용. */
export function makePlaneIcon(size = 64): string {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const s = size;
  ctx.fillStyle = "#ffffff";
  ctx.translate(s / 2, s / 2);
  ctx.beginPath();
  // 위를 향한 항공기 실루엣
  ctx.moveTo(0, -s * 0.42); // nose
  ctx.lineTo(s * 0.09, s * 0.05);
  ctx.lineTo(s * 0.42, s * 0.22); // right wing
  ctx.lineTo(s * 0.42, s * 0.31);
  ctx.lineTo(s * 0.09, s * 0.22);
  ctx.lineTo(s * 0.09, s * 0.36);
  ctx.lineTo(s * 0.2, s * 0.44); // right tail
  ctx.lineTo(s * 0.2, s * 0.5);
  ctx.lineTo(0, s * 0.44);
  ctx.lineTo(-s * 0.2, s * 0.5);
  ctx.lineTo(-s * 0.2, s * 0.44);
  ctx.lineTo(-s * 0.09, s * 0.36);
  ctx.lineTo(-s * 0.09, s * 0.22);
  ctx.lineTo(-s * 0.42, s * 0.31);
  ctx.lineTo(-s * 0.42, s * 0.22);
  ctx.lineTo(-s * 0.09, s * 0.05);
  ctx.closePath();
  ctx.fill();
  return c.toDataURL();
}

export const AC_COLOR: Record<Aircraft["category"], [number, number, number]> = {
  commercial: [210, 230, 255],
  private: [140, 180, 232],
  jet: [92, 225, 255],
  mil: [255, 183, 77],
};
