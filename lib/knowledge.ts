// 궤도역학 지식 코퍼스 (설계서 §4.3 RAG 말뭉치) — 궤도역학·데이터소스 Q&A용.
// 실제 배포는 pgvector에 임베딩; 로컬 슬라이스는 bge-m3 인메모리 검색.

export type Chunk = { id: string; title: string; text: string };

export const KNOWLEDGE: Chunk[] = [
  {
    id: "tle",
    title: "TLE (Two-Line Element)",
    text: "TLE는 위성의 평균 궤도요소를 69자 2줄로 인코딩한 표준 형식으로, 특정 시각(epoch)의 궤도 상태를 담는다. 일반 케플러 요소가 아니라 SGP4 전파 모델 전용으로 피팅된 값이다. NORAD 카탈로그 번호로 식별하며 CelesTrak·Space-Track에서 배포한다. TLE는 하루 약 1~3km씩 오차가 누적되므로 매일 재수집해야 한다.",
  },
  {
    id: "sgp4",
    title: "SGP4 / SDP4 전파 모델",
    text: "SGP4(Simplified General Perturbations 4)는 TLE를 시간 전파해 위성 위치·속도를 구하는 해석적 모델이다. 주기 225분 미만 근지구는 SGP4, 심우주(GEO 등)는 SDP4를 쓴다. J2 지구 편평률·대기 항력 등 섭동을 반영하며 출력은 TEME 관성계다. 현대 표준 구현은 Vallado 등의 'Revisiting Spacetrack Report #3'(2006)이며, satellite.js·Skyfield가 이를 포팅했다.",
  },
  {
    id: "elements",
    title: "궤도 6요소 (케플러 요소)",
    text: "궤도는 6개 요소로 정의된다: 경사각(inclination, 궤도면과 적도면 각도), 승교점 적경(RAAN, 궤도면 방향), 이심률(eccentricity, 타원 찌그러짐), 근지점 편각(argument of perigee), 평균 근점이각(mean anomaly, 궤도상 위치), 평균 운동(mean motion, 하루 공전수).",
  },
  {
    id: "inclination",
    title: "경사각과 궤도 종류",
    text: "경사각은 궤도면이 적도면과 이루는 각이다. 0°는 적도 궤도, 90°는 극궤도다. 약 98°의 역행 궤도는 태양동기궤도(SSO)로, 지구 편평률에 의한 세차가 태양을 따라가 항상 같은 지방시에 통과한다. ISS는 51.6°, 정지궤도는 0°에 가깝다.",
  },
  {
    id: "period",
    title: "궤도 주기와 케플러 제3법칙",
    text: "궤도 주기는 T = 2π√(a³/μ)로, a는 궤도 장반경, μ는 지구 중력상수(398600 km³/s²)다. TLE의 평균 운동 n(하루 공전수)으로부터 주기(분) = 1440 / n으로 구한다. 예: ISS는 평균 운동 약 15.5로 주기 92.9분, 고도 약 400km다. 고도가 높을수록 주기가 길어진다.",
  },
  {
    id: "groundtrack",
    title: "지상궤적과 부위성점",
    text: "부위성점(sub-satellite point)은 위성 바로 아래 지표의 측지 좌표다. 이를 한 주기 이상 이으면 지상궤적이 되고, 지구가 자전하므로 매 공전마다 서쪽으로 밀려 특유의 사인파형을 그린다. 궤도 링은 고도를 유지한 3D 궤도이고, 지상궤적은 그 지표 투영이다.",
  },
  {
    id: "regimes",
    title: "궤도 고도 구분 (LEO/MEO/GEO/SSO)",
    text: "LEO(저궤도)는 고도 약 160~2000km로 ISS·Starlink가 속한다. MEO(중궤도)는 GPS 등 약 20000km. GEO(정지궤도)는 적도 상공 35786km로 지구 자전과 동기해 한 지점에 고정돼 보인다. SSO(태양동기궤도)는 약 600~800km의 극궤도로 지구관측 위성이 많다.",
  },
  {
    id: "frames",
    title: "좌표계 변환 (ECI/ECEF/측지)",
    text: "SGP4 출력은 관성계 ECI(TEME)다. 이를 지구고정계 ECEF로 바꾸려면 지구 자전각 GMST(그리니치 평균 항성시)만큼 Z축 회전한다. 이어 WGS-84 타원체 역변환으로 경위도·고도(측지 좌표)를 얻는다. satellite.js의 eciToEcf·ecfToGeodetic가 이 과정을 수행한다.",
  },
  {
    id: "pass",
    title: "위성 통과 예측 (pass)",
    text: "통과는 특정 지상국에서 위성이 지평선 위로 보이는 구간이다. 위성 위치와 관측지의 상대 벡터로 앙각(elevation)과 방위각을 구하고, 앙각이 0° 이상인 시간대가 가시 통과다. 앙각이 높을수록 통신·관측에 유리하다. 통과 예측은 SGP4로 위성을 전파하며 계산한다.",
  },
  {
    id: "adsb",
    title: "항공기 추적 (ADS-B)",
    text: "ADS-B는 항공기가 GNSS로 얻은 위치를 초당 1회 1090MHz로 자발 방송하는 방식이다. ICAO 24비트 주소, 위경도, 고도, 지상속도, 침로(heading)를 포함한다. 오픈 데이터 소스로 OpenSky Network, adsb.lol, airplanes.live가 있다. 갱신 간격이 커서 렌더 시 dead-reckoning으로 보간한다.",
  },
  {
    id: "gibs",
    title: "NASA GIBS 위성 영상",
    text: "GIBS(Global Imagery Browse Services)는 NASA의 위성 영상 타일 서비스로, WMTS 표준으로 1000+ 레이어를 제공한다. TIME 파라미터로 시계열을 지원해 날짜별 영상을 볼 수 있다. MODIS·VIIRS TrueColor 등이 있으며 토큰 없이 사용 가능하다. 값이 픽셀에 구워져 있어 시각화에 적합하다.",
  },
  {
    id: "firms",
    title: "NASA FIRMS 산불 탐지",
    text: "FIRMS는 위성 열적외 관측으로 활성 화재를 탐지해 포인트로 제공한다. VIIRS·MODIS 소스가 있고 각 탐지는 FRP(화재복사강도, MW=화재 강도)와 confidence(확실성)를 갖는다. GIBS가 '보여주기'라면 FIRMS는 위치·강도로 '필터·분석'하는 데이터다.",
  },
  {
    id: "sources",
    title: "궤도 데이터 소스",
    text: "CelesTrak은 무료·무인증 GP API로 TLE/OMM을 그룹·NORAD별로 제공하는 1차 소스다. Space-Track은 미 우주군의 권위 있는 카탈로그로 계정이 필요하다. SatNOGS DB는 커뮤니티 소스로 폴백에 쓴다. 네트워크에서 한 소스가 막히면 다른 소스로 회복탄력적으로 폴백한다.",
  },
  {
    id: "viz",
    title: "웹 궤도 시각화",
    text: "브라우저에서 satellite.js로 SGP4를 매 프레임 전파해 위성 현재 위치를 얻고, 한 주기를 샘플링해 궤도 링과 지상궤적을 만든다. MapLibre GL v5의 3D 글로브 위에 deck.gl(PathLayer·IconLayer)로 대량 객체를, Three.js custom layer로 3D 위성 모델과 센서 콘을 렌더한다.",
  },
  {
    id: "sar-backscatter",
    title: "SAR 후방산란 (진폭)",
    text: "SAR(합성개구레이더)는 마이크로파를 쏘아 지표에서 되돌아온 신호를 영상화한다. 후방산란(backscatter) 진폭은 표면의 거칠기·구조를 나타내 도시·금속 구조물은 밝고 잔잔한 수면은 어둡게 찍힌다. Sentinel-1은 C-band VV/VH 편파를 IW 모드로 관측하며 GRD 산출물이 진폭 영상이다. 진폭은 표면 상태·홍수·변화 탐지에 쓰지만 지표 변위(침하)는 측정하지 못한다 — 그것은 위상(phase) 정보가 필요하다.",
  },
  {
    id: "insar",
    title: "InSAR 지반침하 측정",
    text: "InSAR(간섭 SAR)는 서로 다른 시각에 관측한 두 SAR 영상의 위상차로 지표 변위를 밀리미터 단위로 측정한다. DInSAR는 두 시기 차분으로 지진·화산·침하 변형을, PS-InSAR·SBAS는 다중시기(수십~수백 장) 시계열로 연간 침하속도(mm/yr)를 산출한다. 입력은 진폭이 아닌 SLC(Single Look Complex, 위상 보존) 산출물이며 SNAP·MintPy·pyroSAR로 처리한다. 처리가 무거워(GB급·수 시간) 실시간 웹이 아니라 배치로 사전계산해 결과 변위점만 소비한다.",
  },
  {
    id: "s2cloudless",
    title: "Sentinel-2 Cloudless (EOX)",
    text: "Sentinel-2 Cloudless는 EOX가 1년치 Sentinel-2 관측을 합성해 구름을 제거한 전지구 무구름 트루컬러 모자이크다. 약 10m 해상도로 BlueMarble(약 500m)보다 훨씬 정밀해 도시·해안·지형 질감이 또렷하다. WMTS 타일(s2maps.eu)로 제공되며 정적 합성이라 궤도 스와스·구름 이음매가 없어 베이스맵에 적합하다. 비상업·저부하 용도는 무료이며 Copernicus 데이터 출처 표기가 필요하다.",
  },
  {
    id: "sentinel5p",
    title: "Sentinel-5P 대기질 (NO₂/CO)",
    text: "Sentinel-5P의 TROPOMI 센서는 대기 미량기체의 연직 컬럼 농도를 관측한다. NO₂는 자동차·발전 연소의 지표로 도시·산업지역에서 높고, CO·SO₂·O₃·메탄도 제공한다. '컬럼 농도'는 지표부터 대기 상단까지 단위면적당 분자 총량(mol/m²)으로 지상 관측소 농도와는 다른 물리량이다. NASA GIBS 오버레이나 CDSE로 접근하며 도시 대기질·오염원 추적에 쓴다.",
  },
  {
    id: "lst",
    title: "지표면온도(LST)와 도시 열섬",
    text: "LST(Land Surface Temperature)는 위성 열적외 밴드로 측정한 지표 표면의 온도로, 기상관측소의 기온(공기 온도)과 다르다. 도심 콘크리트·아스팔트는 주변 녹지·수변보다 LST가 높아 도시 열섬(UHI) 현상이 LST 지도에서 선명하게 드러난다. MODIS·VIIRS·Landsat이 LST를 제공하며 NASA GIBS에 래스터 레이어로 있다. 산불 열이상·폭염 취약지 분석에 활용한다.",
  },
  {
    id: "dem-glo30",
    title: "Copernicus DEM GLO-30",
    text: "Copernicus DEM GLO-30은 TanDEM-X 레이더로 만든 전지구 30m 수치표고모델(DSM)로 무료 개방돼 있다. 오픈 기본값인 AWS Terrarium 타일보다 한반도 지형을 더 정밀·최신으로 표현해 3D 지형·큐브 고도의 프리미엄 소스로 쓴다. DSM이라 건물·수목 표고를 포함하며 지표만의 표고인 DTM과 구분된다. MapLibre setTerrain의 raster-dem 소스로 드레이프한다.",
  },
  {
    id: "vworld",
    title: "VWorld 정사영상",
    text: "VWorld는 국토교통부가 운영하는 대한민국 공간정보 오픈플랫폼으로 고해상도 항공 정사영상(Satellite/Ortho)을 WMTS 타일로 제공한다. 정사영상은 지형·촬영각 왜곡을 보정해 지도처럼 정확한 위치로 정렬된 영상이라 시설·건물 판독에 적합하다. 인증키는 도메인 제한(Referer 검사)이 있어 서버 프록시로 Referer를 실어 호출한다. 한반도 한정 고해상도라 전지구 Sentinel-2보다 국내 상세 관측에 유리하다.",
  },
  {
    id: "stac",
    title: "STAC 위성영상 카탈로그",
    text: "STAC(SpatioTemporal Asset Catalog)은 위성영상 장면을 시공간·속성으로 검색하는 표준 API다. bbox·날짜범위·구름비율 등으로 조건에 맞는 장면(Item)을 질의해 임의 날짜의 Sentinel-2/1 영상을 찾을 수 있다. Element84(earth-search)와 Copernicus(CDSE) STAC가 대표 엔드포인트다. RAG의 '검색' 관점에서 픽셀을 임베딩하는 대신 장면 메타데이터를 카탈로그 쿼리로 찾는 검색 레인에 해당한다.",
  },
  {
    id: "openaq",
    title: "OpenAQ 지상 대기질",
    text: "OpenAQ는 전 세계 지상 관측소의 대기질 측정값(PM2.5·PM10·NO₂·O₃·CO 등)을 통합 제공하는 오픈 데이터 플랫폼이다. 위성 컬럼 농도(Sentinel-5P)와 달리 지표 근처 실측 농도라 사람이 실제 호흡하는 공기질에 가깝다. 위경도·시각을 가진 포인트 데이터라 FIRMS 화재처럼 벡터로 필터·분석하는 데이터다. 위성 컬럼과 지상 실측을 교차하면 오염원과 노출을 함께 볼 수 있다.",
  },
];
