# PostGIS + pgvector 단일 이미지 (레인① 의미검색·레인② 공간검색 공용 백엔드)
# postgis/postgis 는 PGDG apt 저장소가 구성돼 있어 pgvector 패키지를 바로 설치할 수 있다.
FROM postgis/postgis:16-3.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-16-pgvector \
    && rm -rf /var/lib/apt/lists/*
