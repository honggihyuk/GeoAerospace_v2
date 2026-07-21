// 위성 3D 모델 + 자세 정렬 (고도화 §B3).
//
// 스케일 주의: 씬은 1 unit = 1000 km다. ISS 실제 크기는 109 m = 0.000109 unit로
// 실축척으로 그리면 서브픽셀이라 보이지 않는다. 궤도는 실축척이지만 위성 본체는
// 반드시 과장해서 그린다(기존 구 마커도 반지름 120 km 상당으로 이미 과장돼 있었다).
//
// 모델 축 규약 (LVLH 정렬을 위해 모든 변형이 공유한다):
//   +X = 비행 방향(roll, along-track)
//   +Y = 피치축 = 태양전지판 회전축(궤도면 법선의 반대)
//   +Z = 천저(nadir, 지구 중심 방향)
import * as THREE from "three";

export type SatModelKind = "iss" | "hubble" | "bus";

export type SatModel = {
  group: THREE.Group;
  /**
   * 화면 크기 고정 글로우 마커 (LOD).
   * 모델만 두면 넓은 뷰에서 위성이 10 px 남짓이라 어두운 지구를 배경으로 사라진다
   * (특히 식 중일 때). 마커가 추적 기능을, 모델이 근접 리얼리즘을 담당한다.
   */
  marker: THREE.Sprite;
  /** 태양 추적을 위해 Y축으로 회전시키는 태양전지판 피벗. */
  panels: THREE.Object3D;
  /**
   * 일조/식 표현. three의 DirectionalLight는 지구에 의한 가림을 모르므로
   * (그림자 맵 없이) 식 판정 결과를 재질에 직접 반영해야 한다.
   */
  setIlluminated: (lit: boolean) => void;
  dispose: () => void;
};

/** NORAD 번호로 모델 변형 선택. */
export function modelKindFor(noradId: number): SatModelKind {
  if (noradId === 25544) return "iss";
  if (noradId === 20580) return "hubble";
  return "bus";
}

/** 방사형 그라디언트 글로우 텍스처 (모든 마커가 공유). */
let glowTex: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const n = 64;
  // 캔버스가 없는 환경(테스트·SSR)에서는 절차적 DataTexture로 대체
  if (typeof document === "undefined") {
    const data = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const d = Math.hypot(x - n / 2, y - n / 2) / (n / 2);
        const a = Math.max(0, 1 - d) ** 2;
        const i = (y * n + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    glowTex = new THREE.DataTexture(data, n, n);
    glowTex.needsUpdate = true;
    return glowTex;
  }
  const c = document.createElement("canvas");
  c.width = c.height = n;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(255,255,255,0.25)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, n, n);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** 태양전지판 한 장 (평면 + 셀 격자 느낌의 미세 분할). */
function makePanel(w: number, h: number, tracked: THREE.Material[]): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, 0.006, h);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1b3a6b,
    metalness: 0.35,
    roughness: 0.45,
    emissive: 0x0a1730,
    emissiveIntensity: 0.5,
  });
  tracked.push(mat);
  return new THREE.Mesh(geo, mat);
}

function bodyMat(color: number, tracked: THREE.Material[]): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xd8dee9,
    metalness: 0.5,
    roughness: 0.5,
    emissive: new THREE.Color(color).multiplyScalar(0.12),
  });
  tracked.push(m);
  return m;
}

/**
 * 위성 모델 생성. `scale`은 씬 단위 기준 대략적인 전장(과장 스케일).
 * accentColor는 위성별 색을 본체에 은은하게 반영해 기존 색 코드 체계를 유지한다.
 */
export function buildSatelliteModel(kind: SatModelKind, accentColor: number, scale = 0.26): SatModel {
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const bm = bodyMat(accentColor, mats);

  // 태양전지판 피벗 — Y축(피치축) 회전으로 태양을 추적한다.
  const panels = new THREE.Object3D();
  group.add(panels);

  if (kind === "iss") {
    // 트러스: 좌우(Y)로 긴 구조 — 실제 ISS도 트러스가 비행 방향에 수직이다.
    const truss = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.05), bm);
    geos.push(truss.geometry);
    group.add(truss);
    // 여압 모듈: 비행 방향(X)으로 늘어선 실린더들
    for (const [x, len, r] of [
      [0.0, 0.34, 0.07],
      [0.22, 0.2, 0.055],
      [-0.2, 0.22, 0.055],
    ] as const) {
      const mod = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), bm);
      geos.push(mod.geometry);
      mod.rotation.z = Math.PI / 2; // 실린더 축을 X로
      mod.position.set(x, 0, 0);
      group.add(mod);
    }
    // 태양전지 어레이 4쌍 — 트러스를 따라 ±Y에 배치
    for (const y of [-0.42, -0.26, 0.26, 0.42]) {
      const p = makePanel(0.16, 0.44, mats);
      geos.push(p.geometry);
      p.position.set(0, y, 0);
      panels.add(p);
    }
    // 라디에이터 (전지판과 달리 고정)
    const rad = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.008, 0.1), bm);
    geos.push(rad.geometry);
    rad.position.set(0, 0.1, 0.09);
    group.add(rad);
  } else if (kind === "hubble") {
    // 망원경 경통: 비행 방향(X)으로 누운 실린더
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.52, 16), bm);
    geos.push(tube.geometry);
    tube.rotation.z = Math.PI / 2;
    group.add(tube);
    // 개구부(어퍼처) — 앞쪽(+X) 어두운 원판
    const apMat = new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.9 });
    mats.push(apMat);
    const ap = new THREE.Mesh(new THREE.CircleGeometry(0.098, 16), apMat);
    geos.push(ap.geometry);
    ap.position.set(0.261, 0, 0);
    ap.rotation.y = Math.PI / 2;
    group.add(ap);
    // 태양전지판 2장 (±Y)
    for (const y of [-0.26, 0.26]) {
      const p = makePanel(0.3, 0.14, mats);
      geos.push(p.geometry);
      p.position.set(0, y, 0);
      panels.add(p);
    }
  } else {
    // 범용 버스: 육면체 본체 + 전지판 2장 + 천저 지향 안테나
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.18), bm);
    geos.push(body.geometry);
    group.add(body);
    for (const y of [-0.3, 0.3] as const) {
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 6), bm);
      geos.push(boom.geometry);
      boom.position.set(0, y * 0.62, 0);
      group.add(boom);
      const p = makePanel(0.18, 0.36, mats);
      geos.push(p.geometry);
      p.position.set(0, y, 0);
      panels.add(p);
    }
    // 안테나 접시 — 천저(+Z) 지향. 자세 정렬이 맞으면 항상 지구를 향한다.
    const dishMat = new THREE.MeshStandardMaterial({ color: 0xf0f4f8, metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide });
    mats.push(dishMat);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(0.07, 14, 8, 0, Math.PI * 2, 0, Math.PI / 3), dishMat);
    geos.push(dish.geometry);
    dish.position.set(0, 0, 0.11);
    dish.rotation.x = Math.PI / 2; // 오목면이 +Z(지구)를 향하도록
    group.add(dish);
  }

  group.scale.setScalar(scale);

  // 글로우 마커 — 그룹과 독립적으로(스케일·자세 영향 없이) 위치만 따라간다.
  const markerMat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color: accentColor,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  mats.push(markerMat);
  const marker = new THREE.Sprite(markerMat);

  // 식(eclipse) 전환용 기준값 — 복원할 수 있도록 생성 시점 값을 기억한다.
  // 마커는 제외한다: 식 중이어도 추적은 가능해야 하므로 항상 밝게 유지한다.
  const base = mats
    .filter((m): m is THREE.MeshStandardMaterial => (m as THREE.MeshStandardMaterial).isMeshStandardMaterial)
    .map((sm) => ({ mat: sm, color: sm.color.clone(), emissive: sm.emissiveIntensity }));
  let illuminated = true;

  return {
    group,
    marker,
    panels,
    setIlluminated: (lit: boolean) => {
      if (lit === illuminated) return; // 매 프레임 재질을 건드리지 않는다
      illuminated = lit;
      for (const b of base) {
        b.mat.color.copy(b.color).multiplyScalar(lit ? 1 : 0.22);
        b.mat.emissiveIntensity = lit ? b.emissive : b.emissive * 0.15;
      }
    },
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

// ── 마커 LOD ─────────────────────────────────────────────────────────────────

/** 카메라 수직 화각 기준 픽셀당 라디안. */
export function radiansPerPixel(fovDeg: number, viewportHeightPx: number): number {
  return (2 * Math.tan((fovDeg * Math.PI) / 180 / 2)) / Math.max(1, viewportHeightPx);
}

/**
 * 마커를 화면상 일정 크기로 유지하고, 모델이 충분히 커지면 마커를 걷어낸다.
 * @returns world = 스프라이트 월드 스케일, opacity = 마커 투명도
 */
export function markerSizing(
  distance: number,
  radPerPx: number,
  modelWorldSize: number,
  markerPx = 13,
  fadeStartPx = 26,
  fadeEndPx = 60
): { world: number; opacity: number } {
  const world = radPerPx * markerPx * distance;
  // 모델이 화면에서 차지하는 픽셀 수
  const modelPx = modelWorldSize / distance / radPerPx;
  const t = (modelPx - fadeStartPx) / Math.max(1e-6, fadeEndPx - fadeStartPx);
  const opacity = 1 - Math.min(1, Math.max(0, t));
  return { world, opacity };
}

// ── 자세 정렬 ────────────────────────────────────────────────────────────────
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _h = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _sun = new THREE.Vector3();
const _q = new THREE.Quaternion(); // 매 프레임 할당 방지

/**
 * LVLH(Local Vertical Local Horizontal) 자세 — 천저 지향.
 *   z = -r̂ (천저)   y = -ĥ (궤도면 법선의 반대, h = r × v)   x = y × z (≈ 비행 방향)
 * pos/vel은 씬 좌표계 기준.
 */
export function applyNadirAttitude(group: THREE.Object3D, pos: THREE.Vector3, vel: THREE.Vector3): void {
  _z.copy(pos).normalize().negate(); // 천저
  _h.copy(pos).cross(vel); // 각운동량 = 궤도면 법선
  if (_h.lengthSq() < 1e-12) return; // 축퇴 — 자세 유지
  _y.copy(_h).normalize().negate();
  _x.copy(_y).cross(_z).normalize();
  // 수치 오차 보정: y를 z×x로 재직교화
  _y.copy(_z).cross(_x).normalize();
  _m.makeBasis(_x, _y, _z);
  group.quaternion.setFromRotationMatrix(_m);
}

/**
 * 태양전지판 태양 추적 — 피벗을 모델 Y축으로 회전시켜 판 법선을 태양에 최대한 맞춘다.
 * 판 법선은 Y축 회전으로 X–Z 평면을 훑으므로, 태양 방향을 모델 좌표계로 옮겨
 * X–Z 평면에 투영한 각도가 최적해다.
 * sunWorld는 정규화된 월드 태양 방향.
 */
export function trackSun(group: THREE.Object3D, panels: THREE.Object3D, sunWorld: THREE.Vector3): void {
  // 월드 → 모델 좌표계 (group.quaternion의 켤레를 적용)
  _q.copy(group.quaternion).invert();
  _sun.copy(sunWorld).applyQuaternion(_q);
  panels.rotation.y = Math.atan2(_sun.x, _sun.z);
}
