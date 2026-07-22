-- 레인 ①↔② 브리지: 지역 요약카드
-- observations(레인②)를 종류별로 집계한 텍스트 카드를 임베딩(레인①)해 저장.
-- 의미검색이 개념 doc과 함께 이 카드를 회수 → "서울 대기질" 질의가 실측 수치로 그라운딩된다.
CREATE TABLE IF NOT EXISTS region_cards (
  id           text PRIMARY KEY,             -- 'card:서울' 등 (지역별 안정 id → 재생성 시 upsert)
  place        text NOT NULL,
  footprint    geometry(Polygon, 4326),      -- 카드가 요약한 bbox
  body         text NOT NULL,                -- 카드 본문 (임베딩 대상)
  embedding    vector(1024),                 -- bge-m3
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS region_cards_footprint_gist ON region_cards USING gist (footprint);
