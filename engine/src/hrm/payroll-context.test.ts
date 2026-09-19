/**
 * Unit proof for the pure manager-routing choice (payroll-context.ts).
 *
 * The 0184 single_line exclusion makes two live reporting lines unseedable
 * in storage, so no DB fixture can reach the ambiguous branch — the DB suite
 * proves the exclusion holds instead, and this file proves the refusal
 * condition itself: two DISTINCT managers throw coded ambiguous_manager
 * naming both and the remedy, while none (null) and one (winner) behave.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollContextError, pickActiveManager } from "./payroll-context.ts";

const CTX = { employmentId: "emp-1", asOf: "2026-03-01" };

test("no active manager is a legitimate null answer, not a refusal", () => {
  assert.equal(pickActiveManager([], CTX), null);
});

test("one active manager wins", () => {
  const picked = pickActiveManager(
    [{ managerEmploymentId: "mgr-1", managerPartyId: "party-1" }],
    CTX,
  );
  assert.deepEqual(picked, { managerEmploymentId: "mgr-1", managerPartyId: "party-1" });
});

test("the same manager on two rows still routes unambiguously", () => {
  const picked = pickActiveManager(
    [
      { managerEmploymentId: "mgr-1", managerPartyId: "party-1" },
      { managerEmploymentId: "mgr-1", managerPartyId: "party-1" },
    ],
    CTX,
  );
  assert.equal(picked?.managerEmploymentId, "mgr-1");
});

test("two distinct managers refuse coded ambiguous_manager naming both and the remedy", () => {
  assert.throws(
    () =>
      pickActiveManager(
        [
          { managerEmploymentId: "mgr-2", managerPartyId: "party-2" },
          { managerEmploymentId: "mgr-1", managerPartyId: "party-1" },
        ],
        CTX,
      ),
    (error: unknown) => {
      assert.ok(error instanceof PayrollContextError);
      assert.equal(error.code, "ambiguous_manager");
      assert.match(error.message, /mgr-1/);
      assert.match(error.message, /mgr-2/);
      assert.match(error.message, /2026-03-01/);
      assert.match(error.message, /HRM employment change request/);
      return true;
    },
  );
});
