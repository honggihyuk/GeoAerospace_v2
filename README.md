# GeoAerospace — Orbital Command

항공우주·지구관측·교통 데이터 기반 **대화형 지도 제어 플랫폼**. 위성 궤도 시각화에서 시작해 실시간 교통(경찰청/ITS)과 Sentinel-2 위성영상 분석까지 확장했다.

- 설계 문서: [`docs/개발제안서.md`](docs/개발제안서.md) · [`docs/설계서.md`](docs/설계서.md)
- 구현 정리: [지구관측 분석](docs/2026-07-24_Sentinel2_지구관측_분석_구현정리.md) · [UTIC 교통데이터](docs/2026-07-23_UTIC_경찰청교통데이터_통합_구현정리.md) · [데이터 플랫폼·RAG](docs/2026-07-23_데이터플랫폼_RAG_CCTV교통_구현정리.md)
- 사용 가이드: [LLM 질문 프롬프트 가이드](docs/LLM_질문_프롬프트_가이드.md)
- 스택: Next.js(App Router) · React 19 · TypeScript · **MapLibre GL JS v5(globe)** · **deck.gl** · **satellite.js(SGP4)** · **PostGIS + pgvector** · **Ollama(Qwen3-8B/qwen2.5vl/bge-m3)** · Zustand

**핵심 설계 원칙**: 계산은 전부 **결정론적 도구**가 하고, LLM은 도구가 반환한 값을 **서술만** 한다(수치 환각 차단). VLM은 픽셀 시각 판단만.

## 현재 구현

### 위성·항공 (G1 수직 슬라이스)

- MapLibre v5 **3D 글로브** + 다크 베이스(CARTO, 토큰프리) + **3D 지형**(AWS Terrarium DEM) + 대기(sky)
- **실시간 TLE 수집**(`GET /api/tle`, `get_tle`) — **CelesTrak GP → SatNOGS 폴백**, 4h 캐시, SSRF 가드
- **TLE → SGP4 전파**(satellite.js) → **궤도 링**(고도 유지) + **지상궤적**(±180° 분할) + **위성 실시간 위치**
- **실시간 항공 트래킹**(`GET /api/aircraft`) — **adsb.lol → airplanes.live 폴백**, 7지역 팬아웃, single-flight, 429 쿨다운, 10s 캐시, ICAO 콜사인 분류(상용/개인/제트/군용)
- **dead-reckoning 보간**(대권 전진) + deck.gl `IconLayer`(heading 회전·카테고리 색) — **30fps 렌더 루프**
- deck.gl 발광 궤도 렌더 (`PathLayer`/`ScatterplotLayer`, MapboxOverlay interleaved)
- **Three.js custom layer**(§4.6-A) — MapLibre v5 globe 위 **3D 위성 모델**(본체·태양전지판·안테나) + 추적 대상 **센서 콘**(nadir). `getMatrixForModel` + `defaultProjectionData.mainMatrix`로 객체별 렌더
- **실축척 3D 우주 뷰(P2.7, §4.6-B)** — 뷰 전환("2D 글로브"/"3D 우주 뷰"). 전용 Three.js 씬: **관성계(ECI) 실축척 궤도 타원**(satellite.js ECI 좌표 직접 사용) + 자전하는 지구(GMST) + 대기 프레넬 셰이더 + 별필드 + 센서 콘 + OrbitControls(자유 시점). LEO 궤도가 지구에 밀착한 진짜 축척
- **고도화 — 정확도·실시간(구상 §D)**:
  - **TLE 나이/추정오차 배지** — 위성 epoch로 실제 나이 계산(<2d 녹/2~7d 황/>7d 적) + ±km 추정오차. 캐시 4h→2h
  - **실시간 주야 터미네이터 + 식(eclipse)** — 태양 ECI 위치로 3D 지구 조명(터미네이터), 위성이 지구 그림자에 들면 어둡게. TrackCard 일조/식 표시
  - **타임 컨트롤러** — 재생/일시정지/**배속(1×·60×·3600×)**/±1h 스크럽. 가상 시계(`simClock`)가 위성 전파·시각을 구동
- **자연어 지도 제어(P4)** — 로컬 **Qwen3-8B(Ollama)** 백본. 명령 바/챗 → 도구 실행(`fly_to_place`·`select_satellite`·`toggle_layer`). **결정론적 의도 해석 그라운딩 레이어**(§4.5)로 8B 도구선택 변동성 보정 + **지오코딩**(도시 테이블 + Nominatim 폴백)으로 좌표 환각 제거
- **궤도역학 RAG Q&A(P3)** — 지도 명령이 아닌 질문은 `/api/rag`로. **bge-m3(Ollama) 임베딩 + 하이브리드 검색**(코사인 + 어휘 부스트) top-k → **Qwen3 근거 기반 종합**. 지식 코퍼스 14청크(TLE·SGP4·궤도요소·좌표계·데이터소스…), 답변에 근거 출처 표시
- **서버 정확도 CI** — Vallado sgp4-ver 골든 벡터(catalog 00005, <10m/1mm·s) + ISS 불변식 (`npm test`)
- "Orbital Command" HUD: 명령 바 · **접이식 레이어 레일** · 추적 텔레메트리 카드 · **GeoAgent 챗 드로어** · 드래그·접기 팝업

### 실시간 교통 (경찰청 UTIC · 국토부 ITS)
- **도로 CCTV 16,910개** — ITS(고속도로·국도, HLS+VLM 판독) + UTIC(도심·지자체 5,974개 순증, JSP 플레이어 iframe). ⚠️UTIC 목록은 Referer 인증·중간인증서 누락(node:https 우회)
- **실시간 돌발정보** — ITS `eventInfo`(사고·공사·통제), 종류별 색 마커 + 3분 갱신. 서버 IP 등록 불필요
- **신호제어 교차로** — 경찰청 신호개방(data.go.kr `CrossRoadInfoService`), 서울 398개. 좌표 ÷1e7 정규화
- CCTV 차량 혼잡도 **VLM 판독**(qwen2.5vl) + 표준노드링크 방면별 실측 속도 그라운딩

### 지구관측 분석 (Sentinel-2 — 결정론 지오분석)
> AWS `sample-geospatial-agent-on-aws` 철학 이식. Python 없이 **순수 Node**(geotiff.js COG Range 읽기 · sharp PNG · proj4).
- **분광지수 NDVI/NDWI/NBR** — STAC 결정론적 장면 선택(커버리지·구름 재시도) → COG 창 읽기 → 면적·분류. **실제 폴리곤 클리핑**(Nominatim). 컬러맵 PNG 오버레이(TiTiler 불필요)
- **두 시점 변화탐지** — Tier1 합성 + **dNBR 연소 심각도**(Dixie Fire·Pacific Palisades 실증)
- **지수 2시점 비교** — 가뭄 전후 **SCL 수체 면적**(폴섬호 25→37km²)
- **광역 토지변화 스캔** — LGND **Clay v1.5 임베딩** 코사인 유사도(1.28km 셀), 지역 적응형 캘리브레이션. 서울 2019→2024 개발전선(남양주·검단) 적중. **pgvector 적재**로 조회 55초→0.5초
- **지오코딩 교차검증** — 면적 과도 오매칭 기각(엉뚱한 지역 분석 차단)

### RAG·관측 데이터 (3-레인)
- **궤도역학 RAG Q&A** — bge-m3 임베딩 + 하이브리드 검색 → Qwen3 근거 종합
- **PostGIS 공간검색** — FIRMS 화재·OpenAQ 대기질·InSAR 지반운동 인제스트 + `describe_region` 온디맨드 브리핑
- **GIBS/GK2A 위성영상** 오버레이 + 산불 3계층(FIRMS 포인트 → 맥락영상 → VLM 해석)
- ⚠️ **Ollama num_ctx** — 미지정 시 2050토큰에서 조용히 절단·환각. `lib/server/llm.ts` 단일 창구로 강제

## 실행

```bash
# 1) 로컬 LLM (에이전트 백본)
ollama serve            # 별도 터미널 (보통 자동 실행)
ollama pull qwen3:8b bge-m3 qwen2.5vl:7b   # LLM·임베딩·VLM
# 2) DB (선택 — 공간검색/RAG 카드. 미기동 시 인메모리 폴백)
docker compose up -d    # PostGIS + pgvector (호스트 포트 5433)
# 3) 앱
npm install
npm run dev             # http://localhost:3000
npm test                # SGP4 정확도 + 궤도 불변식 테스트
```

**환경변수(`.env.local`, 전부 선택 — 없으면 데모키/폴백)**: `ITS_API_KEY`(CCTV·돌발) · `UTIC_API_KEY`(경찰청, 서버IP 등록 필요) · `DATA_GO_KR_SIGNAL_KEY`(신호개방) · `KMA_SERVICE_KEY`(GK2A) · `OPENAQ_API_KEY` · `VWORLD_KEY` · `DATABASE_URL`

> **에이전트 예시**: "도쿄 상공을 보여줘" · "ISS를 추적해줘" · "**서울 식생 알려줘**" · "**강릉 산불 피해 2022-03-03 2022-03-20**" · "**폴섬호 수면 2021-09-15 2022-09-15 비교**". 전체 트리거는 [프롬프트 가이드](docs/LLM_질문_프롬프트_가이드.md) 참고.
> Ollama 미실행 시 지도/궤도/항공/교통/지수는 정상 동작하고 자연어 챗만 비활성.

## 다음 단계

- Clay 적재 자동화(미적재 시 백그라운드 인제스트) · 변화 오버레이 육안 검증
- 변화 diff 오버레이 · 대화 이력(현재 단일턴) · iMAD Tier 2
- 프로덕션: Qwen3-30B-A3B 승급(8B 도구선택 신뢰성 §4.5) · HTTPS 배포 HLS 프록시
