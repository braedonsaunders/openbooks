// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Inbound parsing refuses unsafe and incomplete documents by name rather
 * than reading them partially.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { EInvoiceParseError, parseEInvoiceXml } from "./parse.ts";
import { renderEInvoiceXml } from "./render.ts";
import { germanInvoice } from "./test-fixtures.ts";

const UBL_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">`;

test("a document type declaration is refused before parsing", () => {
  const entityBomb = `<?xml version="1.0"?>
<!DOCTYPE Invoice [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>
${UBL_HEADER.split("\n").slice(1).join("\n")}<cbc:ID>&b;</cbc:ID></Invoice>`;
  assert.throws(() => parseEInvoiceXml(entityBomb), (error: unknown) =>
    error instanceof EInvoiceParseError && /document type declaration/.test(error.message));
});

test("XML 1.0 declarations preserve lexical identity and processing instructions do not change it", () => {
  const xml = renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml;
  const withoutDeclaration = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  for (const declaration of ["", "<?xml version='1.0'?>", '\uFEFF<?xml version="1.0" encoding="UTF-8" standalone="yes"?>']) {
    assert.equal(parseEInvoiceXml(declaration + withoutDeclaration).number, "RE-2026-0042");
  }
  for (const declaration of ['<?xml version="1.1"?>', '<?xml version="1"?>', '<?xml version="2.0"?>', '<?xml version="invalid"?>', '<?xml encoding="UTF-8"?>', '<?xml version="1.0" version="1.1"?>']) {
    assert.throws(() => parseEInvoiceXml(declaration + withoutDeclaration), /XML 1.0/);
  }
  assert.equal(parseEInvoiceXml('<?xml version="1.0"?><?receiver version="2.0"?>' + withoutDeclaration).number, "RE-2026-0042");
});

test("namespace identity survives arbitrary prefixes and refuses lookalike or rebound fields", () => {
  const xml = renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml;
  const renamed = xml.replaceAll("xmlns:cac", "xmlns:a").replaceAll("cac:", "a:").replaceAll("xmlns:cbc", "xmlns:b").replaceAll("cbc:", "b:");
  assert.equal(parseEInvoiceXml(renamed).number, "RE-2026-0042");
  assert.throws(() => parseEInvoiceXml(xml.replace("urn:oasis:names:specification:ubl:schema:xsd:Invoice-2", "urn:untrusted:invoice")), /namespace/);
  assert.throws(() => parseEInvoiceXml(xml.replaceAll("cbc:IssueDate", "cac:IssueDate")), /namespace/);
  assert.throws(() => parseEInvoiceXml(xml.replace("<cbc:ID>RE-2026-0042", '<cbc:ID xmlns:cbc="urn:untrusted:values">RE-2026-0042')), /namespace/);
  const inline = xml.replace("<cbc:ID>RE-2026-0042</cbc:ID>", '<ID xmlns="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">RE-2026-0042</ID>');
  assert.equal(parseEInvoiceXml(inline).number, "RE-2026-0042");
});

test("ambiguous singleton values, undeclared entities and invalid XML characters are refused", () => {
  const xml = renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml;
  assert.throws(() => parseEInvoiceXml(xml.replace("<cbc:ID>RE-2026-0042</cbc:ID>", "<cbc:ID>ONE</cbc:ID><cbc:ID>TWO</cbc:ID>")), /singleton ID/);
  assert.throws(() => parseEInvoiceXml(xml.replace("RE-2026-0042", "&untrusted;")), /undeclared/);
  assert.throws(() => parseEInvoiceXml(xml.replace("RE-2026-0042", "&#0;")), /invalid XML character/);
  assert.throws(() => parseEInvoiceXml(xml.replace("RE-2026-0042", "\u0000")), /XML 1.0/);
  assert.throws(() => parseEInvoiceXml(xml.replace("RE-2026-0042", "&#x110000;")), /invalid XML character/);
});

test("CDATA is literal text and entities are decoded exactly once", () => {
  const xml = renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml;
  const cdata = xml.replace("<cbc:ID>RE-2026-0042</cbc:ID>", "<cbc:ID><![CDATA[A &amp; B]]></cbc:ID>");
  assert.equal(parseEInvoiceXml(cdata).number, "A &amp; B");
  const escaped = xml.replace("<cbc:ID>RE-2026-0042</cbc:ID>", "<cbc:ID>A &amp;amp; B &#x1F600;</cbc:ID>");
  assert.equal(parseEInvoiceXml(escaped).number, "A &amp; B 😀");
});

test("inbound totals reconcile allowances and rounding and refuse mismatched currencies", () => {
  const invoice = germanInvoice({ profile: "en16931-ubl" }, { prepaid: "10.00", rounding: "0.01" });
  const xml = renderEInvoiceXml(invoice).xml;
  const parsed = parseEInvoiceXml(xml);
  assert.equal(parsed.totals.allowances, "50.0000");
  assert.equal(parsed.totals.rounding, "0.0100");
  assert.equal(parsed.totals.payable, invoice.totals.payable);
  assert.throws(() => parseEInvoiceXml(xml.replace(/(<cbc:PayableAmount[^>]*>)[^<]+/, "$11.00")), (error) => error instanceof EInvoiceParseError && error.term === "BT-115");
  assert.throws(() => parseEInvoiceXml(xml.replace('<cbc:LineExtensionAmount currencyID="EUR">', '<cbc:LineExtensionAmount currencyID="USD">')), /currency/);
});

test("a missing mandatory term is reported by its business term", () => {
  const withoutIssueDate = `${UBL_HEADER}
  <cbc:ID>INV-1</cbc:ID>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
</Invoice>`;
  assert.throws(() => parseEInvoiceXml(withoutIssueDate), (error: unknown) =>
    error instanceof EInvoiceParseError && error.term === "BT-2");
  assert.throws(() => parseEInvoiceXml("<Order><ID>1</ID></Order>"), /expected a UBL Invoice/);
  assert.throws(() => parseEInvoiceXml(`${UBL_HEADER}<cbc:ID>1</Invoice>`), /not well-formed/);
});
