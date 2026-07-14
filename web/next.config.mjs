import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: ["quickjs-emscripten", "pg"],
};
export default withNextIntl(config);
