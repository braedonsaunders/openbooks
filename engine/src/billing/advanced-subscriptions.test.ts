import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import {
  AdvancedSubscriptionError,
  addMonths,
  arrearsLinesForInterval,
  assertCotermAllowed,
  assertIdempotentReplay,
  assertPlanVersionMutable,
  firstLifecycleBillOn,
  lifecycleBillingPeriod,
  renewalAction,
  subscriptionComponentTotal,
  type ComponentWindow,
} from "./advanced-subscriptions.ts";
import { prorateDays } from "../money/money.ts";

test("trial suppresses advance billing until trial end", () => {
  assert.equal(firstLifecycleBillOn({ termStartsOn: "2026-01-01", trialEndsOn: "2026-01-15", billingTiming: "advance", interval: "monthly", intervalCount: 1 }), "2026-01-15");
});

test("arrears bills one interval after service begins, including after a trial", () => {
  assert.equal(firstLifecycleBillOn({ termStartsOn: "2026-01-01", trialEndsOn: null, billingTiming: "arrears", interval: "monthly", intervalCount: 1 }), "2026-02-01");
  assert.equal(firstLifecycleBillOn({ termStartsOn: "2026-01-01", trialEndsOn: "2026-01-15", billingTiming: "arrears", interval: "monthly", intervalCount: 1 }), "2026-02-15");
});

test("advance and arrears produce different service periods around the same bill date", () => {
  assert.deepEqual(lifecycleBillingPeriod({ billOn: "2026-02-01", serviceAnchor: "2026-01-01", billingTiming: "arrears", interval: "monthly", intervalCount: 1 }), { periodStartsOn: "2026-01-01", periodEndsOn: "2026-02-01" });
  assert.deepEqual(lifecycleBillingPeriod({ billOn: "2026-02-01", serviceAnchor: "2026-01-01", billingTiming: "advance", interval: "monthly", intervalCount: 1 }), { periodStartsOn: "2026-02-01", periodEndsOn: "2026-03-01" });
});

test("published catalog terms are immutable", () => {
  assert.doesNotThrow(() => assertPlanVersionMutable("draft"));
  assert.throws(() => assertPlanVersionMutable("published"), AdvancedSubscriptionError);
  assert.throws(() => assertPlanVersionMutable("superseded"), /immutable/);
});

test("idempotent retries can only replay on the original subscription", () => {
  assert.doesNotThrow(() => assertIdempotentReplay("sub-1", "sub-1"));
  assert.throws(() => assertIdempotentReplay("sub-1", "sub-2"), /another subscription/);
});

test("co-term requires a different subscription for the same customer", () => {
  assert.doesNotThrow(() => assertCotermAllowed({ subscriptionId: "sub-1", anchorSubscriptionId: "sub-2", customerId: "cust-1", anchorCustomerId: "cust-1" }));
  assert.throws(() => assertCotermAllowed({ subscriptionId: "sub-1", anchorSubscriptionId: "sub-1", customerId: "cust-1", anchorCustomerId: "cust-1" }), /different anchor/);
  assert.throws(() => assertCotermAllowed({ subscriptionId: "sub-1", anchorSubscriptionId: "sub-2", customerId: "cust-1", anchorCustomerId: "cust-2" }), /same customer/);
});

test("renewal boundary respects invoice timing and policy", () => {
  assert.equal(renewalAction({ billingTiming: "advance", dueOn: "2027-01-01", termEndsOn: "2027-01-01", policy: "auto" }), "renew");
  assert.equal(renewalAction({ billingTiming: "arrears", dueOn: "2027-01-01", termEndsOn: "2027-01-01", policy: "auto" }), "bill");
  assert.equal(renewalAction({ billingTiming: "arrears", dueOn: "2027-02-01", termEndsOn: "2027-01-01", policy: "manual" }), "stop");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
});

test("multi-component invoice total preserves ledger precision", () => {
  assert.equal(subscriptionComponentTotal([{ quantity: "10", unitPrice: "12.50" }, { quantity: "1", unitPrice: "29.99" }]), "154.9900");
});

function arrearsWindow(overrides: Partial<ComponentWindow> & { componentKey: string }): ComponentWindow {
  return {
    description: "Fee",
    quantity: "1",
    unitPrice: "310.0000",
    incomeAccountId: null,
    itemId: null,
    taxCodeId: null,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    ...overrides,
  };
}

test("arrears prices the interval at the price in force during it, not the next period's", () => {
  // Price A runs through Jan 31, price B starts Feb 1; a Jan 1 - Feb 1
  // arrears bill must charge A for January, never B.
  const lines = arrearsLinesForInterval("2026-01-01", "2026-02-01", [
    arrearsWindow({ componentKey: "fee", unitPrice: "310.0000", effectiveFrom: "2026-01-01", effectiveTo: "2026-01-31" }),
    arrearsWindow({ componentKey: "fee", unitPrice: "620.0000", effectiveFrom: "2026-02-01", effectiveTo: null }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.unitPrice, "310.0000");
  assert.equal(lines[0]!.quantity, "1");
  assert.equal(lines[0]!.description, "Fee");
});

test("an unchanged arrears price bills one verbatim line as before", () => {
  const lines = arrearsLinesForInterval("2026-01-01", "2026-02-01", [
    arrearsWindow({ componentKey: "fee", quantity: "2", unitPrice: "155.0000" }),
  ]);
  assert.deepEqual(lines, [{
    description: "Fee",
    quantity: "2",
    unitPrice: "155.0000",
    incomeAccountId: null,
    itemId: null,
    taxCodeId: null,
  }]);
});

test("a mid-interval arrears price change splits and prorates by effective window", () => {
  const lines = arrearsLinesForInterval("2026-01-01", "2026-02-01", [
    arrearsWindow({ componentKey: "fee", unitPrice: "310.0000", effectiveFrom: "2026-01-01", effectiveTo: "2026-01-15" }),
    arrearsWindow({ componentKey: "fee", unitPrice: "620.0000", effectiveFrom: "2026-01-16", effectiveTo: null }),
  ]);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.unitPrice, prorateDays("310.0000", 15, 31));
  assert.equal(lines[1]!.unitPrice, prorateDays("620.0000", 16, 31));
  assert.equal(lines[0]!.quantity, "1");
  assert.match(lines[0]!.description, /2026-01-01.*2026-01-15/);
  assert.match(lines[1]!.description, /2026-01-16.*2026-01-31/);
  assert.equal(subscriptionComponentTotal(lines), "470.0000");
});

test("an arrears component added mid-interval bills only its served slice", () => {
  const lines = arrearsLinesForInterval("2026-01-01", "2026-02-01", [
    arrearsWindow({ componentKey: "addon", description: "Add-on", unitPrice: "310.0000", effectiveFrom: "2026-01-16", effectiveTo: null }),
  ]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.unitPrice, prorateDays("310.0000", 16, 31));
});

test("arrears windowing keeps civil years 1-99 (0096 splits 14/29 and 15/29)", () => {
  // Date.UTC maps years 0-99 onto 1900-1999; a 0096 window end rendered
  // through it lands in 1996, the lexical clamp then swallows the period
  // boundary, and the whole month bills instead of the served slice.
  // February 0096 is a 29-day leap month, like the 1996 control.
  for (const century of ["0096", "1996"]) {
    const lines = arrearsLinesForInterval(`${century}-02-01`, `${century}-03-01`, [
      arrearsWindow({ componentKey: "fee", unitPrice: "290.0000", effectiveFrom: `${century}-02-01`, effectiveTo: `${century}-02-14` }),
      arrearsWindow({ componentKey: "fee", unitPrice: "290.0000", effectiveFrom: `${century}-02-15`, effectiveTo: null }),
    ]);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.unitPrice, "140.0000");
    assert.equal(lines[1]!.unitPrice, "150.0000");
    assert.match(lines[0]!.description, new RegExp(`${century}-02-01.*${century}-02-14`));
    assert.match(lines[1]!.description, new RegExp(`${century}-02-15.*${century}-02-29`));
  }
});

test("arrears windowing is degenerate-safe", () => {
  assert.deepEqual(arrearsLinesForInterval("2026-02-01", "2026-02-01", [arrearsWindow({ componentKey: "fee" })]), []);
  assert.deepEqual(arrearsLinesForInterval("2026-01-01", "2026-02-01", []), []);
});

// --- scheduled renewal provenance (fnd_mt97nsbf_qvlaww) --------------------

test("the scheduler renewal no longer reads or borrows subscriptions.created_by", () => {
  const source = readFileSync(new URL("./advanced-subscriptions.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function prepareAdvancedSubscriptionBilling");
  const body = source.slice(start);
  // The old code selected subscriptions.created_by, refused a NULL author
  // ("automatic renewal needs an owning user"), and passed that historic user
  // into applyAmendment for the scheduler-generated amendment.
  assert.doesNotMatch(body, /created_by|createdBy/, "the scheduler must not consult the subscription's historical author");
  assert.doesNotMatch(body, /owning user/, "null-author imports must renew under system provenance");
});

test("scheduled renewals stamp system provenance onto the amendment row", () => {
  const source = readFileSync(new URL("./advanced-subscriptions.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function prepareAdvancedSubscriptionBilling");
  const body = source.slice(start);
  assert.match(
    body,
    /applyAmendment\(\s*orgId,\s*null,\s*\{[\s\S]*?type: "renew"[\s\S]*?\},\s*\{\s*system:\s*\{/,
    "auto-renewal must apply its amendment as an explicit system run",
  );
  assert.match(
    body,
    /origin: "subscription-billing-scheduler"/,
    "the scheduler source marker is persisted in the amendment's request snapshot",
  );
  const applyStart = source.indexOf("export async function applyAmendment");
  const applyBody = source.slice(applyStart, start > applyStart ? start : undefined);
  assert.match(applyBody, /SYSTEM_ACTOR_ID/, "system amendments carry the documented engine actor");
  assert.notEqual(SYSTEM_ACTOR_ID, "00000000-0000-0000-0000-000000000000", "the zero UUID means 'no actor at all' and is never persisted");
});

test('subscription date arithmetic rejects malformed dates, intervals, and fractional terms', async () => {
  const { advanceLifecycleDate } = await import('./advanced-subscriptions.ts');
  for (const count of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    assert.throws(() => advanceLifecycleDate('2026-01-31', 'monthly', count), AdvancedSubscriptionError);
    assert.throws(() => addMonths('2026-01-31', count), AdvancedSubscriptionError);
  }
  for (const date of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-1-1', '']) {
    assert.throws(() => advanceLifecycleDate(date, 'monthly'), AdvancedSubscriptionError);
    assert.throws(() => addMonths(date, 1), AdvancedSubscriptionError);
  }
  assert.throws(() => advanceLifecycleDate('2026-01-01', 'typo' as 'monthly'), AdvancedSubscriptionError);
  assert.throws(() => addMonths('9999-12-31', 1), AdvancedSubscriptionError);
  assert.equal(advanceLifecycleDate('2026-01-31', 'monthly', 2), '2026-03-31');
  assert.equal(advanceLifecycleDate('2028-02-29', 'annually'), '2029-02-28');
  assert.equal(advanceLifecycleDate('0096-02-28', 'weekly'), '0096-03-06');
  assert.equal(addMonths('0096-01-31', 1), '0096-02-29');
});
