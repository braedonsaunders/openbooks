import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
const retainDevelopmentCompilation =
  process.env.NODE_ENV === "development" && process.env.OPENBOOKS_DEV_KEEP_COMPILE_CACHE === "1";

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SERVER_RUNTIME_PACKAGE_NAMES,
  serverRuntimeExportsActive,
} from "../scripts/server-runtime-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// The webpack compiler runs in a worker whose argv is the worker script, not
// `next build --webpack`. That worker sets NEXT_PRIVATE_BUILD_WORKER.
const webpackBuild =
  process.argv.includes("--webpack") || process.env.NEXT_PRIVATE_BUILD_WORKER === "1";
const productionBuild = process.argv.includes("build") || webpackBuild;
// Active only while emit-server-runtime.mjs has pointed the node condition at
// prebuilt JS. Dev and a bare `next build` keep compiling source.
const externalEngine = productionBuild && serverRuntimeExportsActive(repoRoot);
const compositionLoader = join(
  dirname(fileURLToPath(import.meta.url)),
  "lib/engine-composition.external.ts",
);

/**
 * Version-skew protection. Each production build carries its own deployment
 * id, so a browser tab left open across a deploy gets a full reload on its
 * next navigation or server action instead of calling code the new build no
 * longer has. An explicit NEXT_DEPLOYMENT_ID wins; otherwise the source
 * commit, otherwise a build stamp shared with the build's worker processes.
 */
function productionDeploymentId() {
  if (process.env.NODE_ENV !== "production") return undefined;
  const explicit = process.env.NEXT_DEPLOYMENT_ID?.trim();
  if (explicit) return explicit;
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (/^[0-9a-f]{12}$/.test(commit)) return (process.env.NEXT_DEPLOYMENT_ID = commit);
  } catch {
    // Builds from an exported tree have no repository; fall through to a stamp.
  }
  return (process.env.NEXT_DEPLOYMENT_ID = `build-${Date.now().toString(36)}`);
}

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

/**
 * Each webpack build worker returns its recorded trace spans to the parent in
 * one IPC message, and V8 caps a single string near 512 MiB. Recording every
 * span (Next's default threshold) puts the server compilation of this app over
 * that cap, so the build fails while serializing its result. Recording spans
 * of at least 100 ms keeps the slow-span profile in `.next/trace` and the
 * message far below the cap. Workers inherit this environment, and an
 * explicit threshold still wins.
 */
process.env.NEXT_TRACE_SPAN_THRESHOLD_MS ??= "100";

/** @type {import('next').NextConfig} */
const config = {
  experimental: {
    // Dedicated development hosts can retain compiled modules between visits.
    ...(retainDevelopmentCompilation ? { turbopackMemoryEviction: false } : {}),
    cpus: 1,
    staticGenerationMaxConcurrency: 1,
    webpackBuildWorker: true,
    webpackMemoryOptimizations: true,
    // Workspace packages expose pure `export *` barrels. Without this, one
    // named import from a barrel puts every module it re-exports into the
    // importing bundle: a single date-preset helper shipped the whole report
    // engine to every page. Only barrels that contain nothing but re-exports
    // belong here.
    optimizePackageImports: [
      "@openbooks/analytics",
      "@openbooks/customization",
      "@openbooks/reports",
      "@openbooks/ui",
    ].filter(
      (name) => !(externalEngine && !webpackBuild && SERVER_RUNTIME_PACKAGE_NAMES.includes(name)),
    ),
  },
  webpack(webpackConfig, { dev, isServer, nextRuntime }) {
    if (!dev) {
      webpackConfig.parallelism = 1;
      webpackConfig.cache = false;
    }
    // One engine instance in the Node process. Route and page compilations
    // must not parse @openbooks/engine; the composition root in particular
    // pulls every domain module into each server bundle.
    if (externalEngine && isServer && nextRuntime !== "edge") {
      const runtimeRequest = (request) =>
        typeof request === "string" &&
        SERVER_RUNTIME_PACKAGE_NAMES.some(
          (name) => request === name || request.startsWith(`${name}/`),
        );
      const externalize = ({ request }, callback) => {
        if (runtimeRequest(request)) return callback(null, `module ${request}`);
        callback();
      };
      const existing = webpackConfig.externals;
      webpackConfig.externals = [
        externalize,
        ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
      ];
      webpackConfig.resolve.alias = {
        ...webpackConfig.resolve.alias,
        "@/lib/engine-composition$": compositionLoader,
      };
    }
    return webpackConfig;
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
  // (app) loading skeleton and the Suspense boundary around the layout
  // children. Shell nav links keep Next's default prefetch, which fetches a
  // dynamic route only down to that loading boundary: a full prefetch would
  // render every linked module home on each page load.
  // Shared development hosts explicitly authorize their private proxy origin.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    ...(process.env.OPENBOOKS_DEV_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  ],
  // Webpack keeps these in transpilePackages so the client still compiles the
  // few pure modules it imports. They cannot also sit in serverExternalPackages;
  // the server compilation externalizes them in the webpack hook above.
  // Turbopack has no webpack hook, so a turbopack production build lists them
  // as server externals and relies on workspace transpilation for the client.
  transpilePackages:
    externalEngine && !webpackBuild ? [] : ["@openbooks/engine", "@openbooks/schema"],
  serverExternalPackages: [
    ...(externalEngine && !webpackBuild ? SERVER_RUNTIME_PACKAGE_NAMES : []),
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
  deploymentId: productionDeploymentId(),
  // Local blue/green rebuilds: build into a staging dir (NEXT_DIST_DIR=.next-stage)
  // while `next start` keeps serving the live .next, then swap. Unset = default.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), ".."),
  ...(externalEngine && !webpackBuild
    ? {
        turbopack: {
          resolveAlias: {
            "@/lib/engine-composition": "./lib/engine-composition.external.ts",
          },
        },
      }
    : {}),
  outputFileTracingIncludes: {
    "/api/documents/*/einvoice": [
      "../engine/src/einvoice/srgb-iec61966-2-1.icc",
      "../engine/src/einvoice/standards/**/*.xsd",
      "../engine/src/einvoice/standards/*manifest.json",
      ...(externalEngine
        ? [
            "../engine/dist/einvoice/srgb-iec61966-2-1.icc",
            "../engine/dist/einvoice/standards/**/*.xsd",
            "../engine/dist/einvoice/standards/*manifest.json",
          ]
        : []),
    ],
  },
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};
export default withNextIntl(config);
