import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: ["quickjs-emscripten", "pg", "pdfkit", "exceljs"],
  // Docker image: self-contained server bundle. The tracing root is the
  // monorepo root so workspace deps (@openbooks/*) land in the output.
  output: "standalone",
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
};
export default withNextIntl(config);
