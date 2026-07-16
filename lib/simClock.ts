// 가상 시뮬레이션 시계 (B2 타임 컨트롤러) — 재생/일시정지/배속/스크럽.
// 모듈 싱글턴. 위성 전파는 이 시각을 기준으로 한다(실시간=1×, 가속·과거·예측 가능).
let anchorReal = Date.now();
let anchorSim = Date.now();
let rate = 1;
let paused = false;

function reanchor() {
  anchorSim = current();
  anchorReal = Date.now();
}
function current(): number {
  return paused ? anchorSim : anchorSim + (Date.now() - anchorReal) * rate;
}

export const simClock = {
  now: () => current(),
  nowDate: () => new Date(current()),
  offsetMs: () => current() - Date.now(),
  getRate: () => rate,
  isPaused: () => paused,
  setRate(r: number) {
    reanchor();
    rate = r;
  },
  setPaused(p: boolean) {
    reanchor();
    paused = p;
  },
  seek(deltaMs: number) {
    reanchor();
    anchorSim += deltaMs;
  },
  reset() {
    anchorReal = Date.now();
    anchorSim = Date.now();
    rate = 1;
    paused = false;
  },
};
