"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer, IconLayer } from "@deck.gl/layers";
import { computeOrbit, currentPosition, type OrbitData } from "@/lib/orbit";
import { useStore } from "@/lib/store";
import { loadAircraft, deadReckon, makePlaneIcon, AC_COLOR, type AircraftSnapshot } from "@/lib/aircraft";
import { createOrbitalLayer, type SatView } from "@/lib/three/orbitalLayer";
import { mapBus } from "@/lib/mapBus";
import { simClock } from "@/lib/simClock";
import { useFiresLayer } from "@/lib/firesClient";
import { findGibsLayer, gibsTileUrl } from "@/lib/gibs";
import type { FirePoint } from "@/lib/store";

// --- 다크 글로브 스타일 (오픈·토큰프리: CARTO dark + AWS Terrarium DEM) ---
const STYLE: StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png",
      ],
      tileSize: 256,
      attribution: "© CARTO © OpenStreetMap · DEM: AWS Terrain Tiles · ADS-B: adsb.lol/airplanes.live",
    },
    terrain: {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      tileSize: 256,
      encoding: "terrarium",
      maxzoom: 13,
    },
  },
  layers: [
    { id: "space", type: "background", paint: { "background-color": "#05070f" } },
    { id: "carto", type: "raster", source: "carto", paint: { "raster-opacity": 0.92 } },
  ],
};

/**
 * FRP(화재복사파워, MW) → 색. 약한 화재는 노랑, 강할수록 적색.
 * 선형이 아니라 sqrt를 쓰는 이유: FRP 분포가 극단적으로 치우쳐 있어(대부분 <10 MW,
 * 소수가 500 MW+) 선형 매핑하면 거의 전부 같은 색이 된다.
 */
function frpColor(frp: number): [number, number, number, number] {
  const t = Math.min(1, Math.sqrt(Math.max(0, frp)) / 16); // 256 MW에서 포화
  return [255, Math.round(220 - 180 * t), Math.round(60 - 55 * t), 215];
}

export default function MapCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const acRef = useRef<AircraftSnapshot>({ data: [], source: "—", fetchedAt: Date.now() });
  const satViewRef = useRef<SatView[]>([]);
  const iconRef = useRef<{ url: string; width: number; height: number; anchorX: number; anchorY: number; mask: boolean } | null>(null);
  const select = useStore((s) => s.select);
  const sats = useStore((s) => s.sats);
  const [pickedFire, setPickedFire] = useState<FirePoint | null>(null);
  useFiresLayer(); // 레이어를 켤 때 1회 지연 로딩 (§4.8-A)

  // 실시간 TLE 로딩은 뷰와 무관해야 하므로 app/page.tsx의 useLiveTles()가 담당한다.
  // (여기 있던 시절엔 3D 전환 시 언마운트되며 setSats가 취소돼 영구 LOADING… 이었다.)

  // 항공 아이콘 생성 (1회, 클라이언트)
  useEffect(() => {
    const url = makePlaneIcon(64);
    if (url) iconRef.current = { url, width: 64, height: 64, anchorX: 32, anchorY: 32, mask: true };
  }, []);

  // 항공 ADS-B 폴링 (12s, 차등 폴링 §4.8-A) + single-flight는 서버측
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const snap = await loadAircraft();
      if (!alive) return;
      acRef.current = snap;
      useStore.getState().setAircraftMeta(snap.data.length, snap.source);
    };
    poll();
    const id = window.setInterval(poll, 12_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  // 궤도 계산 — TLE 변경 시 재계산 (§7.4)
  const orbits = useMemo<OrbitData[]>(() => {
    const now = new Date();
    return sats.map((d) => computeOrbit(d, now)).filter((o): o is OrbitData => o !== null);
  }, [sats]);

  // 지도 초기화
  useEffect(() => {
    if (!ref.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: STYLE,
      center: [118, 22],
      zoom: 1.55,
      pitch: 0,
      attributionControl: { compact: true },
      maxPitch: 85,
    });
    mapRef.current = map;
    mapBus.set(map); // 에이전트가 지도를 조작할 수 있도록 연결 (P4)

    const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
    overlayRef.current = overlay;
    map.addControl(overlay);
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    map.on("style.load", () => {
      map.setSky({
        "sky-color": "#0b1530",
        "sky-horizon-blend": 0.6,
        "horizon-color": "#1a3a5c",
        "horizon-fog-blend": 0.6,
        "fog-color": "#05070f",
        "fog-ground-blend": 0.4,
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 0.9, 4, 0.6, 8, 0],
      });
      try {
        map.setTerrain({ source: "terrain", exaggeration: 1.25 });
      } catch {
        /* noop */
      }
      // Three.js 3D 위성·센서 콘 custom layer (§4.6-A). globe 미지원 시 render()가 자체 skip.
      try {
        map.addLayer(createOrbitalLayer(() => (useStore.getState().layers.satellites ? satViewRef.current : [])));
      } catch {
        /* noop */
      }
    });

    return () => {
      mapBus.set(null);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // GIBS 맥락영상 오버레이 (제안서 §4.7) — store 변화에 맞춰 raster 소스를 붙였다 뗀다.
  const gibs = useStore((s) => s.gibs);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const SRC = "gibs-context";
    const LYR = "gibs-context-layer";

    const apply = () => {
      if (!map.isStyleLoaded()) return;
      // 기존 것 제거 (레이어 → 소스 순서를 지켜야 한다)
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      if (map.getSource(SRC)) map.removeSource(SRC);
      if (!gibs) return;

      const def = findGibsLayer(gibs.layerId);
      if (!def) return;

      map.addSource(SRC, {
        type: "raster",
        tiles: [gibsTileUrl(def, gibs.date)],
        tileSize: 256,
        // 실측: GoogleMapsCompatible_Level9는 z10에서 HTTP 400. maxzoom을 주면
        // MapLibre가 그 이상은 확대해 늘려 쓰고 요청을 보내지 않는다.
        maxzoom: def.maxZoom,
        attribution: "NASA GIBS / EOSDIS",
      });

      // 베이스맵 바로 위에 넣는다. 그냥 addLayer하면 맨 위로 가서
      // 산불 포인트·위성 마커를 덮어버린다.
      const layers = map.getStyle().layers ?? [];
      const cartoIdx = layers.findIndex((l) => l.id === "carto");
      const beforeId = cartoIdx >= 0 ? layers[cartoIdx + 1]?.id : undefined;
      map.addLayer(
        { id: LYR, type: "raster", source: SRC, paint: { "raster-opacity": gibs.opacity } },
        beforeId
      );
    };

    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);

    return () => {
      // once 핸들러도 반드시 떼야 한다. 안 그러면 gibs가 여러 번 바뀔 때
      // 대기 중인 핸들러들이 나중에 한꺼번에 발화해 낡은 레이어를 붙인다.
      map.off("style.load", apply);
      try {
        if (map.getLayer(LYR)) map.removeLayer(LYR);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch {
        /* 언마운트 중 스타일이 이미 사라진 경우 */
      }
    };
  }, [gibs]);

  // 렌더 루프: 위성 전파 + 항공 dead-reckoning (30fps 게이트)
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const build = () => {
      const st = useStore.getState();
      const now = simClock.nowDate(); // 위성 전파는 가상 시계 기준(배속/스크럽)
      const sel = st.selectedNorad;

      const orbitData = orbits.map((o) => ({ path: o.ring, color: o.def.color, sel: o.def.noradId === sel }));
      const groundData = orbits.flatMap((o) => o.track.map((seg) => ({ path: seg, color: o.def.color })));
      const satData = orbits
        .map((o) => {
          const p = currentPosition(o.satrec, now);
          return p ? { pos: p, color: o.def.color, norad: o.def.noradId, sel: o.def.noradId === sel } : null;
        })
        .filter(Boolean) as { pos: [number, number, number]; color: [number, number, number]; norad: number; sel: boolean }[];

      // Three.js 레이어용 위성 뷰 갱신 (§4.6-A)
      satViewRef.current = satData.map((s) => ({ lng: s.pos[0], lat: s.pos[1], alt: s.pos[2], color: s.color, sel: s.sel }));

      const acData = st.layers.aircraft && iconRef.current ? deadReckon(acRef.current, Date.now()) : [];

      overlay.setProps({
        layers: [
          st.layers.groundTracks &&
            new PathLayer({
              id: "ground-tracks",
              data: groundData,
              getPath: (d: { path: [number, number][] }) => d.path,
              getColor: (d: { color: [number, number, number] }) => [...d.color, 90] as [number, number, number, number],
              getWidth: 1.5,
              widthUnits: "pixels",
              widthMinPixels: 1,
              parameters: { depthTest: false },
            }),
          st.layers.orbits &&
            new PathLayer({
              id: "orbit-glow",
              data: orbitData,
              getPath: (d: { path: number[][] }) => d.path,
              getColor: (d: { color: [number, number, number]; sel: boolean }) => [...d.color, d.sel ? 70 : 40] as [number, number, number, number],
              getWidth: (d: { sel: boolean }) => (d.sel ? 7 : 5),
              widthUnits: "pixels",
              parameters: { depthTest: false },
            }),
          st.layers.orbits &&
            new PathLayer({
              id: "orbit-core",
              data: orbitData,
              getPath: (d: { path: number[][] }) => d.path,
              getColor: (d: { color: [number, number, number]; sel: boolean }) => [...d.color, d.sel ? 255 : 190] as [number, number, number, number],
              getWidth: (d: { sel: boolean }) => (d.sel ? 2 : 1.4),
              widthUnits: "pixels",
              widthMinPixels: 1,
              parameters: { depthTest: false },
            }),
          st.layers.aircraft &&
            iconRef.current &&
            new IconLayer({
              id: "aircraft",
              data: acData,
              getPosition: (d: { lon: number; lat: number; alt: number }) => [d.lon, d.lat, d.alt * 0.3048],
              getIcon: () => iconRef.current!,
              getSize: 15,
              sizeUnits: "pixels",
              getAngle: (d: { track: number }) => -d.track,
              getColor: (d: { category: keyof typeof AC_COLOR }) => [...AC_COLOR[d.category], 235] as [number, number, number, number],
              parameters: { depthTest: false },
            }),
          st.layers.fires &&
            new ScatterplotLayer({
              id: "fires",
              data: st.fires.points,
              getPosition: (d: { lon: number; lat: number }) => [d.lon, d.lat],
              // FRP(화재복사파워)로 색·크기를 매핑 — 약한 화재는 노랑, 강한 화재는 적색
              getFillColor: (d: { frp: number; kind: string }) =>
                d.kind === "volcano"
                  ? ([255, 90, 220, 230] as [number, number, number, number])
                  : (frpColor(d.frp) as [number, number, number, number]),
              getRadius: (d: { frp: number; kind: string }) =>
                d.kind === "volcano" ? 5 : 2.2 + Math.min(5, Math.sqrt(Math.max(0, d.frp)) * 0.45),
              radiusUnits: "pixels",
              radiusMinPixels: 2,
              stroked: false,
              pickable: true,
              onClick: (info: { object?: FirePoint }) => info.object && setPickedFire(info.object),
              parameters: { depthTest: false },
            }),
          st.layers.satellites &&
            new ScatterplotLayer({
              id: "satellites",
              data: satData,
              getPosition: (d: { pos: [number, number, number] }) => d.pos,
              getFillColor: (d: { color: [number, number, number] }) => [...d.color, 255] as [number, number, number, number],
              getRadius: (d: { sel: boolean }) => (d.sel ? 5 : 3.2),
              radiusUnits: "pixels",
              radiusMinPixels: 2.5,
              stroked: true,
              getLineColor: [255, 255, 255, 160],
              lineWidthUnits: "pixels",
              getLineWidth: 0.6,
              pickable: true,
              onClick: (info: { object?: { norad: number } }) => info.object && select(info.object.norad),
              parameters: { depthTest: false },
            }),
        ].filter(Boolean),
      });
    };

    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= 33) {
        build();
        last = t;
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    const unsub = useStore.subscribe(build);
    return () => {
      window.cancelAnimationFrame(raf);
      unsub();
    };
  }, [orbits, select]);

  return (
    <>
      <div ref={ref} style={{ position: "absolute", inset: 0 }} />
      {pickedFire && (
        <div className="glass" style={FIRE_POPUP}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <b style={{ fontSize: 12.5, color: pickedFire.kind === "volcano" ? "#ff5adc" : "var(--amber)" }}>
              {pickedFire.kind === "volcano" ? (pickedFire.title ?? "화산") : "활성 화재"}
            </b>
            <span onClick={() => setPickedFire(null)} style={{ cursor: "pointer", color: "var(--faint)", fontSize: 12 }}>
              ✕
            </span>
          </div>
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 5, lineHeight: 1.6 }}>
            {pickedFire.lat.toFixed(4)}, {pickedFire.lon.toFixed(4)}
            {pickedFire.kind === "fire" && (
              <>
                <br />
                FRP <b style={{ color: "var(--txt)" }}>{pickedFire.frp.toFixed(1)} MW</b> · 신뢰도 {pickedFire.confidence}
              </>
            )}
            <br />
            <span style={{ color: "var(--faint)" }}>
              {pickedFire.acqDate} {pickedFire.acqTime ? `${pickedFire.acqTime.padStart(4, "0").slice(0, 2)}:${pickedFire.acqTime.padStart(4, "0").slice(2)} UTC` : ""}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

const FIRE_POPUP: React.CSSProperties = {
  position: "absolute",
  right: 16,
  bottom: 20,
  zIndex: 25,
  width: 210,
  padding: "11px 13px",
};
