// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * XRechnung 3.0 CII: a German invoice validates, renders, and parses back
 * into figures that reconcile the way a receiver adds the written strings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { add, mulPercent, sum } from "../money/money.ts";
import { parseEInvoiceXml } from "./parse.ts";
import { PEPPOL_BILLING_PROCESS, XRECHNUNG_GUIDELINE } from "./profiles.ts";
import { renderEInvoiceXml } from "./render.ts";
import { fatalFindings, validateEInvoice } from "./rules.ts";
import { germanInvoice } from "./test-fixtures.ts";

function position(xml: string, needle: string): number {
  const index = xml.indexOf(needle);
  assert.notEqual(index, -1, `expected ${needle} in the document`);
  return index;
}

test("an XRechnung CII invoice round-trips and reconciles as its receiver adds it", () => {
  const invoice = germanInvoice();
  assert.deepEqual(fatalFindings(validateEInvoice(invoice)), []);

  const { xml, fileName, mediaType } = renderEInvoiceXml(invoice);
  assert.equal(fileName, "RE-2026-0042.xml");
  assert.equal(mediaType, "application/xml");
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rsm:CrossIndustryInvoice /);
  assert.doesNotMatch(xml, /<[A-Za-z:]+(\s[^>]*)?\/>/, "no empty elements beyond the mandatory delivery container");
  for (const [, value] of xml.matchAll(/<ram:\w*(?<!Charge)Amount(?: [^>]*)?>([^<]*)</g)) assert.match(value!, /^-?\d+\.\d{2}$/);

  // BT-23 precedes BT-24, as the D16B context sequence requires.
  assert.ok(position(xml, "BusinessProcessSpecifiedDocumentContextParameter") < position(xml, "GuidelineSpecifiedDocumentContextParameter"));
  // The account lands in the D16B creditor account, as an IBAN, with its BIC.
  assert.match(xml, /<ram:PayeePartyCreditorFinancialAccount>\s*<ram:IBANID>DE89370400440532013000<\/ram:IBANID>/);
  assert.match(xml, /<ram:BICID>COBADEFFXXX<\/ram:BICID>/);

  const parsed = parseEInvoiceXml(xml);
  assert.equal(parsed.syntax, "cii");
  assert.equal(parsed.customizationId, XRECHNUNG_GUIDELINE);
  assert.equal(parsed.profileId, PEPPOL_BILLING_PROCESS);
  assert.equal(parsed.number, "RE-2026-0042");
  assert.equal(parsed.issueDate, "2026-10-08");
  assert.equal(parsed.dueDate, "2026-11-07");
  assert.equal(parsed.buyerReference, "04011000-12345-67");
  assert.deepEqual(parsed.buyer.electronicAddress, { id: "04011000-12345-67", schemeId: "0204" });
  assert.equal(parsed.seller.vatId, "DE123456789");
  assert.equal(parsed.seller.taxRegistrationId, "12/345/67890");
  assert.deepEqual(parsed.paymentAccount, { id: "DE89370400440532013000", name: "Muster Bau GmbH", bic: "COBADEFFXXX" });
  assert.equal(parsed.lines[0]!.name, "Concrete works <C25/30> & formwork");
  assert.equal(parsed.lines[0]!.quantity, "12.5");

  // The receiver's arithmetic over the written strings.
  const totals = parsed.totals;
  assert.equal(totals.lineNet, sum(parsed.lines.map((line) => line.netAmount)));
  assert.equal(totals.taxExclusive, sum(parsed.vatBreakdown.map((group) => group.taxableAmount)));
  assert.equal(totals.tax, sum(parsed.vatBreakdown.map((group) => group.taxAmount)));
  assert.equal(totals.taxInclusive, add(totals.taxExclusive, totals.tax));
  assert.equal(totals.payable, add(totals.taxInclusive, `-${totals.prepaid}`));
  assert.deepEqual(
    parsed.vatBreakdown.map((group) => [group.category, group.rate, group.taxableAmount, group.taxAmount]),
    [["S", "19", "1017.5000", "193.3300"], ["S", "7", "74.7000", "5.2300"]],
  );
  for (const group of parsed.vatBreakdown) {
    assert.equal(group.taxAmount, mulPercent(group.taxableAmount, group.rate!, 2), "BR-CO-17 holds exactly on the written figures");
  }
  const sevenPercentLines = parsed.lines.filter((line) => line.vatRate === "7");
  assert.equal(sum(sevenPercentLines.map((line) => line.netAmount)), parsed.vatBreakdown[1]!.taxableAmount);
  assert.equal(totals.payable, "1290.7600");
});

test("a VAT accounting currency is written before the invoice currency, with BT-111 in its own currency", () => {
  const invoice = germanInvoice({ currency: "USD", taxCurrency: "EUR", taxTotalInTaxCurrency: "182.67" });
  const { xml } = renderEInvoiceXml(invoice);
  assert.ok(position(xml, "<ram:TaxCurrencyCode>EUR") < position(xml, "<ram:InvoiceCurrencyCode>USD"));
  assert.match(xml, /<ram:TaxTotalAmount currencyID="USD">198\.56<\/ram:TaxTotalAmount>\s*<ram:TaxTotalAmount currencyID="EUR">182\.67</);
  assert.equal(parseEInvoiceXml(xml).totals.tax, "198.5600", "the parser reads the VAT total in the invoice currency");
});
