import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Injectable clock.
 *
 * The accounting kernel never reads a wall clock for a document's *accounting*
 * date — posting resolves the period from `document.postingDate ?? documentDate`
 * (see posting.ts). But a handful of engine sites still stamp a *system* time
 * from `new Date()`: the `postedAt` audit stamp, the `asOf` defaults in the
 * period-driven engines (dunning / recurring / depreciation / fx-revaluation),
 * and approval-gate / close event timestamps.
 *
 * For the business-simulation harness those sites must advance with simulated
 * time so a run is reproducible and so period-driven engines fire on the right
 * simulated day. This module provides a single override point that mirrors the
 * `orgContext` pattern in db.ts: production behaviour is unchanged (the store is
 * empty, so `now()` returns the real `new Date()`), while `withSimClock(date,fn)`
 * pins a deterministic instant for everything running inside `fn`.
 *
 * Only business-meaningful stamps should read `now()`. Pure audit columns
 * (`createdAt` / `updatedAt`) may keep their DB `defaultNow()` — they are not
 * part of the financial checkpoint the harness diffs.
 */

type ClockStore = { at: Date };

type ClockRuntime = typeof globalThis & {
  __openbooksClock?: AsyncLocalStorage<ClockStore>;
};
const runtime = globalThis as ClockRuntime;

// Process-global singleton, for the same reason db.ts's orgContext is: the
// module may be instantiated through more than one import identity.
const clockContext = (runtime.__openbooksClock ??= new AsyncLocalStorage<ClockStore>());

/** The current instant — the simulated clock if one is pinned, else real time. */
export function now(): Date {
  const store = clockContext.getStore();
  return store ? new Date(store.at.getTime()) : new Date();
}

/** Milliseconds since the epoch, honouring a pinned simulated clock. */
export function nowMs(): number {
  return now().getTime();
}

/** Is a simulated clock currently pinned? */
export function isSimClockActive(): boolean {
  return clockContext.getStore() !== undefined;
}

/**
 * Run `fn` with `now()` pinned to `at`. Accepts a Date or an ISO date/datetime
 * string (a bare `YYYY-MM-DD` is interpreted at UTC midnight).
 */
export function withSimClock<T>(at: Date | string, fn: () => Promise<T>): Promise<T> {
  const date = typeof at === "string"
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T00:00:00.000Z` : at)
    : at;
  if (Number.isNaN(date.getTime())) throw new Error(`withSimClock: invalid instant "${String(at)}"`);
  return clockContext.run({ at: date }, fn);
}
