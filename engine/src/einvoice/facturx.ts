// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Factur-X / ZUGFeRD hybrid invoices: the CII XML embedded in a PDF.
 *
 * The container carries the PDF/A-3 identification and structures Factur-X
 * requires: the XML as an associated file (`/AF`, AFRelationship
 * /Alternative) named factur-x.xml, an XMP packet declaring PDF/A-3B with
 * the Factur-X schema and its PDF/A extension schema description, an sRGB
 * output intent with the ICC profile embedded, a document information
 * dictionary consistent with the XMP, and a file identifier. Full
 * PDF/A-3b conformance of the visual layer (embedded fonts, no
 * transparency groups or device-dependent colour outside the output
 * intent) depends on the renderer that produced the input PDF.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import { parseEInvoiceXml } from "./parse.ts";
import { EN16931_GUIDELINE } from "./profiles.ts";
import { escapeXml } from "./xml.ts";

export interface FacturXMetadata {
  title: string;
  author: string;
  subject?: string;
  createdAt: Date;
  conformanceLevel: "EN 16931";
}

export const FACTURX_ATTACHMENT_NAME = "factur-x.xml";
const FACTURX_NAMESPACE = "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#";
const PRODUCER = "OpenBooks";
const SRGB_CONDITION = "sRGB IEC61966-2.1";

let iccProfile: Promise<Uint8Array> | null = null;

function srgbProfile(): Promise<Uint8Array> {
  iccProfile ??= readFile(new URL("./srgb-iec61966-2-1.icc", import.meta.url)).then((bytes) => new Uint8Array(bytes));
  return iccProfile;
}

function xmpDate(value: Date): string {
  return `${value.toISOString().slice(0, 19)}Z`;
}

function extensionProperty(name: string, description: string): string {
  return `
            <rdf:li rdf:parseType="Resource">
              <pdfaProperty:name>${name}</pdfaProperty:name>
              <pdfaProperty:valueType>Text</pdfaProperty:valueType>
              <pdfaProperty:category>external</pdfaProperty:category>
              <pdfaProperty:description>${description}</pdfaProperty:description>
            </rdf:li>`;
}

function xmpPacket(meta: FacturXMetadata): string {
  const created = xmpDate(meta.createdAt);
  const description = meta.subject
    ? `
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.subject)}</rdf:li></rdf:Alt></dc:description>`
    : "";
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
      <pdfaid:part>3</pdfaid:part>
      <pdfaid:conformance>B</pdfaid:conformance>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:format>application/pdf</dc:format>
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.title)}</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>${escapeXml(meta.author)}</rdf:li></rdf:Seq></dc:creator>${description}
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <xmp:CreatorTool>${PRODUCER}</xmp:CreatorTool>
      <xmp:CreateDate>${created}</xmp:CreateDate>
      <xmp:ModifyDate>${created}</xmp:ModifyDate>
      <xmp:MetadataDate>${created}</xmp:MetadataDate>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
      <pdf:Producer>${PRODUCER}</pdf:Producer>
    </rdf:Description>
    <rdf:Description rdf:about="" xmlns:fx="${FACTURX_NAMESPACE}">
      <fx:DocumentType>INVOICE</fx:DocumentType>
      <fx:DocumentFileName>${FACTURX_ATTACHMENT_NAME}</fx:DocumentFileName>
      <fx:Version>1.0</fx:Version>
      <fx:ConformanceLevel>${escapeXml(meta.conformanceLevel)}</fx:ConformanceLevel>
    </rdf:Description>
    <rdf:Description rdf:about=""
        xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"
        xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#"
        xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
      <pdfaExtension:schemas>
        <rdf:Bag>
          <rdf:li rdf:parseType="Resource">
            <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
            <pdfaSchema:namespaceURI>${FACTURX_NAMESPACE}</pdfaSchema:namespaceURI>
            <pdfaSchema:prefix>fx</pdfaSchema:prefix>
            <pdfaSchema:property>
              <rdf:Seq>${[
                extensionProperty("DocumentFileName", "The name of the embedded XML document"),
                extensionProperty("DocumentType", "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER"),
                extensionProperty("Version", "The actual version of the standard applying to the embedded XML document"),
                extensionProperty("ConformanceLevel", "The conformance level of the embedded XML document"),
              ].join("")}
              </rdf:Seq>
            </pdfaSchema:property>
          </rdf:li>
        </rdf:Bag>
      </pdfaExtension:schemas>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Insert a file specification into the EmbeddedFiles name tree, replacing an entry of the same name. */
function addToEmbeddedFiles(doc: PDFDocument, name: string, fileSpec: PDFRef): void {
  const context = doc.context;
  let names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  if (!names) {
    names = context.obj({});
    doc.catalog.set(PDFName.of("Names"), names);
  }
  let tree = names.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  if (!tree) {
    tree = context.obj({});
    names.set(PDFName.of("EmbeddedFiles"), tree);
  }
  if (tree.has(PDFName.of("Kids"))) {
    throw new Error("the PDF's embedded-file name tree has intermediate nodes; flatten it before embedding the invoice XML");
  }
  const existing = tree.lookupMaybe(PDFName.of("Names"), PDFArray);
  const entries: Array<[string, unknown]> = [];
  if (existing) {
    for (let index = 0; index + 1 < existing.size(); index += 2) {
      const key = existing.lookup(index);
      const keyText = key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : "";
      if (keyText.toLowerCase() !== name.toLowerCase()) entries.push([keyText, existing.get(index + 1)]);
    }
  }
  entries.push([name, fileSpec]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const array = context.obj([]);
  for (const [key, value] of entries) {
    array.push(PDFString.of(key));
    array.push(value as PDFRef);
  }
  tree.set(PDFName.of("Names"), array);
}

/** Refuse known PDF/A violations; complete conformance still requires an ISO 19005 validator. */
function preflightVisualPdf(doc: PDFDocument): void {
  if (doc.context.trailerInfo.Encrypt) throw new Error("Factur-X requires an unencrypted PDF.");
  const prohibitedActions = new Set(["JavaScript", "Launch", "Sound", "Movie", "ResetForm", "ImportData"]);
  const visited = new WeakSet<object>();
  const visit = (object: PDFObject): void => {
    if (object instanceof PDFRef) {
      const target = doc.context.lookup(object);
      if (!target) throw new Error("The Factur-X PDF contains an unresolved object reference.");
      visit(target); return;
    }
    if (visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFStream) { visit(object.dict); return; }
    if (object instanceof PDFArray) { for (const item of object.asArray()) visit(item); return; }
    if (!(object instanceof PDFDict)) return;
    const action = object.get(PDFName.of("S"));
    if (action instanceof PDFName && prohibitedActions.has(action.decodeText())) throw new Error(`Factur-X PDF/A does not permit ${action.decodeText()} actions.`);
    if (object.has(PDFName.of("JS"))) throw new Error("Factur-X PDF/A does not permit embedded JavaScript.");
    if (object.get(PDFName.of("Type")) === PDFName.of("Font")) {
      const subtype = object.get(PDFName.of("Subtype"));
      if (subtype === PDFName.of("Type0")) {
        const descendants = object.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray);
        if (!descendants || descendants.size() === 0) throw new Error("The Factur-X PDF font has no embedded descendant font.");
      } else if (subtype === PDFName.of("Type3")) {
        if (!object.lookupMaybe(PDFName.of("CharProcs"), PDFDict)) throw new Error("The Factur-X PDF Type 3 font has no embedded glyph procedures.");
      } else {
        const descriptor = object.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
        const embedded = descriptor && ["FontFile", "FontFile2", "FontFile3"].some((key) => doc.context.lookup(descriptor.get(PDFName.of(key))) instanceof PDFStream);
        if (!embedded) throw new Error("Factur-X PDF/A requires embedded font programs; render the invoice with embedded fonts.");
      }
    }
    for (const [, value] of object.entries()) visit(value);
  };
  visit(doc.catalog);
}

/**
 * Embed CII XML into a PDF as a Factur-X / ZUGFeRD hybrid invoice.
 * Returns the new PDF bytes; the input is not modified.
 */
export async function embedFacturX(pdf: Uint8Array, xml: string, meta: FacturXMetadata): Promise<Uint8Array> {
  const invoice = parseEInvoiceXml(xml);
  if (invoice.syntax !== "cii" || invoice.customizationId !== EN16931_GUIDELINE) throw new Error("Factur-X EN 16931 requires CII XML carrying the EN 16931 specification identifier.");
  if (meta.conformanceLevel !== "EN 16931" || !Number.isFinite(meta.createdAt.getTime())) throw new Error("The Factur-X metadata requires the supported EN 16931 profile and a valid creation timestamp.");
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  preflightVisualPdf(doc);
  const context = doc.context;
  const xmlBytes = new TextEncoder().encode(xml);
  const created = meta.createdAt;

  const embedded = context.flateStream(xmlBytes, {
    Type: "EmbeddedFile",
    Subtype: "text/xml",
    Params: {
      Size: xmlBytes.length,
      CreationDate: PDFString.fromDate(created),
      ModDate: PDFString.fromDate(created),
      CheckSum: PDFHexString.of(createHash("md5").update(xmlBytes).digest("hex")),
    },
  });
  const embeddedRef = context.register(embedded);
  const fileSpec = context.obj({
    Type: "Filespec",
    F: PDFString.of(FACTURX_ATTACHMENT_NAME),
    UF: PDFHexString.fromText(FACTURX_ATTACHMENT_NAME),
    Desc: PDFString.of("Factur-X invoice"),
    AFRelationship: "Alternative",
    EF: { F: embeddedRef, UF: embeddedRef },
  });
  const fileSpecRef = context.register(fileSpec);
  addToEmbeddedFiles(doc, FACTURX_ATTACHMENT_NAME, fileSpecRef);

  const associated = context.obj([]);
  const previous = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  for (const ref of previous?.asArray() ?? []) {
    const spec = context.lookupMaybe(ref, PDFDict);
    const file = spec?.lookup(PDFName.of("UF")) ?? spec?.lookup(PDFName.of("F"));
    const name = file instanceof PDFString || file instanceof PDFHexString ? file.decodeText() : null;
    if (name?.toLowerCase() !== FACTURX_ATTACHMENT_NAME) associated.push(ref);
  }
  associated.push(fileSpecRef);
  doc.catalog.set(PDFName.of("AF"), associated);

  doc.setTitle(meta.title, { showInWindowTitleBar: true });
  doc.setAuthor(meta.author);
  doc.setSubject(meta.subject ?? "");
  doc.setProducer(PRODUCER);
  doc.setCreator(PRODUCER);
  doc.setCreationDate(created);
  doc.setModificationDate(created);

  const metadata = context.stream(new TextEncoder().encode(xmpPacket(meta)), { Type: "Metadata", Subtype: "XML" });
  doc.catalog.set(PDFName.of("Metadata"), context.register(metadata));

  const intents = doc.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
  const hasPdfaIntent = intents?.asArray().some((entry) => {
    const intent = context.lookupMaybe(entry, PDFDict);
    return intent?.get(PDFName.of("S")) === PDFName.of("GTS_PDFA1");
  }) ?? false;
  if (!hasPdfaIntent) {
    const icc = context.register(context.flateStream(await srgbProfile(), { N: 3 }));
    const intent = context.register(context.obj({
      Type: "OutputIntent",
      S: "GTS_PDFA1",
      OutputConditionIdentifier: PDFString.of(SRGB_CONDITION),
      Info: PDFString.of(SRGB_CONDITION),
      RegistryName: PDFString.of("http://www.color.org"),
      DestOutputProfile: icc,
    }));
    const list = intents ?? context.obj([]);
    list.push(intent);
    doc.catalog.set(PDFName.of("OutputIntents"), list);
  }

  const id = PDFHexString.of(createHash("md5").update(xmlBytes).update(created.toISOString()).digest("hex"));
  context.trailerInfo.ID = context.obj([id, id]);

  return doc.save({ useObjectStreams: false });
}
