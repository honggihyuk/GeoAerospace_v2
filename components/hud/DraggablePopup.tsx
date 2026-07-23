"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 드래그 이동 + 접기/펼치기 팝업 (CCTV 팝업의 드래그 + GeoAgent의 접기 패턴 통합).
 * 헤더를 잡고 이동, 헤더의 –/+로 접고, ✕로 닫는다. 기본 위치는 defaultLeft/Top으로 겹치지 않게 준다.
 */
export default function DraggablePopup({
  title,
  accent = "var(--accent, #5CE1FF)",
  defaultLeft,
  defaultTop,
  width = 240,
  zIndex = 28,
  onClose,
  children,
}: {
  title: ReactNode;
  accent?: string;
  defaultLeft: number;
  defaultTop: number;
  width?: number;
  zIndex?: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: defaultLeft, top: defaultTop });
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

  return (
    <div className="glass" style={{ position: "absolute", left: pos.left, top: pos.top, zIndex, width, padding: "10px 12px" }}>
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
