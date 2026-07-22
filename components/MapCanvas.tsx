"use client";

import { useEffect, useRef, useState } from "react";
import maplibregl, { type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer, IconLayer } from "@deck.gl/layers";
import { computeOrbit, currentPosition, type OrbitData } from "@/lib/orbit";
import { useStore } from "@/lib/store";
import { loadAircraft, deadReckon, makePlaneIcon, AC_COLOR, type AircraftSnapshot } from "@/lib/aircraft";
import { createOrbitalLayer, type SatView, type OrbitRing, type SatHit } from "@/lib/three/orbitalLayer";
import { KOREA_BBOX, KOREA_CENTER, GRID_NX, GRID_NY, cellLngLat, elevationColor, type KoreaGrid } from "@/lib/koreaCube";
import { mapBus } from "@/lib/mapBus";
import { simClock } from "@/lib/simClock";
import { useFiresLayer } from "@/lib/firesClient";
import { findGibsLayer, gibsTileUrl } from "@/lib/gibs";
import type { FirePoint } from "@/lib/store";

// --- 글로브 스타일 (오픈·토큰프리: EOX Sentinel-2 Cloudless + AWS Terrarium DEM) ---
// 베이스맵 = EOX s2cloudless: 1년치 Sentinel-2 관측을 합성해 **구름을 제거한** 10 m급 트루컬러.
// BlueMarble(≈500 m)보다 훨씬 정밀해 도시·해안·지형 질감이 또렷하다. 정적 합성이라 궤도 스와스·
// 구름 이음매가 없다. DEM(terrain)에 드레이프되어 3D 기복도 함께 드러난다.
// ⚠️ EOX 타일은 비상업·저부하 용도 무료 — 대량 트래픽은 https://maps.eox.at 유료 플랜 필요.
const GIBS_WMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const STYLE: StyleSpecification = {
  version: 8,
  projection: { type: "globe" },
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    basemap: {
      type: "raster",
      // EOX Maps WMTS(EPSG:3857, TileMatrixSet 'g'). s2cloudless-2023 = 최신 무구름 합성.
      // {z}/{y}/{x} = TileMatrix/TileRow/TileCol. 약 zoom 14(≈10 m)까지 유효.
      tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"],
      tileSize: 256,
      maxzoom: 14,
      attribution:
        'Sentinel-2 cloudless 2023 (<a href="https://s2maps.eu">s2maps.eu</a>) by EOX — modified Copernicus data · DEM: AWS Terrain Tiles · ADS-B: adsb.lol/airplanes.live',
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
    { id: "basemap", type: "raster", source: "basemap" },
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
  const orbitViewRef = useRef<OrbitRing[]>([]);
  const orbitsRef = useRef<OrbitData[]>([]); // 시뮬 시각 기준으로 주기 재계산되는 궤도(링/지상궤적/satrec)
  const koreaGridRef = useRef<KoreaGrid | null>(null); // 큐브샛 더블클릭 관측 → 한반도 큐브 그리드
  const satHitsRef = useRef<SatHit[]>([]); // orbitalLayer가 매 프레임 채우는 위성 화면좌표(클릭 피킹용)
  const iconRef = useRef<{ url: string; width: number; height: number; anchorX: number; anchorY: number; mask: boolean } | null>(null);
  const select = useStore((s) => s.select);
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

  // 궤도(링/지상궤적)는 아래 렌더 루프에서 **시뮬 시각 기준**으로 주기 재계산한다(§7.4).
  // ECEF 링은 지구자전으로 세차하므로 실시간(new Date())에 한 번 얼려두면 마커와 어긋난다 —
  // 배속/스크럽/일시정지에서도 정합하려면 simClock 기준 재계산이 필수다.

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
      // Three.js 3D 위성·센서 콘 + 실축척 궤도링(ECEF) custom layer (§4.6-A).
      // globe 미지원 시 render()가 자체 skip. 궤도링은 deck.gl 에서 이관 — 깊이 구로 뒤편이 가려진다.
      try {
        map.addLayer(
          createOrbitalLayer(
            () => (useStore.getState().layers.satellites ? satViewRef.current : []),
            () => (useStore.getState().layers.orbits ? orbitViewRef.current : []),
            () => koreaGridRef.current,
            satHitsRef.current
          )
        );
      } catch {
        /* noop */
      }
    });

    // ── 큐브샛 더블클릭 → 한반도 "큐브 관측" ──────────────────────────────────
    // 높이: Copernicus DEM(Sentinel Hub) raster → 캐시(폴백 Terrarium). 표면 색: 우상단 토글.
    //   ortho=VWorld 정사영상, dem=고도색, sar=Sentinel-1 후방산란.
    const N = GRID_NX * GRID_NY;
    let heightsCache: Float32Array | null = null;

    const bmpToData = async (blob: Blob): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> => {
      const bmp = await createImageBitmap(blob);
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d");
      if (!ctx) {
        bmp.close();
        return null;
      }
      ctx.drawImage(bmp, 0, 0);
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const out = { data, w: bmp.width, h: bmp.height };
      bmp.close();
      return out;
    };

    // 셀(x,y) → 이미지 픽셀 RGBA 오프셋. 이미지 y는 위가 북.
    const sampleIdx = (x: number, y: number, iw: number, ih: number) => {
      const px = Math.min(iw - 1, Math.floor(((x + 0.5) / GRID_NX) * iw));
      const py = Math.min(ih - 1, Math.floor((1 - (y + 0.5) / GRID_NY) * ih));
      return (py * iw + px) * 4;
    };

    // 높이 관측: Terrarium 30m DEM(queryTerrainElevation) 셀별 샘플.
    // (Copernicus DEM GLO-30/90 은 남한이 정부 제한으로 CDSE 미제공 nodata — 확인됨. Terrarium 사용.)
    const observeKorea = () => {
      const heights = new Float32Array(N);
      for (let y = 0; y < GRID_NY; y++)
        for (let x = 0; x < GRID_NX; x++) {
          const [lng, lat] = cellLngLat(x, y);
          heights[y * GRID_NX + x] = (map.queryTerrainElevation([lng, lat]) ?? 0) / 1.25; // 과장(1.25) 되돌림
        }
      heightsCache = heights;
    };

    // 표면 색 적용: 즉시 고도색 → 선택 소스(ortho/sar) 도착 시 교체.
    const applySurface = async () => {
      const heights = heightsCache;
      if (!heights) return;
      const elev = new Uint8Array(N * 3);
      for (let i = 0; i < N; i++) {
        const [r, g, b] = elevationColor(heights[i]);
        elev[i * 3] = r;
        elev[i * 3 + 1] = g;
        elev[i * 3 + 2] = b;
      }
      koreaGridRef.current = { bbox: { ...KOREA_BBOX }, nx: GRID_NX, ny: GRID_NY, heights, colors: elev };
      map.triggerRepaint();

      const surface = useStore.getState().cube.surface;
      if (surface === "dem") return; // 고도색이 곧 DEM 표현
      const { west, south, east, north } = KOREA_BBOX;
      const url =
        surface === "ortho"
          ? `/api/vworld?bbox=${west},${south},${east},${north}&w=512`
          : `/api/sar?bbox=${west},${south},${east},${north}&w=512`;
      try {
        const res = await fetch(url);
        if (!res.ok) return; // 미설정/실패 → 고도색 유지
        const img = await bmpToData(await res.blob());
        if (!img) return;
        const st = useStore.getState();
        if (!st.cube.active || st.cube.surface !== surface) return; // 레이스: 그새 바뀜
        const colors = new Uint8Array(N * 3);
        for (let y = 0; y < GRID_NY; y++)
          for (let x = 0; x < GRID_NX; x++) {
            const o = sampleIdx(x, y, img.w, img.h);
            const i = y * GRID_NX + x;
            if (surface === "ortho") {
              colors[i * 3] = img.data[o]; // 정사영상 실제 RGB
              colors[i * 3 + 1] = img.data[o + 1];
              colors[i * 3 + 2] = img.data[o + 2];
            } else {
              const g = img.data[o]; // SAR 후방산란 → 따뜻한 회색조
              colors[i * 3] = g;
              colors[i * 3 + 1] = Math.round(g * 0.92);
              colors[i * 3 + 2] = Math.round(g * 0.78);
            }
          }
        koreaGridRef.current = { bbox: { ...KOREA_BBOX }, nx: GRID_NX, ny: GRID_NY, heights, colors };
        map.triggerRepaint();
      } catch {
        /* 실패 → 고도색 유지 */
      }
    };

    map.on("dblclick", (e) => {
      const p = map.project(KOREA_CENTER as [number, number]);
      if (Math.hypot(e.point.x - p.x, e.point.y - p.y) > 70) return; // 큐브샛 근처만
      e.preventDefault(); // 더블클릭 기본 줌 방지
      const st = useStore.getState();
      const next = !st.cube.active;
      st.setCubeActive(next);
      if (next) {
        map.flyTo({ center: KOREA_CENTER as [number, number], zoom: 4.6, pitch: 45, speed: 1.1, essential: true });
        map.once("idle", () => {
          observeKorea();
          void applySurface();
        });
      } else {
        heightsCache = null;
        koreaGridRef.current = null;
        map.triggerRepaint();
      }
    });

    // 위성 클릭 선택 — Three 레이어가 채운 정확 화면좌표(satHitsRef)로 최근접 피킹(pitch 무관).
    map.on("click", (e) => {
      let best: number | null = null;
      let bd = 16; // px 임계
      for (const h of satHitsRef.current) {
        const d = Math.hypot(e.point.x - h.x, e.point.y - h.y);
        if (d < bd) {
          bd = d;
          best = h.norad;
        }
      }
      if (best != null) select(best);
    });

    // 우상단 표면 토글 변경 → 높이 재사용하며 재색칠(관측 활성 중)
    const unsubCube = useStore.subscribe((s, prev) => {
      if (s.cube.surface !== prev.cube.surface && s.cube.active) void applySurface();
    });

    return () => {
      unsubCube();
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
      const baseIdx = layers.findIndex((l) => l.id === "basemap");
      const beforeId = baseIdx >= 0 ? layers[baseIdx + 1]?.id : undefined;
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

    // ECEF 궤도링/지상궤적은 지구자전으로 세차 → 시뮬 시각이 임계만큼 흐르면 다시 계산한다.
    // 임계는 시뮬 시간 기준이라 배속일수록 실시간상 더 자주 갱신되어 마커와 계속 정합한다.
    const RING_REFRESH_SIM_MS = 3000;
    let ringSats: unknown = null; // TLE(sats) 교체 감지
    let lastRingSimMs = Number.NEGATIVE_INFINITY;
    let lastSel: number | null = null;

    const build = () => {
      const st = useStore.getState();
      const now = simClock.nowDate(); // 위성 전파는 가상 시계 기준(배속/스크럽)
      const nowMs = now.getTime();
      const sel = st.selectedNorad;

      // 링/지상궤적 재계산(비싼 SGP4 180스텝×위성수)은 임계 초과 또는 TLE 교체 시에만.
      const recomputed = st.sats !== ringSats || Math.abs(nowMs - lastRingSimMs) > RING_REFRESH_SIM_MS;
      if (recomputed) {
        ringSats = st.sats;
        lastRingSimMs = nowMs;
        orbitsRef.current = st.sats.map((d) => computeOrbit(d, now)).filter((o): o is OrbitData => o !== null);
      }
      const orbits = orbitsRef.current;

      // Three 링 뷰 배열은 재계산 또는 선택 변경 때만 새로 만든다 — 매 프레임 새 배열이면
      // custom layer 가 참조 변화로 오판해 매 프레임 getMatrixForModel 재구성을 돈다(비쌈).
      if (recomputed || sel !== lastSel) {
        lastSel = sel;
        orbitViewRef.current = orbits.map((o) => ({ points: o.ring, color: o.def.color, sel: o.def.noradId === sel }));
      }

      const satData = orbits
        .map((o) => {
          const p = currentPosition(o.satrec, now);
          return p ? { pos: p, color: o.def.color, norad: o.def.noradId, sel: o.def.noradId === sel } : null;
        })
        .filter(Boolean) as { pos: [number, number, number]; color: [number, number, number]; norad: number; sel: boolean }[];

      // Three.js 레이어용 위성 뷰 갱신 (§4.6-A)
      satViewRef.current = satData.map((s) => ({ norad: s.norad, lng: s.pos[0], lat: s.pos[1], alt: s.pos[2], color: s.color, sel: s.sel }));

      const acData = st.layers.aircraft && iconRef.current ? deadReckon(acRef.current, Date.now()) : [];

      overlay.setProps({
        layers: [
          // 지상궤적 레이어 제거됨(요청). 궤도링·위성은 Three.js custom layer(orbital-3d) 담당.
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
          // 위성 마커는 Three custom layer(orbital-3d)로 이관 — deck.gl은 globe+pitch에서 고도 투영이
          // 어긋나 모델과 벌어졌다. 클릭 피킹도 그 정확 화면좌표(satHitsRef)로 아래 map.on('click')에서.
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
  }, [select]);

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
