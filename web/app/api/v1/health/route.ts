import { NextResponse } from "next/server";
import { getWorkerHeartbeat } from "@openbooks/jobs";
import { assertS3Ready, s3Enabled } from "@openbooks/engine/src/file-storage.ts";
import { pool } from "@openbooks/engine/src/db.ts";

export const runtime = "nodejs";

const version = process.env.OPENBOOKS_VERSION || "development";

async function within<T>(operation: Promise<T>, milliseconds = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health check timed out")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function dependencyReadiness(): Promise<Record<"database" | "redis" | "objectStorage", "ok" | "unavailable" | "disabled">> {
  const requireS3 = process.env.OPENBOOKS_REQUIRE_S3_HEALTH === "1";
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 4_000);
  const checks = await Promise.allSettled([
    within(pool.query("select 1")),
    // A GET proves a bounded producer connection can reach Redis. Worker
    // freshness is reported separately and must not remove every web pod from
    // service during a worker-only incident.
    within(getWorkerHeartbeat()),
    s3Enabled
      ? assertS3Ready(controller.signal)
      : requireS3
        ? Promise.reject(new Error("required object storage is not configured"))
        : Promise.resolve("disabled"),
  ]);
  clearTimeout(abort);
  return {
    database: checks[0].status === "fulfilled" ? "ok" : "unavailable",
    redis: checks[1].status === "fulfilled" ? "ok" : "unavailable",
    objectStorage:
      !s3Enabled && !requireS3
        ? "disabled"
        : checks[2].status === "fulfilled"
          ? "ok"
          : "unavailable",
  };
}

/**
 * Unauthenticated health surface. The default is deliberately process-only
 * liveness; include=dependencies is routing readiness, while include=worker is
 * deployment-level worker telemetry for monitoring.
 */
export async function GET(req: Request) {
  const include = new URL(req.url).searchParams.get("include");
  if (!include) {
    return NextResponse.json({ status: "ok", service: "openbooks-api", version });
  }
  if (include === "dependencies" || include === "readiness") {
    const dependencies = await dependencyReadiness();
    const ready = Object.values(dependencies).every((status) => status === "ok" || status === "disabled");
    return NextResponse.json(
      { status: ready ? "ok" : "degraded", service: "openbooks-api", version, dependencies },
      { status: ready ? 200 : 503 },
    );
  }
  if (include !== "worker") {
    return NextResponse.json({ status: "error", error: "unsupported health detail" }, { status: 400 });
  }
  try {
    const heartbeat = await getWorkerHeartbeat();
    const ageMs = heartbeat ? Date.now() - new Date(heartbeat).getTime() : Number.POSITIVE_INFINITY;
    const workerReady = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 45_000;
    return NextResponse.json({
      status: workerReady ? "ok" : "degraded",
      service: "openbooks-api",
      version,
      worker: { status: workerReady ? "ok" : "stale", heartbeat, ageMs: Number.isFinite(ageMs) ? ageMs : null },
    }, { status: workerReady ? 200 : 503 });
  } catch {
    return NextResponse.json({
      status: "degraded",
      service: "openbooks-api",
      version,
      worker: { status: "unavailable", heartbeat: null, ageMs: null },
    }, { status: 503 });
  }
}
