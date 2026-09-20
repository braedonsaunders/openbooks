/**
 * Scheduler topology ownership — which process runs scheduled ticks.
 *
 * DECIDED: scheduled work runs in the WORKER only (`npm run worker`, which
 * calls `ensureScheduler()` unconditionally). The web process runs the same
 * tick ONLY as an explicit single-process opt-in (`OPENBOOKS_RUN_SCHEDULER=1`),
 * and never under `next dev` (where `NODE_ENV=development`): a developer
 * workstation pointed at a database must not become a job runner. The sole
 * development override is `OPENBOOKS_RUN_SCHEDULER=force`, for locally
 * exercising the scheduler on purpose.
 *
 * This module is a pure function of the environment so the boot decision is
 * unit-testable without a database. The tick itself keeps its Postgres claim
 * lock (`WEB_TICK_LOCK_KEY` via `withTickClaim`), so N worker replicas still
 * run each tick exactly once — the gate only decides WHO may contend for the
 * claim, never how the claim works. Job semantics live in
 * `engine/src/scheduling/scheduler.ts` and are untouched by this module.
 */
export type WebSchedulerMode = "worker-only" | "web-opt-in" | "web-forced-dev" | "web-refused-dev";

export interface WebSchedulerDecision {
  /** Whether this web process should call `ensureScheduler()` at boot. */
  enabled: boolean;
  /** Stable label for tests and log aggregation. */
  mode: WebSchedulerMode;
  /** The exact line the booting process logs — one line, always. */
  logLine: string;
}

interface SchedulerEnv {
  NODE_ENV?: string;
  OPENBOOKS_RUN_SCHEDULER?: string;
}

export function resolveWebSchedulerMode(env: SchedulerEnv = process.env): WebSchedulerDecision {
  const raw = (env.OPENBOOKS_RUN_SCHEDULER ?? "").trim();
  const development = env.NODE_ENV === "development";

  if (raw === "force") {
    return {
      enabled: true,
      mode: development ? "web-forced-dev" : "web-opt-in",
      logLine:
        "[scheduler] web-process scheduler ENABLED " +
        "(OPENBOOKS_RUN_SCHEDULER=force explicit override) — this replica also runs " +
        "scheduled ticks under the shared Postgres claim lock",
    };
  }
  if (raw === "1" && development) {
    return {
      enabled: false,
      mode: "web-refused-dev",
      logLine:
        "[scheduler] web-process scheduler REFUSED — OPENBOOKS_RUN_SCHEDULER=1 is " +
        "ignored when NODE_ENV=development (developer processes never run scheduled " +
        "work); use OPENBOOKS_RUN_SCHEDULER=force to override locally",
    };
  }
  if (raw === "1") {
    return {
      enabled: true,
      mode: "web-opt-in",
      logLine:
        "[scheduler] web-process scheduler ENABLED (OPENBOOKS_RUN_SCHEDULER=1, " +
        "single-process mode) — this replica also runs scheduled ticks under the " +
        "shared Postgres claim lock",
    };
  }
  return {
    enabled: false,
    mode: "worker-only",
    logLine:
      "[scheduler] web-process scheduler disabled — scheduled work runs in the " +
      "worker process (npm run worker); set OPENBOOKS_RUN_SCHEDULER=1 for " +
      "single-process installs",
  };
}
