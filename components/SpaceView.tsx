"use client";

// P2.7 실축척 3D 궤도 뷰 (설계서 §4.6-B) — 관성계(ECI)에 실축척 궤도 타원.
// satellite.js ECI 좌표를 그대로 써서 지구를 자전(GMST)시키고 궤도는 고정 → 진짜 관성계 뷰.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import * as satellite from "satellite.js";
import { useStore } from "@/lib/store";
import { computeOrbit } from "@/lib/orbit";

const KM = 1 / 1000; // km → scene unit (1 unit = 1000 km)
const R_EARTH = 6371 * KM;

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

    // 조명
    scene.add(new THREE.AmbientLight(0x8fb4e8, 0.7));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(30, 10, 20);
    scene.add(sun);

    // 지구 (자전 그룹)
    const earth = new THREE.Group();
    scene.add(earth);
    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH, 64, 48),
      new THREE.MeshStandardMaterial({ color: 0x0c2035, emissive: 0x061423, emissiveIntensity: 0.6, metalness: 0.1, roughness: 0.9 })
    );
    earth.add(globe);
    // 위경도 그리드
    const grid = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.001, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x5ce1ff, wireframe: true, transparent: true, opacity: 0.12 })
    );
    earth.add(grid);

    // 대기 (프레넬 림글로우)
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R_EARTH * 1.03, 64, 48),
      new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color(0x5ce1ff) } },
        vertexShader: `varying vec3 vN; varying vec3 vP;
          void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix*mv; }`,
        fragmentShader: `uniform vec3 uColor; varying vec3 vN; varying vec3 vP;
          void main(){ float rim = 1.0 - max(dot(vN, normalize(-vP)), 0.0); rim = pow(rim, 2.2); gl_FragColor = vec4(uColor*rim, rim*0.9); }`,
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

    // 궤도 + 위성 빌드
    type SatObj = { satrec: satellite.SatRec; mesh: THREE.Mesh; cone: THREE.Mesh; norad: number; color: number };
    const satObjs: SatObj[] = [];
    const orbitGroup = new THREE.Group();
    scene.add(orbitGroup);

    function buildOrbits() {
      // 정리
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
        // 위성 마커
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: col }));
        orbitGroup.add(mesh);
        // 센서 콘 (위성→지구중심)
        const cone = new THREE.Mesh(
          new THREE.ConeGeometry(0.9, 2, 24, 1, true),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })
        );
        cone.visible = false;
        orbitGroup.add(cone);
        satObjs.push({ satrec: o.satrec, mesh, cone, norad: def.noradId, color: col });
      }
    }
    buildOrbits();
    const unsub = useStore.subscribe((s, prev) => {
      if (s.sats !== prev.sats) buildOrbits();
    });

    // 피킹 (위성 클릭 → 선택)
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    function onClick(e: MouseEvent) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(satObjs.map((s) => s.mesh));
      if (hits.length) {
        const found = satObjs.find((s) => s.mesh === hits[0].object);
        if (found) select(found.norad);
      }
    }
    renderer.domElement.addEventListener("click", onClick);

    // 애니메이션
    let raf = 0;
    const loop = () => {
      const now = new Date();
      earth.rotation.y = satellite.gstime(now); // GMST 자전 (관성계 대비)
      const sel = useStore.getState().selectedNorad;
      for (const s of satObjs) {
        const pv = satellite.propagate(s.satrec, now);
        if (pv && pv.position && typeof pv.position !== "boolean") {
          const p = eciToScene(pv.position);
          s.mesh.position.copy(p);
          const isSel = s.norad === sel;
          s.mesh.scale.setScalar(isSel ? 1.8 : 1);
          // 센서 콘: 위성→지구중심 정렬, 높이=고도
          s.cone.visible = isSel;
          if (isSel) {
            const alt = p.length();
            s.cone.position.copy(p).multiplyScalar(0.5); // 위성과 중심 중간
            s.cone.scale.set(1, alt / 2, 1);
            s.cone.lookAt(0, 0, 0);
            s.cone.rotateX(Math.PI / 2);
          }
        }
      }
      controls.update();
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
      cancelAnimationFrame(raf);
      unsub();
      window.removeEventListener("resize", onResize);
      renderer.domElement.removeEventListener("click", onClick);
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, [select]);

  return <div ref={ref} style={{ position: "absolute", inset: 0, background: "#05070f" }} />;
}
