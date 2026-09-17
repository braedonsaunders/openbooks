import assert from "node:assert/strict";
import test from "node:test";
import { verifyPassword } from "../../../../lib/auth-password";
import { UNUSABLE_PASSWORD_HASH, deriveInviteDisplayName } from "./invite";

// Pure invite helpers: the display name an invited user gets before they ever
// sign in, and the credential placeholder that makes password login
// impossible until the mailbox owner sets a real password.

test("invite display names derive from the email local part", () => {
  assert.equal(deriveInviteDisplayName("jane.doe@example.com"), "Jane Doe");
  assert.equal(deriveInviteDisplayName("ops_team-2@example.com"), "Ops Team 2");
  assert.equal(deriveInviteDisplayName("a@b.co"), "A");
});

test("invite display names ignore sub-addressing", () => {
  assert.equal(deriveInviteDisplayName("jane+payroll@example.com"), "Jane");
});

test("invite display names fall back to the address when nothing is derivable", () => {
  assert.equal(deriveInviteDisplayName("@example.com"), "@example.com");
});

test("the invite credential placeholder can never authenticate", async () => {
  for (const candidate of ["password", "invalid-password-shape", "x".repeat(1024)]) {
    const outcome = await verifyPassword(candidate, UNUSABLE_PASSWORD_HASH);
    assert.equal(outcome.valid, false);
    assert.equal(outcome.needsRehash, false);
    assert.equal(outcome.capacityLimited, undefined);
  }
});
