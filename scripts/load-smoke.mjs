import { pathToFileURL } from "node:url";

const DEFAULTS = Object.freeze({
  baseUrl: "http://127.0.0.1:4780",
  concurrency: 4,
  durationMs: 5_000,
  maxErrorRate: 0,
  maxP95Ms: 1_500,
  path: "/api/v1/health",
  timeoutMs: 3_000,
});

function positiveNumber(value, name, { integer = false } = {}) {
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    (integer && !Number.isInteger(parsed))
  ) {
    throw new Error(
      `${name} must be a positive ${integer ? "integer" : "number"}`,
    );
  }
  return parsed;
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

export function parseLoadOptions(argv, env = process.env) {
  const values = {
    baseUrl: env.OPENBOOKS_LOAD_BASE_URL ?? DEFAULTS.baseUrl,
    concurrency: env.OPENBOOKS_LOAD_CONCURRENCY ?? DEFAULTS.concurrency,
    durationMs: env.OPENBOOKS_LOAD_DURATION_MS ?? DEFAULTS.durationMs,
    maxErrorRate: env.OPENBOOKS_LOAD_MAX_ERROR_RATE ?? DEFAULTS.maxErrorRate,
    maxP95Ms: env.OPENBOOKS_LOAD_MAX_P95_MS ?? DEFAULTS.maxP95Ms,
    path: env.OPENBOOKS_LOAD_PATH ?? DEFAULTS.path,
    timeoutMs: env.OPENBOOKS_LOAD_TIMEOUT_MS ?? DEFAULTS.timeoutMs,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--") || value === undefined)
      throw new Error(`invalid argument: ${flag}`);
    index += 1;
    if (flag === "--base-url") values.baseUrl = value;
    else if (flag === "--concurrency") values.concurrency = value;
    else if (flag === "--duration-ms") values.durationMs = value;
    else if (flag === "--max-error-rate") values.maxErrorRate = value;
    else if (flag === "--max-p95-ms") values.maxP95Ms = value;
    else if (flag === "--path") values.path = value;
    else if (flag === "--timeout-ms") values.timeoutMs = value;
    else throw new Error(`unknown argument: ${flag}`);
  }

  const baseUrl = new URL(String(values.baseUrl));
  if (!["http:", "https:"].includes(baseUrl.protocol))
    throw new Error("base URL must use http or https");
  const path = String(values.path);
  if (!path.startsWith("/")) throw new Error("path must start with /");

  return {
    baseUrl: baseUrl.toString(),
    concurrency: positiveNumber(values.concurrency, "concurrency", {
      integer: true,
    }),
    durationMs: positiveNumber(values.durationMs, "durationMs", {
      integer: true,
    }),
    maxErrorRate: nonNegativeNumber(values.maxErrorRate, "maxErrorRate"),
    maxP95Ms: positiveNumber(values.maxP95Ms, "maxP95Ms"),
    path,
    timeoutMs: positiveNumber(values.timeoutMs, "timeoutMs", { integer: true }),
  };
}

export function percentile(samples, percentage) {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentage / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)];
}

export async function runLoadProbe(options, fetchImpl = fetch) {
  const target = new URL(options.path, options.baseUrl).toString();
  const deadline = performance.now() + options.durationMs;
  const latencies = [];
  const statusCounts = new Map();
  let errors = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const started = performance.now();
      try {
        const response = await fetchImpl(target, {
          cache: "no-store",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        latencies.push(performance.now() - started);
        statusCounts.set(
          response.status,
          (statusCounts.get(response.status) ?? 0) + 1,
        );
        if (!response.ok) errors += 1;
        await response.body?.cancel();
      } catch {
        latencies.push(performance.now() - started);
        errors += 1;
      }
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, () => worker()),
  );
  const requests = latencies.length;
  const errorRate = requests === 0 ? 1 : errors / requests;
  const result = {
    target,
    durationMs: options.durationMs,
    concurrency: options.concurrency,
    requests,
    errors,
    errorRate,
    requestsPerSecond: requests / (options.durationMs / 1_000),
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    statusCounts: Object.fromEntries(
      [...statusCounts.entries()].sort(([a], [b]) => a - b),
    ),
  };

  const failures = [];
  if (result.errorRate > options.maxErrorRate) {
    failures.push(
      `error rate ${result.errorRate.toFixed(4)} exceeds ${options.maxErrorRate}`,
    );
  }
  if (result.latencyMs.p95 > options.maxP95Ms) {
    failures.push(
      `p95 ${result.latencyMs.p95.toFixed(1)}ms exceeds ${options.maxP95Ms}ms`,
    );
  }
  return { failures, result };
}

async function main() {
  const options = parseLoadOptions(process.argv.slice(2));
  const { failures, result } = await runLoadProbe(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failures.length > 0) {
    for (const failure of failures)
      process.stderr.write(`load threshold failed: ${failure}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
