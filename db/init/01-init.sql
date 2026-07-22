-- GeoAerospace 스키마 (설계서 §4.3 RAG · 3-레인 검색 백엔드)
-- 이 파일은 데이터 볼륨이 비어 있는 최초 기동 시 1회만 실행된다.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 레인 ① 의미검색: 지식 청크 (bge-m3 = 1024차원) ──────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id        text PRIMARY KEY,
  title     text NOT NULL,
  body      text NOT NULL,
  embedding vector(1024)
);
-- 청크가 수십 개 규모라 seq scan 이 오히려 빠르고 정확 → ivfflat/hnsw 인덱스는
-- 코퍼스가 수천+ 로 커질 때 도입(그때 lists/probes 튜닝). 지금은 생략.

-- ── 레인 ② 공간검색: 관측 포인트 (FIRMS·OpenAQ·InSAR 변위점 등) ─────────────
CREATE TABLE IF NOT EXISTS observations (
  id          bigserial PRIMARY KEY,
  source      text NOT NULL,                 -- 'firms' | 'openaq' | 'insar' ...
  kind        text NOT NULL,                 -- 'fire' | 'no2' | 'subsidence' ...
  geom        geometry(Point, 4326) NOT NULL,
  value       double precision,              -- 대표 수치 (FRP MW, 농도, mm/yr ...)
  unit        text,
  props       jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS observations_geom_gist ON observations USING gist (geom);
CREATE INDEX IF NOT EXISTS observations_kind_idx  ON observations (kind);
-- 같은 관측을 중복 인제스트하지 않도록 (소스·종류·위치·시각) 유일 제약.
CREATE UNIQUE INDEX IF NOT EXISTS observations_dedup
  ON observations (source, kind, observed_at, geom);
