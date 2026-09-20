import assert from "node:assert/strict";
import test from "node:test";
import {
  TAX_BASIS_APPLICABLE_SIDES,
  TAX_BASIS_APPLICABLE_SIDE_LABELS,
  TAX_BASIS_BUYER_FIELD_NAMES,
  TAX_BASIS_FIELDS,
  TAX_BASIS_REGIMES,
  TAX_BASIS_RELATIONSHIPS,
  TAX_BASIS_SOURCE_KINDS,
  TaxBasisPolicyError,
  attachTaxBasisSource,
  caDeemedAcquisitionPayment,
  caOrdinaryCapitalGainsInclusion,
  caStatutoryProceeds,
  freezeCaRegimeBasis,
  isTaxBasisCalendarDate,
  taxBasisApplicableSide,
  taxBasisFieldRequired,
  taxBasisFieldVisible,
  taxBasisSideApplies,
  taxBasisSourceOperation,
  taxBasisSourceRegimes,
  taxWorkpaperBuyerAddition,
  taxWorkpaperSellerDisposition,
  usDispositionProceeds,
  usRegimeWorkpaperOutcome,
  validateTaxRegimeBasis,
  nzAssociatedPersonEquivalentRate,
  nzPooledDepreciationRate,
  nzPoolReduction,
  type CaCcaRegimeBasis,
  type NzPoolRegimeBasis,
  type TaxBasisDraft,
  type TaxBasisFieldPredicate,
  type UsMacrsRegimeBasis,
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
          applicable: "seller",
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
    applicable: "seller",
    rolloverElection: "none",
  };
  assert.equal(taxBasisFieldRequired(field("fairMarketValue"), draft), true);
  assert.equal(taxBasisFieldRequired(field("statutoryProceeds"), draft), true);
  assert.equal(taxBasisFieldRequired(field("payment"), draft), false);
  assert.equal(taxBasisFieldRequired(field("originalCapitalCost"), draft), true);
});

test("US related status does not require the transferred asset's FMV as amount realized", () => {
  const draft: TaxBasisDraft = {
    regime: "us_macrs",
    relationship: "non_arms_length",
    sourceOperation: "partial_disposal",
    applicable: "seller",
    recognition: "taxable",
    amountRealizedRule: "amount_realized",
  };
  assert.equal(taxBasisFieldRequired(field("statutoryProceeds"), draft), true);
  assert.equal(taxBasisFieldRequired(field("amountRealizedRule"), draft), true);
  assert.equal(taxBasisFieldVisible(field("fairMarketValue"), draft), false);
  assert.equal(taxBasisFieldRequired(field("fairMarketValue"), draft), false);
  assert.equal(taxBasisFieldRequired(field("adjustedAmountRealized"), draft), false);
});

test("CA buyer capital-cost facts become required on an intercompany non-arm's-length transfer", () => {
  const draft: TaxBasisDraft = {
    regime: "ca_cca",
    relationship: "non_arms_length",
    sourceOperation: "intercompany_transfer",
    applicable: "both",
    rolloverElection: "none",
    transferorCharacter: "corporation",
  };
  assert.equal(taxBasisFieldRequired(field("payment"), draft), true);
  assert.equal(taxBasisFieldRequired(field("sellerOriginalCapitalCost"), draft), true);
  assert.equal(taxBasisFieldRequired(field("transferorCharacter"), draft), true);
  assert.equal(
    TAX_BASIS_FIELDS.some((row) => row.name === "capitalGainsInclusionRate"),
    false,
  );
  assert.equal(taxBasisFieldRequired(field("fairMarketValue"), draft), true);
});

test("NZ commissioner and ATV buyer exceptions are not required on a customer sale", () => {
  const draft: TaxBasisDraft = {
    regime: "nz_pool",
    relationship: "non_arms_length",
    sourceOperation: "partial_disposal",
    applicable: "seller",
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
    statutoryProceeds: "5000.00",
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
        applicable: "both",
        originalCapitalCost: "10000.00",
        allocationMethod: "ascertainable_amount",
        allocatedCapitalCost: "4000.00",
        fairMarketValue: "5000.00",
        statutoryProceeds: "5000.00",
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
        amountRealizedRule: "amount_realized",
      }),
    /placedInServiceOn must be a calendar date/,
    "impossible calendar day",
  );
});

const caNal = (over: Partial<CaCcaRegimeBasis>): CaCcaRegimeBasis => ({
  regime: "ca_cca",
  relationship: "non_arms_length",
  originalCapitalCost: "800.00",
  allocationMethod: "ascertainable_amount",
  allocatedCapitalCost: "800.00",
  rolloverElection: "none",
  statutoryProceeds: "1200.00",
  fairMarketValue: "1000.00",
  payment: "1200.00",
  sellerOriginalCapitalCost: "800.00",
  transferorCharacter: "corporation",
  capitalGainsInclusionRate: "0.5",
  ...over,
});

test("ITA 69(1)(b)(i) keeps above-FMV actual proceeds and lifts only nil or below-FMV proceeds", () => {
  assert.equal(caStatutoryProceeds(caNal({ statutoryProceeds: "1200.00", fairMarketValue: "1000.00" })), "1200.00");
  assert.equal(caStatutoryProceeds(caNal({ statutoryProceeds: "800.00", fairMarketValue: "1000.00" })), "1000.00");
  assert.equal(caStatutoryProceeds(caNal({ statutoryProceeds: "0.00", fairMarketValue: "1000.00" })), "1000.00");
  assert.equal(caStatutoryProceeds(caNal({ statutoryProceeds: "1000.00", fairMarketValue: "1000.00" })), "1000.00");
});

test("ITA 69(1)(a) caps only the buyer's excessive acquisition price", () => {
  assert.equal(caDeemedAcquisitionPayment(caNal({ payment: "1200.00", fairMarketValue: "1000.00" })), "1000.00");
  assert.equal(caDeemedAcquisitionPayment(caNal({ payment: "800.00", fairMarketValue: "1000.00" })), "800.00");
});

test("Pub 544 amount realized is not replaced by the transferred asset's FMV merely because related", () => {
  const related: UsMacrsRegimeBasis = {
    regime: "us_macrs",
    relationship: "non_arms_length",
    dispositionTrigger: "sale",
    originalUnadjustedBasis: "10000.00",
    remainingUnadjustedBasis: "6000.00",
    disposedUnadjustedBasis: "4000.00",
    placedInServiceOn: "2024-03-15",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    recognition: "taxable",
    relatedPerson: true,
    statutoryProceeds: "1200.00",
    amountRealizedRule: "amount_realized",
  };
  assert.equal(usDispositionProceeds(related), "1200.00");
  throwsPolicy(
    () =>
      usDispositionProceeds({
        ...related,
        amountRealizedRule: "section_482",
        adjustedAmountRealized: "1000.00",
      }),
    /related-person status is not that evidence/,
    "§482 without evidence",
  );
  assert.equal(
    usDispositionProceeds({
      ...related,
      amountRealizedRule: "section_482",
      adjustedAmountRealized: "1000.00",
      deemedValueAdjustmentEvidence: "Form 5472 contemporaneous 482 study ref A-19",
    }),
    "1000.00",
  );
});

test("full disposal and legacy write-off are tax sources under partial_disposal", () => {
  assert.deepEqual([...TAX_BASIS_SOURCE_KINDS], [
    "partially_disposed",
    "transferred",
    "disposed",
    "written_off",
  ]);
  assert.equal(taxBasisSourceOperation("disposed"), "partial_disposal");
  assert.equal(taxBasisSourceOperation("written_off"), "partial_disposal");
  assert.equal(taxBasisSourceOperation("partially_disposed"), "partial_disposal");
  assert.equal(taxBasisSourceOperation("transferred"), "intercompany_transfer");
});

test("ITA 38(a) ordinary inclusion is one-half and freezes on the workpaper", () => {
  const edition = caOrdinaryCapitalGainsInclusion("2026-06-15");
  assert.equal(edition.rate, "0.5");
  assert.match(edition.citation, /^ITA 38\(a\)/);
  const frozen = freezeCaRegimeBasis(caNal({
    capitalGainsInclusionRate: undefined,
    capitalGainsInclusionRateCitation: undefined,
  }), "2026-06-15");
  assert.equal(frozen.capitalGainsInclusionRate, "0.5");
  assert.match(frozen.capitalGainsInclusionRateCitation ?? "", /^ITA 38\(a\)/);
  const already = freezeCaRegimeBasis(frozen, "2026-06-15");
  assert.equal(already.capitalGainsInclusionRate, "0.5");
});

test("nontaxable MACRS workpaper outcome does not demand Pub 544 proceeds", () => {
  const carryover: UsMacrsRegimeBasis = {
    regime: "us_macrs",
    relationship: "non_arms_length",
    dispositionTrigger: "section_168i7b",
    originalUnadjustedBasis: "10000.00",
    remainingUnadjustedBasis: "6000.00",
    disposedUnadjustedBasis: "4000.00",
    placedInServiceOn: "2024-03-15",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    recognition: "nontaxable",
    relatedPerson: true,
    carryoverBasis: "4000.00",
    excessBasis: "250.00",
  };
  const computed = usRegimeWorkpaperOutcome(carryover, "intercompany_transfer", "both", {
    placedInServiceOn: "2025-08-01",
    recoveryPeriodYears: "7",
    method: "200_db",
    convention: "half_year",
  });
  assert.equal(computed.amountRealized, null);
  assert.equal(computed.recognition, "nontaxable");
  assert.equal(computed.carryoverBasis, "4000.00");
  assert.equal(computed.placedInServiceOn, "2024-03-15");
  assert.equal(computed.recoveryPeriodYears, "5");
  assert.equal(computed.buyerPlacedInServiceOn, "2025-08-01");
  assert.equal(computed.buyerRecoveryPeriodYears, "7.0000000000");
  assert.equal(computed.buyerMethod, "200_db");
  assert.equal(computed.buyerConvention, "half_year");
  assert.equal(taxWorkpaperSellerDisposition("us_macrs", computed), "4000.0000");
  assert.equal(taxWorkpaperBuyerAddition("us_macrs", computed), "4250.00");
});

test("applicable=both taxable MACRS freezes the derived buyer schedule, not only seller vintage", () => {
  const taxable: UsMacrsRegimeBasis = {
    regime: "us_macrs",
    relationship: "arms_length",
    dispositionTrigger: "sale",
    originalUnadjustedBasis: "10000.00",
    remainingUnadjustedBasis: "0",
    disposedUnadjustedBasis: "10000.00",
    placedInServiceOn: "2023-03-15",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    recognition: "taxable",
    relatedPerson: false,
    statutoryProceeds: "8500.00",
    amountRealizedRule: "amount_realized",
    buyerCost: "8500.00",
  };
  const computed = usRegimeWorkpaperOutcome(taxable, "intercompany_transfer", "both", {
    placedInServiceOn: "2025-08-01",
    recoveryPeriodYears: "7",
    method: "200_db",
    convention: "half_year",
  });
  assert.equal(computed.placedInServiceOn, "2023-03-15");
  assert.equal(computed.buyerCost, "8500.00");
  assert.equal(computed.buyerPlacedInServiceOn, "2025-08-01");
  assert.equal(computed.buyerRecoveryPeriodYears, "7.0000000000");
  assert.equal(computed.buyerMethod, "200_db");
  assert.equal(computed.buyerConvention, "half_year");
  assert.throws(
    () => usRegimeWorkpaperOutcome(taxable, "intercompany_transfer", "both"),
    (error: unknown) =>
      error instanceof TaxBasisPolicyError && /freeze its own placed-in-service date/.test(error.message),
  );
});

test("classified seller and receiver derive seller, buyer, or both — never an election", () => {
  assert.deepEqual([...TAX_BASIS_APPLICABLE_SIDES], ["seller", "buyer", "both"]);
  assert.deepEqual(TAX_BASIS_APPLICABLE_SIDE_LABELS, {
    seller: "Seller",
    buyer: "Buyer",
    both: "Seller and buyer",
  });
  assert.equal(taxBasisApplicableSide(true, false), "seller");
  assert.equal(taxBasisApplicableSide(false, true), "buyer");
  assert.equal(taxBasisApplicableSide(true, true), "both");
  assert.equal(taxBasisApplicableSide(false, false), null);
  assert.equal(taxBasisSideApplies("both", "seller"), true);
  assert.equal(taxBasisSideApplies("both", "buyer"), true);
  assert.equal(taxBasisSideApplies("seller", "buyer"), false);
  assert.equal(taxBasisSideApplies("buyer", "seller"), false);
  assert.deepEqual(
    taxBasisSourceRegimes(
      [{ code: "ca_cca" }],
      [{ code: "us_macrs" }],
      true,
    ).map((row) => [row.code, row.applicable]),
    [["ca_cca", "seller"], ["us_macrs", "buyer"]],
  );
  assert.deepEqual(
    taxBasisSourceRegimes([{ code: "ca_cca" }], [{ code: "us_macrs" }], false).map((row) => [
      row.code,
      row.applicable,
    ]),
    [["ca_cca", "seller"]],
  );
});

test("buyer-only US hides seller proceeds; seller-only CA hides buyer payment", () => {
  const buyerOnlyUs = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "arms_length", recognition: "taxable" },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  );
  assert.equal(taxBasisFieldVisible(field("statutoryProceeds"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldRequired(field("originalUnadjustedBasis"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldRequired(field("buyerCost"), buyerOnlyUs), true);
  assert.equal(taxBasisFieldRequired(field("placedInServiceOn"), buyerOnlyUs), true);

  const sellerOnlyCa = attachTaxBasisSource(
    { regime: "ca_cca", relationship: "non_arms_length", rolloverElection: "none" },
    { sourceOperation: "intercompany_transfer", applicable: "seller" },
  );
  assert.equal(taxBasisFieldRequired(field("originalCapitalCost"), sellerOnlyCa), true);
  assert.equal(taxBasisFieldRequired(field("statutoryProceeds"), sellerOnlyCa), true);
  assert.equal(taxBasisFieldVisible(field("payment"), sellerOnlyCa), false);
  assert.equal(taxBasisFieldRequired(field("payment"), sellerOnlyCa), false);
});

test("validateTaxRegimeBasis refuses an intercompany row without a classified side", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "arms_length",
        sourceOperation: "intercompany_transfer",
        originalCapitalCost: "10000.00",
        allocationMethod: "ascertainable_amount",
        allocatedCapitalCost: "4000.00",
        statutoryProceeds: "5000.00",
        rolloverElection: "none",
      }),
    /applicable is derived from the classified seller and receiving assets/,
    "missing applicable",
  );
});

test("validateTaxRegimeBasis accepts buyer-only US taxable cost without seller vintage facts", () => {
  const row = validateTaxRegimeBasis(
    {
      regime: "us_macrs",
      relationship: "arms_length",
      recognition: "taxable",
      relatedPerson: false,
      placedInServiceOn: "2026-03-15",
      recoveryPeriodYears: "5",
      method: "200_db",
      convention: "half_year",
      buyerCost: "4000.00",
    },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  );
  assert.equal(row.regime, "us_macrs");
  assert.equal("applicable" in row, false);
  assert.equal("originalUnadjustedBasis" in row, false);
});

test("validateTaxRegimeBasis refuses a negative declared CA original capital cost", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "arms_length",
        sourceOperation: "partial_disposal",
        originalCapitalCost: "-1000",
        allocationMethod: "ascertainable_fraction",
        allocationFraction: "0.25",
        statutoryProceeds: "100",
        rolloverElection: "none",
      }),
    /originalCapitalCost must be nonnegative/,
    "negative originalCapitalCost",
  );
});

test("validateTaxRegimeBasis refuses allocated capital cost above original", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "arms_length",
        sourceOperation: "partial_disposal",
        originalCapitalCost: "1000.00",
        allocationMethod: "ascertainable_amount",
        allocatedCapitalCost: "1000.01",
        statutoryProceeds: "100.00",
        rolloverElection: "none",
      }),
    /allocatedCapitalCost .* cannot exceed originalCapitalCost/,
    "allocated above original",
  );
});

test("validateTaxRegimeBasis validates a supplied optional decimal, not only required fields", () => {
  throwsPolicy(
    () =>
      validateTaxRegimeBasis({
        regime: "ca_cca",
        relationship: "arms_length",
        sourceOperation: "partial_disposal",
        originalCapitalCost: "1000.00",
        allocationMethod: "ascertainable_fraction",
        allocationFraction: "0.25",
        statutoryProceeds: "100.00",
        rolloverElection: "none",
        fairMarketValue: "-50.00",
      }),
    /fairMarketValue must be nonnegative/,
    "optional negative fairMarketValue",
  );
});

test("NZ pool reduction may be a signed computed net when disposal expenditure exceeds consideration", () => {
  const row = validateTaxRegimeBasis({
    regime: "nz_pool",
    relationship: "arms_length",
    sourceOperation: "partial_disposal",
    consideration: "100.00",
    disposalExpenditure: "250.00",
  }) as NzPoolRegimeBasis;
  assert.equal(nzPoolReduction(row), "-150.00");
});

test("NZ associated-person equivalent rate caps the pool and refuses a missing declaration", () => {
  assert.equal(nzPooledDepreciationRate("0.1", ["0.08"]), "0.0800000000");
  assert.equal(nzPooledDepreciationRate("0.1", ["0.16"]), "0.1000000000");
  assert.equal(nzAssociatedPersonEquivalentRate({
    relationship: "non_arms_length",
    associatedPersonEquivalentRate: "0.08",
  }), "0.0800000000");
  assert.equal(nzAssociatedPersonEquivalentRate({ relationship: "arms_length" }), null);
  assert.throws(
    () => nzAssociatedPersonEquivalentRate({ relationship: "non_arms_length" }),
    (error: unknown) =>
      error instanceof TaxBasisPolicyError && /associatedPersonEquivalentRate is required/.test(error.message),
  );
});
