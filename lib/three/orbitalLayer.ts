// MapLibre v5 globe 위 Three.js custom layer (설계서 §4.6-A)
// 3D 위성 모델 + 추적 대상 센서 콘. 위치 국소 객체만 담당(궤도 링은 deck.gl).
// 핵심: camera.projectionMatrix = mainMatrix ⊗ getMatrixForModel(origin) 로 객체별 렌더.
import * as THREE from "three";
import type { CustomLayerInterface, Map as MLMap } from "maplibre-gl";

export type SatView = {
  lng: number;
  lat: number;
  alt: number; // m
  color: [number, number, number];
  sel: boolean;
};

const CONE_H0 = 400_000; // 기준 콘 높이(m) — 렌더 시 고도로 스케일

export function createOrbitalLayer(getSats: () => SatView[]): CustomLayerInterface {
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.Camera;
  let satGroup: THREE.Group; // 재사용 위성 모델
  let bodyMat: THREE.MeshStandardMaterial;
  let cone: THREE.Mesh;
  let coneMat: THREE.MeshBasicMaterial;
  let mapRef: MLMap;

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

    return g;
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

      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
      renderer.autoClear = false;
    },

    render(_gl: WebGLRenderingContext, args: unknown) {
      const transform = mapRef.transform as unknown as { getMatrixForModel?: (l: [number, number], alt: number) => number[] };
      if (typeof transform.getMatrixForModel !== "function") return; // globe custom-layer 미지원 시 skip

      // v5: args.defaultProjectionData.mainMatrix / 구버전: matrix 배열
      const a = args as { defaultProjectionData?: { mainMatrix: number[] } };
      const mainArr = a?.defaultProjectionData?.mainMatrix ?? (args as number[]);
      const mainMatrix = new THREE.Matrix4().fromArray(mainArr);

      const sats = getSats();
      renderer.resetState();

      const modelM = new THREE.Matrix4();
      for (const s of sats) {
        const m = transform.getMatrixForModel!([s.lng, s.lat], s.alt);
        modelM.fromArray(m);
        camera.projectionMatrix.copy(mainMatrix).multiply(modelM);

        // 색/강조
        bodyMat.emissiveIntensity = s.sel ? 1.0 : 0.5;
        coneMat.color.setRGB(s.color[0] / 255, s.color[1] / 255, s.color[2] / 255);
        cone.visible = s.sel; // 센서 콘은 추적 대상만
        const scale = Math.max(0.3, s.alt / CONE_H0);
        cone.scale.set(scale, scale, scale);

        renderer.render(scene, camera);
      }
    },
  };
}
