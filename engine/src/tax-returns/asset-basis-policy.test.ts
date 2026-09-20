import assert from "node:assert/strict";
import test from "node:test";
import {
  TAX_BASIS_BUYER_FIELD_NAMES,
  TAX_BASIS_FIELDS,
  TAX_BASIS_REGIMES,
  TAX_BASIS_RELATIONSHIPS,
  TaxBasisPolicyError,
  isTaxBasisCalendarDate,
  taxBasisFieldRequired,
  taxBasisFieldVisible,
  validateTaxRegimeBasis,
  type TaxBasisDraft,
  type TaxBasisFieldPredicate,
} from "./asset-basis-policy.ts";

function field(name: string) {
  const found = TAX_BASIS_FIELDS.find((row) => row.name === name);
  assert.ok(found, `missing field ${name}`);
  return found;
}

function mentionsSource(predicate: TaxBasisFieldPredicate, operation: "intercompany_transfer"): boolean {
  if ("sourceOperation" in predicate) return predicate.sourceOperation === operation;
  if ("all" in predicate) return predicate.all.some((item) => mentionsSource(item, operation));
  if ("any" in predicate) return predicate.any.some((item) => mentionsSource(item, operation));
  if ("not" in predicate) return mentionsSource(predicate.not, operation);
  return false;
}

function throwsPolicy(fn: () => unknown, pattern: RegExp, label: string) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TaxBasisPolicyError, `${label} threw ${String(error)}`);
    assert.match(error.message, pattern, `${label}: ${error.message}`);
    return;
  }
  assert.fail(`${label} did not refuse`);
}

test("placedInServiceOn is a date field so the drawer renders a date control, not a textarea", () => {
  assert.equal(field("placedInServiceOn").kind, "date");
  assert.equal(TAX_BASIS_FIELDS.some((row) => row.kind === "date"), true);
});

test("every enum choice has a human label, not the raw policy identifier", () => {
  for (const row of TAX_BASIS_FIELDS.filter((item) => item.kind === "enum")) {
    assert.ok(row.choices && row.choices.length > 0, `${row.name} has no choices`);
    for (const choice of row.choices) {
      assert.notEqual(
        choice.label,
        choice.value,
        `${row.name} still labels ${choice.value} with the raw identifier`,
      );
      assert.match(
        choice.label,
        /[ A-Za-z%—–-]/,
        `${row.name} ${choice.value} label ${choice.label} is not readable`,
      );
    }
  }
});

test("named buyer fields stay off a customer partial disposal across every regime", () => {
  for (const name of TAX_BASIS_BUYER_FIELD_NAMES) {
    const row = field(name);
    assert.ok(
      mentionsSource(row.visibleWhen, "intercompany_transfer")
        || mentionsSource(row.requiredWhen, "intercompany_transfer"),
      `${name} has no intercompany_transfer predicate — an external sale would still collect it`,
    );
    for (const regime of TAX_BASIS_REGIMES) {
      for (const relationship of TAX_BASIS_RELATIONSHIPS) {
        const draft: TaxBasisDraft = {
          regime,
          relationship,
          sourceOperation: "partial_disposal",
          rolloverElection: "none",
          recognition: "nontaxable",
          transferorCharacter: "resident_individual",
          associatedPersonCostBasis: "original_cost",
          commissionerActualCost: true,
          consolidatingGroupAtv: true,
        };
        assert.equal(
          taxBasisFieldVisible(row, draft),
          false,
          `${name} visible on ${regime} ${relationship} partial_disposal`,
        );
        assert.equal(
          taxBasisFieldRequired(row, draft),
          false,
          `${name} required on ${regime} ${relationship} partial_disposal`,
        );
      }
    }
  }
});

test("seller ITA 69 fair market value stays required on a CA non-arm's-length sale to a customer", () => {
  const draft: TaxBasisDraft = {
    regime: "ca_cca",
    relationship: "non_arms_length",
    sourceOperation: "partial_disposal",
    rolloverElection: "none",
  };
  assert.equal(taxBasisFieldRequired(field("fairMarketValue"), draft), true);
  assert.equal(taxBasisFieldRequired(field("payment"), draft), false);
  assert.equal(taxBasisFieldRequired(field("originalCapitalCost"), draft), true);
});

test("CA buyer capital-cost facts become required on an intercompany non-arm's-length transfer", () => {
  const draft: TaxBasisDraft = {
    regime: "ca_cca",
    relationship: "non_arms_length",
    sourceOperation: "intercompany_transfer",
    rolloverElection: "none",
    transferorCharacter: "corporation",
  };
  assert.equal(taxBasisFieldRequired(field("payment"), draft), true);
  assert.equal(taxBasisFieldRequired(field("sellerOriginalCapitalCost"), draft), true);
  assert.equal(taxBasisFieldRequired(field("transferorCharacter"), draft), true);
  assert.equal(taxBasisFieldRequired(field("capitalGainsInclusionRate"), draft), true);
  assert.equal(taxBasisFieldRequired(field("fairMarketValue"), draft), true);
});

test("NZ commissioner and ATV buyer exceptions are not required on a customer sale", () => {
  const draft: TaxBasisDraft = {
    regime: "nz_pool",
    relationship: "non_arms_length",
    sourceOperation: "partial_disposal",
  };
  assert.equal(taxBasisFieldRequired(field("commissionerActualCost"), draft), false);
  assert.equal(taxBasisFieldRequired(field("consolidatingGroupAtv"), draft), false);
  assert.equal(taxBasisFieldRequired(field("buyerPrice"), draft), false);
  assert.equal(taxBasisFieldRequired(field("consideration"), draft), true);
});

test("validateTaxRegimeBasis refuses a missing source operation instead of guessing buyer facts", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "arms_length",
        originalCapitalCost: "10000.00",
        allocationMethod: "ascertainable_amount",
        allocatedCapitalCost: "4000.00",
        statutoryProceeds: "5000.00",
        rolloverElection: "none",
      }),
    /sourceOperation is required to decide buyer-side facts/,
    "missing sourceOperation",
  );
});

test("validateTaxRegimeBasis accepts a CA non-arm's-length partial disposal without buyer payment", () => {
  const row = validateTaxRegimeBasis({
    regime: "ca_cca",
    relationship: "non_arms_length",
    sourceOperation: "partial_disposal",
    originalCapitalCost: "10000.00",
    allocationMethod: "ascertainable_amount",
    allocatedCapitalCost: "4000.00",
    fairMarketValue: "5000.00",
    rolloverElection: "none",
  });
  assert.equal(row.regime, "ca_cca");
  assert.equal("sourceOperation" in row, false);
  assert.equal("payment" in row, false);
});

test("validateTaxRegimeBasis refuses a CA intercompany non-arm's-length transfer without payment", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "non_arms_length",
        sourceOperation: "intercompany_transfer",
        originalCapitalCost: "10000.00",
        allocationMethod: "ascertainable_amount",
        allocatedCapitalCost: "4000.00",
        fairMarketValue: "5000.00",
        rolloverElection: "none",
      }),
    /payment is required/,
    "intercompany without payment",
  );
});

test("validateTaxRegimeBasis refuses a nontaxable MACRS carryover on a customer sale", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "us_macrs",
        relationship: "arms_length",
        sourceOperation: "partial_disposal",
        dispositionTrigger: "sale",
        originalUnadjustedBasis: "10000.00",
        remainingUnadjustedBasis: "6000.00",
        disposedUnadjustedBasis: "4000.00",
        placedInServiceOn: "2024-03-15",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        recognition: "nontaxable",
        relatedPerson: false,
        statutoryProceeds: "3500.00",
      }),
    /nontaxable MACRS carryover belongs on the receiving asset/,
    "nontaxable partial_disposal",
  );
});

test("placedInServiceOn rejects a non-calendar day and accepts a real one", () => {
  assert.equal(isTaxBasisCalendarDate("2026-02-31"), false);
  assert.equal(isTaxBasisCalendarDate("2026-02-28"), true);
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "us_macrs",
        relationship: "arms_length",
        sourceOperation: "partial_disposal",
        dispositionTrigger: "sale",
        originalUnadjustedBasis: "10000.00",
        remainingUnadjustedBasis: "6000.00",
        disposedUnadjustedBasis: "4000.00",
        placedInServiceOn: "2026-02-31",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        recognition: "taxable",
        relatedPerson: false,
        statutoryProceeds: "3500.00",
      }),
    /placedInServiceOn must be a calendar date/,
    "impossible calendar day",
  );
});
