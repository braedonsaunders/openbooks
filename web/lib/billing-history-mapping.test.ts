import assert from "node:assert/strict";
import test from "node:test";
import {
  billingAcceptConfig,
  canRerunBillingImport,
  suggestedBillingMappings,
} from "./billing-history-mapping";

test("billing preflight native suggestions seed plan and customer mappings", () => {
  assert.deepEqual(
    suggestedBillingMappings([
      {
        kind: "plan",
        externalRef: "plan-1",
        suggestion: { nativeId: "native-plan", label: "Plan A" },
      },
      {
        kind: "customer",
        externalRef: "customer-1",
        suggestion: { nativeId: "native-customer", label: "Customer A" },
      },
      { kind: "plan", externalRef: "plan-2", suggestion: { nativeId: null, label: "No match" } },
    ]),
    {
      planMap: { "plan-1": "native-plan" },
      customerMap: { "customer-1": "native-customer" },
    },
  );
});

test("billing accept preserves selected mappings and every supported import setting", () => {
  assert.deepEqual(
    billingAcceptConfig({
      mode: "opening_balances",
      cutoverOn: "2026-01-01",
      historyDepthMonths: "24",
      incomeAccountId: "income-account",
      clearingAccountId: "clearing-account",
      taxCodeId: "tax-code",
      planMap: { "external-plan": "native-plan" },
      customerMap: { "external-customer": "native-customer" },
      autoSync: true,
    }),
    {
      mode: "opening_balances",
      cutoverOn: "2026-01-01",
      historyDepthMonths: 24,
      incomeAccountId: "income-account",
      clearingAccountId: "clearing-account",
      taxCodeId: "tax-code",
      planMap: { "external-plan": "native-plan" },
      customerMap: { "external-customer": "native-customer" },
      autoSync: true,
    },
  );
  assert.equal(
    billingAcceptConfig({
      mode: "post_historical",
      cutoverOn: "",
      historyDepthMonths: "",
      incomeAccountId: "",
      clearingAccountId: "",
      taxCodeId: "",
      planMap: {},
      customerMap: {},
      autoSync: false,
    }).historyDepthMonths,
    null,
  );
});

test("only ready and failed billing runs can be rerun", () => {
  assert.equal(canRerunBillingImport("ready"), true);
  assert.equal(canRerunBillingImport("failed"), true);
  assert.equal(canRerunBillingImport("preflight"), false);
  assert.equal(canRerunBillingImport("completed"), false);
  assert.equal(canRerunBillingImport("running"), false);
});
