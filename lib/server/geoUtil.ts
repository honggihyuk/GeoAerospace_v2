// 공유 지오메트리 유틸 — 래스터 I/O 없는 순수 기하 계산.

export type Bbox = [number, number, number, number]; // [w, s, e, n]

/**
 * AOI 대비 장면(footprint bbox)의 커버리지 비율 0~1.
 * 사각형 교차만 쓰므로 **래스터를 열지 않고** 결정론적으로 계산된다 →
 * 같은 AOI에는 항상 같은 장면이 선택된다(재현성).
 * ⚠️ 실제 STAC footprint는 회전된 다각형이라 bbox 교차는 약간의 과대추정이다.
 *    장면 "선택" 용도로는 충분하지만 면적 산출에는 쓰지 말 것.
 */
export function bboxCoverage(aoi: Bbox, item: number[]): number {
  if (!item || item.length < 4) return 0;
  const w = Math.max(0, Math.min(aoi[2], item[2]) - Math.max(aoi[0], item[0]));
  const h = Math.max(0, Math.min(aoi[3], item[3]) - Math.max(aoi[1], item[1]));
  const area = (aoi[2] - aoi[0]) * (aoi[3] - aoi[1]);
  return area > 0 ? Math.min(1, (w * h) / area) : 0;
}
