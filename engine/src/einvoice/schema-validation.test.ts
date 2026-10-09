import assert from "node:assert/strict";
import { test } from "node:test";
import { computeEInvoiceAmounts, type EInvoice, type EInvoiceLine } from "./model.ts";
import { parseEInvoiceXml } from "./parse.ts";
import { EINVOICE_PROFILES, type EInvoiceProfileKey } from "./profiles.ts";
import { renderEInvoiceXml } from "./render.ts";
import { EInvoiceRefusal, fatalFindings, validateEInvoice } from "./rules.ts";
import { validateEInvoiceXmlSchema } from "./schema-validation.ts";
import { germanInvoice } from "./test-fixtures.ts";

function nationalInvoice(profile: EInvoiceProfileKey): EInvoice {
  const inv = germanInvoice({ profile });
  if (profile === "nlcius") {
    return { ...inv, seller: { ...inv.seller, address: { ...inv.seller.address, countryCode: "NL" }, vatId: "NL123456789B01", legalRegistration: { id: "12345678", schemeId: "0106" } }, buyer: { ...inv.buyer, address: { ...inv.buyer.address, countryCode: "BE" } } };
  }
  if (profile === "ehf") {
    return { ...inv, seller: { ...inv.seller, address: { ...inv.seller.address, countryCode: "NO" }, vatId: "NO974761076MVA", legalRegistration: { id: "974761076", schemeId: "0192" }, electronicAddress: { id: "974761076", schemeId: "0192" } } };
  }
  if (EINVOICE_PROFILES[profile].taxSchemeId !== "GST") return inv;
  const sg = EINVOICE_PROFILES[profile].ruleSets.includes("sg");
  const lines: EInvoiceLine[] = [{ id: "1", name: "Professional services", quantity: "2", unitCode: "HUR", netPrice: "50", netAmount: "100", vatCategory: sg ? "SR" : "S", vatRate: sg ? "9" : "10" }];
  const { totals, vatBreakdown } = computeEInvoiceAmounts({ lines, allowanceCharges: [], currencyDecimals: 2 });
  // Party identifiers follow the published PINT examples; amounts exercise the native exact model.
  return {
    ...inv, lines, allowanceCharges: [], totals, vatBreakdown,
    uuid: "123e4567-e89b-12d3-a456-426614174000", currency: sg ? "SGD" : "AUD",
    seller: { ...inv.seller, vatId: sg ? "M2-1234567-K" : "47555222000", taxRegistrationId: null, address: { ...inv.seller.address, countryCode: sg ? "SG" : "AU" }, legalRegistration: { id: sg ? "200212345Z" : "47555222000", schemeId: sg ? "0195" : "0151" }, electronicAddress: { id: sg ? "SGUEN200212345Z" : "47555222000", schemeId: sg ? "0195" : "0151" } },
    buyer: { ...inv.buyer, address: { ...inv.buyer.address, countryCode: sg ? "SG" : "AU" }, legalRegistration: { id: sg ? "200254321Z" : "57946356658", schemeId: sg ? "0195" : "0151" }, electronicAddress: { id: sg ? "SGUEN200254321Z" : "57946356658", schemeId: sg ? "0195" : "0151" } },
    payment: { ...inv.payment, meansCode: "30", creditTransfer: { accountId: "123456789", accountName: "Services supplier" } },
  };
}

for (const profile of Object.keys(EINVOICE_PROFILES) as EInvoiceProfileKey[]) {
  test(`${profile} emits schema-valid invoice and credit-note XML with reconciled amounts`, async () => {
    for (const typeCode of ["380", "381"]) {
      const inv = { ...nationalInvoice(profile), typeCode };
      assert.deepEqual(fatalFindings(validateEInvoice(inv)), []);
      const { xml } = renderEInvoiceXml(inv);
      assert.equal(await validateEInvoiceXmlSchema(xml), xml);
      const parsed = parseEInvoiceXml(xml);
      assert.equal(parsed.customizationId, EINVOICE_PROFILES[profile].guidelineId);
      assert.equal(parsed.taxSchemeId, EINVOICE_PROFILES[profile].taxSchemeId);
      assert.equal(parsed.totals.payable, inv.totals.payable);
      assert.equal(parsed.isCreditNote, typeCode === "381");
    }
  });
}

test("the published schema rejects out-of-order UBL fields even when all amounts reconcile", async () => {
  const xml = renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml;
  const broken = xml.replace(/(<cbc:IssueDate>[^<]+<\/cbc:IssueDate>)\s*(<cbc:DueDate>[^<]+<\/cbc:DueDate>)/, "$2\n$1");
  await assert.rejects(() => validateEInvoiceXmlSchema(broken), (error) => error instanceof EInvoiceRefusal && error.findings.some((entry) => entry.ruleId === "OB-XSD-01"));
});

test("precise quantities, prices, rates and base quantities survive XML output without rounding", async () => {
  const line: EInvoiceLine = { id: "1", name: "Precision material", quantity: "0.123456", unitCode: "KGM", netPrice: "9.87654321", baseQuantity: "0.0123456", netAmount: "98.77", vatCategory: "S", vatRate: "19.125" };
  for (const profile of ["en16931-cii", "en16931-ubl"] as const) {
    const inv = germanInvoice({ profile }, { lines: [line], allowanceCharges: [] });
    const xml = renderEInvoiceXml(inv).xml;
    await validateEInvoiceXmlSchema(xml);
    const parsed = parseEInvoiceXml(xml);
    assert.equal(parsed.lines[0]?.quantity, line.quantity);
    assert.equal(parsed.lines[0]?.netPrice, line.netPrice);
    assert.equal(parsed.lines[0]?.baseQuantity, line.baseQuantity);
    assert.equal(parsed.lines[0]?.vatRate, line.vatRate);
  }
});

test("Singapore foreign-currency invoices preserve the posted SGD totals and UUID", async () => {
  const invoice = {
    ...nationalInvoice("pint-sg"), currency: "USD", taxCurrency: "SGD", taxTotalInTaxCurrency: "12.00",
    accountingCurrencyTotals: { taxExclusive: "133.33", taxInclusive: "145.33" },
  };
  const xml = renderEInvoiceXml(invoice).xml;
  await validateEInvoiceXmlSchema(xml);
  const parsed = parseEInvoiceXml(xml);
  assert.equal(parsed.uuid, invoice.uuid);
  assert.deepEqual(parsed.accountingCurrencyTotals, { taxExclusive: "133.3300", taxInclusive: "145.3300" });
  assert.ok(fatalFindings(validateEInvoice({ ...invoice, accountingCurrencyTotals: null })).some((entry) => entry.ruleId === "BR-53-GST-SG"));
});

test("national GST refuses unknown categories, broken ABNs and missing SG invoice identity", () => {
  const australian = nationalInvoice("pint-aunz");
  assert.ok(fatalFindings(validateEInvoice({ ...australian, seller: { ...australian.seller, legalRegistration: { id: "47555222001", schemeId: "0151" } } })).some((entry) => entry.ruleId === "OB-ABN-01"));
  const singapore = nationalInvoice("pint-sg");
  assert.ok(fatalFindings(validateEInvoice({ ...singapore, uuid: null })).some((entry) => entry.ruleId === "BR-108-GST-SG"));
  assert.throws(() => renderEInvoiceXml({ ...singapore, lines: [{ ...singapore.lines[0]!, vatCategory: "S" }] }), EInvoiceRefusal);
});
