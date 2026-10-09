// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Peppol BIS Billing 3.0 UBL: a credit note renders as a UBL CreditNote
 * document with its own quantity element, the due date in the payment
 * means, and a reference to the invoice it credits.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEInvoiceAmounts, type EInvoice, type EInvoiceLine } from "./model.ts";
import { parseEInvoiceXml } from "./parse.ts";
import { PEPPOL_BILLING_PROCESS, PEPPOL_BIS_GUIDELINE } from "./profiles.ts";
import { renderEInvoiceXml } from "./render.ts";
import { fatalFindings, validateEInvoice } from "./rules.ts";

function belgianCreditNote(): EInvoice {
  const lines: EInvoiceLine[] = [
    {
      id: "1",
      name: "Scaffolding hire, unused days",
      quantity: "4",
      unitCode: "DAY",
      netPrice: "120.00",
      netAmount: "480.00",
      vatCategory: "S",
      vatRate: "21",
      orderLineReference: "3",
    },
  ];
  const { vatBreakdown, totals } = computeEInvoiceAmounts({ lines, allowanceCharges: [], currencyDecimals: 2 });
  return {
    profile: "peppol-bis",
    number: "CN-2026-0007",
    typeCode: "381",
    issueDate: "2026-10-08",
    dueDate: "2026-10-22",
    currency: "EUR",
    currencyDecimals: 2,
    orderReference: "PO-7781",
    precedingInvoices: [{ number: "INV-2026-0042", issueDate: "2026-09-15" }],
    notes: ["Credit for scaffolding returned early."],
    seller: {
      name: "Bouw Steiger NV",
      address: { line1: "Kerkstraat 12", city: "Antwerpen", postcode: "2000", countryCode: "BE" },
      vatId: "BE0123456749",
      legalRegistration: { id: "0123456749", schemeId: "0208" },
      electronicAddress: { id: "0123456749", schemeId: "0208" },
    },
    buyer: {
      name: "Aannemer Janssens BV",
      address: { line1: "Marktplein 3", city: "Gent", postcode: "9000", countryCode: "BE" },
      vatId: "BE0987654321",
      electronicAddress: { id: "0987654321", schemeId: "0208" },
    },
    payment: {
      meansCode: "30",
      creditTransfer: { accountId: "BE68539007547034", accountName: "Aannemer Janssens BV" },
    },
    lines,
    allowanceCharges: [],
    vatBreakdown,
    totals,
  };
}

test("a Peppol credit note renders as a UBL CreditNote and parses back", () => {
  const creditNote = belgianCreditNote();
  assert.deepEqual(fatalFindings(validateEInvoice(creditNote)), []);
  const { xml } = renderEInvoiceXml(creditNote);

  assert.match(xml, /<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2" xmlns:cac="[^"]+" xmlns:cbc="[^"]+">/);
  assert.match(xml, /<cbc:CustomizationID>urn:cen\.eu:en16931:2017#compliant#urn:fdc:peppol\.eu:2017:poacc:billing:3\.0<\/cbc:CustomizationID>\s*<cbc:ProfileID>/);
  assert.match(xml, /<cbc:CreditNoteTypeCode>381<\/cbc:CreditNoteTypeCode>/);
  assert.match(xml, /<cac:CreditNoteLine>\s*<cbc:ID>1<\/cbc:ID>\s*<cbc:CreditedQuantity unitCode="DAY">4<\/cbc:CreditedQuantity>/);
  assert.doesNotMatch(xml, /InvoiceLine|InvoicedQuantity|<cbc:DueDate>/);
  assert.match(xml, /<cac:PaymentMeans>\s*<cbc:PaymentMeansCode>30<\/cbc:PaymentMeansCode>\s*<cbc:PaymentDueDate>2026-10-22<\/cbc:PaymentDueDate>/);
  assert.match(xml, /<cac:BillingReference>\s*<cac:InvoiceDocumentReference>\s*<cbc:ID>INV-2026-0042<\/cbc:ID>\s*<cbc:IssueDate>2026-09-15<\/cbc:IssueDate>/);
  assert.match(xml, /<cac:TaxSubtotal>\s*<cbc:TaxableAmount currencyID="EUR">480\.00<\/cbc:TaxableAmount>\s*<cbc:TaxAmount currencyID="EUR">100\.80</);
  assert.doesNotMatch(xml, /<[A-Za-z:]+(\s[^>]*)?\/>/, "Peppol R008 forbids empty elements");

  const parsed = parseEInvoiceXml(xml);
  assert.equal(parsed.syntax, "ubl");
  assert.equal(parsed.isCreditNote, true);
  assert.equal(parsed.customizationId, PEPPOL_BIS_GUIDELINE);
  assert.equal(parsed.profileId, PEPPOL_BILLING_PROCESS);
  assert.equal(parsed.dueDate, "2026-10-22");
  assert.equal(parsed.orderReference, "PO-7781");
  assert.deepEqual(parsed.lines.map((line) => [line.quantity, line.unitCode, line.netAmount]), [["4", "DAY", "480.0000"]]);
  assert.deepEqual(parsed.totals, {
    lineNet: "480.0000", allowances: "0.0000", charges: "0.0000", taxExclusive: "480.0000", tax: "100.8000", taxInclusive: "580.8000", prepaid: "0.0000", rounding: "0.0000", payable: "580.8000",
  });
});

test("a Peppol invoice refuses a type code outside the Peppol list and a buyer with neither reference", () => {
  const invoice = { ...belgianCreditNote(), typeCode: "384", orderReference: null, precedingInvoices: [] };
  const ids = validateEInvoice(invoice).map((finding) => finding.ruleId);
  assert.ok(ids.includes("PEPPOL-EN16931-P0100"));
  assert.ok(ids.includes("PEPPOL-EN16931-R003"));
});
