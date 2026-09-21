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
  MACRS_VINTAGE_SOURCES,
  MACRS_VINTAGE_SOURCE_LABELS,
  TaxBasisPolicyError,
  macrsVintageKey,
  parseMacrsVintageAllocations,
  attachTaxBasisSource,
  assertMacrsVintageAllocationsMatchOpen,
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
  declaredTaxRegimeFacts,
  validateTaxRegimeBasis,
  continuingNzAssociatedRates,
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
        section168i7Kind: "nonrecognition",
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

test("CA revalidation drops a frozen inclusion rate and reconstructs it from effectiveOn", () => {
  const declared = {
    regime: "ca_cca",
    relationship: "arms_length",
    originalCapitalCost: "3000.00",
    allocationMethod: "ascertainable_fraction",
    allocationFraction: "0.25",
    statutoryProceeds: "600.00",
    rolloverElection: "none",
  };
  const context = { sourceOperation: "partial_disposal" as const, applicable: "seller" as const };
  const first = validateTaxRegimeBasis(declared, context);
  assert.equal(first.regime, "ca_cca");
  if (first.regime !== "ca_cca") return;
  assert.equal(Object.hasOwn(first, "capitalGainsInclusionRate"), false);
  const frozen = freezeCaRegimeBasis(first, "2026-07-01");
  assert.equal(frozen.capitalGainsInclusionRate, "0.5");
  assert.match(frozen.capitalGainsInclusionRateCitation ?? "", /ITA 38\(a\)/);
  const persisted = declaredTaxRegimeFacts(frozen);
  assert.equal(Object.hasOwn(persisted, "capitalGainsInclusionRate"), false);
  assert.equal(Object.hasOwn(persisted, "capitalGainsInclusionRateCitation"), false);
  const replayed = validateTaxRegimeBasis(JSON.parse(JSON.stringify(frozen)), context);
  assert.equal(replayed.regime, "ca_cca");
  if (replayed.regime !== "ca_cca") return;
  assert.equal(Object.hasOwn(replayed, "capitalGainsInclusionRate"), false);
  const invented = validateTaxRegimeBasis(
    { ...declared, capitalGainsInclusionRate: "0.75", capitalGainsInclusionRateCitation: "operator" },
    context,
  );
  assert.equal(invented.regime, "ca_cca");
  if (invented.regime !== "ca_cca") return;
  assert.equal(Object.hasOwn(invented, "capitalGainsInclusionRate"), false);
  const recomputed = freezeCaRegimeBasis(invented, "2026-07-01");
  assert.equal(recomputed.capitalGainsInclusionRate, "0.5");
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
    section168i7Kind: "nonrecognition",
    relatedPerson: true,
    carryoverBasis: "4000.00",
    excessBasis: "250.00",
    section179: "0",
    bonusPercent: "0",
    businessUsePercent: "100",
    priorDepreciation: "0",
  };
  const computed = usRegimeWorkpaperOutcome(carryover, "intercompany_transfer", "both", {
    placedInServiceOn: "2025-08-01",
    recoveryPeriodYears: "7",
    method: "200_db",
    convention: "half_year",
  });
  assert.equal(computed.amountRealized, null);
  assert.equal(computed.recognition, "nontaxable");
  assert.equal(computed.section168i7Kind, "nonrecognition");
  assert.equal(computed.carryoverBasis, "4000.00");
  assert.equal(computed.originalUnadjustedBasis, "10000.0000");
  assert.equal(computed.section179, "0.0000");
  assert.equal(computed.priorDepreciation, "0.0000");
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
  assert.equal(taxBasisFieldRequired(field("placedInServiceOn"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldRequired(field("recoveryPeriodYears"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldRequired(field("method"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldRequired(field("convention"), buyerOnlyUs), false);
  assert.equal(taxBasisFieldVisible(field("placedInServiceOn"), buyerOnlyUs), false);

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
      buyerCost: "4000.00",
    },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  );
  assert.equal(row.regime, "us_macrs");
  assert.equal("applicable" in row, false);
  assert.equal("originalUnadjustedBasis" in row, false);
  assert.equal("placedInServiceOn" in row, false);
});

test("buyer-only nontaxable carryover requires transferor history and allocated elections", () => {
  const draft = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "non_arms_length", recognition: "nontaxable" },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  );
  assert.equal(taxBasisFieldRequired(field("placedInServiceOn"), draft), true);
  assert.equal(taxBasisFieldRequired(field("originalUnadjustedBasis"), draft), true);
  assert.equal(taxBasisFieldRequired(field("section179"), draft), true);
  assert.equal(taxBasisFieldRequired(field("priorDepreciation"), draft), true);
  assert.equal(taxBasisFieldRequired(field("carryoverBasis"), draft), true);
  assert.equal(taxBasisFieldRequired(field("section168i7Kind"), draft), true);
  assert.equal(taxBasisFieldVisible(field("disposedUnadjustedBasis"), draft), false);
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          regime: "us_macrs",
          relationship: "non_arms_length",
          recognition: "nontaxable",
          relatedPerson: true,
          placedInServiceOn: "2023-03-15",
          recoveryPeriodYears: "5",
          method: "200_db",
          convention: "half_year",
          originalUnadjustedBasis: "10000.00",
          carryoverBasis: "6400.00",
          excessBasis: "400.00",
          section168i7Kind: "nonrecognition",
        },
        { sourceOperation: "intercompany_transfer", applicable: "buyer" },
      ),
    /section179 is required/,
    "missing allocated section179",
  );
  const row = validateTaxRegimeBasis(
    {
      regime: "us_macrs",
      relationship: "non_arms_length",
      recognition: "nontaxable",
      relatedPerson: true,
      placedInServiceOn: "2023-03-15",
      recoveryPeriodYears: "5",
      method: "200_db",
      convention: "half_year",
      originalUnadjustedBasis: "10000.00",
      carryoverBasis: "6400.00",
      excessBasis: "400.00",
      section179: "0",
      bonusPercent: "0",
      businessUsePercent: "100",
      priorDepreciation: "3600.00",
      section168i7Kind: "nonrecognition",
    },
    { sourceOperation: "intercompany_transfer", applicable: "buyer" },
  );
  assert.equal(row.carryoverBasis, "6400.00");
  assert.equal(row.section179, "0");
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

test("MACRS vintage sources have human labels and a stable key", () => {
  for (const source of MACRS_VINTAGE_SOURCES) {
    assert.notEqual(MACRS_VINTAGE_SOURCE_LABELS[source], source);
    assert.match(MACRS_VINTAGE_SOURCE_LABELS[source], /[A-Za-z]/);
  }
  assert.equal(
    macrsVintageKey({ source: "original", placedInServiceOn: "2023-03-15" }),
    "original:2023-03-15",
  );
  assert.equal(
    macrsVintageKey({
      source: "carryover",
      placedInServiceOn: "2023-03-15",
      transferOn: "2025-08-01",
    }),
    "carryover:2023-03-15:2025-08-01",
  );
});

test("vintageAllocations must name each vintage and sum to the header split", () => {
  const seller = {
    regime: "us_macrs",
    relationship: "arms_length",
    dispositionTrigger: "sale",
    originalUnadjustedBasis: "10400.00",
    remainingUnadjustedBasis: "8400.00",
    disposedUnadjustedBasis: "2000.00",
    placedInServiceOn: "2023-03-15",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    recognition: "taxable",
    relatedPerson: false,
    statutoryProceeds: "2000.00",
    amountRealizedRule: "amount_realized",
  };
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          ...seller,
          vintageAllocations: [
            {
              source: "carryover",
              placedInServiceOn: "2023-03-15",
              transferOn: "2025-08-01",
              disposedUnadjustedBasis: "2000.00",
              remainingUnadjustedBasis: "8000.00",
            },
          ],
        },
        { sourceOperation: "partial_disposal", applicable: "seller" },
      ),
    /must equal disposedUnadjustedBasis/,
    "allocation remaining short of the header",
  );
  throwsPolicy(
    () => parseMacrsVintageAllocations([]),
    /must identify each open MACRS vintage/,
    "empty allocations are not a silent match",
  );
  throwsPolicy(
    () =>
      parseMacrsVintageAllocations([
        {
          source: "carryover",
          placedInServiceOn: "2023-03-15",
          disposedUnadjustedBasis: "2000.00",
          remainingUnadjustedBasis: "8000.00",
        },
      ]),
    /transferOn is required for a carryover vintage/,
    "buyer vintages require transferOn",
  );
  const row = validateTaxRegimeBasis(
    {
      ...seller,
      vintageAllocations: [
        {
          source: "carryover",
          placedInServiceOn: "2023-03-15",
          transferOn: "2025-08-01",
          disposedUnadjustedBasis: "2000.00",
          remainingUnadjustedBasis: "8000.00",
        },
        {
          source: "excess",
          placedInServiceOn: "2025-08-01",
          transferOn: "2025-08-01",
          disposedUnadjustedBasis: "0.00",
          remainingUnadjustedBasis: "400.00",
        },
      ],
    },
    { sourceOperation: "partial_disposal", applicable: "seller" },
  ) as UsMacrsRegimeBasis;
  assert.equal(row.vintageAllocations?.length, 2);
  assert.equal(row.vintageAllocations?.[0]!.disposedUnadjustedBasis, "2000.0000");
});

test("NZ associated-person rate cap continues after the transfer year", () => {
  const papers = [{
    effective_on: "2024-06-01",
    buyer_subsidiary_id: "sub-a",
    buyer_class: "1",
    relationship: "non_arms_length",
    associated_person_equivalent_rate: "0.0800000000",
  }];
  assert.deepEqual(
    continuingNzAssociatedRates(papers, { subsidiaryId: "sub-a", yearEnd: "2025-03-31" }, "1"),
    ["0.0800000000"],
  );
  assert.deepEqual(
    continuingNzAssociatedRates(
      [{ ...papers[0]!, effective_on: "2026-04-01" }],
      { subsidiaryId: "sub-a", yearEnd: "2025-03-31" },
      "1",
    ),
    [],
  );
});

const readyVintages = [
  {
    key: "carryover:2023-03-15:2025-08-01",
    source: "carryover" as const,
    parentKey: null,
    placedInServiceOn: "2023-03-15",
    transferOn: "2025-08-01",
    unadjustedBasis: "10000.0000",
    adjustedCarryover: "8000.0000",
    section179: "0.0000",
    priorDepreciation: "2000.0000",
    recoveryPeriodYears: "5",
    method: "200_db" as const,
    convention: "half_year" as const,
    bonusPercent: "0",
    businessUsePercent: "100",
  },
  {
    key: "excess:2025-08-01:2025-08-01",
    source: "excess" as const,
    parentKey: null,
    placedInServiceOn: "2025-08-01",
    transferOn: "2025-08-01",
    unadjustedBasis: "400.0000",
    adjustedCarryover: null,
    section179: "0.0000",
    priorDepreciation: null,
    recoveryPeriodYears: "7",
    method: "straight_line" as const,
    convention: "mid_month" as const,
    bonusPercent: "0",
    businessUsePercent: "100",
  },
];

test("ready MACRS history hides the composite seller vintage and requires identified allocations", () => {
  const ready = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "arms_length", recognition: "taxable" },
    {
      sourceOperation: "partial_disposal",
      applicable: "seller",
      usSellerMacrs: { status: "ready", vintages: readyVintages },
    },
  );
  assert.equal(taxBasisFieldRequired(field("originalUnadjustedBasis"), ready), false);
  assert.equal(taxBasisFieldVisible(field("placedInServiceOn"), ready), false);
  assert.equal(taxBasisFieldVisible(field("method"), ready), false);
  assert.equal(taxBasisFieldVisible(field("convention"), ready), false);
  assert.equal(taxBasisFieldVisible(field("recoveryPeriodYears"), ready), false);
  assert.equal(taxBasisFieldRequired(field("remainingUnadjustedBasis"), ready), true);
  assert.equal(taxBasisFieldRequired(field("disposedUnadjustedBasis"), ready), true);

  const first = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "arms_length", recognition: "taxable" },
    {
      sourceOperation: "partial_disposal",
      applicable: "seller",
      usSellerMacrs: { status: "original_declaration_required" },
    },
  );
  assert.equal(taxBasisFieldRequired(field("originalUnadjustedBasis"), first), true);
  assert.equal(taxBasisFieldRequired(field("placedInServiceOn"), first), true);
  assert.equal(taxBasisFieldRequired(field("method"), first), true);

  const refused = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "arms_length", recognition: "taxable" },
    {
      sourceOperation: "partial_disposal",
      applicable: "seller",
      usSellerMacrs: { status: "history_refused", refusal: "frozen US workpaper is missing originalUnadjustedBasis" },
    },
  );
  assert.equal(taxBasisFieldVisible(field("originalUnadjustedBasis"), refused), false);
  assert.equal(taxBasisFieldVisible(field("remainingUnadjustedBasis"), refused), false);

  const bothNontaxable = attachTaxBasisSource(
    { regime: "us_macrs", relationship: "non_arms_length", recognition: "nontaxable" },
    {
      sourceOperation: "intercompany_transfer",
      applicable: "both",
      usSellerMacrs: { status: "ready", vintages: readyVintages },
    },
  );
  assert.equal(taxBasisFieldRequired(field("originalUnadjustedBasis"), bothNontaxable), false);
  assert.equal(taxBasisFieldVisible(field("placedInServiceOn"), bothNontaxable), false);
  assert.equal(taxBasisFieldVisible(field("method"), bothNontaxable), false);
  assert.equal(taxBasisFieldVisible(field("convention"), bothNontaxable), false);
  assert.equal(taxBasisFieldVisible(field("recoveryPeriodYears"), bothNontaxable), false);
  assert.equal(taxBasisFieldVisible(field("carryoverBasis"), bothNontaxable), false);
  assert.equal(taxBasisFieldRequired(field("excessBasis"), bothNontaxable), true);
});

test("validateUs derives the header original from ready vintages and rechecks allocation keys", () => {
  const context = {
    sourceOperation: "partial_disposal" as const,
    applicable: "seller" as const,
    usSellerMacrs: { status: "ready" as const, vintages: readyVintages },
  };
  const allocations = [
    {
      source: "carryover" as const,
      placedInServiceOn: "2023-03-15",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "2000.00",
      remainingUnadjustedBasis: "8000.00",
    },
    {
      source: "excess" as const,
      placedInServiceOn: "2025-08-01",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "0.00",
      remainingUnadjustedBasis: "400.00",
    },
  ];
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "8400.00",
          disposedUnadjustedBasis: "2000.00",
          recognition: "taxable",
          relatedPerson: false,
          statutoryProceeds: "2000.00",
          amountRealizedRule: "amount_realized",
        },
        context,
      ),
    /vintageAllocations must name every open MACRS vintage/,
    "ready history without allocations",
  );
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          placedInServiceOn: "2023-03-15",
          remainingUnadjustedBasis: "8400.00",
          disposedUnadjustedBasis: "2000.00",
          recognition: "taxable",
          relatedPerson: false,
          statutoryProceeds: "2000.00",
          amountRealizedRule: "amount_realized",
          vintageAllocations: allocations,
        },
        context,
      ),
    /placedInServiceOn cannot be declared as one seller vintage/,
    "composite placed date on ready history",
  );
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "8400.00",
          disposedUnadjustedBasis: "2000.00",
          recognition: "taxable",
          relatedPerson: false,
          statutoryProceeds: "2000.00",
          amountRealizedRule: "amount_realized",
          vintageAllocations: [
            {
              source: "carryover",
              placedInServiceOn: "2023-03-15",
              transferOn: "2025-08-01",
              disposedUnadjustedBasis: "2000.00",
              remainingUnadjustedBasis: "8400.00",
            },
          ],
        },
        context,
      ),
    /must name every open MACRS vintage/,
    "omitted excess vintage",
  );
  const row = validateTaxRegimeBasis(
    {
      regime: "us_macrs",
      relationship: "arms_length",
      dispositionTrigger: "sale",
      remainingUnadjustedBasis: "8400.00",
      disposedUnadjustedBasis: "2000.00",
      recognition: "taxable",
      relatedPerson: false,
      statutoryProceeds: "2000.00",
      amountRealizedRule: "amount_realized",
      vintageAllocations: allocations,
    },
    context,
  ) as UsMacrsRegimeBasis;
  assert.equal(row.originalUnadjustedBasis, "10400.0000");
  assert.equal(row.vintageAllocations?.length, 2);
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "8400.00",
          disposedUnadjustedBasis: "2000.00",
          recognition: "taxable",
          relatedPerson: false,
        },
        {
          sourceOperation: "partial_disposal",
          applicable: "seller",
          usSellerMacrs: { status: "history_refused", refusal: "frozen US workpaper is missing originalUnadjustedBasis for the seller vintage; reverse and re-propose it — do not substitute book acquisition cost" },
        },
      ),
    /do not substitute book acquisition cost/,
    "history-refused propose",
  );
  throwsPolicy(
    () =>
      assertMacrsVintageAllocationsMatchOpen(allocations, []),
    /empty vintage list/,
    "empty open list is not a valid match",
  );
});

test("ready both-sided nontaxable freezes per-disposed-vintage receiver schedules from history", () => {
  const allocations = [
    {
      source: "carryover" as const,
      placedInServiceOn: "2023-03-15",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "2000.00",
      remainingUnadjustedBasis: "8000.00",
    },
    {
      source: "excess" as const,
      placedInServiceOn: "2025-08-01",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "0.00",
      remainingUnadjustedBasis: "400.00",
    },
  ];
  const context = {
    sourceOperation: "intercompany_transfer" as const,
    applicable: "both" as const,
    effectiveOn: "2026-09-01",
    usSellerMacrs: { status: "ready" as const, vintages: readyVintages },
  };
  const base = {
    regime: "us_macrs",
    relationship: "non_arms_length",
    dispositionTrigger: "section_168i7b",
    remainingUnadjustedBasis: "8400.00",
    disposedUnadjustedBasis: "2000.00",
    recognition: "nontaxable",
    section168i7Kind: "nonrecognition",
    relatedPerson: true,
    excessBasis: "0.00",
    vintageAllocations: allocations,
  };
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          ...base,
          placedInServiceOn: "2023-03-15",
          recoveryPeriodYears: "10",
          method: "straight_line",
          convention: "mid_month",
        },
        context,
      ),
    /does not match the frozen disposed vintage recoveryPeriodYears 5/,
    "invented recovery is not accepted because the date matches",
  );
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          ...base,
          placedInServiceOn: "2023-03-15",
          recoveryPeriodYears: "5",
          method: "straight_line",
          convention: "half_year",
        },
        context,
      ),
    /does not match the frozen disposed vintage method 200_db/,
    "invented method is not accepted because the date matches",
  );
  throwsPolicy(
    () => validateTaxRegimeBasis(base, { ...context, effectiveOn: undefined }),
    /source effective date is required to freeze buyer vintage transfer dates/,
    "buyer vintages need the source date",
  );
  const row = validateTaxRegimeBasis(base, context) as UsMacrsRegimeBasis;
  assert.equal(row.originalUnadjustedBasis, "10400.0000");
  assert.equal(row.placedInServiceOn, "2023-03-15");
  assert.equal(row.recoveryPeriodYears, "5");
  assert.equal(row.method, "200_db");
  assert.equal(row.convention, "half_year");
  assert.equal(row.carryoverBasis, "1600.0000");
  assert.equal(row.section179, "0.0000");
  assert.equal(row.priorDepreciation, "400.0000");
  assert.equal(row.buyerVintages?.length, 1);
  assert.deepEqual(row.buyerVintages?.[0], {
    key: "carryover:2023-03-15:2026-09-01:carryover:2023-03-15:2025-08-01",
    source: "carryover",
    parentKey: "carryover:2023-03-15:2025-08-01",
    placedInServiceOn: "2023-03-15",
    transferOn: "2026-09-01",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    unadjustedBasis: "2000.0000",
    adjustedCarryover: "1600.0000",
    section179: "0.0000",
    priorDepreciation: "400.0000",
    bonusPercent: "0",
    businessUsePercent: "100",
  });
  const twoDisposed = validateTaxRegimeBasis(
    {
      ...base,
      disposedUnadjustedBasis: "2400.00",
      remainingUnadjustedBasis: "8000.00",
      vintageAllocations: [
        { ...allocations[0]!, disposedUnadjustedBasis: "2000.00", remainingUnadjustedBasis: "8000.00" },
        { ...allocations[1]!, disposedUnadjustedBasis: "400.00", remainingUnadjustedBasis: "0.00" },
      ],
    },
    context,
  ) as UsMacrsRegimeBasis;
  assert.equal(twoDisposed.buyerVintages?.length, 2);
  assert.equal(twoDisposed.placedInServiceOn, undefined);
  assert.equal(twoDisposed.method, undefined);
  assert.equal(twoDisposed.carryoverBasis, "2000.0000");
  assert.equal(twoDisposed.buyerVintages?.[0]!.recoveryPeriodYears, "5");
  assert.equal(twoDisposed.buyerVintages?.[0]!.method, "200_db");
  assert.equal(twoDisposed.buyerVintages?.[1]!.recoveryPeriodYears, "7");
  assert.equal(twoDisposed.buyerVintages?.[1]!.method, "straight_line");
  assert.equal(twoDisposed.buyerVintages?.[1]!.convention, "mid_month");
  assert.equal(twoDisposed.buyerVintages?.[1]!.parentKey, "excess:2025-08-01:2025-08-01");
  throwsPolicy(
    () =>
      validateTaxRegimeBasis(
        {
          ...base,
          disposedUnadjustedBasis: "2400.00",
          remainingUnadjustedBasis: "8000.00",
          placedInServiceOn: "2023-03-15",
          recoveryPeriodYears: "5",
          method: "200_db",
          convention: "half_year",
          vintageAllocations: [
            { ...allocations[0]!, disposedUnadjustedBasis: "2000.00", remainingUnadjustedBasis: "8000.00" },
            { ...allocations[1]!, disposedUnadjustedBasis: "400.00", remainingUnadjustedBasis: "0.00" },
          ],
        },
        context,
      ),
    /cannot be one header 2023-03-15 when the disposed vintages have placedInServiceOn 2023-03-15, 2025-08-01/,
    "two disposed schedules are not one header recovery",
  );
  const computed = usRegimeWorkpaperOutcome(twoDisposed, "intercompany_transfer", "both", {
    placedInServiceOn: "2026-09-01",
    recoveryPeriodYears: "7",
    method: "200_db",
    convention: "half_year",
  });
  assert.ok(Array.isArray(computed.buyerVintages));
  assert.equal(computed.buyerVintages.length, 2);
  assert.equal(computed.carryoverBasis, "2000.0000");
});

test("service revalidation drops client buyerVintages and reconstructs them from history", () => {
  const allocations = [
    {
      source: "carryover" as const,
      placedInServiceOn: "2023-03-15",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "2000.00",
      remainingUnadjustedBasis: "8000.00",
    },
    {
      source: "excess" as const,
      placedInServiceOn: "2025-08-01",
      transferOn: "2025-08-01",
      disposedUnadjustedBasis: "0.00",
      remainingUnadjustedBasis: "400.00",
    },
  ];
  const context = {
    sourceOperation: "intercompany_transfer" as const,
    applicable: "both" as const,
    effectiveOn: "2026-09-01",
    usSellerMacrs: { status: "ready" as const, vintages: readyVintages },
  };
  const declared = {
    regime: "us_macrs",
    relationship: "non_arms_length",
    dispositionTrigger: "section_168i7b",
    remainingUnadjustedBasis: "8400.00",
    disposedUnadjustedBasis: "2000.00",
    recognition: "nontaxable",
    section168i7Kind: "nonrecognition",
    relatedPerson: true,
    excessBasis: "0.00",
    vintageAllocations: allocations,
  };
  const first = validateTaxRegimeBasis(declared, context) as UsMacrsRegimeBasis;
  assert.equal(first.buyerVintages?.length, 1);
  assert.equal(first.buyerVintages?.[0]!.method, "200_db");
  const persisted = declaredTaxRegimeFacts(first);
  assert.equal(Object.hasOwn(persisted, "buyerVintages"), false);
  const replayed = validateTaxRegimeBasis(
    JSON.parse(JSON.stringify(first)),
    context,
  ) as UsMacrsRegimeBasis;
  assert.deepEqual(replayed.buyerVintages, first.buyerVintages);
  const invented = validateTaxRegimeBasis(
    {
      ...declared,
      buyerVintages: [
        {
          key: "invented",
          source: "carryover",
          parentKey: first.buyerVintages?.[0]!.parentKey,
          placedInServiceOn: "2023-03-15",
          transferOn: "2026-09-01",
          recoveryPeriodYears: "10",
          method: "straight_line",
          convention: "mid_month",
          unadjustedBasis: "2000.0000",
          adjustedCarryover: "1999.0000",
          section179: "0.0000",
          priorDepreciation: "1.0000",
          bonusPercent: "0",
          businessUsePercent: "100",
        },
      ],
    },
    context,
  ) as UsMacrsRegimeBasis;
  assert.equal(invented.buyerVintages?.[0]!.method, "200_db");
  assert.equal(invented.buyerVintages?.[0]!.recoveryPeriodYears, "5");
  assert.notEqual(invented.buyerVintages?.[0]!.adjustedCarryover, "1999.0000");
});
