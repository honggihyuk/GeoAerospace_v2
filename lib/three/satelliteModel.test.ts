import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  applyNadirAttitude,
  buildSatelliteModel,
  markerSizing,
  modelKindFor,
  radiansPerPixel,
  trackSun,
} from "./satelliteModel";

/** 그룹 자세를 적용했을 때 모델 로컬축이 향하는 월드 방향. */
function axisOf(group: THREE.Object3D, local: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(...local).applyQuaternion(group.quaternion);
}

describe("applyNadirAttitude (LVLH 자세)", () => {
  it("모델 +Z를 천저(지구 중심)로 향하게 한다", () => {
    const g = new THREE.Object3D();
    const pos = new THREE.Vector3(7, 0, 0); // 7000 km
    const vel = new THREE.Vector3(0, 0, -0.0075); // pos에 수직
    applyNadirAttitude(g, pos, vel);

    const nadir = pos.clone().normalize().negate();
    expect(axisOf(g, [0, 0, 1]).angleTo(nadir)).toBeLessThan(1e-6);
  });

  it("모델 +X를 비행 방향으로 정렬한다", () => {
    const g = new THREE.Object3D();
    const pos = new THREE.Vector3(7, 0, 0);
    const vel = new THREE.Vector3(0, 0, -0.0075);
    applyNadirAttitude(g, pos, vel);

    expect(axisOf(g, [1, 0, 0]).angleTo(vel.clone().normalize())).toBeLessThan(1e-6);
  });

  it("경사 궤도에서도 천저를 유지하고 정규직교 자세를 만든다", () => {
    const g = new THREE.Object3D();
    // 임의의 경사 궤도: 위치와 수직인 속도를 구성
    const pos = new THREE.Vector3(3.1, 5.2, -2.4);
    const vel = new THREE.Vector3(1, -0.4, 0.7);
    vel.sub(pos.clone().normalize().multiplyScalar(vel.dot(pos.clone().normalize()))); // 접선 성분만

    applyNadirAttitude(g, pos, vel);

    const x = axisOf(g, [1, 0, 0]);
    const y = axisOf(g, [0, 1, 0]);
    const z = axisOf(g, [0, 0, 1]);
    // 천저 지향
    expect(z.angleTo(pos.clone().normalize().negate())).toBeLessThan(1e-6);
    // 정규직교
    expect(Math.abs(x.dot(y))).toBeLessThan(1e-6);
    expect(Math.abs(y.dot(z))).toBeLessThan(1e-6);
    expect(Math.abs(x.dot(z))).toBeLessThan(1e-6);
    // 오른손 좌표계 (x × y = z)
    expect(x.clone().cross(y).angleTo(z)).toBeLessThan(1e-6);
  });

  it("속도가 0이면(축퇴) 자세를 바꾸지 않는다", () => {
    const g = new THREE.Object3D();
    const before = g.quaternion.clone();
    applyNadirAttitude(g, new THREE.Vector3(7, 0, 0), new THREE.Vector3(0, 0, 0));
    expect(g.quaternion.angleTo(before)).toBe(0);
  });
});

describe("trackSun (태양전지판 추적)", () => {
  // 판 법선은 Y축 회전으로 X–Z 평면만 훑을 수 있다. 따라서 달성 가능한 최대
  // cos(입사각)은 태양 벡터를 모델 X–Z 평면에 투영한 크기와 같다.
  function maxAchievable(group: THREE.Object3D, sun: THREE.Vector3): number {
    const s = sun.clone().applyQuaternion(group.quaternion.clone().invert());
    return Math.hypot(s.x, s.z);
  }
  function panelNormalWorld(group: THREE.Object3D, panels: THREE.Object3D): THREE.Vector3 {
    return new THREE.Vector3(0, 0, 1)
      .applyEuler(new THREE.Euler(0, panels.rotation.y, 0))
      .applyQuaternion(group.quaternion);
  }

  it("판 법선을 태양 쪽으로 최적 정렬한다", () => {
    const m = buildSatelliteModel("bus", 0x5ce1ff);
    const pos = new THREE.Vector3(7, 0, 0);
    const vel = new THREE.Vector3(0, 0, -0.0075);
    applyNadirAttitude(m.group, pos, vel);

    for (const sun of [
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0.3, 0.5, -0.8).normalize(),
      new THREE.Vector3(-0.6, -0.2, 0.77).normalize(),
    ]) {
      trackSun(m.group, m.panels, sun);
      const got = panelNormalWorld(m.group, m.panels).dot(sun);
      expect(got).toBeCloseTo(maxAchievable(m.group, sun), 6);
    }
    m.dispose();
  });

  it("어떤 회전각도 최적해를 넘지 못한다 (최대성 확인)", () => {
    const m = buildSatelliteModel("bus", 0x5ce1ff);
    applyNadirAttitude(m.group, new THREE.Vector3(0, 6.9, 1.2), new THREE.Vector3(0.007, 0, 0));
    const sun = new THREE.Vector3(0.5, -0.3, 0.81).normalize();
    trackSun(m.group, m.panels, sun);
    const best = panelNormalWorld(m.group, m.panels).dot(sun);

    const saved = m.panels.rotation.y;
    for (let i = 0; i < 64; i++) {
      m.panels.rotation.y = (i / 64) * Math.PI * 2;
      expect(panelNormalWorld(m.group, m.panels).dot(sun)).toBeLessThanOrEqual(best + 1e-9);
    }
    m.panels.rotation.y = saved;
    m.dispose();
  });
});

describe("markerSizing (마커 LOD)", () => {
  const radPerPx = radiansPerPixel(45, 720);

  it("거리와 무관하게 화면상 크기를 일정하게 유지한다", () => {
    const px = (d: number) => markerSizing(d, radPerPx, 0.26).world / d / radPerPx;
    // 지구 근처부터 최대 줌아웃까지 픽셀 크기가 동일해야 한다
    expect(px(10)).toBeCloseTo(px(120), 6);
    expect(px(10)).toBeCloseTo(13, 6); // 기본 markerPx
  });

  it("멀리서는 마커가 완전히 보인다 (회귀 방지: 위성이 사라지면 안 된다)", () => {
    // 기본 카메라 거리(~21)에서 모델은 10 px 남짓이라 어두운 지구에 묻힌다.
    expect(markerSizing(21, radPerPx, 0.26).opacity).toBe(1);
    expect(markerSizing(60, radPerPx, 0.26).opacity).toBe(1);
  });

  it("근접해 모델이 충분히 커지면 마커가 사라진다", () => {
    // 모델이 60 px을 넘는 거리에서는 마커가 완전히 걷힌다
    const near = 0.26 / (60 * radPerPx);
    expect(markerSizing(near * 0.9, radPerPx, 0.26).opacity).toBe(0);
  });

  it("페이드가 단조적이다", () => {
    let prev = -1;
    for (let d = 0.2; d < 30; d *= 1.2) {
      const o = markerSizing(d, radPerPx, 0.26).opacity;
      expect(o).toBeGreaterThanOrEqual(prev - 1e-9); // 멀어질수록 불투명해짐
      prev = o;
    }
  });
});

describe("모델 구성", () => {
  it("NORAD 번호로 변형을 고른다", () => {
    expect(modelKindFor(25544)).toBe("iss");
    expect(modelKindFor(20580)).toBe("hubble");
    expect(modelKindFor(49419)).toBe("bus");
  });

  it("식(eclipse) 전환이 재질을 어둡게 하고 복원한다", () => {
    const m = buildSatelliteModel("bus", 0x5ce1ff);
    const mat = (m.group.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh)
      .material as THREE.MeshStandardMaterial;
    const lit = mat.color.clone();

    m.setIlluminated(false);
    expect(mat.color.r).toBeLessThan(lit.r);

    m.setIlluminated(true);
    expect(mat.color.r).toBeCloseTo(lit.r, 6);
    m.dispose();
  });
});
