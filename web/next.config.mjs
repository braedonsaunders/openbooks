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
  experimental: {
    cpus: 1,
    staticGenerationMaxConcurrency: 1,
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
  },
  // Types are gated by CI's own `npm run typecheck -w web` job, and a release
  // needs that job green on the exact SHA. Type-checking again inside
  // `next build` duplicates it: ~3.3 GB and ~2.5 min in the same process that
  // already holds the Turbopack compilation, and it ran a GitHub runner out of
  // memory (exit 143 at "Running TypeScript", 2026-09-24).
  typescript: { ignoreBuildErrors: true },
  // Latency without architecture change: partial prerendering and `use cache`
  // stay OFF. The (app) shell is force-dynamic per request (session authz,
  // nav, org currency), so a static shell with dynamic holes would need the
  // auth-dependent reads split out of the layout first. Likewise the setup
  // registry module itself is pure static data, while its database reads are
  // tenant-scoped and write-sensitive with no invalidation wiring — caching
  // either without the org in the key (or without invalidation) risks
  // cross-tenant or stale reads. Navigation latency is instead carried by the
  // (app) loading skeleton, the Suspense boundary around the layout children,
  // and explicit prefetch on the shell nav links.
  // Both loopback names serve the same local development instance.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: [
    "quickjs-emscripten-core",
    "xmllint-wasm",
    "pg",
    "pdfkit",
    "exceljs",
    "ssh2",
    // OpenTelemetry must stay external so the whole process shares ONE
    // @opentelemetry/api instance: global tracer/meter providers registered by
    // engine telemetry.ts are invisible across duplicated API copies.
    "@opentelemetry/api",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-metrics-otlp-http",
  ],
  // Docker image: self-contained server bundle. The tracing root is the
  // monorepo root so workspace deps (@openbooks/*) land in the output.
  output: "standalone",
  // Local blue/green rebuilds: build into a staging dir (NEXT_DIST_DIR=.next-stage)
  // while `next start` keeps serving the live .next, then swap. Unset = default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};
export default withNextIntl(config);
