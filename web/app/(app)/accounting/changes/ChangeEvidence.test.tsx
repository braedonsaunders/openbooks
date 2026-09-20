import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeEvidence } from "./ChangeEvidence";

// The test runner uses classic JSX; the production compiler supplies it.
Object.assign(globalThis, { React });

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
