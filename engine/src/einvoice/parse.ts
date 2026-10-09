// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Inbound e-invoices: parse UBL 2.1 Invoice / CreditNote or UN/CEFACT CII
 * into one normalised structure, and extract the XML from a Factur-X /
 * ZUGFeRD / XRechnung hybrid PDF.
 *
 * Inbound documents are untrusted. A document type declaration is refused
 * outright, which rules out external entities (XXE) and entity expansion;
 * a closed entity decoder admits only the five predefined
 * XML entities and numeric character references are decoded. Input is
 * capped at 10 MB. Amounts come back as canonical 4-decimal strings,
 * quantities and prices as exact canonical decimals, and a missing
 * mandatory term is a typed error naming that term.
 */

import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";
import { add, neg, sum, normalizeMoney } from "../money/money.ts";
import { isCreditNoteTypeCode } from "./codes.ts";
import { canonicalDecimal, compare, hasAtMostDecimals, isPlainDecimal } from "./decimal.ts";
import { assertXmlCharacters, isIsoDate } from "./xml.ts";

export const MAX_EINVOICE_XML_BYTES = 10 * 1024 * 1024;
export const MAX_EINVOICE_PDF_BYTES = 50 * 1024 * 1024;

export class EInvoiceParseError extends Error {
  /** The EN 16931 business term that is missing or malformed, when one applies. */
  readonly term: string | null;

  constructor(message: string, term: string | null = null) {
    super(message);
    this.name = "EInvoiceParseError";
    this.term = term;
  }
}

export interface ParsedAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  postcode: string | null;
  subdivision: string | null;
  countryCode: string | null;
}

export interface ParsedParty {
  name: string;
  vatId: string | null;
  taxRegistrationId: string | null;
  legalId: { id: string; schemeId: string | null } | null;
  electronicAddress: { id: string; schemeId: string | null } | null;
  address: ParsedAddress | null;
}

export interface ParsedLine {
  id: string;
  name: string;
  description: string | null;
  quantity: string;
  unitCode: string | null;
  netPrice: string;
  baseQuantity: string | null;
  netAmount: string;
  vatCategory: string;
  vatRate: string | null;
  sellerItemId: string | null;
}

export interface ParsedVatBreakdown {
  category: string;
  rate: string | null;
  taxableAmount: string;
  taxAmount: string;
  exemptionReason: string | null;
  exemptionReasonCode: string | null;
}

export interface ParsedEInvoice {
  syntax: "ubl" | "cii";
  customizationId: string | null;
  profileId: string | null;
  uuid: string | null;
  taxSchemeId: "VAT" | "GST";
  accountingCurrencyTotals: { taxExclusive: string; taxInclusive: string } | null;
  typeCode: string;
  isCreditNote: boolean;
  number: string;
  issueDate: string;
  dueDate: string | null;
  currency: string;
  seller: ParsedParty;
  buyer: ParsedParty;
  buyerReference: string | null;
  orderReference: string | null;
  paymentAccount: { id: string; name: string | null; bic: string | null } | null;
  paymentTerms: string | null;
  totals: { lineNet: string; allowances: string; charges: string; taxExclusive: string; tax: string; taxInclusive: string; prepaid: string; rounding: string; payable: string };
  allowanceCharges: Array<{ isCharge: boolean; amount: string; vatCategory: string; vatRate: string | null }>;
  lines: ParsedLine[];
  vatBreakdown: ParsedVatBreakdown[];
}

// ---------------------------------------------------------------------------
// Tree access
// ---------------------------------------------------------------------------

/** Parsed element: every element is an array entry; text sits under "#text", attributes under "@_name". */
type Node = Record<string, unknown>;

const ENTITY = /&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/g;
const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (value.replace(ENTITY, "").includes("&")) throw new EInvoiceParseError("The e-invoice contains an undeclared or malformed XML entity.");
  return value.replace(ENTITY, (_, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      if (!(code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
        throw new EInvoiceParseError("The e-invoice contains an invalid XML character reference.");
      }
      return String.fromCodePoint(code);
    }
    return NAMED[entity]!;
  });
}

function children(node: Node | null | undefined, name: string): Node[] {
  if (!node) return [];
  const value = node[name];
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === "object" && entry !== null ? (entry as Node) : { "#text": String(entry) }));
}

function child(node: Node | null | undefined, ...path: string[]): Node | null {
  let current: Node | null = node ?? null;
  for (const name of path) {
    const matches = children(current, name);
    if (matches.length > 1) throw new EInvoiceParseError(`The e-invoice repeats the singleton ${name} element; supply one unambiguous value.`);
    current = matches[0] ?? null;
    if (!current) return null;
  }
  return current;
}

function textOf(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (Object.keys(node).some((key) => !key.startsWith("@_") && key !== "#text")) {
    throw new EInvoiceParseError("An invoice value contains nested markup; supply a plain XML value.");
  }
  const raw = node["#text"];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

function text(node: Node | null | undefined, ...path: string[]): string | null {
  return textOf(child(node, ...path));
}

function attr(node: Node | null | undefined, name: string): string | null {
  const raw = node?.[`@_${name}`];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value === "" ? null : value;
}

function mandatory<T>(value: T | null, term: string, label: string): T {
  if (value === null || value === undefined || value === "") {
    throw new EInvoiceParseError(`The e-invoice has no ${label} (${term}).`, term);
  }
  return value;
}

function amount(value: string | null, term: string, label: string): string {
  const present = mandatory(value, term, label);
  if (!isPlainDecimal(present)) throw new EInvoiceParseError(`The ${label} (${term}) is not a decimal number: "${present}".`, term);
  if (!hasAtMostDecimals(present, 2)) throw new EInvoiceParseError(`The ${label} (${term}) carries more than two decimals.`, term);
  try {
    return normalizeMoney(present);
  } catch {
    throw new EInvoiceParseError(`The ${label} (${term}) carries more than four decimals: "${present}".`, term);
  }
}

function optionalAmount(value: string | null, term: string, label: string): string {
  return value === null ? "0.0000" : amount(value, term, label);
}

function decimal(value: string | null, term: string, label: string): string {
  const present = mandatory(value, term, label);
  if (!isPlainDecimal(present)) throw new EInvoiceParseError(`The ${label} (${term}) is not a decimal number: "${present}".`, term);
  return canonicalDecimal(present);
}

function optionalRate(value: string | null, term: string, label: string): string | null {
  return value === null ? null : decimal(value, term, label);
}

function isoDate(value: string | null, term: string, label: string): string {
  const present = mandatory(value, term, label);
  if (!isIsoDate(present)) throw new EInvoiceParseError(`The ${label} (${term}) is not an ISO date: "${present}".`, term);
  return present;
}

/** A CII date: udt:DateTimeString in format 102 (YYYYMMDD). */
function ciiDate(node: Node | null, term: string, label: string): string | null {
  const stringNode = child(node, "DateTimeString") ?? child(node, "DateString");
  const value = textOf(stringNode);
  if (value === null) return null;
  const format = attr(stringNode, "format");
  if (format !== "102" || !/^\d{8}$/.test(value)) {
    throw new EInvoiceParseError(`The ${label} (${term}) must use date format 102 (YYYYMMDD); saw "${value}" in format ${format}.`, term);
  }
  return isoDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, term, label);
}

// ---------------------------------------------------------------------------
// XML entry point
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  entityDecoder: {
    decode: decodeEntities,
    reset: () => {},
    // Version is checked on the declaration itself: the parser coerces it to a
    // number and invokes this hook for unrelated processing instructions too.
    setXmlVersion: () => {},
    addInputEntities: () => { throw new EInvoiceParseError("Custom XML entities are not supported."); },
    setExternalEntities: () => { throw new EInvoiceParseError("External XML entities are not supported."); },
  },
  htmlEntities: false,
  alwaysCreateTextNode: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
  trimValues: true,
  isArray: (_name, _path, _leaf, isAttribute) => !isAttribute,
});

/** Parse an inbound UBL or CII e-invoice. Throws EInvoiceParseError on anything it cannot read faithfully. */
export function parseEInvoiceXml(xml: string): ParsedEInvoice {
  if (typeof xml !== "string") throw new EInvoiceParseError("The e-invoice must be supplied as XML text.");
  if (new TextEncoder().encode(xml).length > MAX_EINVOICE_XML_BYTES) {
    throw new EInvoiceParseError(`The e-invoice exceeds the ${MAX_EINVOICE_XML_BYTES / 1024 / 1024} MB limit.`);
  }
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new EInvoiceParseError("The e-invoice contains a document type declaration, which is refused to prevent external entity and entity expansion attacks.");
  }
  try { assertXmlCharacters(xml); }
  catch { throw new EInvoiceParseError("The e-invoice contains a character that XML 1.0 cannot represent."); }
  const declaration = /^(?:\uFEFF)?<\?xml(?=[\t\r\n ])([\s\S]*?)\?>/.exec(xml);
  if (declaration && !/^[\t\r\n ]+version[\t\r\n ]*=[\t\r\n ]*(["'])1\.0\1(?:[\t\r\n ]+encoding[\t\r\n ]*=[\t\r\n ]*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:[\t\r\n ]+standalone[\t\r\n ]*=[\t\r\n ]*(["'])(?:yes|no)\3)?[\t\r\n ]*$/.test(declaration[1]!)) {
    throw new EInvoiceParseError("Only a well-formed XML 1.0 declaration is supported.");
  }
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new EInvoiceParseError(`The e-invoice is not well-formed XML: ${valid.err.msg} (line ${valid.err.line}).`);
  }
  let tree: Node;
  try { tree = parser.parse(xml) as Node; }
  catch (error) {
    if (error instanceof EInvoiceParseError) throw error;
    throw new EInvoiceParseError(`The e-invoice could not be parsed: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const roots = Object.keys(tree).filter((key) => !key.startsWith("@_") && key !== "#text" && Array.isArray(tree[key]));
  if (roots.length !== 1 || children(tree, roots[0]!).length !== 1) throw new EInvoiceParseError("The document must contain exactly one root element.");
  const qualifiedName = roots[0]!;
  const localName = qualifiedName.split(":").at(-1)!;
  if (!["Invoice", "CreditNote", "CrossIndustryInvoice"].includes(localName)) {
    throw new EInvoiceParseError(`The document root is ${localName}; expected a UBL Invoice, a UBL CreditNote or a CII CrossIndustryInvoice.`);
  }
  const syntax = localName === "CrossIndustryInvoice" ? "cii" : "ubl";
  const root = normalizeNamespaces(qualifiedName, children(tree, qualifiedName)[0]!, {}, syntax, 0);
  const invoice = syntax === "cii" ? parseCii(root) : parseUbl(root, localName === "CreditNote");
  reconcileParsedInvoice(invoice);
  return invoice;
}

const UBL_ROOT_NS = "urn:oasis:names:specification:ubl:schema:xsd:";
const CII_NS = "urn:un:unece:uncefact:data:standard:";
const UBL_AGGREGATES = new Set([
  "AccountingSupplierParty", "AccountingCustomerParty", "Party", "PartyLegalEntity", "PartyName", "PartyTaxScheme", "TaxScheme", "PostalAddress", "Country",
  "PaymentMeans", "PayeeFinancialAccount", "FinancialInstitutionBranch", "TaxTotal", "TaxSubtotal", "LegalMonetaryTotal", "InvoiceLine", "CreditNoteLine", "PartyIdentification",
  "Item", "ClassifiedTaxCategory", "Price", "SellersItemIdentification", "TaxCategory", "OrderReference", "PaymentTerms", "AllowanceCharge",
]);
const UBL_BASIC_TERMS = new Set([
  "ID", "Name", "Description", "InvoiceTypeCode", "CreditNoteTypeCode", "DocumentCurrencyCode", "TaxCurrencyCode", "TaxAmount", "TaxableAmount",
  "PriceAmount", "BaseQuantity", "InvoicedQuantity", "CreditedQuantity", "LineExtensionAmount", "TaxExclusiveAmount", "TaxInclusiveAmount", "PayableAmount",
  "AllowanceTotalAmount", "ChargeTotalAmount", "PrepaidAmount", "PayableRoundingAmount", "Amount", "BaseAmount", "ChargeIndicator", "Percent",
  "CustomizationID", "ProfileID", "UUID", "BuyerReference", "IssueDate", "DueDate", "PaymentDueDate", "PaymentMeansCode", "PaymentID", "Note",
  "StreetName", "AdditionalStreetName", "CityName", "PostalZone", "CountrySubentity", "IdentificationCode", "CompanyID", "RegistrationName", "EndpointID",
  "TaxExemptionReason", "TaxExemptionReasonCode", "DocumentTypeCode", "DocumentDescription", "SalesOrderID", "StartDate", "EndDate", "ActualDeliveryDate", "TaxPointDate",
  "AccountingCost", "LineID", "MultiplierFactorNumeric", "AllowanceChargeReason", "AllowanceChargeReasonCode", "Telephone", "ElectronicMail",
]);
const CII_ROOT_ELEMENTS = new Set(["CrossIndustryInvoice", "ExchangedDocumentContext", "ExchangedDocument", "SupplyChainTradeTransaction"]);

/** Resolve expanded names before reading values; prefixes never establish an element's identity. */
function normalizeNamespaces(name: string, node: Node, inherited: Record<string, string>, syntax: "ubl" | "cii", depth: number): Node {
  if (depth > 128) throw new EInvoiceParseError("The e-invoice exceeds the XML nesting limit.");
  const bindings = Object.assign(Object.create(null) as Record<string, string>, inherited);
  for (const [key, value] of Object.entries(node)) {
    if (key === "@_xmlns") bindings[""] = String(value);
    else if (key.startsWith("@_xmlns:")) bindings[key.slice(8)] = String(value);
  }
  const parts = name.split(":");
  const local = parts.at(-1)!;
  const namespace = bindings[parts.length === 2 ? parts[0]! : ""];
  let expected: string;
  if (syntax === "ubl") {
    expected = UBL_ROOT_NS + (local === "Invoice" || local === "CreditNote" ? `${local}-2` : UBL_AGGREGATES.has(local) ? "CommonAggregateComponents-2" : "CommonBasicComponents-2");
    // Unknown aggregate terms are preserved only in their own namespace, never as basic values.
    if (!UBL_AGGREGATES.has(local) && !UBL_BASIC_TERMS.has(local) && namespace === UBL_ROOT_NS + "CommonAggregateComponents-2") expected = namespace;
  } else {
    expected = CII_NS + (CII_ROOT_ELEMENTS.has(local) ? "CrossIndustryInvoice:100" : ["DateTimeString", "DateString", "Indicator"].includes(local) ? "UnqualifiedDataType:100" : "ReusableAggregateBusinessInformationEntity:100");
    if (local === "DateTimeString" && namespace === CII_NS + "QualifiedDataType:100") expected = namespace;
  }
  if (namespace !== expected) throw new EInvoiceParseError(`The ${name} element has an unsupported or incorrect XML namespace.`);
  const result: Node = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_xmlns")) continue;
    if (key === "#text" || key.startsWith("@_")) { result[key] = value; continue; }
    if (!Array.isArray(value)) continue;
    const childName = key.split(":").at(-1)!;
    const resolved = value.map((entry) => normalizeNamespaces(key, entry as Node, bindings, syntax, depth + 1));
    result[childName] = [...(result[childName] as Node[] | undefined ?? []), ...resolved];
  }
  return result;
}

/** Refuse internally inconsistent invoice totals before any inbound accounting mapping. */
function reconcileParsedInvoice(invoice: ParsedEInvoice): void {
  if (invoice.lines.length === 0) throw new EInvoiceParseError("The e-invoice contains no invoice lines (BG-25).", "BG-25");
  if (invoice.vatBreakdown.length === 0) throw new EInvoiceParseError("The e-invoice contains no VAT breakdown (BG-23).", "BG-23");
  const t = invoice.totals;
  const equal = (actual: string, expected: string, term: string) => {
    if (compare(actual, expected) !== 0) throw new EInvoiceParseError(`The e-invoice ${term} amount ${actual} does not reconcile with ${expected}.`, term);
  };
  equal(t.lineNet, sum(invoice.lines.map((line) => line.netAmount)), "BT-106");
  equal(t.allowances, sum(invoice.allowanceCharges.filter((entry) => !entry.isCharge).map((entry) => entry.amount)), "BT-107");
  equal(t.charges, sum(invoice.allowanceCharges.filter((entry) => entry.isCharge).map((entry) => entry.amount)), "BT-108");
  equal(t.taxExclusive, add(add(t.lineNet, neg(t.allowances)), t.charges), "BT-109");
  equal(t.tax, sum(invoice.vatBreakdown.map((group) => group.taxAmount)), "BT-110");
  equal(t.taxInclusive, add(t.taxExclusive, t.tax), "BT-112");
  equal(t.payable, add(add(t.taxInclusive, neg(t.prepaid)), t.rounding), "BT-115");
  const lineIds = new Set<string>();
  for (const line of invoice.lines) {
    if (lineIds.has(line.id)) throw new EInvoiceParseError(`The e-invoice repeats line identifier ${line.id}.`, "BT-126");
    lineIds.add(line.id);
    if (compare(line.netPrice, "0") < 0) throw new EInvoiceParseError("An invoice net price must not be negative.", "BT-146");
    if (line.baseQuantity !== null && compare(line.baseQuantity, "0") <= 0) throw new EInvoiceParseError("An invoice price base quantity must be positive.", "BT-149");
  }
}

// ---------------------------------------------------------------------------
// UBL
// ---------------------------------------------------------------------------

function ublAddress(node: Node | null): ParsedAddress | null {
  if (!node) return null;
  return {
    line1: text(node, "StreetName"),
    line2: text(node, "AdditionalStreetName"),
    city: text(node, "CityName"),
    postcode: text(node, "PostalZone"),
    subdivision: text(node, "CountrySubentity"),
    countryCode: text(node, "Country", "IdentificationCode"),
  };
}

function ublParty(root: Node, wrapper: string, role: "seller" | "buyer"): ParsedParty {
  const party = child(root, wrapper, "Party");
  const term = role === "seller" ? "BT-27" : "BT-44";
  const name = mandatory(text(party, "PartyLegalEntity", "RegistrationName") ?? text(party, "PartyName", "Name"), term, `${role} name`);
  const schemes = children(party, "PartyTaxScheme");
  const vat = schemes.find((scheme) => ["VAT", "GST"].includes(text(scheme, "TaxScheme", "ID")?.toUpperCase() ?? ""));
  const other = schemes.find((scheme) => !["VAT", "GST"].includes(text(scheme, "TaxScheme", "ID")?.toUpperCase() ?? ""));
  const legalNode = child(party, "PartyLegalEntity", "CompanyID");
  const endpoint = child(party, "EndpointID");
  return {
    name,
    vatId: text(vat, "CompanyID"),
    taxRegistrationId: text(other, "CompanyID"),
    legalId: textOf(legalNode) ? { id: textOf(legalNode)!, schemeId: attr(legalNode, "schemeID") } : null,
    electronicAddress: textOf(endpoint) ? { id: textOf(endpoint)!, schemeId: attr(endpoint, "schemeID") } : null,
    address: ublAddress(child(party, "PostalAddress")),
  };
}

function parseUbl(root: Node, creditNote: boolean): ParsedEInvoice {
  const issueDate = isoDate(text(root, "IssueDate"), "BT-2", "issue date");
  const typeCode = mandatory(text(root, creditNote ? "CreditNoteTypeCode" : "InvoiceTypeCode"), "BT-3", "invoice type code");
  const currency = mandatory(text(root, "DocumentCurrencyCode"), "BT-5", "invoice currency");
  const means = children(root, "PaymentMeans");
  const account = means.map((entry) => child(entry, "PayeeFinancialAccount")).find(Boolean) ?? null;
  const taxTotals = children(root, "TaxTotal");
  const mainTaxTotal = taxTotals.find((total) => children(total, "TaxSubtotal").length > 0)
    ?? taxTotals.find((total) => (attr(child(total, "TaxAmount"), "currencyID") ?? currency) === currency)
    ?? null;
  const monetary = child(root, "LegalMonetaryTotal");
  const taxScheme = text(children(mainTaxTotal, "TaxSubtotal")[0], "TaxCategory", "TaxScheme", "ID");
  if (taxScheme !== "VAT" && taxScheme !== "GST") throw new EInvoiceParseError("The invoice must state a supported VAT or GST tax scheme.", "BG-23");
  const accountingTotal = (type: string) => text(children(root, "AdditionalDocumentReference").find((entry) => text(entry, "DocumentTypeCode") === type), "DocumentDescription");
  const accountingExclusive = accountingTotal("sgdtotal-excl-gst");
  const accountingInclusive = accountingTotal("sgdtotal-incl-gst");
  const lineName = creditNote ? "CreditNoteLine" : "InvoiceLine";
  const quantityName = creditNote ? "CreditedQuantity" : "InvoicedQuantity";
  const dueDate = text(root, "DueDate") ?? means.map((entry) => text(entry, "PaymentDueDate")).find(Boolean) ?? null;
  if (creditNote !== isCreditNoteTypeCode(typeCode)) throw new EInvoiceParseError("The invoice type code does not agree with the UBL document type.", "BT-3");
  const currencyAmounts = (node: Node | null): void => {
    if (!node) return;
    for (const [name, value] of Object.entries(node)) {
      if (!Array.isArray(value)) continue;
      for (const entry of value as Node[]) {
        if (name.endsWith("Amount") && attr(entry, "currencyID") !== currency) {
          throw new EInvoiceParseError(`The ${name} currency must be the invoice currency ${currency}.`, "BT-5");
        }
        currencyAmounts(entry);
      }
    }
  };
  currencyAmounts(mainTaxTotal);
  currencyAmounts(monetary);
  for (const node of [...children(root, lineName), ...children(root, "AllowanceCharge")]) currencyAmounts(node);

  return {
    syntax: "ubl",
    customizationId: text(root, "CustomizationID"),
    profileId: text(root, "ProfileID"),
    uuid: text(root, "UUID"),
    taxSchemeId: taxScheme,
    accountingCurrencyTotals: accountingExclusive === null && accountingInclusive === null ? null : {
      taxExclusive: amount(accountingExclusive, "BT-109-SG", "SGD total excluding GST"),
      taxInclusive: amount(accountingInclusive, "BT-112-SG", "SGD total including GST"),
    },
    typeCode,
    isCreditNote: creditNote || isCreditNoteTypeCode(typeCode),
    number: mandatory(text(root, "ID"), "BT-1", "invoice number"),
    issueDate,
    dueDate: dueDate === null ? null : isoDate(dueDate, "BT-9", "payment due date"),
    currency,
    seller: ublParty(root, "AccountingSupplierParty", "seller"),
    buyer: ublParty(root, "AccountingCustomerParty", "buyer"),
    buyerReference: text(root, "BuyerReference"),
    orderReference: text(root, "OrderReference", "ID"),
    paymentAccount: text(account, "ID")
      ? { id: text(account, "ID")!, name: text(account, "Name"), bic: text(account, "FinancialInstitutionBranch", "ID") }
      : null,
    paymentTerms: text(root, "PaymentTerms", "Note"),
    totals: {
      lineNet: amount(text(monetary, "LineExtensionAmount"), "BT-106", "sum of line net amounts"),
      taxExclusive: amount(text(monetary, "TaxExclusiveAmount"), "BT-109", "total without VAT"),
      allowances: optionalAmount(text(monetary, "AllowanceTotalAmount"), "BT-107", "allowance total"),
      charges: optionalAmount(text(monetary, "ChargeTotalAmount"), "BT-108", "charge total"),
      rounding: optionalAmount(text(monetary, "PayableRoundingAmount"), "BT-114", "rounding amount"),
      tax: amount(text(mainTaxTotal, "TaxAmount"), "BT-110", "VAT total"),
      taxInclusive: amount(text(monetary, "TaxInclusiveAmount"), "BT-112", "total with VAT"),
      prepaid: optionalAmount(text(monetary, "PrepaidAmount"), "BT-113", "paid amount"),
      payable: amount(text(monetary, "PayableAmount"), "BT-115", "amount due"),
    },
    allowanceCharges: children(root, "AllowanceCharge").map((entry) => {
      const indicator = mandatory(text(entry, "ChargeIndicator"), "BG-20", "allowance or charge indicator");
      if (!["true", "false", "1", "0"].includes(indicator)) throw new EInvoiceParseError("The allowance or charge indicator is not an XML boolean.");
      return { isCharge: indicator === "true" || indicator === "1", amount: amount(text(entry, "Amount"), "BT-92", "allowance or charge amount"), vatCategory: mandatory(text(entry, "TaxCategory", "ID"), "BT-95", "allowance or charge VAT category"), vatRate: optionalRate(text(entry, "TaxCategory", "Percent"), "BT-96", "allowance or charge VAT rate") };
    }),
    lines: children(root, lineName).map((line, index): ParsedLine => {
      const where = `line ${index + 1}`;
      const quantity = child(line, quantityName);
      const category = child(line, "Item", "ClassifiedTaxCategory");
      return {
        id: mandatory(text(line, "ID"), "BT-126", `${where} identifier`),
        name: mandatory(text(line, "Item", "Name"), "BT-153", `${where} item name`),
        description: text(line, "Item", "Description"),
        quantity: decimal(textOf(quantity), "BT-129", `${where} quantity`),
        unitCode: attr(quantity, "unitCode"),
        netPrice: decimal(text(line, "Price", "PriceAmount"), "BT-146", `${where} net price`),
        baseQuantity: optionalRate(text(line, "Price", "BaseQuantity"), "BT-149", `${where} price base quantity`),
        netAmount: amount(text(line, "LineExtensionAmount"), "BT-131", `${where} net amount`),
        vatCategory: mandatory(text(category, "ID"), "BT-151", `${where} VAT category`),
        vatRate: optionalRate(text(category, "Percent"), "BT-152", `${where} VAT rate`),
        sellerItemId: text(line, "Item", "SellersItemIdentification", "ID"),
      };
    }),
    vatBreakdown: children(mainTaxTotal, "TaxSubtotal").map((group): ParsedVatBreakdown => {
      const category = child(group, "TaxCategory");
      if (text(category, "TaxScheme", "ID") !== taxScheme) throw new EInvoiceParseError("The invoice mixes VAT and GST tax schemes.", "BG-23");
      return {
        category: mandatory(text(category, "ID"), "BT-118", "VAT breakdown category"),
        rate: optionalRate(text(category, "Percent"), "BT-119", "VAT breakdown rate"),
        taxableAmount: amount(text(group, "TaxableAmount"), "BT-116", "VAT category taxable amount"),
        taxAmount: amount(text(group, "TaxAmount"), "BT-117", "VAT category tax amount"),
        exemptionReason: text(category, "TaxExemptionReason"),
        exemptionReasonCode: text(category, "TaxExemptionReasonCode"),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// CII
// ---------------------------------------------------------------------------

function ciiAddress(node: Node | null): ParsedAddress | null {
  if (!node) return null;
  return {
    line1: text(node, "LineOne"),
    line2: text(node, "LineTwo"),
    city: text(node, "CityName"),
    postcode: text(node, "PostcodeCode"),
    subdivision: text(node, "CountrySubDivisionName"),
    countryCode: text(node, "CountryID"),
  };
}

function ciiParty(agreement: Node | null, name: string, role: "seller" | "buyer"): ParsedParty {
  const party = child(agreement, name);
  const registrations = children(party, "SpecifiedTaxRegistration").map((entry) => child(entry, "ID"));
  const byScheme = (scheme: string) => textOf(registrations.find((id) => attr(id, "schemeID") === scheme));
  const legalNode = child(party, "SpecifiedLegalOrganization", "ID");
  const endpoint = child(party, "URIUniversalCommunication", "URIID");
  return {
    name: mandatory(text(party, "Name"), role === "seller" ? "BT-27" : "BT-44", `${role} name`),
    vatId: byScheme("VA"),
    taxRegistrationId: byScheme("FC"),
    legalId: textOf(legalNode) ? { id: textOf(legalNode)!, schemeId: attr(legalNode, "schemeID") } : null,
    electronicAddress: textOf(endpoint) ? { id: textOf(endpoint)!, schemeId: attr(endpoint, "schemeID") } : null,
    address: ciiAddress(child(party, "PostalTradeAddress")),
  };
}

function parseCii(root: Node): ParsedEInvoice {
  const context = child(root, "ExchangedDocumentContext");
  const document = child(root, "ExchangedDocument");
  const transaction = child(root, "SupplyChainTradeTransaction");
  const agreement = child(transaction, "ApplicableHeaderTradeAgreement");
  const settlement = child(transaction, "ApplicableHeaderTradeSettlement");
  const summation = child(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");
  const currency = mandatory(text(settlement, "InvoiceCurrencyCode"), "BT-5", "invoice currency");
  const typeCode = mandatory(text(document, "TypeCode"), "BT-3", "invoice type code");
  const means = children(settlement, "SpecifiedTradeSettlementPaymentMeans");
  const account = means.map((entry) => child(entry, "PayeePartyCreditorFinancialAccount")).find(Boolean) ?? null;
  const accountMeans = means.find((entry) => child(entry, "PayeePartyCreditorFinancialAccount")) ?? null;
  const accountId = text(account, "IBANID") ?? text(account, "ProprietaryID");
  const terms = children(settlement, "SpecifiedTradePaymentTerms");
  const dueDateNode = terms.map((entry) => child(entry, "DueDateDateTime")).find(Boolean) ?? null;
  const taxTotal = children(summation, "TaxTotalAmount").find((node) => (attr(node, "currencyID") ?? currency) === currency) ?? null;
  const termsText = terms.map((entry) => text(entry, "Description")).filter((value): value is string => value !== null);

  return {
    syntax: "cii",
    customizationId: text(context, "GuidelineSpecifiedDocumentContextParameter", "ID"),
    profileId: text(context, "BusinessProcessSpecifiedDocumentContextParameter", "ID"),
    uuid: null,
    taxSchemeId: "VAT",
    accountingCurrencyTotals: null,
    typeCode,
    isCreditNote: isCreditNoteTypeCode(typeCode),
    number: mandatory(text(document, "ID"), "BT-1", "invoice number"),
    issueDate: mandatory(ciiDate(child(document, "IssueDateTime"), "BT-2", "issue date"), "BT-2", "issue date"),
    dueDate: ciiDate(dueDateNode, "BT-9", "payment due date"),
    currency,
    seller: ciiParty(agreement, "SellerTradeParty", "seller"),
    buyer: ciiParty(agreement, "BuyerTradeParty", "buyer"),
    buyerReference: text(agreement, "BuyerReference"),
    orderReference: text(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"),
    paymentAccount: accountId
      ? { id: accountId, name: text(account, "AccountName"), bic: text(accountMeans, "PayeeSpecifiedCreditorFinancialInstitution", "BICID") }
      : null,
    paymentTerms: termsText.length > 0 ? termsText.join("\n") : null,
    totals: {
      lineNet: amount(text(summation, "LineTotalAmount"), "BT-106", "sum of line net amounts"),
      taxExclusive: amount(text(summation, "TaxBasisTotalAmount"), "BT-109", "total without VAT"),
      allowances: optionalAmount(text(summation, "AllowanceTotalAmount"), "BT-107", "allowance total"),
      charges: optionalAmount(text(summation, "ChargeTotalAmount"), "BT-108", "charge total"),
      rounding: optionalAmount(text(summation, "RoundingAmount"), "BT-114", "rounding amount"),
      tax: amount(textOf(taxTotal), "BT-110", "VAT total"),
      taxInclusive: amount(text(summation, "GrandTotalAmount"), "BT-112", "total with VAT"),
      prepaid: optionalAmount(text(summation, "TotalPrepaidAmount"), "BT-113", "paid amount"),
      payable: amount(text(summation, "DuePayableAmount"), "BT-115", "amount due"),
    },
    allowanceCharges: children(settlement, "SpecifiedTradeAllowanceCharge").map((entry) => {
      const indicator = mandatory(text(entry, "ChargeIndicator", "Indicator"), "BG-20", "allowance or charge indicator");
      if (!["true", "false", "1", "0"].includes(indicator)) throw new EInvoiceParseError("The allowance or charge indicator is not an XML boolean.");
      return { isCharge: indicator === "true" || indicator === "1", amount: amount(text(entry, "ActualAmount"), "BT-92", "allowance or charge amount"), vatCategory: mandatory(text(entry, "CategoryTradeTax", "CategoryCode"), "BT-95", "allowance or charge VAT category"), vatRate: optionalRate(text(entry, "CategoryTradeTax", "RateApplicablePercent"), "BT-96", "allowance or charge VAT rate") };
    }),
    lines: children(transaction, "IncludedSupplyChainTradeLineItem").map((line, index): ParsedLine => {
      const where = `line ${index + 1}`;
      const quantity = child(line, "SpecifiedLineTradeDelivery", "BilledQuantity");
      const tax = child(line, "SpecifiedLineTradeSettlement", "ApplicableTradeTax");
      return {
        id: mandatory(text(line, "AssociatedDocumentLineDocument", "LineID"), "BT-126", `${where} identifier`),
        name: mandatory(text(line, "SpecifiedTradeProduct", "Name"), "BT-153", `${where} item name`),
        description: text(line, "SpecifiedTradeProduct", "Description"),
        quantity: decimal(textOf(quantity), "BT-129", `${where} quantity`),
        unitCode: attr(quantity, "unitCode"),
        netPrice: decimal(text(line, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice", "ChargeAmount"), "BT-146", `${where} net price`),
        baseQuantity: optionalRate(text(line, "SpecifiedLineTradeAgreement", "NetPriceProductTradePrice", "BasisQuantity"), "BT-149", `${where} price base quantity`),
        netAmount: amount(
          text(line, "SpecifiedLineTradeSettlement", "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount"),
          "BT-131",
          `${where} net amount`,
        ),
        vatCategory: mandatory(text(tax, "CategoryCode"), "BT-151", `${where} VAT category`),
        vatRate: optionalRate(text(tax, "RateApplicablePercent"), "BT-152", `${where} VAT rate`),
        sellerItemId: text(line, "SpecifiedTradeProduct", "SellerAssignedID"),
      };
    }),
    vatBreakdown: children(settlement, "ApplicableTradeTax").map((group): ParsedVatBreakdown => ({
      category: mandatory(text(group, "CategoryCode"), "BT-118", "VAT breakdown category"),
      rate: optionalRate(text(group, "RateApplicablePercent"), "BT-119", "VAT breakdown rate"),
      taxableAmount: amount(text(group, "BasisAmount"), "BT-116", "VAT category taxable amount"),
      taxAmount: amount(text(group, "CalculatedAmount"), "BT-117", "VAT category tax amount"),
      exemptionReason: text(group, "ExemptionReason"),
      exemptionReasonCode: text(group, "ExemptionReasonCode"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Hybrid PDF extraction
// ---------------------------------------------------------------------------

const EMBEDDED_INVOICE_NAMES: ReadonlySet<string> = new Set([
  "factur-x.xml",
  "zugferd-invoice.xml",
  "xrechnung.xml",
]);

function stringValue(value: PDFObject | undefined): string | null {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : null;
}

function* nameTreeEntries(doc: PDFDocument, node: PDFDict, depth = 0): Generator<[string, PDFDict]> {
  if (depth > 32) throw new EInvoiceParseError("The PDF embedded-file name tree exceeds the nesting limit.");
  const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names) {
    for (let index = 0; index + 1 < names.size(); index += 2) {
      const key = stringValue(names.lookup(index));
      const spec = doc.context.lookupMaybe(names.get(index + 1), PDFDict);
      if (key !== null && spec) yield [key, spec];
    }
  }
  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
  for (const kid of kids?.asArray() ?? []) {
    const dict = doc.context.lookupMaybe(kid, PDFDict);
    if (dict) yield* nameTreeEntries(doc, dict, depth + 1);
  }
}

/**
 * Find the invoice XML embedded in a hybrid PDF (Factur-X, ZUGFeRD or
 * XRechnung attachment), by name, case-insensitively. Returns null when the
 * PDF carries none.
 */
export async function extractEmbeddedInvoiceXml(pdf: Uint8Array): Promise<{ fileName: string; xml: string } | null> {
  if (pdf.length > MAX_EINVOICE_PDF_BYTES) throw new EInvoiceParseError("The invoice PDF exceeds the 50 MB limit.");
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const tree = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const candidates: Array<{ fileName: string; stream: PDFRawStream }> = [];
  const seen = new Set<PDFDict>();
  const entries = tree ? [...nameTreeEntries(doc, tree)] : [];
  const associated = doc.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  for (const ref of associated?.asArray() ?? []) {
    const spec = doc.context.lookupMaybe(ref, PDFDict);
    if (spec) entries.push(["", spec]);
  }
  for (const [key, spec] of entries) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    const fileName = stringValue(spec.lookup(PDFName.of("UF"))) ?? stringValue(spec.lookup(PDFName.of("F"))) ?? key;
    if (!EMBEDDED_INVOICE_NAMES.has(fileName.toLowerCase()) && !EMBEDDED_INVOICE_NAMES.has(key.toLowerCase())) continue;
    const files = spec.lookupMaybe(PDFName.of("EF"), PDFDict);
    const stream = files ? files.lookup(PDFName.of("UF")) ?? files.lookup(PDFName.of("F")) : undefined;
    if (!(stream instanceof PDFRawStream)) throw new EInvoiceParseError(`The embedded invoice ${fileName} has no readable XML stream.`);
    candidates.push({ fileName, stream });
  }
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new EInvoiceParseError("The PDF contains multiple invoice XML attachments; supply one unambiguous invoice.");
  const { fileName, stream } = candidates[0]!;
  const bytes = decodePDFRawStream(stream).getBytes(MAX_EINVOICE_XML_BYTES + 1);
  if (bytes.length > MAX_EINVOICE_XML_BYTES) throw new EInvoiceParseError(`The embedded invoice ${fileName} exceeds the 10 MB limit.`);
  try { return { fileName, xml: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { throw new EInvoiceParseError(`The embedded invoice ${fileName} is not valid UTF-8 XML.`); }
}
