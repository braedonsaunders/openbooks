import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryOwnedRunStore } from "./owned-runs";
import { assembleStoreBranch, streamOwnedChatTurn } from "./owned-chat-turn";
import type { OwnedRunOutcome } from "./owned-runs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const encoder = new TextEncoder();

function sseBytes(chunks: unknown[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[index++])}\n\n`));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const TEXT = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Checking the books" },
  { type: "text-end", id: "t1" },
];

function fakeStarter(outcome: OwnedRunOutcome, chunks: unknown[] = TEXT) {
  return async ({ onChunk, onStreamReady }: {
    signal: AbortSignal;
    onChunk: (parts: unknown[]) => void;
    onStreamReady: (s: ReadableStream<Uint8Array>) => void;
  }) => {
    const [toClient, toStore] = sseBytes(chunks).tee();
    onStreamReady(toClient);
    const assembly = assembleStoreBranch(toStore, onChunk);
    await tick();
    await assembly;
    return outcome;
  };
}

const doneOutcome = (parts: unknown[]): OwnedRunOutcome => ({
  status: "complete",
  parts,
  content: "Checking the books",
  usage: {},
  finishReason: "stop",
});

test("the client branch streams live while the run persists to its row", async () => {
  const store = createMemoryOwnedRunStore();
  const parts = [{ type: "text", text: "Checking the books" }];
  const turn = await streamOwnedChatTurn({
    store,
    conversationId: "conv-composed",
    userText: "hello",
    startTurn: fakeStarter(doneOutcome(parts)),
    progressIntervalMs: 1,
  });
  const body = await readAll(turn.response.body!);
  assert.ok(body.includes("Checking the books"), "client must receive live bytes");
  const final = await turn.done;
  assert.equal(final.status, "complete");
  assert.deepEqual(final.parts, parts);
  assert.equal((await store.readRun(final.runId))?.status, "complete");
});

test("dropping the client branch mid-turn does not stop the run", async () => {
  const store = createMemoryOwnedRunStore();
  const parts = [{ type: "text", text: "Checking the books" }];
  const turn = await streamOwnedChatTurn({
    store,
    conversationId: "conv-drop-branch",
    userText: "hello",
    startTurn: fakeStarter(doneOutcome(parts)),
    progressIntervalMs: 1,
  });
  // Read one byte, then abandon the client branch (navigation / reload).
  const reader = turn.response.body!.getReader();
  await reader.read();
  await reader.cancel();
  const final = await turn.done;
  assert.equal(final.status, "complete");
  assert.deepEqual(final.parts, parts);
  // …and a reattached reader finds the full log on the row.
  assert.deepEqual((await store.readRun(final.runId))?.parts, parts);
});

test("a turn that fails before streaming rejects instead of hanging", async () => {
  const store = createMemoryOwnedRunStore();
  await assert.rejects(
    streamOwnedChatTurn({
      store,
      conversationId: "conv-nostream",
      userText: "hello",
      startTurn: async () => {
        throw new Error("model unavailable");
      },
    }),
    /failed before streaming/,
  );
});
