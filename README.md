# GeoAerospace — Orbital Command

항공우주 데이터 기반 대화형 지도 제어 플랫폼. 이 리포는 **G1(위성 궤도 구형 시각화)** 수직 슬라이스 구현이다.

- 설계 문서: [`docs/개발제안서.md`](docs/개발제안서.md) · [`docs/설계서.md`](docs/설계서.md)
- 스택: Next.js(App Router) · React 19 · TypeScript · **MapLibre GL JS v5(globe)** · **deck.gl** · **satellite.js(SGP4)** · Zustand

## 현재 구현 (P0 + P1 + P2 + P2.5 + P2.7 + P3 + P4 완료)

- MapLibre v5 **3D 글로브** + 다크 베이스(CARTO, 토큰프리) + **3D 지형**(AWS Terrarium DEM) + 대기(sky)
- **실시간 TLE 수집**(`GET /api/tle`, `get_tle`) — **CelesTrak GP → SatNOGS 폴백**, 4h 캐시, SSRF 가드
- **TLE → SGP4 전파**(satellite.js) → **궤도 링**(고도 유지) + **지상궤적**(±180° 분할) + **위성 실시간 위치**
- **실시간 항공 트래킹**(`GET /api/aircraft`) — **adsb.lol → airplanes.live 폴백**, 7지역 팬아웃, single-flight, 429 쿨다운, 10s 캐시, ICAO 콜사인 분류(상용/개인/제트/군용)
- **dead-reckoning 보간**(대권 전진) + deck.gl `IconLayer`(heading 회전·카테고리 색) — **30fps 렌더 루프**
- deck.gl 발광 궤도 렌더 (`PathLayer`/`ScatterplotLayer`, MapboxOverlay interleaved)
- **Three.js custom layer**(§4.6-A) — MapLibre v5 globe 위 **3D 위성 모델**(본체·태양전지판·안테나) + 추적 대상 **센서 콘**(nadir). `getMatrixForModel` + `defaultProjectionData.mainMatrix`로 객체별 렌더
- **실축척 3D 우주 뷰(P2.7, §4.6-B)** — 뷰 전환("2D 글로브"/"3D 우주 뷰"). 전용 Three.js 씬: **관성계(ECI) 실축척 궤도 타원**(satellite.js ECI 좌표 직접 사용) + 자전하는 지구(GMST) + 대기 프레넬 셰이더 + 별필드 + 센서 콘 + OrbitControls(자유 시점). LEO 궤도가 지구에 밀착한 진짜 축척
- **자연어 지도 제어(P4)** — 로컬 **Qwen3-8B(Ollama)** 백본. 명령 바/챗 → 도구 실행(`fly_to_place`·`select_satellite`·`toggle_layer`). **결정론적 의도 해석 그라운딩 레이어**(§4.5)로 8B 도구선택 변동성 보정 + **지오코딩**(도시 테이블 + Nominatim 폴백)으로 좌표 환각 제거
- **궤도역학 RAG Q&A(P3)** — 지도 명령이 아닌 질문은 `/api/rag`로. **bge-m3(Ollama) 임베딩 + 하이브리드 검색**(코사인 + 어휘 부스트) top-k → **Qwen3 근거 기반 종합**. 지식 코퍼스 14청크(TLE·SGP4·궤도요소·좌표계·데이터소스…), 답변에 근거 출처 표시
- **서버 정확도 CI** — Vallado sgp4-ver 골든 벡터(catalog 00005, <10m/1mm·s) + ISS 불변식 (`npm test`)
- "Orbital Command" HUD: 명령 바 · 레이어 레일 · 추적 텔레메트리 카드 · **GeoAgent 챗 드로어**

## 실행

```bash
# 1) 로컬 LLM (에이전트 백본)
ollama serve            # 별도 터미널 (보통 자동 실행)
ollama pull qwen3:8b    # 최초 1회 (~5GB)
# 2) 앱
npm install
npm run dev             # http://localhost:3000
npm test                # SGP4 정확도 + 궤도 불변식 테스트
```

> 에이전트 예시: "도쿄 상공을 보여줘", "ISS를 추적해줘", "항공기 레이어 꺼줘". Ollama 미실행 시 지도/궤도/항공은 정상 동작하고 챗만 비활성.

## 다음 단계 (설계서 로드맵)

- **P3**: pgvector RAG (bge-m3 임베딩 로컬 보유) — "궤도역학 Q&A"
- **P2.7**: 실축척 3D 궤도 뷰(CesiumJS/R3F) · **P5.5**: GIBS/FIRMS 산불
- 프로덕션: Qwen3-30B-A3B 승급(8B 도구선택 신뢰성 §4.5)
