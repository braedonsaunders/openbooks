import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeEvidence } from "./ChangeEvidence";

// The test runner uses classic JSX; the production compiler supplies it.
Object.assign(globalThis, { React });

test("dated checkpoint evidence separates bonus actually taken from its rate and preserves per-vintage methods", () => {
  const markup = renderToStaticMarkup(<ChangeEvidence taxBasis value={{ buyerVintages: [
    {
      checkpointKind: "taken_components", section179: "0.0000", takenBonus: "5250.0000",
      priorDepreciation: "0.0000", adjustedCarryover: "3750.0000", bonusPercent: "100",
      shortYearMethod: "simplified",
    },
    {
      checkpointKind: "declared_elections", section179: "1000.0000", takenBonus: null,
      priorDepreciation: "2000.0000", adjustedCarryover: "7000.0000", bonusPercent: "0",
      shortYearMethod: "allocation",
    },
  ] }} />);
  for (const fact of [
    "Carryover checkpoint evidence", "Dated taken §179, bonus, regular MACRS, and remaining",
    "Declared elections (bonus from allocated percent)", "Bonus depreciation taken (this slice)",
    "Section 179 depreciation taken (this slice)", "Prior MACRS depreciation (this slice)",
    "5250.0000", "3750.0000", "1000.0000", "2000.0000", "7000.0000",
    "Simplified method (Pub 946)", "Allocation method (Rev. Proc. 89-15)",
  ]) assert.ok(markup.includes(fact), fact);
  assert.doesNotMatch(markup, />taken_components<|>declared_elections<|>simplified<|>allocation</);
  assert.match(markup, /Not supplied/);
});

test("matching evidence preserves signed amounts, deferred balance and the redetermined tax attributes", () => {
  const markup = renderToStaticMarkup(<ChangeEvidence taxBasis value={{
    deferredOpening: "40.0000",
    actualCorrespondingItems: [{ attribute: "section1245_ordinary", amount: "10.0000" }],
    recomputedCorrespondingItems: [
      { attribute: "section1245_ordinary", amount: "40.0000" },
      { attribute: "section1231", amount: "10.0000" },
    ],
    actualCorrespondingAmount: "10.0000",
    recomputedCorrespondingAmount: "50.0000",
    sellerMatchingItems: [
      { attribute: "section1245_ordinary", amount: "30.0000" },
      { attribute: "section1231", amount: "10.0000" },
    ],
    sellerMatchingAmount: "40.0000",
    deferredClosing: "0.0000",
  }} />);
  for (const fact of [
    "Opening deferred intercompany amount", "Recomputed corresponding items for the group",
    "recognized matching amount", "Closing deferred intercompany amount",
    "Redetermined tax attribute", "Section 1245 ordinary gain", "Section 1231 gain or loss",
    "30.0000", "40.0000", "50.0000", "0.0000",
  ]) assert.ok(markup.includes(fact), fact);
  assert.doesNotMatch(markup, />section1245_ordinary<|>section1231</);
  const loss = renderToStaticMarkup(<ChangeEvidence taxBasis value={{
    sellerMatchingItems: [{ attribute: "ordinary", amount: "-5.0001" }],
    deferredClosing: "-44.9999",
  }} />);
  assert.match(loss, /Ordinary income or deduction/);
  assert.match(loss, /-5\.0001/);
  assert.match(loss, /-44\.9999/);
});

test("an explicitly empty matching read differs from missing evidence and retains unknown statutory attributes", () => {
  const empty = renderToStaticMarkup(<ChangeEvidence taxBasis value={{
    actualCorrespondingItems: [], recomputedCorrespondingItems: [], sellerMatchingItems: [],
  }} />);
  assert.match(empty, /No corresponding items were taken into account/);
  assert.match(empty, /No recomputed corresponding items arose/);
  assert.match(empty, /No seller matching items arose/);
  const missing = renderToStaticMarkup(<ChangeEvidence taxBasis value={{ sellerMatchingItems: null }} />);
  assert.match(missing, /Not supplied/);
  assert.doesNotMatch(missing, /No seller matching items arose/);
  const unknown = renderToStaticMarkup(<ChangeEvidence taxBasis value={{ attribute: "documented_special_attribute" }} />);
  assert.match(unknown, /documented_special_attribute/);
  const ordinaryEvidence = renderToStaticMarkup(<ChangeEvidence value={{ attribute: "section1231" }} />);
  assert.match(ordinaryEvidence, />section1231</);
});

test("calendar evidence preserves distinct dates for equal filing labels and distinguishes an empty read set", () => {
  const markup = renderToStaticMarkup(<ChangeEvidence taxBasis names={{ company: "Receiving company" }} value={{
    taxYearWindows: [
      { id: "first-window", subsidiaryId: "company", regime: "us_macrs", yearStart: "2026-01-01", yearEnd: "2026-06-30", filingYear: 2026 },
      { id: "second-window", subsidiaryId: "company", regime: "us_macrs", yearStart: "2026-07-01", yearEnd: "2026-12-31", filingYear: 2026 },
    ],
  }} />);
  for (const fact of ["Registered tax years used by this calculation", "Receiving company", "first-window", "second-window", "2026-01-01", "2026-06-30", "2026-07-01", "2026-12-31", "Filing-year label"])
    assert.ok(markup.includes(fact), fact);
  const empty = renderToStaticMarkup(<ChangeEvidence taxBasis value={{ taxYearWindows: [] }} />);
  assert.match(empty, /No registered tax-year windows were read by this calculation/);
  const missing = renderToStaticMarkup(<ChangeEvidence taxBasis value={{ taxYearWindows: null }} />);
  assert.match(missing, /Not supplied/);
  assert.doesNotMatch(missing, /No registered tax-year windows were read/);
});

test("tax approval evidence names statutory choices and preserves the exact assessment", () => {
  const markup = renderToStaticMarkup(
    <ChangeEvidence
      taxBasis
      value={{
        assessment: "Evidence: 2026_CA_basis_workpaper.pdf",
        regimes: [
          {
            regime: "ca_cca",
            allocationMethod: "ascertainable_fraction",
            allocationFraction: "0.2500",
            statutoryProceeds: "0.0000",
          },
        ],
      }}
    />,
  );
  assert.match(markup, /Canada — Capital Cost Allowance/);
  assert.match(markup, /Section 43 allocation method/);
  assert.match(markup, /Identifiable fraction of capital cost/);
  assert.match(markup, /0\.2500/);
  assert.match(markup, /0\.0000/);
  assert.match(markup, /2026_CA_basis_workpaper\.pdf/);
  assert.doesNotMatch(markup, /ascertainable_fraction/);
});

test("applied tax results retain each regime, frozen outcome, explicit false and reference", () => {
  const markup = renderToStaticMarkup(
    <ChangeEvidence
      taxBasis
      names={{ "asset-reference": "FA-42 — Transfer recipient" }}
      value={{
        receivingAssetId: "asset-reference",
        regimes: ["ca_cca", "us_macrs"],
        computed: {
          ca_cca: { dispositionAmount: "600.0000" },
          us_macrs: {
            buyerSection179Allowed: false,
            placedInServiceOn: "2023-03-15",
            method: "200_db",
            convention: "half_year",
            buyerPlacedInServiceOn: "2026-07-01",
            buyerRecoveryPeriodYears: "7",
            buyerMethod: "150_db",
            buyerConvention: "mid_quarter",
            evidenceEdition: "IRS_2026_01",
          },
        },
        workpaperIds: ["workpaper-ca", "workpaper-us"],
      }}
    />,
  );
  assert.match(markup, /Canada — Capital Cost Allowance/);
  assert.match(markup, /United States — MACRS/);
  assert.match(markup, /600\.0000/);
  assert.match(markup, /<span>No<\/span>/);
  assert.match(markup, /FA-42 — Transfer recipient/);
  assert.match(markup, /IRS_2026_01/);
  assert.match(markup, /2023-03-15/);
  assert.match(markup, /200% declining balance/);
  assert.match(markup, /Half-year/);
  assert.match(markup, /Receiving asset placed-in-service date/);
  assert.match(markup, /2026-07-01/);
  assert.match(markup, /Receiving asset recovery period \(years\)/);
  assert.match(markup, /Receiving asset MACRS method/);
  assert.match(markup, /150% declining balance/);
  assert.match(markup, /Receiving asset MACRS convention/);
  assert.match(markup, /Mid-quarter/);
  assert.doesNotMatch(markup, /150_db|mid_quarter/);
  assert.match(markup, /workpaper-ca/);
  assert.match(markup, /workpaper-us/);
});

test("ordinary accounting evidence keeps its own labels and exact reference text", () => {
  const markup = renderToStaticMarkup(
    <ChangeEvidence
      value={{
        standaloneSellingPrice: "1050.0000",
        assessment: "contract_2026_amendment.pdf",
        idempotencyKey: "transport-only-request-key",
      }}
    />,
  );
  assert.match(markup, /Extended standalone selling price/);
  assert.match(markup, /1050\.0000/);
  assert.match(markup, /contract_2026_amendment\.pdf/);
  assert.doesNotMatch(markup, /transport-only-request-key/);
});

test("tax allocation evidence distinguishes received vintages and preserves each exact split", () => {
  const markup = renderToStaticMarkup(
    <ChangeEvidence
      taxBasis
      value={{
        vintageAllocations: [
          {
            source: "carryover",
            placedInServiceOn: "2024-03-15",
            transferOn: "2025-08-20",
            disposedUnadjustedBasis: "2250.0001",
            remainingUnadjustedBasis: "6749.9999",
          },
          {
            source: "excess",
            placedInServiceOn: "2025-08-20",
            transferOn: "2025-08-20",
            disposedUnadjustedBasis: "500.0000",
            remainingUnadjustedBasis: "0.0000",
          },
        ],
        assessment: "carryover_source_2025.pdf",
      }}
    />,
  );
  assert.match(markup, /Allocation by tax depreciation vintage/);
  assert.match(markup, /§168\(i\)\(7\) carryover — transferor history/);
  assert.match(markup, /Nontaxable excess basis — newly placed/);
  assert.match(markup, /Transfer effective date/);
  for (const exact of [
    "2024-03-15",
    "2025-08-20",
    "2250.0001",
    "6749.9999",
    "500.0000",
    "0.0000",
    "carryover_source_2025.pdf",
  ]) {
    assert.ok(markup.includes(exact), exact);
  }
  assert.doesNotMatch(markup, />carryover<|>excess</);
  const ordinary = renderToStaticMarkup(
    <ChangeEvidence value={{ source: "carryover" }} />,
  );
  assert.match(ordinary, />carryover</);
});

test("tax approval evidence distinguishes the monthly allocation from the consolidated-group rule", () => {
  for (const [kind, expected] of [
    ["nonrecognition", /monthly months-held allocation/],
    [
      "consolidated_group",
      /consolidated-group member transfer — no monthly split/,
    ],
    ["partnership_721_prior_interest", /bonus stays with the transferor/],
  ] as const) {
    const markup = renderToStaticMarkup(
      <ChangeEvidence taxBasis value={{ section168i7Kind: kind }} />,
    );
    assert.match(markup, /§168\(i\)\(7\) transfer kind/);
    assert.match(markup, expected);
    assert.doesNotMatch(markup, new RegExp(`>${kind}<`));
  }
});

test("receiver evidence preserves each frozen schedule and its parent lineage", () => {
  const markup = renderToStaticMarkup(
    <ChangeEvidence
      taxBasis
      value={{
        buyerVintages: [
          {
            source: "carryover",
            parentKey: "original:2023-03-15",
            placedInServiceOn: "2023-03-15",
            transferOn: "2026-07-01",
            method: "200_db",
            convention: "half_year",
            recoveryPeriodYears: "5",
            unadjustedBasis: "2000.0001",
            adjustedCarryover: "1600.0000",
          },
          {
            source: "carryover",
            parentKey: "excess:2025-08-01:2025-08-01",
            placedInServiceOn: "2025-08-01",
            transferOn: "2026-07-01",
            method: "straight_line",
            convention: "mid_month",
            recoveryPeriodYears: "7",
            unadjustedBasis: "100.0000",
            adjustedCarryover: "80.0001",
          },
        ],
      }}
    />,
  );
  for (const value of [
    "original:2023-03-15",
    "excess:2025-08-01:2025-08-01",
    "200% declining balance",
    "Half-year",
    "Straight line",
    "Mid-month",
    "2000.0001",
    "1600.0000",
    "100.0000",
    "80.0001",
  ])
    assert.ok(markup.includes(value), value);
  assert.doesNotMatch(
    markup,
    />200_db<|>half_year<|>straight_line<|>mid_month</,
  );
});
