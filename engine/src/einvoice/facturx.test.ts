// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Factur-X: the CII XML travels inside the PDF as an associated file with
 * the PDF/A-3 identification, XMP and output intent a receiver checks, and
 * comes back out byte for byte.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from "pdf-lib";
import { embedFacturX } from "./facturx.ts";
import { extractEmbeddedInvoiceXml, parseEInvoiceXml } from "./parse.ts";
import { EN16931_GUIDELINE } from "./profiles.ts";
import { renderEInvoiceXml } from "./render.ts";
import { germanInvoice } from "./test-fixtures.ts";

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawRectangle({ x: 50, y: 750, width: 400, height: 30, opacity: 0.5 });
  return doc.save();
}

function streamBytes(stream: unknown): Uint8Array {
  assert.ok(stream instanceof PDFRawStream);
  return decodePDFRawStream(stream).decode();
}

test("a Factur-X hybrid carries the XML as an associated file with PDF/A-3 identification", async () => {
  const rendered = renderEInvoiceXml(germanInvoice({ profile: "facturx" }));
  assert.equal(rendered.fileName, "factur-x.xml");
  const createdAt = new Date("2026-10-08T09:30:00Z");
  const hybrid = await embedFacturX(await onePagePdf(), rendered.xml, {
    title: "Invoice RE-2026-0042",
    author: "Muster Bau GmbH",
    subject: "Invoice & XML",
    createdAt,
    conformanceLevel: "EN 16931",
  });

  const doc = await PDFDocument.load(hybrid, { updateMetadata: false });
  const catalog = doc.catalog;
  const names = catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  assert.equal(names.size(), 2);
  const fileSpec = names.lookup(1, PDFDict);
  assert.equal(fileSpec.get(PDFName.of("AFRelationship")), PDFName.of("Alternative"));
  const associated = catalog.lookup(PDFName.of("AF"), PDFArray);
  assert.equal(associated.size(), 1);
  assert.equal(associated.get(0), names.get(1), "the /AF entry is the same file specification");

  const embedded = fileSpec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"));
  assert.equal(new TextDecoder().decode(streamBytes(embedded)), rendered.xml);
  assert.equal((embedded as PDFRawStream).dict.get(PDFName.of("Subtype")), PDFName.of("text/xml"));

  const intent = catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict);
  assert.equal(intent.get(PDFName.of("S")), PDFName.of("GTS_PDFA1"));
  const icc = intent.lookup(PDFName.of("DestOutputProfile"));
  assert.ok(icc instanceof PDFRawStream);
  assert.equal(icc.dict.lookup(PDFName.of("N"), PDFNumber).asNumber(), 3);
  assert.equal(new TextDecoder("latin1").decode(streamBytes(icc).subarray(36, 40)), "acsp", "an ICC profile signature");

  const metadata = catalog.lookup(PDFName.of("Metadata"));
  assert.ok(metadata instanceof PDFRawStream);
  assert.equal(metadata.dict.get(PDFName.of("Filter")), undefined, "PDF/A metadata streams are unfiltered");
  const xmp = new TextDecoder().decode(metadata.contents);
  assert.match(xmp, /<pdfaid:part>3<\/pdfaid:part>\s*<pdfaid:conformance>B<\/pdfaid:conformance>/);
  assert.match(xmp, /<fx:ConformanceLevel>EN 16931<\/fx:ConformanceLevel>/);
  assert.match(xmp, /<pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#<\/pdfaSchema:namespaceURI>/);
  assert.match(xmp, /<rdf:li xml:lang="x-default">Invoice &amp; XML<\/rdf:li>/);
  assert.equal(doc.getProducer(), "OpenBooks");
  assert.equal(doc.getCreationDate()?.toISOString(), createdAt.toISOString());

  const extracted = await extractEmbeddedInvoiceXml(hybrid);
  assert.equal(extracted?.fileName, "factur-x.xml");
  assert.equal(extracted?.xml, rendered.xml);
  assert.equal(parseEInvoiceXml(extracted!.xml).customizationId, EN16931_GUIDELINE);
  assert.equal(await extractEmbeddedInvoiceXml(await onePagePdf()), null, "a plain PDF carries no invoice");
});

test("Factur-X refuses unembedded font programs before declaring PDF/A conformance", async () => {
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Invoice", { font: await doc.embedFont(StandardFonts.Helvetica) });
  const bytes = await doc.save();
  await assert.rejects(() => embedFacturX(bytes, renderEInvoiceXml(germanInvoice({ profile: "facturx" })).xml, {
    title: "Invoice", author: "Seller", createdAt: new Date("2026-10-08T00:00:00Z"), conformanceLevel: "EN 16931",
  }), /embedded font programs/);
});

test("re-embedding an invoice replaces its associated file instead of accumulating competing XML", async () => {
  const rendered = renderEInvoiceXml(germanInvoice({ profile: "facturx" }));
  const meta = { title: "Invoice", author: "Seller", createdAt: new Date("2026-10-08T00:00:00Z"), conformanceLevel: "EN 16931" as const };
  const first = await embedFacturX(await onePagePdf(), rendered.xml, meta);
  const second = await embedFacturX(first, rendered.xml, meta);
  const doc = await PDFDocument.load(second, { updateMetadata: false });
  assert.equal(doc.catalog.lookup(PDFName.of("AF"), PDFArray).size(), 1);
  assert.equal((await extractEmbeddedInvoiceXml(second))?.xml, rendered.xml);
});

test("Factur-X refuses UBL and mismatched profile XML instead of relabelling them as CII", async () => {
  const pdf = await onePagePdf();
  await assert.rejects(() => embedFacturX(pdf, renderEInvoiceXml(germanInvoice({ profile: "en16931-ubl" })).xml, {
    title: "Invoice", author: "Seller", createdAt: new Date("2026-10-08T00:00:00Z"), conformanceLevel: "EN 16931",
  }), /requires CII XML/);
});
