import assert from "node:assert/strict";
import test from "node:test";
import { parseDelegationReason } from "./delegation.ts";

/**
 * Behavioural contract for the shared inbox delegation parser: every
 * adapter demands `user:<uuid>: handover note`, and the note half must
 * survive parsing so delegateGate can persist it.
 */

test("parseDelegationReason splits the recipient from the handover note", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(parseDelegationReason(`user:${id}: covering my on-call week`), {
    toUserId: id,
    note: "covering my on-call week",
  });
  // The colon-less shape keeps working too.
  assert.deepEqual(parseDelegationReason(`user:${id} covering my on-call week`), {
    toUserId: id,
    note: "covering my on-call week",
  });
});

test("parseDelegationReason trims the note and allows an empty one", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(parseDelegationReason(`user:${id}:   padded   `).note, "padded");
  assert.equal(parseDelegationReason(`user:${id}`).note, "");
  assert.equal(parseDelegationReason(`user:${id}:`).note, "");
});

test("parseDelegationReason refuses a missing recipient by name", () => {
  assert.throws(() => parseDelegationReason(null), /delegation needs a recipient/);
  assert.throws(() => parseDelegationReason("just a note, no recipient"), /delegation needs a recipient/);
  assert.throws(() => parseDelegationReason("user:not-a-uuid: note"), /delegation needs a recipient/);
});
