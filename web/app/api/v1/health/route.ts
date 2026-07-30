import { NextResponse } from "next/server";
import { getWorkerHeartbeat } from "@openbooks/jobs";

export const runtime = "nodejs";

const version = process.env.OPENBOOKS_VERSION || "development";

/** Liveness probe — no authentication required. Add include=worker for stack readiness. */
export async function GET(req: Request) {
  const includeWorker = new URL(req.url).searchParams.get("include") === "worker";
  if (!includeWorker) {
    return NextResponse.json({ status: "ok", service: "openbooks-api", version });
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
