// MapLibre v5 globe 위 Three.js custom layer (설계서 §4.6-A)
// 3D 위성 모델 + 센서 콘 + 실축척 궤도링(ECEF) + 깊이 가림(depth-only 지구 구).
//
// 핵심 좌표 트릭 — getMatrixForModel([lng,lat],alt) 는 그 지점에 놓인 모델을
// mainMatrix 가 소비하는 월드 공간으로 옮기는 행렬이다. 모델 원점(0,0,0)의 클립좌표는
//   mainMatrix · M · [0,0,0,1] = mainMatrix · (M 의 translation 열)
// 이므로, **정점마다 M 의 translation(m[12..14])만 뽑아** BufferGeometry 에 담고
// projectionMatrix=mainMatrix 로 그리면 globe 곡률이 정점별로 정확히 반영된 궤도링을
// 단일 draw 로 얻는다(ECEF 수동 변환 불필요, 접평면 선형화 오차 없음). 위성 본체 배치와
// 정확히 같은 공간이라 궤도선이 위성 마커를 정확히 관통한다.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { CustomLayerInterface, Map as MLMap } from "maplibre-gl";
import { KOREA_CENTER, CUBE_EXAG, CUBE_GAP, CUBE_MIN_M, SEA_LEVEL_M, type KoreaGrid } from "@/lib/koreaCube";

export type SatView = {
  norad: number;
  lng: number;
  lat: number;
  alt: number; // m
  color: [number, number, number];
  sel: boolean;
};

/** 위성 화면좌표(px) — MapLibre 클릭 피킹용(pitch에서도 모델과 정확히 일치). */
export type SatHit = { norad: number; x: number; y: number };

/** 한 주기 궤도링 (deck.gl 에서 이관). points: [lng, lat, alt(m)] */
export type OrbitRing = {
  points: [number, number, number][];
  color: [number, number, number];
  sel: boolean;
};

const CONE_H0 = 400_000; // 기준 콘 높이(m) — 렌더 시 고도로 스케일

// 대한민국 상공 16U 큐브샛 데모 (요청) — 고정 위치·고도.
const KOREA_LNGLAT: [number, number] = [127.8, 36.5];
const KOREA_ALT = 550_000; // m (LEO 상공)

// maplibre 내부 transform 의 모델 배치 API (v5). 5.6 에 존재하나 타입 미노출이라 캐스팅.
type ModelTransform = { getMatrixForModel?: (l: [number, number], alt: number) => number[] };

export function createOrbitalLayer(
  getSats: () => SatView[],
  getOrbits: () => OrbitRing[],
  getKoreaGrid: () => KoreaGrid | null,
  satHitsOut: SatHit[]
): CustomLayerInterface {
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.Camera;
  let satGroup: THREE.Group; // 재사용 위성 모델
  let bodyMat: THREE.MeshStandardMaterial;
  let satMarker: THREE.Mesh; // 항상 보이는 마커 구 — 줌아웃 시 모델은 서브픽셀
  let satMarkerMat: THREE.MeshBasicMaterial;
  let cone: THREE.Mesh;
  let coneMat: THREE.MeshBasicMaterial;
  let mapRef: MLMap;

  // ── 오버레이(궤도링 + 깊이 구) ─────────────────────────────────────────────
  let overlayScene: THREE.Scene;
  let sphere: THREE.Mesh; // colorWrite off · depthWrite on → 지구 뒤 궤도/위성을 가린다
  const sphereLon: number[] = [];
  const sphereLat: number[] = [];
  let lineGroup: THREE.Group;
  const lines: THREE.Line[] = [];
  // 궤도링·구의 투영 위치는 카메라(pan/pitch/bearing)와 무관하고 zoom morph 에서만 변한다.
  // → 'move' 시에만 재구성한다(정지 상태 애니메이션에선 재계산 0). 위성 점은 매 프레임 갱신.
  let moveDirty = true;
  let lastOrbits: OrbitRing[] | null = null;
  let onMove: (() => void) | null = null;

  // 대한민국 상공 16U 큐브샛 (별도 씬 — 위성 per-model 패스와 섞이지 않게)
  let cubeScene: THREE.Scene;
  let cubeSat: THREE.Group;
  let cubeSpin = 0;

  // 한반도 큐브 그리드 (큐브샛 관측) — Korea 중심 앵커 접평면에 InstancedMesh 복셀.
  let gridScene: THREE.Scene;
  let gridMesh: THREE.InstancedMesh | null = null;
  let lastGrid: KoreaGrid | null = null;

  function rebuildGrid(transform: ModelTransform, grid: KoreaGrid | null) {
    if (gridMesh) {
      gridScene.remove(gridMesh);
      gridMesh.geometry.dispose();
      (gridMesh.material as THREE.Material).dispose();
      gridMesh = null;
    }
    if (!grid || typeof transform.getMatrixForModel !== "function") return;
    const { nx, ny, heights, colors, bbox } = grid;
    const cLng = (bbox.west + bbox.east) / 2;
    const cLat = (bbox.south + bbox.north) / 2;
    const mLat = 110_540;
    const mLng = 111_320 * Math.cos((cLat * Math.PI) / 180);
    const cellWm = ((bbox.east - bbox.west) / nx) * mLng;
    const cellHm = ((bbox.north - bbox.south) / ny) * mLat;

    // 앵커(한국 중심) 로컬 프레임에서 동/북/상 기저를 경험적으로 유도한다 — 프레임 축 규약을
    // 가정하지 않는다. 렌더 패스가 mainMatrix ⊗ getMatrixForModel(KOREA_CENTER,0) 로 이 프레임을 쓴다.
    const anchorInv = new THREE.Matrix4().fromArray(transform.getMatrixForModel!(KOREA_CENTER, 0)).invert();
    const localOf = (lng: number, lat: number, alt: number) => {
      const t = transform.getMatrixForModel!([lng, lat], alt);
      return new THREE.Vector3(t[12], t[13], t[14]).applyMatrix4(anchorInv);
    };
    const o = localOf(cLng, cLat, 0);
    const dDeg = 0.1;
    const eHat = localOf(cLng + dDeg, cLat, 0).sub(o).multiplyScalar(1 / (dDeg * mLng)); // 로컬단위/미터(동)
    const nHat = localOf(cLng, cLat + dDeg, 0).sub(o).multiplyScalar(1 / (dDeg * mLat)); // /미터(북)
    const uHat = localOf(cLng, cLat, 10_000).sub(o).multiplyScalar(1 / 10_000); // /미터(상)

    // 바다 셀(해발 SEA_LEVEL_M 이하) 제외 → 육지·섬만 큐브화. 인스턴스 수 = 육지 셀 수.
    let land = 0;
    for (let idx = 0; idx < nx * ny; idx++) if (heights[idx] >= SEA_LEVEL_M) land++;
    if (land === 0) return;

    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.85 }),
      land
    );
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    const xA = new THREE.Vector3();
    const yA = new THREE.Vector3();
    const zA = new THREE.Vector3();
    const pos = new THREE.Vector3();
    let k = 0; // 육지 인스턴스 인덱스
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        if (heights[i] < SEA_LEVEL_M) continue; // 바다 숨김
        const lng = bbox.west + ((x + 0.5) / nx) * (bbox.east - bbox.west);
        const lat = bbox.south + ((y + 0.5) / ny) * (bbox.north - bbox.south);
        const eastM = (lng - cLng) * mLng;
        const northM = (lat - cLat) * mLat;
        const hzM = Math.max(CUBE_MIN_M, heights[i] * CUBE_EXAG);
        xA.copy(eHat).multiplyScalar(cellWm * CUBE_GAP);
        yA.copy(nHat).multiplyScalar(cellHm * CUBE_GAP);
        zA.copy(uHat).multiplyScalar(hzM);
        pos.copy(o).addScaledVector(eHat, eastM).addScaledVector(nHat, northM).addScaledVector(uHat, hzM / 2);
        m.makeBasis(xA, yA, zA).setPosition(pos);
        mesh.setMatrixAt(k, m);
        col.setRGB(colors[i * 3] / 255, colors[i * 3 + 1] / 255, colors[i * 3 + 2] / 255);
        mesh.setColorAt(k, col);
        k++;
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    gridScene.add(mesh);
    gridMesh = mesh;
  }

  function buildSatellite(): THREE.Group {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;

    bodyMat = new THREE.MeshStandardMaterial({ color: 0xcbb57a, metalness: 0.6, roughness: 0.35, emissive: 0x2a2410, emissiveIntensity: 0.5 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(30_000, 22_000, 22_000), bodyMat);
    g.add(body);

    const panelMat = new THREE.MeshStandardMaterial({ color: 0x11305a, metalness: 0.2, roughness: 0.4, emissive: 0x0a2a5a, emissiveIntensity: 0.6 });
    for (const sx of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(130_000, 46_000, 2_500), panelMat);
      panel.position.set(sx * 90_000, 0, 0);
      g.add(panel);
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(2500, 2500, 55_000), bodyMat);
      boom.rotation.z = Math.PI / 2;
      boom.position.set(sx * 42_000, 0, 0);
      g.add(boom);
    }
    // 안테나 (+Z, 우주 방향)
    const ant = new THREE.Mesh(new THREE.ConeGeometry(9_000, 26_000, 12), bodyMat);
    ant.position.set(0, 0, 24_000);
    g.add(ant);

    // 센서 콘: 정점=위성(원점), -Z(지구 방향)로 개방
    const cg = new THREE.ConeGeometry(CONE_H0 * Math.tan((18 * Math.PI) / 180), CONE_H0, 40, 1, true);
    cg.rotateX(Math.PI / 2); // +Y → +Z
    cg.translate(0, 0, -CONE_H0 / 2); // 정점을 원점으로
    coneMat = new THREE.MeshBasicMaterial({ color: 0x5ce1ff, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false });
    cone = new THREE.Mesh(cg, coneMat);
    g.add(cone);

    // 항상 보이는 마커 구 — 원점(위성 위치). 무광(MeshBasic)이라 각도·조명 무관하게 점으로 보인다.
    satMarkerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    satMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 12), satMarkerMat);
    satMarker.scale.setScalar(150_000); // ~150 km 반경
    g.add(satMarker);

    return g;
  }

  // 16U 큐브샛 (2U×2U×4U ≈ 20×20×40 cm). 실축척은 서브픽셀이라 위성 본체처럼 과장 스케일.
  // 태양전지 셀 격자 텍스처 (캔버스) — 다크블루 모노셀 + 금박 갭 + 버스바. 실기체 룩의 핵심.
  function makeSolarTexture(): THREE.Texture {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 512;
    const c = cv.getContext("2d")!;
    c.fillStyle = "#b1892f"; // 금박(anodized) 기판
    c.fillRect(0, 0, cv.width, cv.height);
    const cols = 4;
    const rows = 8;
    const mgn = 9;
    const gap = 4;
    const cw = (cv.width - 2 * mgn - (cols - 1) * gap) / cols;
    const ch = (cv.height - 2 * mgn - (rows - 1) * gap) / rows;
    const chamf = cw * 0.16;
    for (let r = 0; r < rows; r++)
      for (let col = 0; col < cols; col++) {
        const x = mgn + col * (cw + gap);
        const y = mgn + r * (ch + gap);
        const grd = c.createLinearGradient(x, y, x + cw * 0.4, y + ch);
        grd.addColorStop(0, "#2a447d");
        grd.addColorStop(0.5, "#182a54");
        grd.addColorStop(1, "#0e1c3c");
        c.fillStyle = grd;
        c.fillRect(x, y, cw, ch);
        // 모노셀 모서리 챔퍼(금박 삼각형)
        c.fillStyle = "#b1892f";
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + chamf, y); c.lineTo(x, y + chamf); c.fill();
        c.beginPath(); c.moveTo(x + cw, y); c.lineTo(x + cw - chamf, y); c.lineTo(x + cw, y + chamf); c.fill();
        c.beginPath(); c.moveTo(x, y + ch); c.lineTo(x + chamf, y + ch); c.lineTo(x, y + ch - chamf); c.fill();
        c.beginPath(); c.moveTo(x + cw, y + ch); c.lineTo(x + cw - chamf, y + ch); c.lineTo(x + cw, y + ch - chamf); c.fill();
        // 버스바(은색 세로 라인)
        c.strokeStyle = "rgba(198,210,232,0.30)";
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(x + cw * 0.36, y); c.lineTo(x + cw * 0.36, y + ch);
        c.moveTo(x + cw * 0.64, y); c.lineTo(x + cw * 0.64, y + ch);
        c.stroke();
      }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  // 16U(2×2×4) 큐브샛 — 첨부 실기체 룩. 실축척은 서브픽셀이라 과장 스케일.
  function buildCubeSat(): THREE.Group {
    const g = new THREE.Group();
    g.rotation.x = 0.3;
    g.rotation.y = -0.42;
    const U = 9_000; // 1U ≈ 9 km(과장) → 16U 본체 18×18×36 km
    const W = 2 * U;
    const L = 4 * U;

    const solar = makeSolarTexture();
    const solarMat = new THREE.MeshStandardMaterial({ map: solar, metalness: 0.34, roughness: 0.46, emissive: 0x0a1a38, emissiveIntensity: 0.22, side: THREE.DoubleSide });
    const gold = new THREE.MeshStandardMaterial({ color: 0xb1892f, metalness: 0.72, roughness: 0.34, emissive: 0x2a1e08, emissiveIntensity: 0.22 });
    const alum = new THREE.MeshStandardMaterial({ color: 0xc4cad0, metalness: 0.9, roughness: 0.26 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0a0c12, metalness: 0.5, roughness: 0.38 });

    // 본체 — 전 면에 태양전지 셀
    g.add(new THREE.Mesh(new THREE.BoxGeometry(W, W, L), solarMat));

    // 상/하 골드 캡 + 세로 골드 프레임 스트립(면 경계)
    for (const s of [1, -1]) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.03 * W, 1.03 * W, 0.1 * U), gold);
      cap.position.z = s * (L / 2 + 0.02 * U);
      g.add(cap);
    }
    for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(ax ? 0.12 * U : W, ay ? 0.12 * U : W, L), gold);
      strip.position.set(ax * (W / 2), ay * (W / 2), 0);
      g.add(strip);
    }

    // 알루미늄 코너 레일 4
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.24 * U, 0.24 * U, L * 1.04), alum);
        rail.position.set(sx * (W / 2 - 0.02 * U), sy * (W / 2 - 0.02 * U), 0);
        g.add(rail);
      }

    // 상단 데크(+Z): 골드 + 카메라/광학 + 위프 안테나
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.82 * W, 0.82 * W, 0.12 * U), gold);
    deck.position.z = L / 2 + 0.12 * U;
    g.add(deck);
    // 카메라 배럴 + 렌즈
    const cam = new THREE.Mesh(new THREE.CylinderGeometry(0.32 * U, 0.32 * U, 0.75 * U, 18), alum);
    cam.rotation.x = Math.PI / 2;
    cam.position.set(-0.22 * W, 0.1 * W, L / 2 + 0.55 * U);
    g.add(cam);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.26 * U, 0.26 * U, 0.14 * U, 18), dark);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(-0.22 * W, 0.1 * W, L / 2 + 0.95 * U);
    g.add(lens);
    // 소형 광학(스타트래커) 2
    for (const dx of [0.28 * W, 0.42 * W]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.13 * U, 0.16 * U, 0.4 * U, 12), alum);
      st.rotation.x = Math.PI / 2;
      st.position.set(dx - 0.35 * W, -0.14 * W, L / 2 + 0.4 * U);
      g.add(st);
    }
    // 위프 안테나 2 (은색)
    for (const [dx, dy] of [[0.18 * W, 0.22 * W], [-0.06 * W, 0.06 * W]] as const) {
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.035 * U, 0.05 * U, 2.4 * U, 8), alum);
      ant.rotation.x = -0.12;
      ant.position.set(dx, dy, L / 2 + 1.3 * U);
      g.add(ant);
    }

    // 전개형 태양전지 날개 — 양측 × 상/하 2단(레퍼런스처럼 넓게 펼침), 양면 셀
    for (const sx of [-1, 1])
      for (const sz of [1, -1]) {
        const zc = sz * (L / 2 - 1.0 * U);
        const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * U, 0.09 * U, 1.3 * U, 8), alum);
        boom.rotation.z = Math.PI / 2;
        boom.position.set(sx * (W / 2 + 0.6 * U), 0, zc);
        g.add(boom);
        const hinge = new THREE.Mesh(new THREE.BoxGeometry(0.35 * U, 0.5 * U, 0.35 * U), alum);
        hinge.position.set(sx * (W / 2 + 1.2 * U), 0, zc);
        g.add(hinge);
        const wingLen = 5.2 * U;
        const wing = new THREE.Mesh(new THREE.BoxGeometry(wingLen, 0.08 * U, 1.7 * U), solarMat);
        wing.position.set(sx * (W / 2 + 1.3 * U + wingLen / 2), 0, zc);
        wing.rotation.y = sx > 0 ? 0.05 : -0.05;
        g.add(wing);
      }

    // 하향(-Z) 통신 안테나
    const antBoom = new THREE.Mesh(new THREE.CylinderGeometry(0.06 * U, 0.06 * U, 1.6 * U, 8), alum);
    antBoom.rotation.x = Math.PI / 2;
    antBoom.position.set(0.2 * W, 0.2 * W, -(L / 2 + 0.7 * U));
    g.add(antBoom);

    return g;
  }

  // 깊이 전용 지구 구 — 위경도 격자. 정점 좌표는 매 rebuild 시 getMatrixForModel 로 채운다.
  function buildSphere(): THREE.Mesh {
    const LON = 64;
    const LAT = 32;
    for (let y = 0; y <= LAT; y++) {
      const lat = -90 + (180 * y) / LAT;
      for (let x = 0; x <= LON; x++) {
        sphereLon.push(-180 + (360 * x) / LON);
        sphereLat.push(lat);
      }
    }
    const idx: number[] = [];
    for (let y = 0; y < LAT; y++) {
      for (let x = 0; x < LON; x++) {
        const a = y * (LON + 1) + x;
        const b = a + 1;
        const c = a + (LON + 1);
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(sphereLon.length * 3), 3));
    geo.setIndex(idx);
    // 색은 쓰지 않고 깊이만 남긴다 → MapLibre 가 그린 지구 색은 그대로, 뒤편 궤도만 가려진다.
    // DoubleSide: globe 월드 공간에서 삼각형 감김(winding)이 예측 불가라, 단면이면 뒷면 컬링으로
    // 근접 반구의 깊이가 안 써져 가림이 통째로 무력화될 수 있다. 양면으로 감김에 무관하게 만든다.
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, depthTest: true, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false; // 정점이 mercator 월드좌표라 Three 프러스텀 컬링이 오판한다
    m.matrixAutoUpdate = false;
    return m;
  }

  function rebuildSphere(t: ModelTransform) {
    const attr = sphere.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < sphereLon.length; i++) {
      const m = t.getMatrixForModel!([sphereLon[i], sphereLat[i]], 0);
      attr.setXYZ(i, m[12], m[13], m[14]);
    }
    attr.needsUpdate = true;
  }

  function rebuildLines(t: ModelTransform, orbits: OrbitRing[]) {
    // 라인 풀 크기 맞추기
    while (lines.length < orbits.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(0), 3));
      const mat = new THREE.LineBasicMaterial({ transparent: true, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending });
      const ln = new THREE.Line(g, mat);
      ln.frustumCulled = false;
      ln.matrixAutoUpdate = false;
      lines.push(ln);
      lineGroup.add(ln);
    }
    while (lines.length > orbits.length) {
      const ln = lines.pop()!;
      lineGroup.remove(ln);
      ln.geometry.dispose();
      (ln.material as THREE.Material).dispose();
    }
    for (let k = 0; k < orbits.length; k++) {
      const o = orbits[k];
      const ln = lines[k];
      const n = o.points.length;
      let attr = ln.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!attr || attr.count !== n) {
        attr = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
        ln.geometry.setAttribute("position", attr);
      }
      for (let i = 0; i < n; i++) {
        const p = o.points[i];
        const m = t.getMatrixForModel!([p[0], p[1]], p[2]);
        attr.setXYZ(i, m[12], m[13], m[14]);
      }
      attr.needsUpdate = true;
      ln.geometry.setDrawRange(0, n);
      const mat = ln.material as THREE.LineBasicMaterial;
      mat.color.setRGB(o.color[0] / 255, o.color[1] / 255, o.color[2] / 255);
      mat.opacity = o.sel ? 0.95 : 0.5;
    }
  }

  return {
    id: "orbital-3d",
    type: "custom",
    renderingMode: "3d",

    onAdd(map: MLMap, gl: WebGLRenderingContext) {
      mapRef = map;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0x9fc0ff, 1.1));
      const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
      sun.position.set(-0.6, 0.5, 0.8);
      scene.add(sun);

      satGroup = buildSatellite();
      scene.add(satGroup);

      // 대한민국 상공 큐브샛 씬 (자체 조명)
      cubeScene = new THREE.Scene();
      cubeScene.add(new THREE.AmbientLight(0x9fb4d8, 1.15));
      const cubeSun = new THREE.DirectionalLight(0xfff2d8, 2.6);
      cubeSun.position.set(0.5, 0.7, 0.9);
      cubeScene.add(cubeSun);
      cubeScene.add(new THREE.DirectionalLight(0x88a0c0, 0.7).translateX(-1)); // 후면 필라이트
      // 실기체 glTF 모델 로드 (public/models/cubesat.glb). cubeSat 그룹이 스핀을 담당.
      cubeSat = new THREE.Group();
      cubeScene.add(cubeSat);
      // glb 는 DRACO 압축이라 DRACOLoader 필요(디코더는 public/draco/gltf/ 로컬 호스팅).
      const gltfLoader = new GLTFLoader();
      const dracoLoader = new DRACOLoader();
      dracoLoader.setDecoderPath("/draco/gltf/");
      gltfLoader.setDRACOLoader(dracoLoader);
      gltfLoader.load(
        "/models/cubesat.glb",
        (gltf) => {
          const model = gltf.scene;
          // glb 실축(2U ≈ 0.2 m) → 서브픽셀이라 과장 스케일. 바운딩박스로 목표 크기에 맞춤.
          const box = new THREE.Box3().setFromObject(model);
          const dia = box.getSize(new THREE.Vector3()).length() || 1;
          const s = 90_000 / dia; // 대각 ~90 km
          model.scale.setScalar(s);
          const c = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
          model.position.sub(c); // 원점 중심 정렬
          cubeSat.add(model);
        },
        undefined,
        (err) => {
          console.warn("[cubesat] glb 로드 실패 → 절차적 폴백:", err);
          cubeSat.add(buildCubeSat());
        }
      );

      // 한반도 큐브 그리드 씬 (자체 조명 — 밝게 해 지형/SAR 색이 드러나게)
      gridScene = new THREE.Scene();
      gridScene.add(new THREE.AmbientLight(0xbcd0f0, 1.15));
      const gridSun = new THREE.DirectionalLight(0xffffff, 1.6);
      gridSun.position.set(0.4, 0.5, 1.0);
      gridScene.add(gridSun);

      overlayScene = new THREE.Scene();
      sphere = buildSphere();
      overlayScene.add(sphere);
      lineGroup = new THREE.Group();
      lineGroup.matrixAutoUpdate = false;
      overlayScene.add(lineGroup);

      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;

      onMove = () => {
        moveDirty = true;
      };
      map.on("move", onMove);
    },

    onRemove() {
      if (mapRef && onMove) mapRef.off("move", onMove);
      for (const ln of lines) {
        ln.geometry.dispose();
        (ln.material as THREE.Material).dispose();
      }
      lines.length = 0;
      if (sphere) {
        sphere.geometry.dispose();
        (sphere.material as THREE.Material).dispose();
      }
      cubeSat?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
      });
      if (gridMesh) {
        gridMesh.geometry.dispose();
        (gridMesh.material as THREE.Material).dispose();
      }
      renderer?.dispose();
    },

    render(_gl: WebGLRenderingContext, args: unknown) {
      const transform = mapRef.transform as unknown as ModelTransform;
      if (typeof transform.getMatrixForModel !== "function") return; // globe custom-layer 미지원 시 skip

      // v5: args.defaultProjectionData.mainMatrix / 구버전: matrix 배열
      const a = args as { defaultProjectionData?: { mainMatrix: number[] } };
      const mainArr = a?.defaultProjectionData?.mainMatrix ?? (args as number[]);
      const mainMatrix = new THREE.Matrix4().fromArray(mainArr);

      renderer.resetState();
      const wasDirty = moveDirty; // 큐브 그리드도 zoom morph 시 앵커 기저를 다시 잡아야 한다

      // ── 오버레이 패스: 깊이 구 → 궤도링(ECEF) ──────────────────────────────
      // 깊이 구가 지구 표면 깊이를 먼저 써두면, 뒤편으로 넘어간 궤도·위성이 자동 가려진다.
      const orbits = getOrbits();
      if (moveDirty) {
        rebuildSphere(transform);
        rebuildLines(transform, orbits);
        moveDirty = false;
        lastOrbits = orbits;
      } else if (orbits !== lastOrbits) {
        rebuildLines(transform, orbits); // TLE/선택 변경 → 데이터 배열 교체
        lastOrbits = orbits;
      }
      camera.projectionMatrix.copy(mainMatrix);
      renderer.render(overlayScene, camera);

      // ── 위성 패스: 모델별 배치 행렬. 위 깊이 구에 대해 depth-test 되어 뒤편은 가려진다.
      const sats = getSats();
      const modelM = new THREE.Matrix4();
      satHitsOut.length = 0;
      const canvas = mapRef.getCanvas();
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      // 마커를 대략 화면 고정 크기로 — 줌인 시 작아져 모델 디테일을 가리지 않게. (작게)
      const markerBase = 85_000 / Math.pow(2, Math.max(0, mapRef.getZoom() - 2));
      for (const s of sats) {
        const m = transform.getMatrixForModel!([s.lng, s.lat], s.alt);
        modelM.fromArray(m);
        camera.projectionMatrix.copy(mainMatrix).multiply(modelM);

        // 색/강조 + 마커
        bodyMat.emissiveIntensity = s.sel ? 1.0 : 0.5;
        satMarkerMat.color.setRGB(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255);
        satMarker.scale.setScalar(markerBase * (s.sel ? 1.7 : 1));
        coneMat.color.setRGB(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255);
        cone.visible = s.sel; // 센서 콘은 추적 대상만
        const scale = Math.min(2.5, Math.max(0.3, s.alt / CONE_H0)); // 고궤도에서 거대해지지 않게 캡
        cone.scale.set(scale, scale, scale);

        renderer.render(scene, camera);

        // 클릭 피킹용 화면좌표(모델과 동일 투영) — 위성 원점의 클립 → 화면 px
        const tx = m[12];
        const ty = m[13];
        const tz = m[14];
        const cw = mainArr[3] * tx + mainArr[7] * ty + mainArr[11] * tz + mainArr[15];
        if (cw > 0) {
          const ndx = (mainArr[0] * tx + mainArr[4] * ty + mainArr[8] * tz + mainArr[12]) / cw;
          const ndy = (mainArr[1] * tx + mainArr[5] * ty + mainArr[9] * tz + mainArr[13]) / cw;
          satHitsOut.push({ norad: s.norad, x: (ndx * 0.5 + 0.5) * W, y: (1 - (ndy * 0.5 + 0.5)) * H });
        }
      }

      // ── 대한민국 상공 16U 큐브샛 (요청) — 고정 위치, 천천히 자전. 깊이 구에 대해 뒤편은 가려진다.
      {
        const km = transform.getMatrixForModel!(KOREA_LNGLAT, KOREA_ALT);
        modelM.fromArray(km);
        camera.projectionMatrix.copy(mainMatrix).multiply(modelM);
        cubeSpin += 0.005;
        cubeSat.rotation.z = cubeSpin;
        renderer.render(cubeScene, camera);
      }

      // ── 한반도 큐브 그리드 (큐브샛 관측) — Korea 중심 앵커에 렌더 ──────────────
      const grid = getKoreaGrid();
      if (grid !== lastGrid || (grid && wasDirty)) {
        rebuildGrid(transform, grid); // 프레임(zoom morph)·데이터 변경 시 재빌드
        lastGrid = grid;
      }
      if (gridMesh) {
        const gm = transform.getMatrixForModel!(KOREA_CENTER, 0);
        modelM.fromArray(gm);
        camera.projectionMatrix.copy(mainMatrix).multiply(modelM);
        renderer.render(gridScene, camera);
      }

      // 연속 리페인트 (위성 전파 + 큐브샛 자전)
      mapRef.triggerRepaint();
    },
  };
}
