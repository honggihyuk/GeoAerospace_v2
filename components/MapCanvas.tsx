"use client";

import { useEffect, useMemo, useRef } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { computeOrbit, currentPosition, type OrbitData } from "@/lib/orbit";
import { useStore } from "@/lib/store";
import { loadLiveTles } from "@/lib/tleClient";

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
      attribution: "© CARTO © OpenStreetMap · DEM: AWS Terrain Tiles",
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
  const select = useStore((s) => s.select);
  const sats = useStore((s) => s.sats);

  // 마운트 시 실시간 TLE 로드 (get_tle, 설계서 §7.5) — 실패 시 데모 폴백
  useEffect(() => {
    let alive = true;
    loadLiveTles().then(({ sats, source }) => {
      if (alive) useStore.getState().setSats(sats, source);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 궤도 계산 — 로드된 TLE가 바뀌면 재계산 (설계서 §7.4)
  const orbits = useMemo<OrbitData[]>(() => {
    const now = new Date();
    return sats.map((d) => computeOrbit(d, now)).filter((o): o is OrbitData => o !== null);
  }, [sats]);

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
        /* 지형 소스 미로드 시 무시 */
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // 레이어 빌드 + 현재 위성 위치 애니메이션 (1s tick)
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const groundData = orbits
      .filter((o) => useStore.getState().layers.groundTracks)
      .flatMap((o) => o.track.map((seg) => ({ path: seg, color: o.def.color })));

    function build() {
      const st = useStore.getState();
      const now = new Date();
      const sel = st.selectedNorad;

      const orbitData = orbits.map((o) => ({
        path: o.ring,
        color: o.def.color,
        norad: o.def.noradId,
        sel: o.def.noradId === sel,
      }));

      const sats = orbits
        .map((o) => {
          const p = currentPosition(o.satrec, now);
          if (!p) return null;
          return { pos: p, color: o.def.color, norad: o.def.noradId, name: o.def.name, sel: o.def.noradId === sel };
        })
        .filter(Boolean) as { pos: [number, number, number]; color: [number, number, number]; norad: number; name: string; sel: boolean }[];

      overlay!.setProps({
        layers: [
          // 지상궤적 (지표)
          st.layers.groundTracks &&
            new PathLayer({
              id: "ground-tracks",
              data: groundData,
              getPath: (d: { path: [number, number][] }) => d.path,
              getColor: (d: { color: [number, number, number] }) => [...d.color, 90] as [number, number, number, number],
              getWidth: 1.5,
              widthUnits: "pixels",
              widthMinPixels: 1,
              jointRounded: true,
              capRounded: true,
              parameters: { depthTest: false },
            }),
          // 궤도 링 글로우 (넓고 흐린 하단)
          st.layers.orbits &&
            new PathLayer({
              id: "orbit-glow",
              data: orbitData,
              getPath: (d: { path: number[][] }) => d.path,
              getColor: (d: { color: [number, number, number]; sel: boolean }) =>
                [...d.color, d.sel ? 70 : 40] as [number, number, number, number],
              getWidth: (d: { sel: boolean }) => (d.sel ? 7 : 5),
              widthUnits: "pixels",
              jointRounded: true,
              capRounded: true,
              parameters: { depthTest: false },
            }),
          // 궤도 링 코어
          st.layers.orbits &&
            new PathLayer({
              id: "orbit-core",
              data: orbitData,
              getPath: (d: { path: number[][] }) => d.path,
              getColor: (d: { color: [number, number, number]; sel: boolean }) =>
                [...d.color, d.sel ? 255 : 190] as [number, number, number, number],
              getWidth: (d: { sel: boolean }) => (d.sel ? 2 : 1.4),
              widthUnits: "pixels",
              widthMinPixels: 1,
              jointRounded: true,
              capRounded: true,
              parameters: { depthTest: false },
            }),
          // 위성 (현재 위치, 고도)
          st.layers.satellites &&
            new ScatterplotLayer({
              id: "satellites",
              data: sats,
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
              onClick: (info: { object?: { norad: number } }) => {
                if (info.object) select(info.object.norad);
              },
              parameters: { depthTest: false },
            }),
        ].filter(Boolean),
      });
    }

    build();
    const id = window.setInterval(build, 1000);
    // 상태 변경(레이어 토글·선택) 시 즉시 반영
    const unsub = useStore.subscribe(build);
    return () => {
      window.clearInterval(id);
      unsub();
    };
  }, [orbits, select]);

  return <div ref={ref} style={{ position: "absolute", inset: 0 }} />;
}
