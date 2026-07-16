import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "GeoAerospace — Orbital Command",
  description: "항공우주 데이터 기반 대화형 지도 제어 플랫폼 · 위성 궤도 시각화",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
