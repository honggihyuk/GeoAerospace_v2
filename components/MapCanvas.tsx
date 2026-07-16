"use client";

import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer, IconLayer } from "@deck.gl/layers";
import { computeOrbit, currentPosition, type OrbitData } from "@/lib/orbit";
import { useStore } from "@/lib/store";
import { loadLiveTles } from "@/lib/tleClient";
import { loadAircraft, deadReckon, makePlaneIcon, AC_COLOR, type AircraftSnapshot } from "@/lib/aircraft";
import { createOrbitalLayer, type SatView } from "@/lib/three/orbitalLayer";
import { mapBus } from "@/lib/mapBus";
import { simClock } from "@/lib/simClock";

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

export default function MapCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const acRef = useRef<AircraftSnapshot>({ data: [], source: "—", fetchedAt: Date.now() });
  const satViewRef = useRef<SatView[]>([]);
  const iconRef = useRef<{ url: string; width: number; height: number; anchorX: number; anchorY: number; mask: boolean } | null>(null);
  const select = useStore((s) => s.select);
  const sats = useStore((s) => s.sats);

  // 실시간 TLE (get_tle, §7.5)
  useEffect(() => {
    let alive = true;
    loadLiveTles().then(({ sats, source }) => alive && useStore.getState().setSats(sats, source));
    return () => {
      alive = false;
    };
  }, []);

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

  return <div ref={ref} style={{ position: "absolute", inset: 0 }} />;
}
