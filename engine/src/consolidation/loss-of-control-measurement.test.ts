import assert from "node:assert/strict";
import { test } from "node:test";
import { measureLossOfControl } from "./loss-of-control-measurement.ts";
import { sum } from "../money/money.ts";
const base = {
  netAssetBalances: [
    { accountId: "assets", amount: "1200", description: "Subsidiary assets" },
    {
      accountId: "liabilities",
      amount: "-400",
      description: "Subsidiary liabilities",
    },
    { accountId: "goodwill", amount: "100", description: "Goodwill" },
  ],
  nciBalance: { accountId: "nci", amount: "-180", description: "NCI" },
  eliminatedInvestmentBalance: {
    accountId: "investment",
    amount: "-720",
    description: "Parent investment",
  },
  parentProceeds: "850",
  parentInvestmentCarrying: "720",
  parentRetainedCarrying: "0",
  retainedFairValue: "0",
  retainedAccountId: "retained",
  gainLossAccountId: "gain",
  oci: [],
};
test("loss of control removes goodwill and NCI while avoiding a duplicate parent disposal gain", () => {
  const r = measureLossOfControl(base);
  assert.equal(r.netAssets, "900.0000");
  assert.equal(r.nci, "180.0000");
  assert.equal(r.parentGain, "130.0000");
  assert.equal(r.groupGain, "130.0000");
  assert.equal(sum(r.lines.map((l) => l.amount)), "0.0000");
  assert.ok(!r.lines.some((l) => l.accountId === "gain"));
});
test("retained interest starts at fair value and OCI recycling remains distinct from direct equity transfers", () => {
  const r = measureLossOfControl({
    ...base,
    parentProceeds: "600",
    parentRetainedCarrying: "120",
    retainedFairValue: "210",
    oci: [
      {
        accountId: "cta",
        balance: "-25",
        treatment: "profit_loss",
        destinationAccountId: "gain",
        description: "Foreign currency translation reserve",
      },
      {
        accountId: "revaluation",
        balance: "-40",
        treatment: "retained_earnings",
        destinationAccountId: "retained_earnings",
        description: "Revaluation surplus",
      },
    ],
  });
  assert.equal(r.groupGain, "90.0000");
  assert.equal(r.totalGroupGain, "115.0000");
  assert.equal(r.recycledOci, "25.0000");
  assert.equal(r.transferredOci, "40.0000");
  assert.equal(
    r.lines.find((l) => l.accountId === "retained")?.amount,
    "90.0000",
  );
  assert.equal(sum(r.lines.map((l) => l.amount)), "0.0000");
});
test("a disposal loss remains signed and exact", () => {
  const r = measureLossOfControl({ ...base, parentProceeds: "600" });
  assert.equal(r.groupGain, "-120.0000");
  assert.equal(r.parentGain, "-120.0000");
});
test("unreconciled investment and unreadable amounts refuse rather than plug a false gain", () => {
  assert.throws(
    () => measureLossOfControl({ ...base, parentInvestmentCarrying: "700" }),
    /reconcile/,
  );
  assert.throws(
    () => measureLossOfControl({ ...base, retainedFairValue: "12,34" }),
    /exact/,
  );
});

test('historical investment translation is released through OCI, never plugged into disposal profit',()=>{const r=measureLossOfControl({...base,parentInvestmentCarrying:'750',investmentTranslationAccountId:'investment_cta'});assert.equal(r.groupGain,'130.0000');assert.equal(r.lines.find(l=>l.accountId==='investment_cta')?.amount,'30.0000');assert.equal(sum(r.lines.map(l=>l.amount)),'0.0000');});
