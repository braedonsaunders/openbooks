/**
 * Client-side follow-cache for server-owned assistant runs.
 *
 * Runs live on the server (web/lib/assistant/owned-runs.ts): the client only
 * follows them. Each entry is keyed by conversation id — or by a provisional
 * `pending:<stamp>` key until the server answers a new chat with its real id
 * — never by mounted view, so switching chats, remounting, or reloading
 * re-adopts the same live progress instead of losing it.
 *
 * Render rule: the transcript loaded from the server is the base; a live
 * entry composes its optimistic tail on top. When a turn settles, the entry
 * is dropped — the persisted transcript is the truth from then on. A
 * reattach poll upserts server snapshots (revision-guarded, so a stale poll
 * can never clobber live chunks). Deleting a conversation drops ONLY its
 * own entry, controller, and loop registration.
 *
 * Framework-free: semantics are unit-testable without a DOM.
 */

export interface TurnBubbles {
  userId: string;
  assistantId: string;
  userText: string;
}

export interface TurnEntry extends TurnBubbles {
  /** View key: conversation id, or `pending:<stamp>` before the first response. */
  key: string;
  conversationId: string | null;
  /** Latest streamed assistant parts (text + tool-use cards), in order. */
  parts: unknown[];
  streaming: boolean;
  error: string | null;
  /** Highest server revision adopted (poll path); live chunks bypass it. */
  serverRevision: number;
  /** Bumped on every mutation; views subscribe on it. */
  revision: number;
}

export interface ServerTurnSnapshot {
  conversationId: string;
  status: "running" | "complete" | "failed" | "stopped";
  parts: unknown[];
  revision: number;
}

type Listener = () => void;

const turns = new Map<string, TurnEntry>();
const controllers = new Map<string, AbortController>();
const liveLoops = new Set<string>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeTurns(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Revision snapshot for useSyncExternalStore (stable -1 when untracked). */
export function turnRevision(key: string | null): number {
  if (!key) return -1;
  return turns.get(key)?.revision ?? -1;
}

export function readTurn(key: string | null): TurnEntry | undefined {
  if (!key) return undefined;
  return turns.get(key);
}

export function beginTurn(key: string, conversationId: string | null, bubbles: TurnBubbles): void {
  const previous = turns.get(key);
  if (previous?.streaming) return;
  turns.set(key, {
    key,
    conversationId,
    ...bubbles,
    parts: [],
    streaming: true,
    error: null,
    serverRevision: previous?.serverRevision ?? -1,
    revision: (previous?.revision ?? 0) + 1,
  });
  emit();
}

/** Move a provisional entry to its real conversation id (new-chat header). */
export function rekeyTurn(oldKey: string, conversationId: string): void {
  if (oldKey === conversationId) return;
  const entry = turns.get(oldKey);
  if (entry) {
    turns.delete(oldKey);
    turns.set(conversationId, { ...entry, key: conversationId, conversationId, revision: entry.revision + 1 });
  }
  const controller = controllers.get(oldKey);
  if (controller) {
    controllers.delete(oldKey);
    controllers.set(conversationId, controller);
  }
  if (liveLoops.has(oldKey)) {
    liveLoops.delete(oldKey);
    liveLoops.add(conversationId);
  }
  emit();
}

export function writeTurnParts(key: string, parts: unknown[]): void {
  const entry = turns.get(key);
  if (!entry || !entry.streaming) return;
  entry.parts = parts;
  entry.revision += 1;
  emit();
}

export function failTurn(key: string, error: string): void {
  const entry = turns.get(key);
  if (!entry) return;
  entry.streaming = false;
  entry.error = error;
  entry.revision += 1;
  releaseController(key);
  emit();
}

/** Adopt a server snapshot (reattach poll). Stale snapshots never clobber. */
export function syncTurn(snapshot: ServerTurnSnapshot): void {
  const key = snapshot.conversationId;
  const entry = turns.get(key);
  if (entry?.streaming && snapshot.revision <= entry.serverRevision) return;
  if (entry && snapshot.status !== "running") {
    // Terminal server state: the transcript (refetched by the caller) is the
    // truth — drop the tail so it cannot double-render.
    dropTurn(key);
    return;
  }
  if (entry) {
    entry.parts = snapshot.parts;
    entry.streaming = snapshot.status === "running";
    entry.serverRevision = snapshot.revision;
    entry.revision += 1;
  } else if (snapshot.status === "running") {
    turns.set(key, {
      key,
      conversationId: snapshot.conversationId,
      userId: `u-sync-${snapshot.revision}`,
      assistantId: `a-sync-${snapshot.revision}`,
      userText: "",
      parts: snapshot.parts,
      streaming: true,
      error: null,
      serverRevision: snapshot.revision,
      revision: 1,
    });
  }
  emit();
}

/** The turn settled (transcript adopted): drop the tail, keep the transcript. */
export function settleTurn(key: string): void {
  if (turns.delete(key)) emit();
  releaseController(key);
  detachLoop(key);
}

/**
 * The loop ended while nobody viewed this conversation (switched away,
 * unmounted): keep the final parts for instant adopt on return. The next
 * transcript load converges and drops the tail.
 */
export function completeTurn(key: string, parts: unknown[]): void {
  const entry = turns.get(key);
  if (!entry) return;
  entry.parts = parts;
  entry.streaming = false;
  entry.revision += 1;
  releaseController(key);
  emit();
}

/** Deleting a conversation aborts and drops ONLY its own turn state. */
export function dropTurn(key: string): void {
  abortTurn(key);
  detachLoop(key);
  if (turns.delete(key)) emit();
}

/** The AbortController for a turn (created on demand, moved on rekey). */
export function controllerFor(key: string): AbortController {
  const existing = controllers.get(key);
  if (existing && !existing.signal.aborted) return existing;
  const next = new AbortController();
  controllers.set(key, next);
  return next;
}

export function abortTurn(key: string): void {
  controllers.get(key)?.abort();
  releaseController(key);
}

function releaseController(key: string): void {
  controllers.delete(key);
}

/** Reader-loop presence: a live loop means our own stream still feeds this entry. */
export function attachLoop(key: string): void {
  liveLoops.add(key);
}

export function detachLoop(key: string): void {
  liveLoops.delete(key);
}

export function hasLiveLoop(key: string | null): boolean {
  return key !== null && liveLoops.has(key);
}
