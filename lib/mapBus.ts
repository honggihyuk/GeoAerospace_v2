// 지도 인스턴스 싱글턴 — 에이전트 executor가 지도를 조작할 수 있게 연결 (설계서 §7.2)
import type { Map as MLMap } from "maplibre-gl";

let _map: MLMap | null = null;

export const mapBus = {
  set(m: MLMap | null) {
    _map = m;
  },
  flyTo(lng: number, lat: number, zoom = 3.5) {
    _map?.flyTo({ center: [lng, lat], zoom, speed: 0.9, curve: 1.4, essential: true });
  },
};
