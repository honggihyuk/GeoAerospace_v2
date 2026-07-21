"use client";

// P2.7 실축척 3D 궤도 뷰 (설계서 §4.6-B) — 관성계(ECI)에 실축척 궤도 타원.
// satellite.js ECI 좌표를 그대로 써서 지구를 자전(GMST)시키고 궤도는 고정 → 진짜 관성계 뷰.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as satellite from "satellite.js";
import { useStore } from "@/lib/store";
import { computeOrbit, sunEci, isEclipsed } from "@/lib/orbit";
import { simClock } from "@/lib/simClock";
import { footprintCentralAngleDeg, R_EARTH_KM, visibleStations, type Station } from "@/lib/passes";
import { preciseStateTeme } from "@/lib/precise";
import { GK2A_NORAD, gridToTexture } from "@/lib/gk2aClient";
import {
  applyNadirAttitude,
  buildSatelliteModel,
  markerSizing,
  modelKindFor,
  radiansPerPixel,
  trackSun,
  type SatModel,
} from "@/lib/three/satelliteModel";

const KM = 1 / 1000; // km → scene unit (1 unit = 1000 km)
const R_EARTH = 6371 * KM;

// 위성 본체 과장 배율. 실축척(ISS 109 m = 0.000109 unit)이면 서브픽셀이라 보이지 않는다.
// 궤도는 실축척이지만 본체는 과장한다 — 기존 구 마커(반지름 0.12 = 120 km)와 같은 취지.
const MODEL_SCALE = 0.26;

// ECI(Z-up, km) → Three.js(Y-up, unit)
function eciToScene(p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x * KM, p.z * KM, -p.y * KM);
}

export default function SpaceView() {
  const ref = useRef<HTMLDivElement>(null);
  const sats = useStore((s) => s.sats);
  const select = useStore((s) => s.select);
  const satsRef = useRef(sats);
  satsRef.current = sats;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const W = el.clientWidth;
    const H = el.clientHeight;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 4000);
    camera.position.set(6, 5, 20);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = R_EARTH * 1.3;
    controls.maxDistance = 120;
    controls.rotateSpeed = 0.5;

    // 태양 방향(월드). 지구/대기 셰이더와 위성 조명이 공유하며 매 프레임 갱신된다.
    const uSun = { value: new THREE.Vector3(1, 0, 0) };

    // 위성 모델(MeshStandardMaterial)용 조명. 지구는 자체 셰이더로 음영을 계산하므로
    // 이 조명은 위성에만 유효하다 — 태양 방향을 따라가서 실제 일조/음영이 드러난다.
    const sunLight = new THREE.DirectionalLight(0xfff4e2, 3.0);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x2a3d5a, 0.55)); // 지구 반사광 근사
    // 텍스처 도착 전 placeholder (샘플러 uniform은 null일 수 없음)
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;

    // 지구 (자전 그룹)
    const earth = new THREE.Group();
    scene.add(earth);

    // 주간 트루컬러 + 야간 도시광을 태양각으로 블렌딩하는 셰이더 (고도화 B1).
    // 텍스처가 없으면 uHas*=0 → 기존 양식화 지구로 자연 폴백.
    const globeUniforms = {
      uDay: { value: blank as THREE.Texture },
      uPrev: { value: blank as THREE.Texture },
      uNight: { value: blank as THREE.Texture },
      uBaseMap: { value: blank as THREE.Texture },
      uHasDay: { value: 0 },
      uHasPrev: { value: 0 },
      uHasNight: { value: 0 },
      uHasBase: { value: 0 },
      // GK2A 격자 오버레이 (제안서_GK2A) — 한반도 영역에만 얹는 지역 텍스처
      uOverlay: { value: blank as THREE.Texture },
      uHasOverlay: { value: 0 },
      /** west, south, east, north (deg) */
      uOverlayBounds: { value: new THREE.Vector4(124, 32, 132, 39) },
      uOverlayOpacity: { value: 0.95 },
      /** 관측 영역 안에서 기반 실사 텍스처를 누르는 정도 (0=그대로, 1=완전히 가림) */
      uOverlayDim: { value: 0.5 },
      uSun,
      uBase: { value: new THREE.Color(0x123049) },
    };
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH, 128, 96),
      new THREE.ShaderMaterial({
        uniforms: globeUniforms,
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vNw;
          void main(){
            vUv = uv;
            vNw = normalize(mat3(modelMatrix) * normal); // 자전 반영된 월드 법선
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: `
          uniform sampler2D uDay, uPrev, uNight, uBaseMap, uOverlay;
          uniform float uHasDay, uHasPrev, uHasNight, uHasBase, uHasOverlay, uOverlayOpacity, uOverlayDim;
          uniform vec4 uOverlayBounds;
          uniform vec3 uSun, uBase;
          varying vec2 vUv;
          varying vec3 vNw;
          void main(){
            vec3 N = normalize(vNw);
            float mu = dot(N, uSun);                       // 태양 고도 cos

            // 당일 트루컬러는 궤도 스와스가 빠진 경도대가 검게 비어 있다.
            // 그 화소는 "데이터 없음"으로 보고 갭 없는 베이스로 메운다.
            // (메우지 않으면 알베도 0에 박명 띠만 더해져 순수 주황 얼룩이 생긴다.)
            //
            // 임계값 주의: 샘플값은 sRGB가 하드웨어 디코딩된 *선형* 값이다.
            // 실측(2026-07-19) — 결손대 = 정확히 0.0, 실제 어두운 바다 = 중앙값 0.095.
            // 표시공간 감각으로 잡으면(예: 0.012) 바다를 덮어쓴다. 0에 바짝 붙인다.
            vec3 tc = texture2D(uDay, vUv).rgb;
            vec3 pv = texture2D(uPrev, vUv).rgb;
            vec3 bm = mix(uBase, texture2D(uBaseMap, vUv).rgb, uHasBase);
            float hasTc = smoothstep(0.0005, 0.003, max(tc.r, max(tc.g, tc.b))) * uHasDay;
            float hasPv = smoothstep(0.0005, 0.003, max(pv.r, max(pv.g, pv.b))) * uHasPrev;
            // 당일 → 전날 → 정적 베이스 3단 폴백
            vec3 dayAlbedo = mix(mix(bm, pv, hasPv), tc, hasTc);
            vec3 cityLight = texture2D(uNight, vUv).rgb * uHasNight;

            // 낮면: 램버트 + 약한 앰비언트
            vec3 lit = dayAlbedo * (0.10 + 1.05 * max(mu, 0.0));
            // 박명(황혼) 띠 — 터미네이터를 따라 따뜻하게.
            // pow(음수, 2.0)은 GLSL에서 미정의 → 반드시 곱으로 제곱한다.
            float tws = mu * 5.5;
            float tw = exp(-tws * tws);
            lit += vec3(1.0, 0.42, 0.14) * tw * 0.22;

            // 밤면: 도시광 + 아주 옅은 심야 베이스
            vec3 night = cityLight * 2.4 + uBase * 0.09;

            // 부드러운 터미네이터 (지구 박명대 폭에 대응)
            float day = smoothstep(-0.12, 0.18, mu);
            vec3 base = mix(night, lit, day);

            // ── GK2A 격자 오버레이 ─────────────────────────────────────────
            // vUv는 등장방형이므로 경위도를 직접 역산할 수 있다:
            //   lon = vUv.x*360-180,  lat = vUv.y*180-90
            // 위성 격자는 LCC라 CPU에서 이미 이 경위도 격자로 재투영해 넘겨받는다.
            if (uHasOverlay > 0.5) {
              float lon = vUv.x * 360.0 - 180.0;
              float lat = vUv.y * 180.0 - 90.0;
              vec2 ouv = vec2(
                (lon - uOverlayBounds.x) / (uOverlayBounds.z - uOverlayBounds.x),
                (lat - uOverlayBounds.y) / (uOverlayBounds.w - uOverlayBounds.y)
              );
              if (ouv.x >= 0.0 && ouv.x <= 1.0 && ouv.y >= 0.0 && ouv.y <= 1.0) {
                vec4 ov = texture2D(uOverlay, ouv);
                // 관측 자료는 밤에도 유효하다 — 낮면 밝기에 종속시키지 않는다.
                //
                // 관측 영역 안에서는 기반 실사 텍스처를 눌러준다. 안 그러면 기반에도
                // 흰 구름이 있어 관측값이 묻힌다(실측: 오버레이를 켜도 육안 구분이 안 됨).
                // 가장자리는 부드럽게 풀어 사각형 경계가 드러나지 않게 한다.
                float edge = min(min(ouv.x, 1.0 - ouv.x), min(ouv.y, 1.0 - ouv.y));
                float feather = smoothstep(0.0, 0.06, edge); // 경계를 넉넉히 풀어 사각형 티를 없앤다
                float k = uOverlayOpacity * feather;
                base = base * (1.0 - uOverlayDim * k) ;
                base = mix(base, ov.rgb, ov.a * k);
              }
            }

            gl_FragColor = vec4(base, 1.0);
            #include <colorspace_fragment>
          }`,
      })
    );
    earth.add(globe);
    // 위경도 그리드 (실사 텍스처 위에서는 옅게)
    const grid = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.001, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x5ce1ff, wireframe: true, transparent: true, opacity: 0.07 })
    );
    earth.add(grid);

    // 대기 산란 근사 (Rayleigh 청색 + Mie 골든아워) — 태양 방향 인식.
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.035, 64, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uRayleigh: { value: new THREE.Color(0x4aa6ff) },
          uMie: { value: new THREE.Color(0xff7a33) },
          uSun,
        },
        vertexShader: `
          varying vec3 vNv; varying vec3 vPv; varying vec3 vNw;
          void main(){
            vNv = normalize(normalMatrix * normal);
            vNw = normalize(mat3(modelMatrix) * normal);
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vPv = mv.xyz;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform vec3 uRayleigh, uMie, uSun;
          varying vec3 vNv; varying vec3 vPv; varying vec3 vNw;
          void main(){
            float rim = 1.0 - max(dot(normalize(vNv), normalize(-vPv)), 0.0);
            rim = pow(rim, 2.6);                                 // rim >= 0 이므로 pow 안전
            float mu = dot(normalize(vNw), uSun);
            float sunlit = smoothstep(-0.35, 0.15, mu);          // 낮면 림만 밝게
            // 터미네이터 골든아워 링 — 실제 림에서 좁은 띠이므로 폭을 조이고 약하게.
            // (pow(음수, 2.0)은 GLSL 미정의 → 곱으로 제곱)
            float ts = (mu + 0.02) * 7.0;
            float twi = exp(-ts * ts);
            vec3 col = uRayleigh * sunlit + uMie * twi * 0.5;
            gl_FragColor = vec4(col * rim, rim * (sunlit * 0.85 + twi * 0.4));
          }`,
      })
    );
    scene.add(atmo);

    // 별필드
    const starGeo = new THREE.BufferGeometry();
    const starN = 2200;
    const sp = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 300 + Math.random() * 400;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      sp[i * 3] = r * Math.sin(ph) * Math.cos(th);
      sp[i * 3 + 1] = r * Math.cos(ph);
      sp[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfe3ff, size: 0.6, sizeAttenuation: false })));

    // ── GIBS 실사 텍스처 (고도화 B1) ────────────────────────────────────────
    // 저해상도를 먼저 입혀 즉시 실사감을 주고, 고해상도가 오면 교체한다.
    // 실패해도 uHasDay/uHasNight=0 인 채로 양식화 지구가 계속 돈다.
    let disposed = false;
    const loadedTex: THREE.Texture[] = [];
    const setImagery = useStore.getState().setImagery;

    async function loadImagery(layer: "day" | "dayprev" | "night" | "base", width: number) {
      const res = await fetch(`/api/earth-texture?layer=${layer}&w=${width}`);
      if (!res.ok) throw new Error(`earth-texture ${res.status}`);
      const date = res.headers.get("x-imagery-date") ?? "";
      const blob = await res.blob();
      if (disposed) return;
      // blob → object URL → TextureLoader(HTMLImageElement 경로: flipY 기본값이 맞음).
      // fetch를 거치는 이유는 x-imagery-date 헤더(실제 영상 날짜)를 함께 읽기 위함.
      const objUrl = URL.createObjectURL(blob);
      let tex: THREE.Texture;
      try {
        tex = await new THREE.TextureLoader().loadAsync(objUrl);
      } finally {
        URL.revokeObjectURL(objUrl);
      }
      if (disposed) {
        tex.dispose();
        return;
      }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = THREE.RepeatWrapping; // 경도 ±180° 이음매
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();

      const slot =
        layer === "day"
          ? globeUniforms.uDay
          : layer === "dayprev"
            ? globeUniforms.uPrev
            : layer === "night"
              ? globeUniforms.uNight
              : globeUniforms.uBaseMap;
      const prev = slot.value;
      slot.value = tex;
      loadedTex.push(tex);
      if (prev !== blank) {
        prev.dispose();
        const i = loadedTex.indexOf(prev);
        if (i >= 0) loadedTex.splice(i, 1);
      }
      if (layer === "day") {
        globeUniforms.uHasDay.value = 1;
        setImagery({ status: "live", date });
      } else if (layer === "dayprev") {
        globeUniforms.uHasPrev.value = 1;
      } else if (layer === "night") {
        globeUniforms.uHasNight.value = 1;
      } else {
        globeUniforms.uHasBase.value = 1;
      }
    }

    (async () => {
      try {
        await loadImagery("base", 2048); // 갭 없는 베이스 먼저 → 구멍 뚫린 지구를 보이지 않게
        if (disposed) return;
        await loadImagery("day", 1024); // 빠른 1차 (~130KB)
        if (disposed) return;
        await loadImagery("night", 2048);
        if (disposed) return;
        await loadImagery("dayprev", 2048); // 결손 경도대를 전날 영상으로 메움
        if (disposed) return;
        await loadImagery("day", 4096); // 고해상도 교체 (~1.8MB)
      } catch (e) {
        if (!disposed && globeUniforms.uHasDay.value === 0) {
          console.warn("[SpaceView] GIBS 텍스처 실패, 양식화 지구로 폴백:", e);
          setImagery({ status: "off", date: null });
        }
      }
    })();

    // ── 커버리지 풋프린트 + 가시 지상국 (고도화 B4) ───────────────────────────
    // 둘 다 지구 자전 그룹(earth)에 넣는다 → 지표 고정 좌표(ECEF)로 다루면 되고,
    // GMST 회전은 부모가 알아서 적용한다.
    const b4 = new THREE.Group();
    earth.add(b4);

    // 풋프린트 링: 서브위성점을 중심으로 지심각 λ 만큼 떨어진 지표 원.
    const FP_SEGMENTS = 128;
    const fpGeo = new THREE.BufferGeometry();
    fpGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((FP_SEGMENTS + 1) * 3), 3));
    const footprint = new THREE.Line(
      fpGeo,
      new THREE.LineBasicMaterial({ color: 0x5ce1ff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending })
    );
    footprint.visible = false;
    b4.add(footprint);

    // 지상국 마커: 전체(옅게) + 가시(강조) 두 세트를 Points로.
    const stationGeo = new THREE.BufferGeometry();
    const stationPts = new THREE.Points(
      stationGeo,
      new THREE.PointsMaterial({ color: 0x8fb4e8, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0.42 })
    );
    b4.add(stationPts);
    const visGeo = new THREE.BufferGeometry();
    const visPts = new THREE.Points(
      visGeo,
      new THREE.PointsMaterial({ color: 0x4dffa8, size: 6, sizeAttenuation: false, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending })
    );
    b4.add(visPts);

    /** 측지 좌표 → 지구 고정 씬 좌표 (earth 그룹 로컬). */
    const geoToLocal = (latDeg: number, lonDeg: number, altKm = 0): THREE.Vector3 => {
      const la = (latDeg * Math.PI) / 180;
      const lo = (lonDeg * Math.PI) / 180;
      const r = (R_EARTH_KM + altKm) * KM;
      // SpaceView 규약: local = (r cosφ cosλ, r sinφ, -r cosφ sinλ)
      return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
    };

    // 전체 지상국 위치는 목록이 바뀔 때만 다시 만든다.
    let stationsRef: Station[] = [];
    const rebuildStations = (list: Station[]) => {
      stationsRef = list;
      const arr = new Float32Array(list.length * 3);
      list.forEach((s, i) => {
        const v = geoToLocal(s.lat, s.lon, s.altKm);
        arr[i * 3] = v.x;
        arr[i * 3 + 1] = v.y;
        arr[i * 3 + 2] = v.z;
      });
      stationGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      stationGeo.computeBoundingSphere();
      visGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(list.length * 3), 3));
      visGeo.setDrawRange(0, 0);
    };
    rebuildStations(useStore.getState().stations);

    // ── GK2A 격자 오버레이 텍스처 (제안서_GK2A) ───────────────────────────
    //
    // 재투영은 1024×N 픽셀마다 LCC 정투영을 도는 비싼 연산이다(프레임당 수백 ms).
    // 시계열 재생(4fps)에서 매번 다시 만들면 따라가지 못하므로 **dateTime별로 캐시**하고
    // 재생 중에는 텍스처 교체만 한다.
    const overlayCache = new Map<string, { tex: THREE.Texture; bounds: [number, number, number, number] }>();
    const OVERLAY_CACHE_MAX = 40; // 시계열 프레임 수 상한보다 여유 있게
    let overlayKey = "";

    const syncGk2aOverlay = () => {
      const g = useStore.getState().gk2a;
      const key = g.grid ? `${g.waveType}:${g.unitType}:${g.dateTime}:${g.emphasis.toFixed(2)}` : "";
      if (key === overlayKey) return;
      overlayKey = key;

      if (!g.grid || !g.meta || !g.bounds) {
        globeUniforms.uHasOverlay.value = 0;
        globeUniforms.uOverlay.value = blank;
        return;
      }

      let hit = overlayCache.get(key);
      if (!hit) {
        const out = gridToTexture(g.grid, g.meta, g.bounds, g.waveType, g.unitType);
        if (!out) {
          globeUniforms.uHasOverlay.value = 0;
          return;
        }
        hit = { tex: out.texture, bounds: out.bounds };
        overlayCache.set(key, hit);
        // 오래된 것부터 버린다 (Map은 삽입 순서를 유지한다)
        while (overlayCache.size > OVERLAY_CACHE_MAX) {
          const oldest = overlayCache.keys().next().value as string;
          overlayCache.get(oldest)?.tex.dispose();
          overlayCache.delete(oldest);
        }
      }

      globeUniforms.uOverlay.value = hit.tex;
      // 강조는 불투명도와 기반 억제를 함께 움직인다 — 따로 두면 조합이 어긋난 상태가 생긴다
      const em = useStore.getState().gk2a.emphasis;
      globeUniforms.uOverlayOpacity.value = 0.45 + 0.55 * em;
      globeUniforms.uOverlayDim.value = 0.15 + 0.7 * em;
      globeUniforms.uOverlayBounds.value.set(hit.bounds[0], hit.bounds[1], hit.bounds[2], hit.bounds[3]);
      globeUniforms.uHasOverlay.value = 1;
    };
    syncGk2aOverlay();

    // ── 위성 시점(POV) 카메라 ──────────────────────────────────────────────
    // 위성 위치에서 지구 중심을 바라본다. GK2A는 정지궤도(35,786 km)라
    // 지구 각반경이 8.7° — 45° 화각에 원반 전체가 담긴다(실제 GK2A 전구 영상과 같은 구도).
    const povTarget = new THREE.Vector3();
    let povActive = false;
    let povBlend = 0; // 0=자유시점 1=위성시점
    const freePos = camera.position.clone();

    // 궤도 + 위성 빌드
    type SatObj = {
      satrec: satellite.SatRec;
      model: SatModel;
      cone: THREE.Mesh;
      norad: number;
      color: number;
    };
    const satObjs: SatObj[] = [];
    const orbitGroup = new THREE.Group();
    scene.add(orbitGroup);

    function buildOrbits() {
      // 정리 — 모델은 자체 지오메트리/머티리얼을 들고 있으므로 명시적으로 dispose
      for (const s of satObjs) s.model.dispose();
      orbitGroup.clear();
      satObjs.length = 0;
      const now = new Date();
      for (const def of satsRef.current) {
        const o = computeOrbit(def, now, 256);
        if (!o) continue;
        const col = (def.color[0] << 16) | (def.color[1] << 8) | def.color[2];
        // 궤도 타원 (ECI)
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 256; i++) {
          const t = new Date(now.getTime() + (i / 256) * o.periodMin * 60000);
          const pv = satellite.propagate(o.satrec, t);
          if (pv && pv.position && typeof pv.position !== "boolean") pts.push(eciToScene(pv.position));
        }
        if (pts.length < 8) continue;
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending })
        );
        orbitGroup.add(line);
        // 위성 실모델 (고도화 B3) — 구 마커에서 승격. 자세는 매 프레임 LVLH로 정렬.
        const model = buildSatelliteModel(modelKindFor(def.noradId), col, MODEL_SCALE);
        orbitGroup.add(model.group);
        orbitGroup.add(model.marker);
        // 센서 콘 (위성→지구중심)
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.9, 2, 24, 1, true),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
        );
        cone.visible = false;
        orbitGroup.add(cone);
        satObjs.push({ satrec: o.satrec, model, cone, norad: def.noradId, color: col });
      }
    }
    buildOrbits();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.sats !== prev.sats) buildOrbits();
      if (s.stations !== prev.stations) rebuildStations(s.stations);
    });

    // 피킹 (위성 클릭 → 선택)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onClick(e: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // 넓은 뷰에서는 마커가, 근접 시에는 모델이 클릭 대상이 된다.
      // 모델은 여러 자식 메시로 구성되므로 재귀 탐색 후 소유 위성으로 되짚는다.
      const targets: THREE.Object3D[] = [];
      for (const s of satObjs) {
        targets.push(s.model.group);
        if (s.model.marker.visible) targets.push(s.model.marker);
      }
      const hits = raycaster.intersectObjects(targets, true);
      if (hits.length) {
        const owner = (o: THREE.Object3D | null) => {
          while (o) {
            const f = satObjs.find((s) => s.model.group === o || s.model.marker === o);
            if (f) return f;
            o = o.parent;
          }
          return undefined;
        };
        const found = owner(hits[0].object);
        if (found) {
          select(found.norad);
          // 관측 자료를 제공하는 위성은 클릭 시 그 위성의 시점으로 들어간다
          const st = useStore.getState();
          if (found.norad === GK2A_NORAD) st.setPov(GK2A_NORAD);
          else if (st.povNorad != null) st.setPov(null);
        }
      }
    }
    renderer.domElement.addEventListener("click", onClick);

    // 애니메이션
    let raf = 0;
    const _vel = new THREE.Vector3(); // 매 프레임 할당 방지

    // 가시성 판정은 지상국 수 × 프레임이라 비싸다. 위성이 1초에 7.7 km 움직이므로
    // 매 프레임 다시 풀 필요가 없다 — 500 ms 간격이면 충분하다.
    let lastVisCalc = 0;

    /** 풋프린트 링 + 가시 지상국 갱신. */
    const updateB4 = (satrec: satellite.SatRec, posEci: { x: number; y: number; z: number }, now: Date) => {
      const gmst = satellite.gstime(now);
      const gd = satellite.eciToGeodetic(posEci as satellite.EciVec3<number>, gmst);
      const subLat = satellite.degreesLat(gd.latitude);
      const subLon = satellite.degreesLong(gd.longitude);
      const lambda = footprintCentralAngleDeg(gd.height);

      // 링: 서브위성점을 중심으로 각반경 λ인 소원. 지표에서 살짝 띄워 z-fighting 방지.
      const attr = fpGeo.getAttribute("position") as THREE.BufferAttribute;
      const center = geoToLocal(subLat, subLon).normalize();
      // center에 수직인 임의의 기저 두 개
      const tmp = Math.abs(center.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const e1 = new THREE.Vector3().crossVectors(center, tmp).normalize();
      const e2 = new THREE.Vector3().crossVectors(center, e1).normalize();
      const rad = (lambda * Math.PI) / 180;
      const rr = R_EARTH_KM * KM * 1.002;
      for (let i = 0; i <= FP_SEGMENTS; i++) {
        const th = (i / FP_SEGMENTS) * Math.PI * 2;
        const x = center.x * Math.cos(rad) + (e1.x * Math.cos(th) + e2.x * Math.sin(th)) * Math.sin(rad);
        const y = center.y * Math.cos(rad) + (e1.y * Math.cos(th) + e2.y * Math.sin(th)) * Math.sin(rad);
        const z = center.z * Math.cos(rad) + (e1.z * Math.cos(th) + e2.z * Math.sin(th)) * Math.sin(rad);
        attr.setXYZ(i, x * rr, y * rr, z * rr);
      }
      attr.needsUpdate = true;
      footprint.visible = true;

      if (stationsRef.length === 0) return;
      const nowMs = Date.now();
      if (nowMs - lastVisCalc < 500) return;
      lastVisCalc = nowMs;

      const vis = visibleStations(satrec, stationsRef, now);
      const va = visGeo.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < vis.length && i < stationsRef.length; i++) {
        const v = geoToLocal(vis[i].lat, vis[i].lon, vis[i].altKm);
        va.setXYZ(i, v.x, v.y, v.z);
      }
      va.needsUpdate = true;
      visGeo.setDrawRange(0, Math.min(vis.length, stationsRef.length));
      if (useStore.getState().visibleCount !== vis.length) useStore.getState().setVisibleCount(vis.length);
    };

    /** 씬 상태를 주어진 시각으로 갱신. 렌더 루프와 검증 캡처가 동일 경로를 쓴다. */
    const updateScene = (now: Date) => {
      earth.rotation.y = satellite.gstime(now); // GMST 자전 (관성계 대비)
      // 태양 방향 → 지구/대기 셰이더(실시간 주야 터미네이터)
      const se = sunEci(now);
      uSun.value.set(se.x, se.z, -se.y).normalize();
      sunLight.position.copy(uSun.value).multiplyScalar(100); // 위성 조명도 태양을 따라간다
      const sel = useStore.getState().selectedNorad;
      const precise = useStore.getState().precise;
      for (const s of satObjs) {
        // A3: 정밀 ephemeris가 이 위성/시각을 커버하면 SGP4 대신 그것을 쓴다.
        // SGP4는 TLE epoch에서 이미 ~900 m 어긋나 있고(A2 실측), 정밀 ephemeris는 그 오차가 없다.
        const usingPrecise =
          precise && precise.norad === s.norad ? preciseStateTeme(precise, now) : null;
        const pv = usingPrecise ?? satellite.propagate(s.satrec, now);
        if (pv && pv.position && typeof pv.position !== "boolean") {
          const p = eciToScene(pv.position);
          const g = s.model.group;
          g.position.copy(p);
          const isSel = s.norad === sel;
          g.scale.setScalar(isSel ? MODEL_SCALE * 1.8 : MODEL_SCALE);

          // 자세 정렬 (B3): 천저 지향 + 태양전지판 태양 추적.
          // 속도가 있어야 궤도면을 알 수 있다 — 없으면 이전 자세를 유지.
          if (pv.velocity && typeof pv.velocity !== "boolean") {
            _vel.copy(eciToScene(pv.velocity));
            applyNadirAttitude(g, p, _vel);
            trackSun(g, s.model.panels, uSun.value);
          }

          // 식(eclipse) → 지구 그림자 안이면 위성 어둡게
          s.model.setIlluminated(!isEclipsed(pv.position, now));

          // 마커 LOD: 화면 크기 고정, 모델이 커지면 페이드아웃
          const radPerPx = radiansPerPixel(camera.fov, el.clientHeight);
          const dist = camera.position.distanceTo(p);
          const sz = markerSizing(dist, radPerPx, MODEL_SCALE * (isSel ? 1.8 : 1));
          s.model.marker.position.copy(p);
          s.model.marker.scale.setScalar(sz.world * (isSel ? 1.5 : 1));
          (s.model.marker.material as THREE.SpriteMaterial).opacity = sz.opacity;
          s.model.marker.visible = sz.opacity > 0.01;

          // 위성 시점에서는 자기 자신과 자기 센서 콘을 그리지 않는다.
          // 콘은 위성→지구 원뿔이라 축 방향에서 보면 화면 전체가 콘 내부로 덮이고,
          // 본체는 카메라 코앞이라 지구를 통째로 가린다.
          const inPov = useStore.getState().povNorad === s.norad;
          g.visible = !inPov;
          s.model.marker.visible = s.model.marker.visible && !inPov;

          // 센서 콘: 위성→지구중심 정렬, 높이=고도
          s.cone.visible = isSel && !inPov;
          if (isSel && !inPov) {
            const alt = p.length();
            s.cone.position.copy(p).multiplyScalar(0.5); // 위성과 중심 중간
            s.cone.scale.set(1, alt / 2, 1);
            s.cone.lookAt(0, 0, 0);
            s.cone.rotateX(Math.PI / 2);

            // 커버리지 풋프린트 + 가시 지상국 (B4) — 추적 대상에 대해서만 계산
            updateB4(s.satrec, pv.position, now);
          }
        }
      }
    };

    const loop = () => {
      updateScene(simClock.nowDate()); // 가상 시계(배속/스크럽/일시정지)
      syncGk2aOverlay();

      // 위성 시점 전환 — 급전환이 아니라 보간해 "날아가는" 느낌을 준다
      const pov = useStore.getState().povNorad;
      const target = pov != null ? satObjs.find((s) => s.norad === pov) : undefined;
      if (target) {
        if (!povActive) {
          povActive = true;
          freePos.copy(camera.position);
        }
        povBlend = Math.min(1, povBlend + 0.035);
        // 위성 위치 그대로 — 실제 그 위성이 보는 화면이어야 한다
        povTarget.copy(target.model.group.position);
        camera.position.lerpVectors(freePos, povTarget, povBlend);
        camera.lookAt(0, 0, 0);
        controls.enabled = false;
      } else {
        if (povActive) {
          povBlend = Math.max(0, povBlend - 0.045);
          camera.position.lerpVectors(freePos, povTarget, povBlend);
          camera.lookAt(0, 0, 0);
          if (povBlend <= 0) {
            povActive = false;
            controls.enabled = true;
            controls.target.set(0, 0, 0);
          }
        }
      }
      if (!povActive) controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);







    const onResize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      unsub();
      for (const t of loadedTex) t.dispose();
      for (const s of satObjs) s.model.dispose();
      for (const v of overlayCache.values()) v.tex.dispose();
      overlayCache.clear();
      fpGeo.dispose();
      stationGeo.dispose();
      visGeo.dispose();
      blank.dispose();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [select]);

  return <div ref={ref} style={{ position: "absolute", inset: 0, background: "#05070f" }} />;
}
