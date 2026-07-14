/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: ["quickjs-emscripten", "pg"],
};
export default config;
