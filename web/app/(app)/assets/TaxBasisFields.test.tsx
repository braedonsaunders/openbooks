import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { TaxBasisFields } from "./TaxBasisFields";
import { attachTaxBasisSource } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";

// The test runner uses classic JSX; the production compiler supplies it.
Object.assign(globalThis, { React });
const common = JSON.parse(
  readFileSync(
    new URL("../../../messages/en/common.json", import.meta.url),
    "utf8",
  ),
);
const ui = JSON.parse(
  readFileSync(
    new URL("../../../messages/en/ui.json", import.meta.url),
    "utf8",
  ),
);

function render(
  draft: Parameters<typeof TaxBasisFields>[0]["draft"],
  omitFields?: readonly string[],
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ common, ui }}
    >
      <TaxBasisFields
        draft={{
          sourceOperation: "partial_disposal",
          applicable: "seller",
          ...draft,
        }}
        onChange={() => {}}
        omitFields={omitFields}
      />
    </NextIntlClientProvider>,
  );
}

test("frozen seller history uses the allocation editor without asking for a composite schedule", () => {
  const markup = render(
    attachTaxBasisSource(
      { regime: "us_macrs", recognition: "taxable" },
      {
        sourceOperation: "partial_disposal",
        applicable: "seller",
        usSellerMacrs: {
          status: "ready",
          vintages: [
            {
              key: "original:2024-03-15",
              source: "original",
              parentKey: null,
              placedInServiceOn: "2024-03-15",
              transferOn: null,
              unadjustedBasis: "1000.0000",
              adjustedCarryover: null,
              section179: "0.0000",
              priorDepreciation: null,
              recoveryPeriodYears: "5",
              method: "200_db",
              convention: "half_year",
              bonusPercent: "0",
              businessUsePercent: "100",
            },
          ],
        },
      },
    ),
    ["disposedUnadjustedBasis", "remainingUnadjustedBasis"],
  );
  for (const field of [
    "originalUnadjustedBasis",
    "placedInServiceOn",
    "recoveryPeriodYears",
    "method",
    "convention",
    "disposedUnadjustedBasis",
    "remainingUnadjustedBasis",
  ]) {
    assert.ok(!markup.includes(`-${field}\"`), field);
  }
  assert.match(markup, /MACRS partial-disposition trigger/);
});

test("the first statutory declaration still presents its original basis and recovery fields", () => {
  const markup = render(
    attachTaxBasisSource(
      { regime: "us_macrs" },
      {
        sourceOperation: "partial_disposal",
        applicable: "seller",
        usSellerMacrs: { status: "original_declaration_required" },
      },
    ),
  );
  for (const field of [
    "originalUnadjustedBasis",
    "placedInServiceOn",
    "recoveryPeriodYears",
    "method",
    "convention",
    "disposedUnadjustedBasis",
    "remainingUnadjustedBasis",
  ]) {
    assert.ok(markup.includes(`-${field}\"`), field);
  }
});

test("tax relationship is an explicit choice with native option children", () => {
  const markup = render({ regime: "ca_cca" });
  assert.match(markup, /<option value="arms_length">/);
  assert.match(markup, /<option value="non_arms_length">/);
  assert.doesNotMatch(
    markup,
    /value="(?:arms_length|non_arms_length)" selected/,
  );
});

test("unanswered tax facts do not render as false, while an explicit no remains selected", () => {
  const unanswered = render({ regime: "uk_wda" });
  assert.doesNotMatch(unanswered, /value="false" selected/);
  const answered = render({
    regime: "uk_wda",
    relationship: "arms_length",
    saleBelowMarket: false,
    buyerCanClaimPma: false,
    connectedChain: false,
  });
  assert.match(answered, /value="false" selected=""/);
});

test("changing a tax allocation method replaces the irrelevant input", () => {
  const amount = render({
    regime: "ca_cca",
    allocationMethod: "ascertainable_amount",
    allocatedCapitalCost: "750.0000",
  });
  assert.match(amount, /value="750\.0000"/);
  assert.doesNotMatch(amount, /-allocationFraction"/);
  const fraction = render({
    regime: "ca_cca",
    allocationMethod: "ascertainable_fraction",
    allocationFraction: "0.25",
    allocatedCapitalCost: "750.0000",
  });
  assert.match(fraction, /value="0\.25"/);
  assert.doesNotMatch(fraction, /value="750\.0000"/);
});

test("a MACRS service date uses a date control and preserves the original vintage", () => {
  const markup = render({
    regime: "us_macrs",
    placedInServiceOn: "2024-02-29",
  });
  assert.match(markup, /<input[^>]*type="date"[^>]*value="2024-02-29"/);
});

test("seller-only Canadian transfer asks for seller allocation without a buyer cost worksheet", () => {
  const markup = render({
    regime: "ca_cca",
    sourceOperation: "intercompany_transfer",
    applicable: "seller",
    relationship: "non_arms_length",
    allocationMethod: "ascertainable_amount",
    allocatedCapitalCost: "750.0000",
  });
  assert.match(markup, /value="750\.0000"/);
  assert.doesNotMatch(markup, /-payment"/);
  assert.doesNotMatch(markup, /-sellerOriginalCapitalCost"/);
  assert.doesNotMatch(markup, /-transferorCharacter"/);
});

test("buyer-only US transfer asks for acquisition facts without seller disposal amounts", () => {
  const markup = render({
    regime: "us_macrs",
    sourceOperation: "intercompany_transfer",
    applicable: "buyer",
    relationship: "non_arms_length",
    recognition: "taxable",
    buyerCost: "925.0000",
  });
  assert.match(markup, /-buyerCost"/);
  assert.match(markup, /value="925\.0000"/);
  assert.doesNotMatch(markup, /-originalUnadjustedBasis"/);
  assert.doesNotMatch(markup, /-disposedUnadjustedBasis"/);
  assert.doesNotMatch(markup, /-statutoryProceeds"/);
  assert.doesNotMatch(markup, /-amountRealizedRule"/);
  assert.doesNotMatch(markup, /-placedInServiceOn"/);
  assert.doesNotMatch(markup, /-recoveryPeriodYears"/);
  assert.doesNotMatch(markup, /-method"/);
  assert.doesNotMatch(markup, /-convention"/);
});

test("buyer-only US carryover asks for transferor history without inventing a seller disposition", () => {
  const markup = render({
    regime: "us_macrs",
    sourceOperation: "intercompany_transfer",
    applicable: "buyer",
    relationship: "non_arms_length",
    recognition: "nontaxable",
    placedInServiceOn: "2023-03-15",
    recoveryPeriodYears: "5",
    method: "200_db",
    convention: "half_year",
    originalUnadjustedBasis: "10000.0000",
    carryoverBasis: "6400.0000",
    excessBasis: "400.0000",
  });
  assert.match(markup, /-placedInServiceOn"/);
  assert.match(markup, /value="2023-03-15"/);
  assert.match(markup, /-recoveryPeriodYears"/);
  assert.match(markup, /-method"/);
  assert.match(markup, /-convention"/);
  assert.match(markup, /-originalUnadjustedBasis"/);
  assert.match(markup, /value="10000\.0000"/);
  assert.match(markup, /-carryoverBasis"/);
  assert.match(markup, /value="6400\.0000"/);
  assert.match(markup, /-excessBasis"/);
  assert.doesNotMatch(markup, /-disposedUnadjustedBasis"/);
  assert.doesNotMatch(markup, /-remainingUnadjustedBasis"/);
  assert.doesNotMatch(markup, /-amountRealizedRule"/);
});

test("both classified parties receive both statutory worksheets with no applicability election", () => {
  const markup = render({
    regime: "ca_cca",
    sourceOperation: "intercompany_transfer",
    applicable: "both",
    relationship: "non_arms_length",
    allocationMethod: "ascertainable_amount",
    allocatedCapitalCost: "750.0000",
    payment: "600.0000",
  });
  assert.match(markup, /value="750\.0000"/);
  assert.match(markup, /value="600\.0000"/);
  assert.match(markup, /-sellerOriginalCapitalCost"/);
  assert.doesNotMatch(markup, /-(?:applicable|sourceOperation)"/);
});

test("a nontaxable transfer requires a statutory vehicle and a taxable intercompany sale can declare carryover treatment", () => {
  const context = {
    regime: "us_macrs",
    sourceOperation: "intercompany_transfer" as const,
    applicable: "buyer" as const,
    relationship: "non_arms_length",
  };
  const unanswered = render({ ...context, recognition: "nontaxable" });
  const nativeKindSelect = unanswered
    .match(/<select\b[^>]*>[\s\S]*?<\/select>/g)
    ?.find((select) => select.includes('value="nonrecognition"'));
  assert.ok(
    nativeKindSelect,
    "statutory transfer kind must have a native form control",
  );
  assert.match(nativeKindSelect, /^<select\b[^>]*required=""/);
  assert.match(unanswered, /<option value="nonrecognition">/);
  assert.match(unanswered, /<option value="consolidated_group">/);
  assert.match(unanswered, /<option value="partnership_721_prior_interest">/);
  assert.doesNotMatch(
    unanswered,
    /value="(?:nonrecognition|consolidated_group|partnership_721_prior_interest)" selected/,
  );
  const answered = render({
    ...context,
    recognition: "nontaxable",
    section168i7Kind: "consolidated_group",
  });
  assert.match(answered, /value="consolidated_group" selected=""/);
  const taxable = render({
    ...context,
    recognition: "taxable",
    section168i7Kind: "consolidated_group",
  });
  const taxableKind = taxable.match(/<select\b[^>]*>[\s\S]*?<\/select>/g)
    ?.find((select) => select.includes('value="consolidated_group"'));
  assert.ok(taxableKind, "a taxable group sale must be able to declare its independent carryover treatment");
  assert.doesNotMatch(taxableKind, /^<select\b[^>]*required=""/);
  assert.match(taxableKind, /value="consolidated_group" selected=""/);
  assert.match(taxable, /-carryoverBasis"/);
  assert.match(taxable, /-excessBasis"/);
});
