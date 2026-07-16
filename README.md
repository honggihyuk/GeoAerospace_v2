# GeoAerospace — Orbital Command

항공우주 데이터 기반 대화형 지도 제어 플랫폼. 이 리포는 **G1(위성 궤도 구형 시각화)** 수직 슬라이스 구현이다.

- 설계 문서: [`docs/개발제안서.md`](docs/개발제안서.md) · [`docs/설계서.md`](docs/설계서.md)
- 스택: Next.js(App Router) · React 19 · TypeScript · **MapLibre GL JS v5(globe)** · **deck.gl** · **satellite.js(SGP4)** · Zustand

## 현재 구현 (P0 + P1 + P2 완료)

- MapLibre v5 **3D 글로브** + 다크 베이스(CARTO, 토큰프리) + **3D 지형**(AWS Terrarium DEM) + 대기(sky)
- **실시간 TLE 수집**(`GET /api/tle`, `get_tle`) — **CelesTrak GP → SatNOGS 폴백**, 4h 캐시, SSRF 가드
- **TLE → SGP4 전파**(satellite.js) → **궤도 링**(고도 유지) + **지상궤적**(±180° 분할) + **위성 실시간 위치**
- **실시간 항공 트래킹**(`GET /api/aircraft`) — **adsb.lol → airplanes.live 폴백**, 7지역 팬아웃, single-flight, 429 쿨다운, 10s 캐시, ICAO 콜사인 분류(상용/개인/제트/군용)
- **dead-reckoning 보간**(대권 전진) + deck.gl `IconLayer`(heading 회전·카테고리 색) — **30fps 렌더 루프**
- deck.gl 발광 궤도 렌더 (`PathLayer`/`ScatterplotLayer`, MapboxOverlay interleaved)
- **서버 정확도 CI** — Vallado sgp4-ver 골든 벡터(catalog 00005, <10m/1mm·s) + ISS 불변식 (`npm test`)
- "Orbital Command" HUD: 명령 바(TLE LIVE) · 레이어 레일(항공 대수 라이브) · 추적 텔레메트리 카드

## 실행

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # SGP4 정확도 + 궤도 불변식 테스트
```

## 다음 단계 (설계서 로드맵)

- **P2.5**: Three.js custom layer(glTF 위성·궤도 튜브·센서 콘)
- **P3/P4**: pgvector RAG + deepagents(Qwen3) 자연어 지도 제어 + 명령 바 연동
