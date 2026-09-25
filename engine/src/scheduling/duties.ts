/**
 * Worker scheduled-duty registry (HR-16 hook).
 *
 * The worker process runs many schedulers; the 60-second scheduler tick
 * (engine/src/scheduling/scheduler.ts) executes every registered duty each
 * pass. Duties register here — this module owns the registry and imports
 * NOTHING duty-specific, so registering a new duty never adds a module
 * edge. Composition (which duties exist in production) lives OUTSIDE the
 * engine module graph: scripts/worker-entry.ts registers the automation
 * tick beside booting the worker, and web/instrumentation.node.ts covers
 * the single-process opt-in. Tests import this registry directly.
 */

export type WorkerDuty = {
  /** Stable key, e.g. 'automation-tick'. */
  key: string;
  /** The scan; receives the tick instant. Throwing fails only this duty. */
  run: (now: Date) => Promise<unknown>;
};

const duties = new Map<string, WorkerDuty>();

export class WorkerDutyError extends Error {}

/** Register one duty. A duplicate key is a refusal — two scanners with one
 *  name would double-fire, so the second registration names the first. */
export function registerWorkerDuty(duty: WorkerDuty): void {
  if (!duty.key?.trim()) {
    throw new WorkerDutyError("a worker duty needs a non-blank key — name the scan and register again");
  }
  if (typeof duty.run !== "function") {
    throw new WorkerDutyError(`worker duty '${duty.key}' has no run function — pass the scan and register again`);
  }
  if (duties.has(duty.key)) {
    throw new WorkerDutyError(
      `worker duty '${duty.key}' is already registered — one scanner per key; remove the first registration instead of adding a second`,
    );
  }
  duties.set(duty.key, duty);
}

/** Keys in registration order (for the boot log and the registry test). */
export function listWorkerDuties(): string[] {
  return [...duties.keys()];
}

/** Test seam: drop all duties. Production never calls this. */
export function clearWorkerDuties(): void {
  duties.clear();
}

export type WorkerDutySummary = {
  key: string;
  ok: boolean;
  error?: string;
};

/**
 * Run every registered duty, sequentially. A throwing duty is recorded —
 * never propagated — so one broken scanner cannot suppress the rest.
 */
export async function runWorkerDuties(now: Date = new Date()): Promise<WorkerDutySummary[]> {
  const summary: WorkerDutySummary[] = [];
  for (const duty of duties.values()) {
    try {
      await duty.run(now);
      summary.push({ key: duty.key, ok: true });
    } catch (e) {
      console.error(`[worker] duty ${duty.key} failed:`, e instanceof Error ? e.message : e);
      summary.push({ key: duty.key, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summary;
}
