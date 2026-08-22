import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("direct subcontracts join both project committed-cost rollups without double-counting linked POs", () => {
  const helper = source("lib/subcontract-commitments.ts");
  const costing = source("lib/project-costing.ts");
  const financials = source("lib/project-financials.ts");
  assert.match(helper, /original_commitment[\s\S]+changes\.approved[\s\S]+apps\.billed/);
  assert.match(helper, /status in \('active', 'substantially_complete'\)/);
  assert.match(helper, /purchase_order_id is null/);
  assert.match(costing, /directSubcontractOpenCommitment/);
  assert.match(financials, /directSubcontractOpenCommitment/);
});

test("subcontract payment controls gate run creation and final vendor-payment posting", () => {
  const payments = source("../engine/src/payments.ts");
  const occurrences = payments.match(/assertSubcontractPaymentCleared/g) ?? [];
  assert.ok(occurrences.length >= 3, "expected import plus run-creation and final-posting gates");
  assert.match(payments, /for \(const bill of payable\)[\s\S]+assertSubcontractPaymentCleared/);
  assert.match(payments, /doc\.kind === "vendor_payment"[\s\S]+assertSubcontractPaymentCleared/);
});

test("subcontract API applies AP permission tiers", () => {
  const route = source("app/api/subcontracts/route.ts");
  assert.match(route, /approvalActions[\s\S]+"ap\.approve"/);
  assert.match(route, /postingActions[\s\S]+"ap\.post"/);
  assert.match(route, /paymentActions[\s\S]+"ap\.pay"/);
  assert.match(route, /guardSubcontractsFeature/);
});

test("subcontract API persists money through canonicalDecimal and normalizeMoney", () => {
  const route = source("app/api/subcontracts/route.ts");
  assert.match(route, /canonicalDecimal/);
  assert.match(route, /normalizeMoney/);
  assert.match(route, /originalCommitment/);
  assert.match(route, /scheduledValue/);
  assert.match(route, /Draw amount/);
  assert.doesNotMatch(route, /createSubcontract\(\{ \.\.\.body, orgId, userId \}/);
});

