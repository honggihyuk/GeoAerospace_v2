// 표준노드링크 MOCT_LINK를 PostGIS moct_link 테이블로 적재 (docker cp 회피, 호스트에서 직접).
// 고속국도(101)·도시고속(102)·일반국도(103)·광역시도(104)만 — CCTV가 있는 주요도로. EPSG:5186.
import * as shapefile from "shapefile";
import pg from "pg";

const SP = process.argv[2] || "./nl";
const RANKS = new Set(["101", "102", "103", "104"]);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL || "postgres://geo:geo_dev_pw@localhost:5433/geoaerospace" });
await c.connect();
await c.query(`DROP TABLE IF EXISTS moct_link;
  CREATE TABLE moct_link(link_id text, f_node text, t_node text, road_rank text, road_name text, geom geometry(LineString,5186));`);

const src = await shapefile.open(`${SP}/MOCT_LINK.shp`, `${SP}/MOCT_LINK.dbf`, { encoding: "euc-kr" });
let batch = [];
let scanned = 0;
let kept = 0;

async function flush() {
  if (!batch.length) return;
  const vals = [];
  const params = [];
  let i = 1;
  for (const f of batch) {
    const wkt = "LINESTRING(" + f.g.coordinates.map((p) => `${p[0]} ${p[1]}`).join(",") + ")";
    vals.push(`($${i++},$${i++},$${i++},$${i++},$${i++},ST_GeomFromText($${i++},5186))`);
    params.push(f.p.LINK_ID, f.p.F_NODE, f.p.T_NODE, f.p.ROAD_RANK, f.p.ROAD_NAME, wkt);
  }
  await c.query(`INSERT INTO moct_link(link_id,f_node,t_node,road_rank,road_name,geom) VALUES ${vals.join(",")}`, params);
  batch = [];
}

for (;;) {
  const r = await src.read();
  if (r.done) break;
  scanned++;
  const p = r.value.properties;
  const g = r.value.geometry;
  if (!RANKS.has(p.ROAD_RANK) || !g || g.type !== "LineString" || g.coordinates.length < 2) continue;
  batch.push({ g, p });
  kept++;
  if (batch.length >= 700) await flush();
  if (scanned % 200000 === 0) console.log(`scanned ${scanned}, kept ${kept}`);
}
await flush();
await c.query(`CREATE INDEX moct_link_geom ON moct_link USING gist(geom);
  CREATE INDEX moct_link_lid ON moct_link(link_id);
  CREATE INDEX moct_link_road ON moct_link(road_name);`);
const { rows } = await c.query("SELECT count(*) n FROM moct_link");
console.log(`DONE scanned ${scanned}, loaded ${rows[0].n}`);
await c.end();
