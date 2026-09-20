import test from "node:test";
import assert from "node:assert/strict";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import {
  hygieneFindings,
  nameTypeMismatch,
  normalizePartyName,
  type HygieneLoaders,
} from "./hygiene.ts";

function policies() {
  return defaultContinuousCloseDetectors("hygiene");
}

function stubLoaders(overrides: Partial<HygieneLoaders> = {}): HygieneLoaders {
  return {
    controlMismatches: async () => [],
    duplicateParties: async () => [],
    untaxedItems: async () => [],
    unbudgetedProjects: async () => [],
    emptyScenarios: async () => [],
    unmappedComponents: async () => [],
    ...overrides,
  };
}

const ORG = "00000000-0000-0000-0000-000000000004";

test("name/type keywords fire only on genuine contradictions", () => {
  assert.equal(nameTypeMismatch({ name: "Bad Debt Provision", type: "asset_bank" }), "provision");
  assert.equal(nameTypeMismatch({ name: "Sales Income", type: "expense" }), "income/revenue");
  assert.equal(nameTypeMismatch({ name: "Petty Cash", type: "expense" }), "bank/cash");
  assert.equal(nameTypeMismatch({ name: "Trade Receivables", type: "asset_receivable" }), null);
  assert.equal(nameTypeMismatch({ name: "Cost of Goods", type: "cogs" }), null);
  assert.equal(nameTypeMismatch({ name: "Provision USA", type: "liability_provision" }), null);
  assert.equal(nameTypeMismatch({ name: "Cashflow Forecast", type: "asset_bank" }), null, "whole-word match only");
});

test("party names canonicalize whitespace and case", () => {
  assert.equal(normalizePartyName("  Acme   Corp "), "acme corp");
  assert.equal(normalizePartyName("ACME CORP"), "acme corp");
});

test("control mismatches surface with stable fingerprints and no proposals", async () => {
  const loaders = stubLoaders({
    controlMismatches: async () => [
      {
        accountId: "a1",
        accountNumber: "1010",
        accountName: "Bad Debt Provision",
        accountType: "asset_bank",
        reason: "name_type",
        detail: "named like provision but typed asset_bank",
        sampleDocId: null,
        balance: null,
      },
    ],
  });
  const findings = await hygieneFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fingerprint, "hygiene-control:a1");
  assert.equal(findings[0]!.severity, "warning");
  assert.equal(findings[0]!.materiality, "0.0000");
  assert.equal(findings[0]!.proposal ?? null, null, "retype vs rename needs a human");
  assert.equal(findings[0]!.summary.href, "/accounts");
});

test("bank credit balances carry their balance and a cash review", async () => {
  const loaders = stubLoaders({
    controlMismatches: async () => [
      {
        accountId: "a9",
        accountNumber: "5910",
        accountName: "Harbor Reserve",
        accountType: "asset_bank",
        reason: "bank_credit_balance",
        detail: "typed asset_bank but carries a credit-normal balance",
        sampleDocId: null,
        balance: "-40000.0000",
      },
    ],
  });
  const findings = await hygieneFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.fingerprint, "hygiene-control:a9");
  assert.equal(findings[0]!.summary.reason, "bank_credit_balance");
  assert.equal(findings[0]!.summary.balance, "-40000.0000");
  assert.match(String(findings[0]!.summary.review), /reconcile it as a bank account/);
  assert.equal(findings[0]!.proposal ?? null, null, "retype vs reconcile needs a human");
});

test("duplicate parties rank tax-id matches above name matches", async () => {
  const loaders = stubLoaders({
    duplicateParties: async () => [
      { key: "acme corp", matchOn: "name", partyIds: ["p1", "p2"], displayNames: ["Acme Corp", "ACME Corp"], taxIds: ["{}", "{}"] },
      { key: "tax:{\"gst\":\"123\"}", matchOn: "tax_id", partyIds: ["p3", "p4"], displayNames: ["Foo", "Bar"], taxIds: ["x", "x"] },
    ],
  });
  const findings = await hygieneFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(findings.length, 2);
  const byConfidence = [...findings].sort((a, b) => Number(b.confidence) - Number(a.confidence));
  assert.equal(byConfidence[0]!.confidence, "0.9500");
  assert.equal(byConfidence[1]!.confidence, "0.8000");
});

test("unmapped components name every missing mapping", async () => {
  const loaders = stubLoaders({
    unmappedComponents: async () => [
      { componentId: "c1", code: "DED-1", name: "Garnishment", kind: "deduction", missing: ["liabilityAccountId", "remittancePartyId"] },
    ],
  });
  const findings = await hygieneFindings(ORG, "1000.0000", policies(), loaders);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]!.summary.missing, ["liabilityAccountId", "remittancePartyId"]);
  assert.equal(findings[0]!.summary.href, "/admin/setup/payroll");
  assert.equal(findings[0]!.proposal ?? null, null, "the correct accounts are the user's call");
});

test("a disabled hygiene control stays silent", async () => {
  const loaders = stubLoaders({
    untaxedItems: async () => [{ itemId: "i1", code: "WIDGET", name: "Widget", kind: "sale" }],
  });
  const detectors = policies().map((detector) =>
    detector.detectorKey === "item_missing_tax_code" ? { ...detector, enabled: false } : detector,
  );
  assert.deepEqual(await hygieneFindings(ORG, "1000.0000", detectors, loaders), []);
});
