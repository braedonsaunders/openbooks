import assert from "node:assert/strict";
import test from "node:test";
import {
  abortTurn,
  attachLoop,
  beginTurn,
  completeTurn,
  controllerFor,
  detachLoop,
  dropTurn,
  failTurn,
  hasLiveLoop,
  readTurn,
  rekeyTurn,
  settleTurn,
  subscribeTurns,
  syncTurn,
  turnRevision,
  writeTurnParts,
} from "./turn-store";

const bubbles = (text: string) => ({ userId: `u-${text}`, assistantId: `a-${text}`, userText: text });

test("a begun turn streams parts under its key with rising revisions", () => {
  const key = "conv-stream-1";
  dropTurn(key);
  const before = turnRevision(key);
  beginTurn(key, key, bubbles("q1"));
  const entry = readTurn(key);
  assert.ok(entry);
  assert.equal(entry.streaming, true);
  assert.deepEqual(entry.parts, []);
  assert.ok(turnRevision(key) > before);
  writeTurnParts(key, [{ type: "text", text: "hello" }]);
  assert.deepEqual(readTurn(key)?.parts, [{ type: "text", text: "hello" }]);
  settleTurn(key);
  assert.equal(readTurn(key), undefined);
  assert.equal(turnRevision(key), -1);
});

test("settled turns take no more chunks", () => {
  const key = "conv-settled-1";
  dropTurn(key);
  beginTurn(key, key, bubbles("q"));
  writeTurnParts(key, [{ type: "text", text: "hello" }]);
  failTurn(key, "boom");
  assert.equal(readTurn(key)?.streaming, false);
  assert.equal(readTurn(key)?.error, "boom");
  writeTurnParts(key, [{ type: "text", text: "late" }]);
  assert.deepEqual(readTurn(key)?.parts, [{ type: "text", text: "hello" }]);
  dropTurn(key);
});

test("rekey moves the entry, controller, and loop to the real conversation", () => {
  const pending = "pending:rekey-1";
  const real = "conv-rekey-1";
  dropTurn(pending);
  dropTurn(real);
  beginTurn(pending, null, bubbles("new chat"));
  const controller = controllerFor(pending);
  attachLoop(pending);
  writeTurnParts(pending, [{ type: "text", text: "hi" }]);
  rekeyTurn(pending, real);
  assert.equal(readTurn(pending), undefined);
  const entry = readTurn(real);
  assert.ok(entry);
  assert.equal(entry.conversationId, real);
  assert.deepEqual(entry.parts, [{ type: "text", text: "hi" }]);
  assert.equal(controllerFor(real), controller);
  assert.equal(hasLiveLoop(real), true);
  assert.equal(hasLiveLoop(pending), false);
  dropTurn(real);
});

test("reattach polls adopt newer server snapshots and drop terminal ones", () => {
  const key = "conv-sync-1";
  dropTurn(key);
  // Discovered mid-run with no local entry: adopt.
  syncTurn({ conversationId: key, status: "running", parts: [{ type: "text", text: "v1" }], revision: 3 });
  assert.deepEqual(readTurn(key)?.parts, [{ type: "text", text: "v1" }]);
  assert.equal(readTurn(key)?.streaming, true);
  // Stale poll never clobbers.
  syncTurn({ conversationId: key, status: "running", parts: [{ type: "text", text: "v0" }], revision: 2 });
  assert.deepEqual(readTurn(key)?.parts, [{ type: "text", text: "v1" }]);
  // Newer poll adopts.
  syncTurn({ conversationId: key, status: "running", parts: [{ type: "text", text: "v2" }], revision: 4 });
  assert.deepEqual(readTurn(key)?.parts, [{ type: "text", text: "v2" }]);
  // Terminal server state drops the tail (transcript is truth).
  syncTurn({ conversationId: key, status: "complete", parts: [{ type: "text", text: "v3" }], revision: 5 });
  assert.equal(readTurn(key), undefined);
});

test("a turn completed while away keeps its final parts for adopt on return", () => {
  const key = "conv-away-1";
  dropTurn(key);
  beginTurn(key, key, bubbles("away"));
  writeTurnParts(key, [{ type: "text", text: "partial" }]);
  completeTurn(key, [{ type: "text", text: "final answer" }]);
  const entry = readTurn(key);
  assert.ok(entry);
  assert.equal(entry.streaming, false);
  assert.deepEqual(entry.parts, [{ type: "text", text: "final answer" }]);
  // A later transcript load converges and drops the tail.
  settleTurn(key);
  assert.equal(readTurn(key), undefined);
  writeTurnParts(key, [{ type: "text", text: "late" }]);
  assert.equal(readTurn(key), undefined);
});

test("dropping one conversation leaves other in-flight turns untouched", () => {
  const keep = "conv-keep-1";
  const drop = "conv-drop-1";
  dropTurn(keep);
  dropTurn(drop);
  beginTurn(keep, keep, bubbles("keep"));
  beginTurn(drop, drop, bubbles("drop"));
  writeTurnParts(keep, [{ type: "text", text: "keep-progress" }]);
  writeTurnParts(drop, [{ type: "text", text: "drop-progress" }]);
  dropTurn(drop);
  assert.equal(readTurn(drop), undefined);
  const kept = readTurn(keep);
  assert.ok(kept);
  assert.equal(kept.streaming, true);
  assert.deepEqual(kept.parts, [{ type: "text", text: "keep-progress" }]);
  dropTurn(keep);
});

test("aborting one conversation does not abort another", () => {
  const a = "conv-abort-a";
  const b = "conv-abort-b";
  dropTurn(a);
  dropTurn(b);
  const acA = controllerFor(a);
  const acB = controllerFor(b);
  abortTurn(a);
  assert.equal(acA.signal.aborted, true);
  assert.equal(acB.signal.aborted, false);
  abortTurn(b);
});

test("loop presence distinguishes live streams from orphaned entries", () => {
  const key = "conv-loop-1";
  detachLoop(key);
  assert.equal(hasLiveLoop(key), false);
  attachLoop(key);
  assert.equal(hasLiveLoop(key), true);
  detachLoop(key);
  assert.equal(hasLiveLoop(key), false);
  assert.equal(hasLiveLoop(null), false);
});

test("subscribers are notified on turn mutations", () => {
  const key = "conv-sub-1";
  dropTurn(key);
  let calls = 0;
  const stop = subscribeTurns(() => {
    calls += 1;
  });
  try {
    beginTurn(key, key, bubbles("sub"));
    writeTurnParts(key, []);
    settleTurn(key);
    assert.ok(calls >= 3, `expected notifications, got ${calls}`);
  } finally {
    stop();
  }
  const frozen = calls;
  beginTurn("conv-sub-other", "conv-sub-other", bubbles("other"));
  assert.equal(calls, frozen, "unsubscribed listeners stay silent");
  dropTurn("conv-sub-other");
});
