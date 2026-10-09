// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Business-rule refusals: each realistic defect is reported under the
 * identifier a receiver's validator would cite, and strict rendering
 * refuses it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnownVatexCode, unitCode } from "./codes.ts";
import { computeEInvoiceAmounts, type EInvoice, type EInvoiceLine } from "./model.ts";
import { renderEInvoiceXml } from "./render.ts";
import { EInvoiceRefusal, validateEInvoice } from "./rules.ts";
import { GERMAN_ALLOWANCES, GERMAN_LINES, germanInvoice } from "./test-fixtures.ts";

function ruleIds(invoice: EInvoice): string[] {
  return validateEInvoice(invoice).filter((finding) => finding.severity === "fatal").map((finding) => finding.ruleId);
}

test("XRechnung refuses a missing Leitweg-ID as BR-DE-15, and strict rendering throws the findings", () => {
  const invoice = germanInvoice({ buyerReference: null });
  assert.ok(ruleIds(invoice).includes("BR-DE-15"));
  assert.throws(() => renderEInvoiceXml(invoice), (error: unknown) => {
    assert.ok(error instanceof EInvoiceRefusal);
    const finding = error.findings.find((entry) => entry.ruleId === "BR-DE-15")!;
    assert.equal(finding.term, "BT-10");
    assert.match(finding.message, /buyer reference/);
    return true;
  });
  assert.doesNotThrow(() => renderEInvoiceXml(invoice, { strict: false }), "previews render despite findings");
});

test("a credit transfer without an account is BR-61 and, under XRechnung, BR-DE-23-a", () => {
  const base = germanInvoice();
  const ids = ruleIds({ ...base, payment: { ...base.payment, creditTransfer: null } });
  assert.ok(ids.includes("BR-61"));
  assert.ok(ids.includes("BR-DE-23-a"));
});

test("category O cannot be combined with standard-rated supplies", () => {
  const lines: EInvoiceLine[] = [
    GERMAN_LINES[0]!,
    { id: "3", name: "Disbursed permit fee", quantity: "1", unitCode: "C62", netPrice: "120.00", netAmount: "120.00", vatCategory: "O", vatRate: "0" },
  ];
  const ids = ruleIds(germanInvoice({}, {
    lines,
    allowanceCharges: [],
    exemptions: [{ category: "O", reasonCode: "VATEX-EU-O", reason: "Not subject to VAT" }],
  }));
  assert.ok(ids.includes("BR-O-11"));
  assert.ok(ids.includes("BR-O-12"));
});

test("posted tax within one currency unit of basis × rate passes BR-CO-17; beyond it is refused", () => {
  // Basis 1017.50 at 19% computes to 193.33. Tax posted per line may legitimately differ by rounding.
  const stated = (taxAmount: string) => ({
    statedTax: [{ category: "S" as const, rate: "19", taxAmount }, { category: "S" as const, rate: "7", taxAmount: "5.23" }],
  });
  const withinTolerance = germanInvoice({}, stated("193.73"));
  assert.equal(withinTolerance.totals.tax, "198.9600", "the document carries the posted tax, not a recomputation");
  assert.deepEqual(ruleIds(withinTolerance), []);

  const beyondTolerance = germanInvoice({}, stated("194.83"));
  const finding = validateEInvoice(beyondTolerance).find((entry) => entry.ruleId === "BR-CO-17")!;
  assert.equal(finding.severity, "fatal");
  assert.deepEqual(finding.params, { category: "S", rate: "19", stated: "194.83", expected: "193.33" });
  assert.deepEqual(ruleIds(beyondTolerance), ["BR-CO-17"], "the totals still reconcile, so only the tax rule fires");
});

test("totals that do not add up are refused exactly, after rounding to the document precision", () => {
  const base = germanInvoice();
  const ids = ruleIds({ ...base, totals: { ...base.totals, payable: "1290.77" } });
  assert.deepEqual(ids, ["BR-CO-16"]);
  const tooPrecise = ruleIds({ ...base, totals: { ...base.totals, payable: "1290.755" } });
  assert.ok(tooPrecise.includes("BR-DEC-18"));
});

test("a reverse-charge group must state its exemption reason (BR-AE-10)", () => {
  const lines: EInvoiceLine[] = [{ ...GERMAN_LINES[0]!, vatCategory: "AE", vatRate: "0" }];
  const buyerVat = { buyer: { ...germanInvoice().buyer, vatId: "ATU12345678" } };
  const withoutReason = germanInvoice(buyerVat, { lines, allowanceCharges: [] });
  assert.ok(ruleIds(withoutReason).includes("BR-AE-10"));
  const withReason = germanInvoice(buyerVat, {
    lines,
    allowanceCharges: [],
    exemptions: [{ category: "AE", reasonCode: "VATEX-EU-AE", reason: "Reverse charge" }],
  });
  assert.deepEqual(ruleIds(withReason), []);
  assert.equal(withReason.totals.tax, "0.0000");
});

test("the Dutch national rule set applies by seller country: a non-KvK registration is NL-R-003", () => {
  const { vatBreakdown, totals } = computeEInvoiceAmounts({ lines: GERMAN_LINES, allowanceCharges: GERMAN_ALLOWANCES, currencyDecimals: 2 });
  const seller = (countryCode: string) => ({
    name: "Bouwbedrijf De Vries BV",
    address: { line1: "Damrak 1", city: "Amsterdam", postcode: "1012 LG", countryCode },
    vatId: `${countryCode}123456789B01`,
    legalRegistration: { id: "HRB 12345", schemeId: "0204" },
    electronicAddress: { id: "0123456789", schemeId: "0106" },
  });
  const invoice = (countryCode: string): EInvoice => ({
    ...germanInvoice(),
    profile: "peppol-bis",
    seller: seller(countryCode),
    vatBreakdown,
    totals,
  });
  const dutch = validateEInvoice(invoice("NL")).find((finding) => finding.ruleId === "NL-R-003");
  assert.equal(dutch?.term, "BT-30");
  assert.ok(!ruleIds(invoice("BE")).some((id) => id.startsWith("NL-R-")), "a Belgian seller is not judged by Dutch rules");
});

test("code lists refuse what they do not know instead of guessing", () => {
  assert.equal(unitCode("Hour"), "HUR");
  assert.equal(unitCode("lump sum"), "LS");
  assert.equal(unitCode("C62"), "C62");
  assert.equal(unitCode("bundles of rebar"), null);
  assert.equal(isKnownVatexCode("VATEX-EU-132-1Q"), true);
  assert.equal(isKnownVatexCode("VATEX-EU-999"), false);
  assert.throws(
    () => computeEInvoiceAmounts({
      lines: GERMAN_LINES,
      allowanceCharges: [],
      currencyDecimals: 2,
      statedTax: [{ category: "Z", rate: "0", taxAmount: "4.00" }],
    }),
    /no line, allowance or charge in that group/,
  );
});
