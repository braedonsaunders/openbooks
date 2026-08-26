import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SYSTEM_ACTOR_ID } from "./banking.ts";
import {
  AdvancedSubscriptionError,
  addMonths,
  assertCotermAllowed,
  assertIdempotentReplay,
  assertPlanVersionMutable,
  firstLifecycleBillOn,
  lifecycleBillingPeriod,
  renewalAction,
  subscriptionComponentTotal,
} from "./advanced-subscriptions.ts";

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
