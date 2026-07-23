"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** 기본 위치 앵커 — left/right/top/bottom 조합(px). 드래그하면 left/top 절대좌표로 전환된다. */
export type Anchor = { left?: number; right?: number; top?: number; bottom?: number };

/**
 * 드래그 이동 + 접기/펼치기 팝업 (CCTV 팝업의 드래그 + GeoAgent의 접기 패턴 통합).
 * 헤더를 잡고 이동, 헤더의 –/+로 접고, ✕로 닫는다. 기본 위치는 defaultPos(앵커)로 주며
 * bottom/right 앵커를 쓰면 창 크기가 바뀌어도 그 모서리에 붙어 있다(드래그 전까지).
 */
export default function DraggablePopup({
  title,
  accent = "var(--accent, #5CE1FF)",
  defaultPos,
  width = 240,
  zIndex = 28,
  onClose,
  children,
}: {
  title: ReactNode;
  accent?: string;
  defaultPos: Anchor;
  width?: number;
  zIndex?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null); // null = 기본 앵커, 드래그하면 절대좌표
  const [collapsed, setCollapsed] = useState(false);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (d) setPos({ left: e.clientX - d.ox, top: e.clientY - d.oy });
    };
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  const posStyle: React.CSSProperties = pos ? { left: pos.left, top: pos.top } : { ...defaultPos };

  return (
    <div className="glass" style={{ position: "absolute", ...posStyle, zIndex, width, padding: "10px 12px" }}>
      <div
        onMouseDown={(e) => {
          const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          dragRef.current = { ox: e.clientX - box.left, oy: e.clientY - box.top };
        }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, cursor: "move", userSelect: "none" }}
      >
        <b style={{ fontSize: 12.5, color: accent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</b>
        <span style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
          <span
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setCollapsed((c) => !c)}
            style={{ cursor: "pointer", color: "var(--faint)", fontSize: 14, lineHeight: 1 }}
            title={collapsed ? "펼치기" : "접기"}
          >
            {collapsed ? "+" : "–"}
          </span>
          <span
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            style={{ cursor: "pointer", color: "var(--faint)", fontSize: 12 }}
            title="닫기"
          >
            ✕
          </span>
        </span>
      </div>
      {!collapsed && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}
