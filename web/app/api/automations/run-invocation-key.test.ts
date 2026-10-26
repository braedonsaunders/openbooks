// Run-now identity: an Idempotency-Key collapses retries onto one run, and a
// request without the key is always a new invocation.
import assert from "node:assert/strict";
import test from "node:test";
import { RUN_IDEMPOTENCY_KEY_MAX_LENGTH, resolveRunInvocationKey } from "./_lib";

const ACTOR = "6f1c2a3e-0000-4000-8000-000000000001";

test("an Idempotency-Key header becomes the run fingerprint", () => {
  const result = resolveRunInvocationKey("  order-17-retry  ", ACTOR);
  assert.deepEqual(result, { ok: true, fingerprint: `manual:${ACTOR}:order-17-retry` });
});

test("the same key always resolves to the same fingerprint", () => {
  const first = resolveRunInvocationKey("k-123", ACTOR);
  const second = resolveRunInvocationKey("k-123", ACTOR);
  assert.deepEqual(first, second);
});

test("a request without the header gets a fresh fingerprint each time", () => {
  const first = resolveRunInvocationKey(null, ACTOR);
  const second = resolveRunInvocationKey(null, ACTOR);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.match(first.fingerprint, /^manual:[0-9a-f-]{36}$/);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("a blank Idempotency-Key header refuses with an actionable remedy", () => {
  const result = resolveRunInvocationKey("   ", ACTOR);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /Idempotency-Key header is empty/);
  assert.match(result.error, /omit the header/);
});

test("an Idempotency-Key longer than the maximum refuses", () => {
  const tooLong = "x".repeat(RUN_IDEMPOTENCY_KEY_MAX_LENGTH + 1);
  const result = resolveRunInvocationKey(tooLong, ACTOR);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /at most 200 characters/);
});

test("an Idempotency-Key at the maximum length is accepted", () => {
  const atLimit = "x".repeat(RUN_IDEMPOTENCY_KEY_MAX_LENGTH);
  const result = resolveRunInvocationKey(atLimit, ACTOR);
  assert.deepEqual(result, { ok: true, fingerprint: `manual:${ACTOR}:${atLimit}` });
});

test("the same key from another user is a different invocation", () => {
  const mine = resolveRunInvocationKey("k-123", ACTOR);
  const theirs = resolveRunInvocationKey("k-123", "6f1c2a3e-0000-4000-8000-000000000002");
  assert.notDeepEqual(mine, theirs);
});
