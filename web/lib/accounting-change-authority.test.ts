import assert from "node:assert/strict";
import test from "node:test";
import {
  canShowNetInvestmentOciReversal,
  enabledAccountingChangeDomains,
  isAccountingChangeFeatureAllowed,
  type AccountingChangeFeatureState,
} from "./accounting-change-authority";

test("change visibility follows each domain feature and preserves the reversal exception", () => {
  const candidates = [
    "lease",
    "asset",
    "revenue",
    "sales",
    "consolidation",
    "provision",
    "payroll",
    "manufacturing",
  ] as const;
  const features: AccountingChangeFeatureState = {
    fixedAssets: false,
    revenueRecognition: false,
    dropShipping: false,
    multiSubsidiary: false,
    payroll: false,
    manufacturing: false,
  };
  const enabledDomains = enabledAccountingChangeDomains(candidates, features);
  const allowReversal = canShowNetInvestmentOciReversal(candidates, features);

  assert.deepEqual(enabledDomains, ["provision"]);
  assert.equal(allowReversal, true);
  assert.equal(
    isAccountingChangeFeatureAllowed(
      "consolidation",
      "net_investment_oci_reversal",
      enabledDomains,
      allowReversal,
    ),
    true,
  );
  assert.equal(
    isAccountingChangeFeatureAllowed(
      "consolidation",
      "loss_of_control",
      enabledDomains,
      allowReversal,
    ),
    false,
  );
});

test("enabled domains and consolidation reversal access follow enabled features", () => {
  const features: AccountingChangeFeatureState = {
    fixedAssets: true,
    revenueRecognition: true,
    dropShipping: true,
    multiSubsidiary: true,
    payroll: true,
    manufacturing: true,
  };
  const candidates = [
    "lease",
    "asset",
    "revenue",
    "sales",
    "consolidation",
    "payroll",
    "manufacturing",
  ] as const;

  assert.deepEqual(enabledAccountingChangeDomains(candidates, features), candidates);
  assert.equal(canShowNetInvestmentOciReversal(candidates, features), false);
});
