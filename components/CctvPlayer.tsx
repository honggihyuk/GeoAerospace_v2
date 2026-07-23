"use client";

// 도로 CCTV HLS 라이브 플레이어 + 프레임 VLM 판독(차량 혼잡도).
// ITS 스트림(cctvsec.ktict.co.kr)은 CORS(*) 허용이라 프록시 없이 hls.js로 직접 재생.
//   ⚠️ 배포가 HTTPS면 HTTP 스트림은 mixed-content로 차단 → 서버 프록시 필요(추후).
import { useEffect, useRef, useState } from "react";

type Traffic = { road: string; roadSpeed: number; nearAvg: number; dirs: { speed: number }[] };

export default function CctvPlayer({ url, name, lon, lat }: { url: string; name?: string; lon?: number; lat?: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState(false);
  const [blocked, setBlocked] = useState(false); // 자동재생 차단 시 탭-투-플레이
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<Traffic | null>(null);

  const tryPlay = (video: HTMLVideoElement) => {
    video.play().then(
      () => setBlocked(false),
      () => setBlocked(true) // 브라우저 자동재생 정책이 막음 → 사용자 탭 필요
    );
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setErr(false);
    setBlocked(false);
    setAnalysis(null);
    let cancelled = false;
    let hls: import("hls.js").default | null = null;

    (async () => {
      // Safari 등 네이티브 HLS 우선
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        tryPlay(video);
        return;
      }
      const Hls = (await import("hls.js")).default;
      if (cancelled) return;
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, maxBufferLength: 8, liveSyncDurationCount: 3 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setErr(true);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay(video));
        hls.loadSource(url);
        hls.attachMedia(video);
      } else {
        video.src = url; // 최후 시도
        tryPlay(video);
      }
    })();

    return () => {
      cancelled = true;
      if (hls) hls.destroy();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* noop */
      }
    };
  }, [url]);

  // 현재 프레임 캡처 → VLM 차량 혼잡도 판독.
  // hls.js(MSE)는 blob 소스라 캔버스가 오염되지 않고, 네이티브 경로는 crossOrigin='anonymous'로 회피.
  const analyze = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setAnalyzing(true);
    setAnalysis(null);
    setTraffic(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("canvas");
      ctx.drawImage(video, 0, 0);
      const image = canvas.toDataURL("image/jpeg", 0.7).split(",")[1];
      const r = await fetch("/api/analyze-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, name, lon, lat }),
      });
      const j = (await r.json()) as { ok?: boolean; answer?: string; reason?: string; traffic?: Traffic | null };
      setAnalysis(j.ok ? (j.answer ?? "") : `분석 실패: ${j.reason ?? ""}`);
      setTraffic(j.traffic ?? null);
    } catch (e) {
      setAnalysis(`분석 실패: ${String(e)}`);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div>
      <div style={{ position: "relative", width: "100%", aspectRatio: "4 / 3", background: "#000", borderRadius: 6, overflow: "hidden" }}>
        <video ref={videoRef} autoPlay muted playsInline crossOrigin="anonymous" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        {blocked && !err && (
          <button
            onClick={() => videoRef.current && tryPlay(videoRef.current)}
            style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, color: "#fff", background: "rgba(0,0,0,0.35)", border: "none", cursor: "pointer" }}
            aria-label="재생"
          >
            ▶
          </button>
        )}
        {err && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--faint)", textAlign: "center", padding: 10 }}>
            영상을 불러오지 못했습니다
            <br />
            (스트림 만료 시 레이어를 다시 켜세요)
          </div>
        )}
        <span style={{ position: "absolute", top: 6, left: 6, fontSize: 9, fontWeight: 700, letterSpacing: "0.06em", color: "#fff", background: "rgba(220,40,40,0.85)", padding: "1px 5px", borderRadius: 3 }}>
          ● LIVE
        </span>
      </div>

      <button
        onClick={analyze}
        disabled={analyzing || err}
        style={{
          marginTop: 7,
          width: "100%",
          padding: "6px 8px",
          fontSize: 11,
          borderRadius: 6,
          border: "1px solid var(--cyan-dim, #2a6b7a)",
          background: analyzing ? "rgba(92,225,255,0.06)" : "rgba(92,225,255,0.10)",
          color: "var(--cyan, #5CE1FF)",
          cursor: analyzing || err ? "default" : "pointer",
        }}
      >
        {analyzing ? "분석 중… (VLM)" : "🚗 차량 혼잡도 분석"}
      </button>
      {analysis && (
        <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.55, color: "var(--txt)", background: "rgba(255,255,255,0.04)", borderRadius: 6, padding: "7px 8px" }}>
          {analysis}
          {traffic && (
            <div style={{ marginTop: 6, paddingTop: 5, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 9.5, color: "var(--faint)" }}>
              📡 실측 {traffic.road}{" "}
              {traffic.dirs && traffic.dirs.length === 2
                ? `방향별 ${traffic.dirs[0].speed}·${traffic.dirs[1].speed} km/h`
                : `약 ${traffic.roadSpeed} km/h`}{" "}
              · ITS
            </div>
          )}
        </div>
      )}
    </div>
  );
}
