/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // deck.gl / maplibre ship modern ESM; Next 15 transpiles as needed.
  // parquet-wasm은 .wasm 사이드카를 번들에 안 실어(ENOENT parquet_wasm_bg.wasm) → 서버 외부 패키지로
  // 지정해 런타임에 node_modules에서 로드한다(광역 토지변화 스캔의 Clay 임베딩 파싱).
  serverExternalPackages: ["parquet-wasm", "apache-arrow"],
};

export default nextConfig;
