/**
 * Process-wide observation of database round trips.
 *
 * The connection layer reports every statement it sends on a checked-out
 * client — pooled queries, transaction statements and the tenant-scope
 * statements that precede them — with its text and wall-clock duration. A
 * host (the web server's query profiler) registers one observer to attribute
 * those round trips to its own unit of work. Parameter values are never
 * passed: observers receive the statement text only.
 *
 * With no observer registered the connection layer takes no timestamps and
 * calls nothing, so the hook costs one property read per statement.
 */

export type QueryObserver = (statement: string, durationMs: number) => void;

type QueryObserverRuntime = typeof globalThis & {
  __openbooksQueryObserver?: QueryObserver | null;
};

// Process-global for the same reason as the tenant-context store in db.ts:
// Next/Turbopack can instantiate engine modules through more than one module
// graph, and a registration from one copy must reach the connection layer of
// every other copy.
const runtime = globalThis as QueryObserverRuntime;

/**
 * Install the process's query observer, replacing any previous one. Returns a
 * function that removes it again if it is still the installed observer.
 */
export function registerQueryObserver(fn: QueryObserver): () => void {
  runtime.__openbooksQueryObserver = fn;
  return () => {
    if (runtime.__openbooksQueryObserver === fn) runtime.__openbooksQueryObserver = null;
  };
}

/** The installed observer, or null when database round trips are not observed. */
export function activeQueryObserver(): QueryObserver | null {
  return runtime.__openbooksQueryObserver ?? null;
}

/**
 * Deliver one observation. A failing observer is reported and otherwise
 * ignored: diagnostics must never change the outcome of the statement.
 */
export function notifyQueryObserver(observer: QueryObserver, statement: string, durationMs: number): void {
  try {
    observer(statement, durationMs);
  } catch (error) {
    console.error("[query observer] observer failed; statement unaffected:", (error as Error).message);
  }
}
