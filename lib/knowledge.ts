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
];
