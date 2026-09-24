/**
 * Scheduler tick health (B2-SCH-1, C-56) — the observability surface for the
 * 60-second scheduler tick.
 *
 * A tick that overruns its interval makes the next tick hit `if (running)
 * return` with no trace; scans silently miss their cadence while every
 * health signal reads normal. Every overlap skip is therefore recorded
 * here (in-process counter plus structured log at the call site) and
 * published best-effort to Redis, where the web health endpoint reads it.
 * Worker-duty outcomes land in the same surface: runWorkerDuties records
 * ok:false per failed duty and returns the summary, and the tick stores
 * the failures here instead of dropping them.
 *
 * This module is a leaf: its only static import is the queue package, so
 * the web health route can read it without pulling the scheduler's import
 * chain. Every Redis call is best-effort — health reporting must never
 * fail a tick or a health check.
 */

import { getConnection } from "@openbooks/jobs";

export type SchedulerDutyFailure = {
  key: string;
  error: string;
};

export type SchedulerTickHealth = {
  /** Lifetime overlap skips recorded by this process. */
  overlapSkips: number;
  /** Consecutive skips since the last completed tick; drives the degraded signal. */
  consecutiveSkips: number;
  /** When the last tick finished (null before the first tick). */
  lastTickAt: string | null;
  /** Whether the last tick finished (false when it threw). */
  lastTickOk: boolean | null;
  /** Failed worker duties from the last completed tick. */
  lastDutyFailures: SchedulerDutyFailure[];
};

/** Consecutive overlap skips that mark the scheduler degraded. */
export const SCHEDULER_OVERLAP_DEGRADED_THRESHOLD = 3;

/** Deployment-wide tick-health key; short expiry so a dead scheduler ages out. */
export const SCHEDULER_TICK_HEALTH_KEY = "openbooks:scheduler:tick-health";
const SCHEDULER_TICK_HEALTH_TTL_SECONDS = 300;

let health: SchedulerTickHealth = {
  overlapSkips: 0,
  consecutiveSkips: 0,
  lastTickAt: null,
  lastTickOk: null,
  lastDutyFailures: [],
};

/** A copy of this process's tick health (never the live object). */
export function getSchedulerTickHealth(): SchedulerTickHealth {
  return { ...health, lastDutyFailures: [...health.lastDutyFailures] };
}

/** Test seam: reset this process's tick health. Production never calls this. */
export function resetSchedulerTickHealth(): void {
  health = { overlapSkips: 0, consecutiveSkips: 0, lastTickAt: null, lastTickOk: null, lastDutyFailures: [] };
}

/**
 * Record one overlap skip: the previous tick was still running when the
 * next 60s boundary fired, so this pass stands down. Returns the updated
 * health for the caller's structured log.
 */
export function recordTickOverlapSkip(): SchedulerTickHealth {
  health = {
    ...health,
    overlapSkips: health.overlapSkips + 1,
    consecutiveSkips: health.consecutiveSkips + 1,
  };
  return getSchedulerTickHealth();
}

/** Record one finished tick: stamp it, clear the consecutive-skip run. */
export function recordTickOutcome(ok: boolean, at: Date = new Date()): SchedulerTickHealth {
  health = { ...health, lastTickAt: at.toISOString(), lastTickOk: ok, consecutiveSkips: 0 };
  return getSchedulerTickHealth();
}

/** Store the failed worker duties from a finished tick (empty clears). */
export function recordTickDutyFailures(failures: SchedulerDutyFailure[]): SchedulerTickHealth {
  health = { ...health, lastDutyFailures: [...failures] };
  return getSchedulerTickHealth();
}

/** Whether the given health reads degraded (sustained cadence misses). */
export function isSchedulerTickHealthDegraded(
  snapshot: Pick<SchedulerTickHealth, "consecutiveSkips">,
): boolean {
  return snapshot.consecutiveSkips >= SCHEDULER_OVERLAP_DEGRADED_THRESHOLD;
}

type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, seconds: number): Promise<unknown>;
};

function tickHealthConnection(): RedisClient | null {
  try {
    return getConnection() as unknown as RedisClient;
  } catch {
    return null;
  }
}

/** Publish this process's tick health for the health endpoint. Best-effort. */
export async function publishSchedulerTickHealth(): Promise<void> {
  try {
    const connection = tickHealthConnection();
    if (!connection) return;
    await connection.set(SCHEDULER_TICK_HEALTH_KEY, JSON.stringify(getSchedulerTickHealth()), "EX", SCHEDULER_TICK_HEALTH_TTL_SECONDS);
  } catch (error) {
    console.warn("[scheduler] tick-health publish failed:", error instanceof Error ? error.message : error);
  }
}

/** Read the deployment-wide tick health; null when never reported or unreadable. */
export async function readSchedulerTickHealth(): Promise<SchedulerTickHealth | null> {
  try {
    const connection = tickHealthConnection();
    if (!connection) return null;
    const raw = await connection.get(SCHEDULER_TICK_HEALTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SchedulerTickHealth>;
    if (
      typeof parsed.overlapSkips !== "number" ||
      typeof parsed.consecutiveSkips !== "number" ||
      !Array.isArray(parsed.lastDutyFailures)
    ) {
      return null;
    }
    return {
      overlapSkips: parsed.overlapSkips,
      consecutiveSkips: parsed.consecutiveSkips,
      lastTickAt: typeof parsed.lastTickAt === "string" ? parsed.lastTickAt : null,
      lastTickOk: typeof parsed.lastTickOk === "boolean" ? parsed.lastTickOk : null,
      lastDutyFailures: parsed.lastDutyFailures.filter(
        (entry): entry is SchedulerDutyFailure =>
          typeof entry?.key === "string" && typeof entry?.error === "string",
      ),
    };
  } catch {
    return null;
  }
}
