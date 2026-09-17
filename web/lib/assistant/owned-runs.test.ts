import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryOwnedRunStore,
  executeOwnedRun,
  type OwnedRunSnapshot,
} from "./owned-runs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A scripted model turn: emits chunk/part pairs, then resolves. */
function scriptedTurn(
  frames: { parts: unknown[] }[],
  opts?: { hangAfter?: number; signalSeen?: (signal: AbortSignal) => void },
) {
  return async ({ signal, onChunk }: { signal: AbortSignal; onChunk: (parts: unknown[]) => void }) => {
    opts?.signalSeen?.(signal);
    let emitted = 0;
    for (const frame of frames) {
      if (signal.aborted) {
        return { status: "stopped" as const, parts: [], content: "Response stopped.", usage: {}, finishReason: "abort" };
      }
      onChunk(frame.parts);
      emitted += 1;
      if (opts?.hangAfter !== undefined && emitted >= opts.hangAfter) {
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (signal.aborted) {
              clearInterval(timer);
              resolve();
            }
          }, 5);
        });
        return { status: "stopped" as const, parts: [], content: "Response stopped.", usage: {}, finishReason: "abort" };
      }
      await tick();
    }
    const parts = frames.at(-1)?.parts ?? [];
    return { status: "complete" as const, parts, content: "done", usage: {}, finishReason: "stop" };
  };
}

const textFrames = (words: string[]) =>
  words.map((word, i) => ({
    parts: [{ type: "text", text: words.slice(0, i + 1).join(" ") }],
  }));

test("a completed turn persists its full parts and broadcasts progress", async () => {
  const store = createMemoryOwnedRunStore();
  const seen: OwnedRunSnapshot[] = [];
  const final = await executeOwnedRun({
    store,
    conversationId: "conv-1",
    userText: "hello",
    run: scriptedTurn(textFrames(["Checking", "the", "books"])),
    onBroadcast: (snapshot) => seen.push(snapshot),
    progressIntervalMs: 1,
  });
  assert.equal(final.status, "complete");
  assert.deepEqual(final.parts, [{ type: "text", text: "Checking the books" }]);
  assert.ok(seen.length > 0, "progress must broadcast while running");
  assert.ok(seen.every((s) => s.runId === final.runId));
  const reread = await store.readRun(final.runId);
  assert.deepEqual(reread?.parts, final.parts);
  assert.equal(reread?.status, "complete");
  assert.equal(await store.activeRun("conv-1"), null);
});

test("a dropped client connection never stops the run", async () => {
  const store = createMemoryOwnedRunStore();
  const clientSignal = new AbortController();
  let runSignal: AbortSignal | null = null;
  const frames = textFrames(["one", "two", "three", "four"]);
  const finished = executeOwnedRun({
    store,
    conversationId: "conv-disconnect",
    userText: "hello",
    run: async (ctx) => {
      runSignal = ctx.signal;
      // The run must not observe the client's signal at all.
      assert.notEqual(ctx.signal, clientSignal.signal);
      return scriptedTurn(frames)(ctx);
    },
    progressIntervalMs: 1,
  });
  // Let the turn start, then simulate the user navigating away / reloading:
  // the client's own fetch signal dies here.
  await tick();
  await tick();
  clientSignal.abort();
  const partial = await store.activeRun("conv-disconnect");
  assert.ok(partial, "the run must still be active after disconnect");
  const final = await finished;
  assert.equal(final.status, "complete");
  assert.deepEqual(final.parts, [{ type: "text", text: "one two three four" }]);
  const observed = runSignal as AbortSignal | null;
  assert.ok(observed && !observed.aborted, "the run-owned signal must outlive the client");
});

test("an explicit abort stops the run with its partial parts persisted", async () => {
  const store = createMemoryOwnedRunStore();
  const frames = textFrames(["alpha", "beta", "gamma"]);
  const finished = executeOwnedRun({
    store,
    conversationId: "conv-abort",
    userText: "hello",
    run: scriptedTurn(frames, { hangAfter: 2 }),
    progressIntervalMs: 1,
  });
  await tick();
  await tick();
  const active = await store.activeRun("conv-abort");
  assert.ok(active);
  assert.equal(await store.requestAbort(active.runId), true);
  const final = await finished;
  assert.equal(final.status, "stopped");
  const reread = await store.readRun(active.runId);
  assert.equal(reread?.status, "stopped");
  assert.ok((reread?.parts.length ?? 0) > 0, "partial progress must survive the abort");
});

test("deleting the conversation mid-run stops the run instead of throwing", async () => {
  const store = createMemoryOwnedRunStore();
  const finished = executeOwnedRun({
    store,
    conversationId: "conv-deleted",
    userText: "hello",
    run: scriptedTurn(textFrames(["x", "y", "z"]), { hangAfter: 1 }),
    progressIntervalMs: 1,
  });
  await tick();
  await tick();
  store.deleteConversation("conv-deleted");
  const final = await finished;
  assert.equal(final.status, "stopped");
});

test("tool activity flushes immediately while text rides the throttle", async () => {
  const store = createMemoryOwnedRunStore();
  const toolParts = [
    { type: "text", text: "working" },
    { type: "tool-profit_and_loss", toolCallId: "c1", state: "input-streaming" },
  ];
  const finished = executeOwnedRun({
    store,
    conversationId: "conv-flush",
    userText: "hello",
    run: async ({ onChunk }) => {
      onChunk([{ type: "text", text: "working" }]);
      await tick();
      onChunk(toolParts);
      await tick();
      return { status: "complete" as const, parts: toolParts, content: "done", usage: {}, finishReason: "stop" };
    },
    // A throttle no test should ever wait out: only boundaries may persist.
    progressIntervalMs: 3_600_000,
  });
  await tick();
  await tick();
  const mid = await store.activeRun("conv-flush");
  assert.ok(mid, "tool boundary must flush past the throttle");
  assert.deepEqual(mid.parts, toolParts);
  await finished;
});

test("a reattached reader sees the full event log, including pre-attach progress", async () => {
  const store = createMemoryOwnedRunStore();
  const frames = textFrames(["first", "second", "third"]);
  const finished = executeOwnedRun({
    store,
    conversationId: "conv-reattach",
    userText: "hello",
    run: scriptedTurn(frames),
    progressIntervalMs: 1,
  });
  await tick();
  await tick();
  // Reattach mid-run: the log already holds what streamed before attach.
  const mid = await store.activeRun("conv-reattach");
  assert.ok(mid);
  assert.ok(mid.parts.length > 0, "pre-attach progress must be in the log");
  assert.ok(mid.revision > 0);
  await finished;
  const end = await store.readRun(mid.runId);
  assert.deepEqual(end?.parts, [{ type: "text", text: "first second third" }]);
});
