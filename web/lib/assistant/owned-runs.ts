/**
 * Server-owned assistant runs.
 *
 * The streamed turn used to live and die with the client's fetch: navigating
 * away (or reloading) aborted the request signal, and the model loop stopped
 * with it — the owner watched runs die when they switched chats. A run is
 * therefore owned HERE now, not by the mounted view or an aborted fetch:
 *
 *   - the run executes under a run-owned AbortController. A dropped client
 *     connection never aborts it; only an explicit abort request does;
 *   - streamed parts are persisted to the run row as they arrive (throttled),
 *     so any client can reattach by conversation id and read the full event
 *     log — switch away and back, tab switch, page reload;
 *   - deleting a conversation removes its rows, so the run's next progress
 *     write lands on zero rows and the run aborts itself. Other
 *     conversations' runs never share state.
 *
 * Framework-free: the model turn is injected, so the lifecycle is fully
 * unit-testable without a provider or a database (see the memory store).
 */

export type OwnedRunStatus = "running" | "complete" | "failed" | "stopped";

export interface OwnedRunSnapshot {
  runId: string;
  conversationId: string;
  status: OwnedRunStatus;
  parts: unknown[];
  revision: number;
}

export interface OwnedRunOutcome {
  status: OwnedRunStatus;
  parts: unknown[];
  content: string;
  usage: unknown;
  finishReason: string;
}

export interface OwnedRunStore {
  startRun(conversationId: string, userText: string): Promise<{ runId: string }>;
  /** False when the run row is gone (conversation deleted): the run must stop. */
  writeProgress(runId: string, parts: unknown[], revision: number): Promise<boolean>;
  finishRun(runId: string, outcome: OwnedRunOutcome): Promise<boolean>;
  readRun(runId: string): Promise<OwnedRunSnapshot | null>;
  activeRun(conversationId: string): Promise<OwnedRunSnapshot | null>;
  requestAbort(runId: string): Promise<boolean>;
  abortRequested(runId: string): Promise<boolean>;
}

/** In-process abort registry: explicit abort requests land instantly without
 *  waiting for the next persistence poll. Keyed by run id — deleting or
 *  aborting one run never touches another. */
const liveControllers = new Map<string, AbortController>();

export function abortOwnedRunNow(runId: string): void {
  liveControllers.get(runId)?.abort();
}

/** Best-effort immediate stop of a conversation's active run (used by the
 *  conversation DELETE route; the row-cascade backstop covers the rest). */
export async function abortActiveRun(store: OwnedRunStore, conversationId: string): Promise<void> {
  try {
    const active = await store.activeRun(conversationId);
    if (!active) return;
    abortOwnedRunNow(active.runId);
    await store.requestAbort(active.runId);
  } catch {
    // Never fail a delete for an abort bookkeeping miss.
  }
}

export function abortOwnedRunsWhere(predicate: (runId: string) => boolean): void {
  for (const [runId, controller] of liveControllers) {
    if (predicate(runId)) controller.abort();
  }
}

/** Snapshot writes at most this often; tool boundaries always flush. */
export const OWNED_RUN_PROGRESS_INTERVAL_MS = 2_000;

/** A parts snapshot carrying tool activity is a progress boundary worth
 *  persisting immediately (the in-progress tool card must survive a
 *  disconnect); pure text deltas ride the throttle. */
function isBoundaryParts(parts: unknown[]): boolean {
  return parts.some((part) => {
    const type = (part as { type?: unknown })?.type;
    return typeof type === "string" && (type.startsWith("tool-") || type === "dynamic-tool");
  });
}

export async function executeOwnedRun(opts: {
  store: OwnedRunStore;
  conversationId: string;
  userText: string;
  /** The model turn. Receives ONLY the run-owned signal: a dropped client
   *  connection must never reach it. Reports assembled parts per chunk. */
  run: (ctx: { signal: AbortSignal; onChunk: (parts: unknown[]) => void }) => Promise<OwnedRunOutcome>;
  onBroadcast?: (snapshot: OwnedRunSnapshot) => void;
  progressIntervalMs?: number;
}): Promise<OwnedRunSnapshot> {
  const { runId } = await opts.store.startRun(opts.conversationId, opts.userText);
  return trackOwnedRun({ ...opts, runId });
}

export async function trackOwnedRun(opts: {
  store: OwnedRunStore;
  runId: string;
  conversationId: string;
  /** The model turn. Receives ONLY the run-owned signal: a dropped client
   *  connection must never reach it. Reports assembled parts per chunk. */
  run: (ctx: { signal: AbortSignal; onChunk: (parts: unknown[]) => void }) => Promise<OwnedRunOutcome>;
  onBroadcast?: (snapshot: OwnedRunSnapshot) => void;
  progressIntervalMs?: number;
}): Promise<OwnedRunSnapshot> {
  const { store, runId, conversationId } = opts;
  const progressIntervalMs = opts.progressIntervalMs ?? OWNED_RUN_PROGRESS_INTERVAL_MS;
  const controller = new AbortController();
  liveControllers.set(runId, controller);
  let revision = 0;
  let lastWrite = 0;
  let latestParts: unknown[] = [];
  let stopped = false;
  const snapshot = (status: OwnedRunStatus): OwnedRunSnapshot => ({
    runId,
    conversationId,
    status,
    parts: latestParts,
    revision,
  });
  const broadcast = () => {
    try {
      opts.onBroadcast?.(snapshot(stopped ? "stopped" : "running"));
    } catch {
      // Broadcast feeds live SSE fan-out; it must never fail the run.
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    broadcast();
  };
  // Watchdog: chunks can stall for a long tool execution, so an abort
  // request or a deleted conversation must also be noticed between chunks.
  const watchdog = setInterval(() => {
    void (async () => {
      try {
        const current = await store.readRun(runId);
        if (!current || current.status !== "running" || (await store.abortRequested(runId))) stop();
      } catch {
        // Transient store failure: the next tick retries; the run continues.
      }
    })();
  }, progressIntervalMs);
  try {
    const outcome = await opts.run({
      signal: controller.signal,
      onChunk: (parts) => {
        latestParts = parts;
        const now = Date.now();
        if (now - lastWrite >= progressIntervalMs || isBoundaryParts(parts)) {
          lastWrite = now;
          revision += 1;
          void store
            .writeProgress(runId, latestParts, revision)
            .then(async (written) => {
              // The run row is gone (conversation deleted) or an abort was
              // requested: stop the run. Otherwise just fan the progress out.
              if (!written || (await store.abortRequested(runId))) stop();
              else broadcast();
            })
            .catch(() => {
              // A failed progress write must not kill the turn; the final
              // finish write is retried below and carries the full parts.
            });
        } else {
          broadcast();
        }
      },
    });
    // A stopped turn resolves with no assembled parts of its own: the live
    // progress written so far is the transcript, not an empty bubble.
    if (outcome.parts.length > 0) latestParts = outcome.parts;
    const terminal: OwnedRunStatus = stopped || controller.signal.aborted ? "stopped" : outcome.status;
    revision += 1;
    try {
      await store.finishRun(runId, { ...outcome, parts: latestParts, status: terminal });
    } catch {
      // The row may be gone (deleted mid-turn): the turn still completed.
    }
    return snapshot(terminal);
  } catch {
    latestParts = latestParts.length > 0 ? latestParts : [{ type: "text", text: "The assistant could not complete this response. Please try again." }];
    revision += 1;
    try {
      await store.finishRun(runId, {
        status: "failed",
        parts: latestParts,
        content: "The assistant could not complete this response. Please try again.",
        usage: {},
        finishReason: "error",
      });
    } catch {
      // Row gone: nothing left to persist.
    }
    return snapshot("failed");
  } finally {
    clearInterval(watchdog);
    liveControllers.delete(runId);
  }
}

/** Hermetic store for unit tests: same lifecycle contract, no database. */
export function createMemoryOwnedRunStore(): OwnedRunStore & {
  deleteConversation(conversationId: string): void;
  rows(): OwnedRunSnapshot[];
} {
  const rows = new Map<string, OwnedRunSnapshot & { aborted: boolean }>();
  let counter = 0;
  const snap = (row: OwnedRunSnapshot & { aborted: boolean }): OwnedRunSnapshot => ({
    runId: row.runId,
    conversationId: row.conversationId,
    status: row.status,
    parts: row.parts,
    revision: row.revision,
  });
  return {
    rows: () => [...rows.values()].map(snap),
    deleteConversation(conversationId: string) {
      for (const [id, row] of rows) {
        if (row.conversationId === conversationId) rows.delete(id);
      }
    },
    async startRun(conversationId: string) {
      const runId = `run-${(counter += 1)}`;
      rows.set(runId, { runId, conversationId, status: "running", parts: [], revision: 0, aborted: false });
      return { runId };
    },
    async writeProgress(runId: string, parts: unknown[], revision: number) {
      const row = rows.get(runId);
      if (!row || row.status !== "running") return false;
      row.parts = parts;
      row.revision = revision;
      return true;
    },
    async finishRun(runId: string, outcome: OwnedRunOutcome) {
      const row = rows.get(runId);
      if (!row) return false;
      row.status = outcome.status;
      row.parts = outcome.parts;
      row.revision += 1;
      return true;
    },
    async readRun(runId: string) {
      const row = rows.get(runId);
      return row ? snap(row) : null;
    },
    async activeRun(conversationId: string) {
      for (const row of rows.values()) {
        if (row.conversationId === conversationId && row.status === "running") return snap(row);
      }
      return null;
    },
    async requestAbort(runId: string) {
      const row = rows.get(runId);
      if (!row || row.status !== "running") return false;
      row.aborted = true;
      abortOwnedRunNow(runId);
      return true;
    },
    async abortRequested(runId: string) {
      return rows.get(runId)?.aborted === true;
    },
  };
}
