-- LGND Clay v1.5 지구관측 임베딩 (광역 토지변화 스캔) — 256차원.
--   같은 cell_id의 두 시점(ym)을 pgvector `<=>` 코사인으로 조인해 변화를 잰다.
--   조회 시 240MB parquet 다운로드가 사라지고(사전 적재), 코사인은 DB가 계산한다.
CREATE TABLE IF NOT EXISTS clay_cells (
  cell_id    text NOT NULL,               -- 셀 고유 해시(시점 간 동일 → 조인 키)
  ym         text NOT NULL,               -- 시점 'YYYY-MM'
  geohash    text NOT NULL,               -- precision-2 파티션(적재 관리용)
  geom       geometry(Point, 4326) NOT NULL, -- 셀 중심(1.28km)
  embedding  vector(256) NOT NULL,        -- Clay 임베딩
  PRIMARY KEY (cell_id, ym)
);

-- bbox 공간 필터(변화 스캔은 항상 AOI로 좁힌다).
CREATE INDEX IF NOT EXISTS clay_cells_geom_gist ON clay_cells USING gist (geom);
-- 시점 조인.
CREATE INDEX IF NOT EXISTS clay_cells_ym_idx ON clay_cells (ym);
-- ⚠️ ANN 인덱스(ivfflat/hnsw)는 **두지 않는다** — 변화 탐지는 최근접 이웃 검색이 아니라
--    같은 cell_id 쌍의 정확한 코사인이라 근사 인덱스가 무의미하고, GIST로 AOI를 좁힌 뒤
--    소수 셀만 계산하므로 seq가 오히려 정확·충분하다.
