import assert from "node:assert/strict";
import test from "node:test";
import { validateRuleVersion } from "./validate.ts";
import {
  OVERHEAD_EVENT_DOCUMENT_KIND,
  OVERHEAD_SYSTEM_DRIVER_KEY,
  OVERHEAD_SYSTEM_RULE_KEY,
  deriveOverheadSystemVersion,
} from "./overhead-sync.ts";

const POLICY = { mode: "net_zero_pair", accountId: "11111111-1111-4111-8111-111111111111" };
const DRIVER_ID = "22222222-2222-4222-8222-222222222222";

function publishedCtx() {
  return {
    orgId: "33333333-3333-4333-8333-333333333333",
    ruleId: "44444444-4444-4444-8444-444444444444",
    mode: "post" as const,
    publishedVersions: [],
    driver: { id: DRIVER_ID, dimension: "project", isActive: true },
    activePostingBookIds: ["55555555-5555-4555-8555-555555555555"],
  };
}

test("overhead derivation publishes from the rate card, dated from the earliest row", () => {
  const derived = deriveOverheadSystemVersion(POLICY, [
    { departmentId: "dept-b", category: "Facilities", method: "standard", ratePercent: "20.0000", effectiveFrom: "2026-03-01", effectiveTo: null },
    { departmentId: "dept-a", category: "Facilities", method: "standard", ratePercent: "12.5000", effectiveFrom: "2026-01-01", effectiveTo: "2026-02-28" },
  ]);
  assert.equal(derived.action, "publish");
  assert.equal(derived.effectiveFrom, "2026-01-01");
  assert.equal(derived.accountId, POLICY.accountId);
  assert.ok(derived.rateHash.length === 64);
});

test("overhead derivation is order-stable and rate-sensitive", () => {
  const rowsA = [
    { departmentId: "dept-a", category: null, method: "standard", ratePercent: "12.5000", effectiveFrom: "2026-01-01", effectiveTo: null },
    { departmentId: null, category: null, method: "standard", ratePercent: "10.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
  ];
  const rowsB = [...rowsA].reverse();
  const a = deriveOverheadSystemVersion(POLICY, rowsA);
  const b = deriveOverheadSystemVersion(POLICY, rowsB);
  assert.equal(a.action, "publish");
  assert.equal(b.action, "publish");
  assert.equal(a.rateHash, b.rateHash);
  const changed = deriveOverheadSystemVersion(POLICY, rowsA.map((r) => ({ ...r, ratePercent: "12.6000" })));
  assert.equal(changed.action, "publish");
  assert.notEqual(changed.rateHash, a.rateHash);
});

test("overhead derivation retires when the policy is not a net-zero pair", () => {
  for (const policy of [
    { mode: "report_only", accountId: POLICY.accountId },
    { mode: "off", accountId: POLICY.accountId },
    { mode: "net_zero_pair", accountId: null },
  ]) {
    const derived = deriveOverheadSystemVersion(policy, [
      { departmentId: null, category: null, method: "standard", ratePercent: "10.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
    ]);
    assert.equal(derived.action, "retire");
  }
});

test("overhead derivation retires when the card holds no hourly rows", () => {
  assert.equal(deriveOverheadSystemVersion(POLICY, []).action, "retire");
});

test("the derived definition is a post-mode net-zero pair no document matcher can select", () => {
  const derived = deriveOverheadSystemVersion(POLICY, [
    { departmentId: null, category: null, method: "standard", ratePercent: "10.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
  ]);
  assert.equal(derived.action, "publish");
  assert.equal(derived.definition.impact, "net_zero_pair");
  assert.equal(derived.definition.basisKind, "driver");
  assert.equal(derived.definition.targetKind, "dynamic");
  assert.deepEqual(derived.definition.dynamicTarget, { dimension: "project" });
  // The event pseudo-kind never appears on a real document, so A5's post
  // seam and A4's entry matcher can never select the system rule.
  assert.deepEqual(derived.definition.documentKinds, [OVERHEAD_EVENT_DOCUMENT_KIND]);
  assert.deepEqual(derived.definition.accountScope, { kind: "accounts", accountIds: [POLICY.accountId] });
});

test("the derived definition passes publish validation against its system driver", () => {
  const derived = deriveOverheadSystemVersion(POLICY, [
    { departmentId: null, category: null, method: "standard", ratePercent: "10.0000", effectiveFrom: "2026-01-01", effectiveTo: null },
  ]);
  assert.equal(derived.action, "publish");
  const problems = validateRuleVersion(
    {
      id: "66666666-6666-4666-8666-666666666666",
      orgId: publishedCtx().orgId,
      ruleId: publishedCtx().ruleId,
      versionNo: 1,
      status: "draft",
      ...derived.definition,
      driverId: DRIVER_ID,
      definitionHash: null,
      publishedAt: null,
      publishedBy: null,
    },
    [],
    publishedCtx(),
  );
  assert.deepEqual(problems, []);
});

test("system key constants are stable slugs", () => {
  assert.equal(OVERHEAD_SYSTEM_RULE_KEY, "overhead-net-zero-pair");
  assert.equal(OVERHEAD_SYSTEM_DRIVER_KEY, "overhead-labor-hours");
});
