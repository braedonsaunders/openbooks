import assert from "node:assert/strict";
import test from "node:test";
import { listFailedPostingEffects, MAX_POSTING_EFFECTS_ATTEMPTS, postingEffectsBackoffMs, replayTerminalPostingEffect } from "./posting-effects.ts";


test("posting effects backoff doubles then caps at one hour", () => {
  assert.equal(postingEffectsBackoffMs(0), 60_000);
  assert.equal(postingEffectsBackoffMs(1), 60_000);
  assert.equal(postingEffectsBackoffMs(2), 120_000);
  assert.equal(postingEffectsBackoffMs(3), 240_000);
  assert.equal(postingEffectsBackoffMs(MAX_POSTING_EFFECTS_ATTEMPTS), 60 * 60_000);
});

test("replay reason length is enforced before any database work", async () => {
  // The bounds throw before the function touches the database, so these
  // rows pin both fences without a database: a narrowed bound accepts the
  // 9-character reason (or rejects the 1001-character one differently) and
  // a negated guard lets everything through to a connection error.
  const base = { orgId: "00000000-0000-0000-0000-000000000000", id: "00000000-0000-0000-0000-000000000000", actorId: "00000000-0000-0000-0000-000000000000" };
  await assert.rejects(
    () => replayTerminalPostingEffect({ ...base, reason: "too short" }),
    /between 10 and 1000/,
  );
  await assert.rejects(
    () => replayTerminalPostingEffect({ ...base, reason: "x".repeat(1001) }),
    /between 10 and 1000/,
  );
});

test("failed-effects listing requires its tenant scope up front", async () => {
  // The org guard throws before any query: a negated guard queries with an
  // empty scope and surfaces a connection error instead of this refusal.
  await assert.rejects(() => listFailedPostingEffects(""), /organization id is required/);
});
