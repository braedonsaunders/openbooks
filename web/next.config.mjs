import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const securityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
];

/** @type {import('next').NextConfig} */
const config = {
  transpilePackages: ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: [
    "quickjs-emscripten",
    "pg",
    "pdfkit",
    "exceljs",
    "ssh2",
  ],
  // Docker image: self-contained server bundle. The tracing root is the
  // monorepo root so workspace deps (@openbooks/*) land in the output.
  output: "standalone",
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default withNextIntl(config);
