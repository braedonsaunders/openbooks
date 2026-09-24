import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Static imports evaluate before the module body, so the service import
// below is dynamic: cycles.ts pulls platform/db.ts, whose environment
// resolution must see the cleared URLs first (same pattern as
// authorization.test.ts). These tests never touch a real database.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const { assertLineDeciderSeparation } = await import("./cycles.ts");
const { CompensationError } = await import("./errors.ts");

/**
 * C-78: line-decision separation of duties. Both identity legs hold — the
 * decider is neither the proposing user nor the same person behind a
 * second login — and an unresolvable proposer (legacy null proposed_by,
 * a deleted proposing user, a null party on either side) is a named
 * refusal to re-propose, never a pass. users.party_id is nullable
 * (baseline schema), so the null-party self-approval is real.
 */

const PROPOSER = randomUUID();
const PROPOSER_PARTY = randomUUID();
const DECIDER = randomUUID();
const DECIDER_PARTY = randomUUID();

test("an independent decider clears both legs", async () => {
  assertLineDeciderSeparation({
    proposedBy: PROPOSER,
    proposerPartyId: PROPOSER_PARTY,
    deciderUserId: DECIDER,
    deciderPartyId: DECIDER_PARTY,
  });
});

test("the proposing user cannot decide, even behind a different party", async () => {
  assert.throws(
    () =>
      assertLineDeciderSeparation({
        proposedBy: PROPOSER,
        proposerPartyId: PROPOSER_PARTY,
        deciderUserId: PROPOSER,
        deciderPartyId: DECIDER_PARTY,
      }),
    (e: unknown) => e instanceof CompensationError && /cannot decide their own line/.test(e.message),
  );
});

test("the same person behind a second login cannot decide", async () => {
  assert.throws(
    () =>
      assertLineDeciderSeparation({
        proposedBy: PROPOSER,
        proposerPartyId: PROPOSER_PARTY,
        deciderUserId: DECIDER,
        deciderPartyId: PROPOSER_PARTY,
      }),
    (e: unknown) => e instanceof CompensationError && /cannot decide their own line/.test(e.message),
  );
});

test("a legacy line with no proposer is refused with the re-propose remedy", async () => {
  assert.throws(
    () =>
      assertLineDeciderSeparation({
        proposedBy: null,
        proposerPartyId: null,
        deciderUserId: DECIDER,
        deciderPartyId: DECIDER_PARTY,
      }),
    (e: unknown) => e instanceof CompensationError && /re-propose the line/.test(e.message),
  );
});

test("a null-party proposer is refused, never passed as self-approval", async () => {
  assert.throws(
    () =>
      assertLineDeciderSeparation({
        proposedBy: PROPOSER,
        proposerPartyId: null,
        deciderUserId: DECIDER,
        deciderPartyId: DECIDER_PARTY,
      }),
    (e: unknown) => e instanceof CompensationError && /can't be verified/.test(e.message),
  );
  assert.throws(
    () =>
      assertLineDeciderSeparation({
        proposedBy: PROPOSER,
        proposerPartyId: PROPOSER_PARTY,
        deciderUserId: DECIDER,
        deciderPartyId: null,
      }),
    (e: unknown) => e instanceof CompensationError && /can't be verified/.test(e.message),
  );
});
