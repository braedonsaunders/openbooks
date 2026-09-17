import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from "ai";
import {
  trackOwnedRun,
  type OwnedRunSnapshot,
  type OwnedRunStore,
} from "./owned-runs";

/**
 * Bridges a UI-message-protocol turn (runAgentTurn's SSE response) into a
 * server-owned run. The byte stream is split at the source:
 *
 *   - one branch answers the connected client with the unchanged live
 *     protocol (returned immediately, before the turn completes);
 *   - the other branch is assembled into parts and persisted to the run row
 *     as it streams, detached from the client's connection.
 *
 * A client that navigates away or reloads only drops its own branch (the
 * route cancels it on request abort to free the tee buffer); the store
 * branch keeps the run alive to completion, and any client reattaches by
 * reading the run row. The run's lifetime is never tied to the fetch.
 */

export interface ChatTurnStarter {
  (ctx: {
    signal: AbortSignal;
    onChunk: (parts: unknown[]) => void;
    onStreamReady: (clientStream: ReadableStream<Uint8Array>, init?: ResponseInit) => void;
  }): Promise<import("./owned-runs").OwnedRunOutcome>;
}

export async function streamOwnedChatTurn(opts: {
  store: OwnedRunStore;
  conversationId: string;
  userText: string;
  startTurn: ChatTurnStarter;
  onBroadcast?: (snapshot: OwnedRunSnapshot) => void;
  onRunStarted?: (runId: string) => void;
  progressIntervalMs?: number;
}): Promise<{ response: Response; done: Promise<OwnedRunSnapshot> }> {
  let onStreamReady!: (clientStream: ReadableStream<Uint8Array>, init?: ResponseInit) => void;
  const streamReady = new Promise<{ stream: ReadableStream<Uint8Array>; init?: ResponseInit }>(
    (resolve) => {
      onStreamReady = (stream, init) => resolve({ stream, init });
    },
  );
  const done = (async () => {
    const { runId } = await opts.store.startRun(opts.conversationId, opts.userText);
    opts.onRunStarted?.(runId);
    return trackOwnedRun({
      store: opts.store,
      runId,
      conversationId: opts.conversationId,
      run: async (ctx) =>
        opts.startTurn({ signal: ctx.signal, onChunk: ctx.onChunk, onStreamReady }),
      onBroadcast: opts.onBroadcast,
      progressIntervalMs: opts.progressIntervalMs,
    });
  })();
  // A turn that fails before producing a stream (model setup error) must
  // reject here so the route can answer 5xx instead of hanging.
  void done.catch(() => {});
  const { stream, init } = await Promise.race([
    streamReady,
    done.then((): never => {
      throw new Error("assistant turn failed before streaming");
    }),
  ]);
  return { response: new Response(stream, init), done };
}

/**
 * Assemble the store branch of a teed UI-message stream into parts,
 * reporting each assembled message. Never throws: persistence trouble must
 * not break the client's live branch.
 */
export async function assembleStoreBranch(
  branch: ReadableStream<Uint8Array>,
  onChunk: (parts: unknown[]) => void,
): Promise<void> {
  try {
    const chunks = parseJsonEventStream({ stream: branch, schema: uiMessageChunkSchema }).pipeThrough(
      new TransformStream<{ success: boolean; value?: UIMessageChunk }, UIMessageChunk>({
        transform(part, controller) {
          if (part.success && part.value) controller.enqueue(part.value);
        },
      }),
    );
    for await (const message of readUIMessageStream({ stream: chunks })) {
      onChunk(message.parts as unknown[]);
    }
  } catch (error) {
    console.error("[assistant/owned-chat-turn] store branch failed", error);
  }
}
