import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  retainedTransactionPolicyOrder,
  type BenefitTransactionPolicy,
} from "./transaction-policy.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// PostgreSQL JSONB does not preserve object insertion order. Array order,
// decimal representations and the presence of optional fields still matter.
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, reordered(entry)]),
    );
  return value;
}
const policy: BenefitTransactionPolicy = {
  documentKind: "sales_order",
  dateBasis: "document_date",
  groupingSegmentId: null,
  unassignedShare: "forfeit",
  rounding: "per_recipient",
  capPercent: null,
  capProjectTypeId: null,
  itemIds: ["item"],
  positions: [
    {
      key: "lead",
      name: "Lead",
      weight: "1.0000",
      recipientSource: "field_ticket_foreman",
      fallbackSource: "project_foreman",
    },
  ],
  responsibilities: [
    {
      groupId: "employer",
      positionKey: "lead",
      employmentId: "employment",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    },
  ],
  limits: [{ groupId: "employer", kind: "none", amount: null }],
};
test("retained dated policy reproduces its original transaction digest after JSONB ordering", () => {
  const stored = reordered(policy) as BenefitTransactionPolicy;
  assert.notEqual(digest(stored), digest(policy));
  const restored = retainedTransactionPolicyOrder(stored);
  assert.equal(digest(restored), digest(policy));
  assert.deepEqual(restored, policy);
  assert.equal("fallbackOnlyWhenContextAbsent" in restored.positions[0]!, false);
});
test("policy order restoration retains changed financial facts and additional evidence", () => {
  const changed = {
    ...policy,
    positions: [{ ...policy.positions[0]!, weight: "2.0000", fallbackOnlyWhenContextAbsent: true }],
  };
  const restored = retainedTransactionPolicyOrder(reordered(changed) as BenefitTransactionPolicy);
  assert.notEqual(digest(restored), digest(policy));
  assert.equal(restored.positions[0]!.weight, "2.0000");
  assert.equal(restored.positions[0]!.fallbackOnlyWhenContextAbsent, true);
  const additional = { ...policy, retainedSource: { id: "source" } };
  assert.deepEqual(
    retainedTransactionPolicyOrder(reordered(additional) as BenefitTransactionPolicy),
    additional,
  );
  assert.notEqual(digest(retainedTransactionPolicyOrder(additional)), digest(policy));
});
