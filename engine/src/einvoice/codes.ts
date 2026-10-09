// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Code lists the EN 16931 model and its validators read: VAT categories
 * (UNTDID 5305 subset), document types (UNTDID 1001), payment means
 * (UNTDID 4461), VAT exemption reasons (CEF VATEX), electronic address
 * schemes (CEF EAS) and units of measure (UNECE Recommendation 20).
 *
 * Labels are English operator-facing names for pickers; validation reads the
 * code sets, never the labels.
 */

import type { VatCategory } from "./model.ts";
import { INVOICE_CODES, CREDITNOTE_CODES, SG_GST_CODES, PAYMENTMEANS_CODES, VATEX_CODES, EAS_CODES, UNIT_CODES } from "./standard-codes.ts";

// ---------------------------------------------------------------------------
// VAT categories (UNTDID 5305, EN 16931 subset)
// ---------------------------------------------------------------------------

/** Every category EN 16931 admits, in display order, with its rule family prefix. */
export const VAT_CATEGORIES: ReadonlyArray<{ code: VatCategory; label: string; rulePrefix: string }> = [
  { code: "S", label: "Standard rate", rulePrefix: "BR-S" },
  { code: "Z", label: "Zero rated goods", rulePrefix: "BR-Z" },
  { code: "E", label: "Exempt from tax", rulePrefix: "BR-E" },
  { code: "AE", label: "VAT reverse charge", rulePrefix: "BR-AE" },
  { code: "K", label: "Intra-community supply (VAT exempt for EEA)", rulePrefix: "BR-IC" },
  { code: "G", label: "Free export item, tax not charged", rulePrefix: "BR-G" },
  { code: "O", label: "Services outside scope of tax", rulePrefix: "BR-O" },
  { code: "L", label: "Canary Islands general indirect tax (IGIC)", rulePrefix: "BR-IG" },
  { code: "M", label: "Tax for production, services and importation in Ceuta and Melilla (IPSI)", rulePrefix: "BR-IP" },
];

export const EINVOICE_TAX_CATEGORIES: ReadonlyArray<{ code: VatCategory; label: string }> = [
  ...VAT_CATEGORIES,
  { code: "SR", label: "Standard-rated GST" },
  { code: "SRCA-S", label: "Customer accounting supply by supplier" },
  { code: "SRCA-C", label: "Customer accounting supply by customer" },
  { code: "ZR", label: "Zero-rated GST" },
  { code: "ES33", label: "GST exemption under regulation 33" },
  { code: "ESN33", label: "Other GST-exempt supply" },
  { code: "DS", label: "Deemed GST supply" },
  { code: "OS", label: "Outside the scope of GST" },
  { code: "NA", label: "Taxable supply without GST charged" },
  { code: "NG", label: "Supply by a company not registered for GST" },
  { code: "SRRC", label: "GST reverse charge on imported services" },
  { code: "SROVR-RS", label: "Remote services under overseas vendor registration" },
  { code: "SROVR-LVG", label: "Low-value goods under overseas vendor registration" },
  { code: "SRLVG", label: "Own supply of low-value goods" },
];

const VAT_CATEGORY_INDEX = new Map(VAT_CATEGORIES.map((entry, index) => [entry.code as string, { ...entry, index }]));

export function isVatCategory(code: string): code is VatCategory {
  return VAT_CATEGORY_INDEX.has(code) || SG_GST_CODES.has(code);
}

/** The rule family prefix (BR-S, BR-IC, ...) for a category, or null for an unknown code. */
export function vatCategoryRulePrefix(code: string): string | null {
  return VAT_CATEGORY_INDEX.get(code)?.rulePrefix ?? null;
}

/** Stable display/document order of a category; unknown codes sort last. */
export function vatCategoryOrder(code: string): number {
  return VAT_CATEGORY_INDEX.get(code)?.index ?? VAT_CATEGORIES.length;
}

/** Categories whose VAT amount is computed from a rate; every other category carries zero VAT. */
export const TAXED_VAT_CATEGORIES: ReadonlySet<VatCategory> = new Set<VatCategory>(["S", "L", "M", "SR", "SRCA-S", "SRCA-C", "DS", "SRRC", "SROVR-RS", "SROVR-LVG", "SRLVG"]);

// ---------------------------------------------------------------------------
// Document type codes (UNTDID 1001)
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  "71": "Request for payment",
  "80": "Debit note related to goods or services",
  "81": "Credit note related to goods or services",
  "82": "Metered services invoice",
  "83": "Credit note related to financial adjustments",
  "84": "Debit note related to financial adjustments",
  "102": "Tax notification",
  "218": "Final payment request based on completion of work",
  "219": "Payment request for completed units",
  "261": "Self billed credit note",
  "262": "Consolidated credit note - goods and services",
  "296": "Credit note for price variation",
  "308": "Delcredere credit note",
  "326": "Partial invoice",
  "331": "Commercial invoice which includes a packing list",
  "380": "Commercial invoice",
  "381": "Credit note",
  "382": "Commission note",
  "383": "Debit note",
  "384": "Corrected invoice",
  "386": "Prepayment invoice",
  "388": "Tax invoice",
  "389": "Self-billed invoice",
  "393": "Factored invoice",
  "395": "Consignment invoice",
  "396": "Factored credit note",
  "420": "Optical Character Reading (OCR) payment credit note",
  "458": "Reverse factoring credit note",
  "532": "Forwarder's credit note",
  "553": "Forwarder's invoice discrepancy report",
  "575": "Insurer's invoice",
  "623": "Forwarder's invoice",
  "780": "Freight invoice",
  "817": "Claim notification",
  "870": "Consular invoice",
  "875": "Partial construction invoice",
  "876": "Partial final construction invoice",
  "877": "Final construction invoice",
  "935": "Customs invoice",
};

/** EN 16931 invoice-class type codes (BR-CL-01). */
export const INVOICE_TYPE_CODES: readonly string[] = [...INVOICE_CODES];

/** EN 16931 credit-note-class type codes; UBL renders these as a CreditNote document. */
export const CREDIT_NOTE_TYPE_CODES: readonly string[] = [...CREDITNOTE_CODES];

/** Corrective and self-billing codes national specifications admit beside the EN 16931 classes. */
export const SUPPLEMENTARY_INVOICE_TYPE_CODES: readonly string[] = ["384", "389"];

export const XRECHNUNG_TYPE_CODES: readonly string[] = ["326", "380", "384", "389", "381", "875", "876", "877"];

export const PEPPOL_INVOICE_TYPE_CODES: readonly string[] = [
  "71", "80", "82", "84", "102", "218", "219", "326", "331", "380", "382", "383", "386", "388", "393", "395",
  "553", "575", "623", "780", "817", "870", "875", "876", "877",
];

export const PEPPOL_CREDIT_NOTE_TYPE_CODES: readonly string[] = ["81", "83", "381", "396", "532"];

const CREDIT_NOTE_SET = new Set(CREDIT_NOTE_TYPE_CODES);

export function isCreditNoteTypeCode(code: string): boolean {
  return CREDIT_NOTE_SET.has(code.trim());
}

// ---------------------------------------------------------------------------
// Payment means (UNTDID 4461)
// ---------------------------------------------------------------------------

const PAYMENT_MEANS_CODES = PAYMENTMEANS_CODES;

/** Labels for the payment means an operator commonly chooses; every UNTDID 4461 code is accepted. */
export const PAYMENT_MEANS_LABELS: Readonly<Record<string, string>> = {
  "1": "Instrument not defined",
  "10": "In cash",
  "20": "Cheque",
  "30": "Credit transfer",
  "31": "Debit transfer",
  "42": "Payment to bank account",
  "48": "Bank card",
  "49": "Direct debit",
  "54": "Credit card",
  "55": "Debit card",
  "57": "Standing agreement",
  "58": "SEPA credit transfer",
  "59": "SEPA direct debit",
  "68": "Online payment service",
  "97": "Clearing between partners",
  "ZZZ": "Mutually defined",
};

export const CREDIT_TRANSFER_MEANS: ReadonlySet<string> = new Set(["30", "58"]);
export const PAYMENT_CARD_MEANS: ReadonlySet<string> = new Set(["48", "54", "55"]);
export const DIRECT_DEBIT_MEANS: ReadonlySet<string> = new Set(["59", "49"]);

export function isKnownPaymentMeansCode(code: string): boolean {
  return PAYMENT_MEANS_CODES.has(code.trim());
}

// ---------------------------------------------------------------------------
// VAT exemption reasons (CEF VATEX)
// ---------------------------------------------------------------------------

const DIRECTIVE = "Council Directive 2006/112/EC";

const article132Points = "ABCDEFGHIJKLMNOPQ".split("");
const article143Points = ["A", "B", "C", "D", "E", "F", "FA", "G", "H", "I", "J", "K", "L"];
const article148Points = ["A", "B", "C", "D", "E", "F", "G"];
const article151Points = ["A", "AA", "B", "C", "D", "E"];

export const VATEX_LABELS: Readonly<Record<string, string>> = {
  "VATEX-EU-79-C": `Exempt based on article 79, point c of ${DIRECTIVE}`,
  "VATEX-EU-132": `Exempt based on article 132 of ${DIRECTIVE}`,
  ...Object.fromEntries(article132Points.map((point) => [
    `VATEX-EU-132-1${point}`,
    `Exempt based on article 132, section 1 (${point.toLowerCase()}) of ${DIRECTIVE}`,
  ])),
  "VATEX-EU-143": `Exempt based on article 143 of ${DIRECTIVE}`,
  ...Object.fromEntries(article143Points.map((point) => [
    `VATEX-EU-143-1${point}`,
    `Exempt based on article 143, section 1 (${point.toLowerCase()}) of ${DIRECTIVE}`,
  ])),
  "VATEX-EU-148": `Exempt based on article 148 of ${DIRECTIVE}`,
  ...Object.fromEntries(article148Points.map((point) => [
    `VATEX-EU-148-${point}`,
    `Exempt based on article 148, section (${point.toLowerCase()}) of ${DIRECTIVE}`,
  ])),
  "VATEX-EU-151": `Exempt based on article 151 of ${DIRECTIVE}`,
  ...Object.fromEntries(article151Points.map((point) => [
    `VATEX-EU-151-1${point}`,
    `Exempt based on article 151, section 1 (${point.toLowerCase()}) of ${DIRECTIVE}`,
  ])),
  "VATEX-EU-309": `Exempt based on article 309 of ${DIRECTIVE}`,
  "VATEX-EU-AE": "Reverse charge",
  "VATEX-EU-D": "Intra-Community acquisition from second hand means of transport",
  "VATEX-EU-F": "Intra-Community acquisition of second hand goods",
  "VATEX-EU-G": "Export outside the EU",
  "VATEX-EU-I": "Intra-Community acquisition of works of art",
  "VATEX-EU-IC": "Intra-Community supply",
  "VATEX-EU-J": "Intra-Community acquisition of collectors items and antiques",
  "VATEX-EU-O": "Not subject to VAT",
  "VATEX-FR-FRANCHISE": "France domestic VAT franchise in base",
  "VATEX-FR-CNWVAT": "France domestic credit notes without VAT, due to supplier forfeit of VAT for discount",
};

export function isKnownVatexCode(code: string): boolean {
  return VATEX_CODES.has(code.trim());
}

// ---------------------------------------------------------------------------
// Electronic address schemes (CEF EAS)
// ---------------------------------------------------------------------------

const VAT_NUMBER_SCHEMES: ReadonlyArray<[string, string]> = [
  ["9922", "Andorra"], ["9923", "Albania"], ["9924", "Bosnia and Herzegovina"], ["9925", "Belgium"],
  ["9926", "Bulgaria"], ["9927", "Switzerland"], ["9928", "Cyprus"], ["9929", "Czech Republic"],
  ["9930", "Germany"], ["9931", "Estonia"], ["9932", "United Kingdom"], ["9933", "Greece"],
  ["9934", "Croatia"], ["9935", "Ireland"], ["9936", "Liechtenstein"], ["9937", "Lithuania"],
  ["9938", "Luxembourg"], ["9939", "Latvia"], ["9940", "Monaco"], ["9941", "Montenegro"],
  ["9942", "North Macedonia"], ["9943", "Malta"], ["9944", "Netherlands"], ["9945", "Poland"],
  ["9946", "Portugal"], ["9947", "Romania"], ["9948", "Serbia"], ["9949", "Slovenia"],
  ["9950", "Slovakia"], ["9951", "San Marino"], ["9952", "Turkey"], ["9953", "Holy See (Vatican City State)"],
];

export const EAS_LABELS: Readonly<Record<string, string>> = {
  EM: "Electronic mail (SMTP)",
  "0002": "SIRENE (France)",
  "0007": "Organisationsnummer (Sweden)",
  "0009": "SIRET (France)",
  "0037": "LY-tunnus (Finland)",
  "0060": "Data Universal Numbering System (D-U-N-S)",
  "0088": "Global Location Number (GLN)",
  "0096": "Danish Business Authority P-number",
  "0097": "FTI - Ediforum Italia",
  "0106": "Chamber of Commerce number (KvK, Netherlands)",
  "0130": "Directorates of the European Commission",
  "0135": "SIA object identifiers",
  "0142": "SECETI object identifiers",
  "0151": "Australian Business Number (ABN)",
  "0183": "Swiss Unique Business Identification Number (UIDB)",
  "0184": "DIGSTORG (Denmark)",
  "0188": "Corporate Number of the National Tax Agency (Japan)",
  "0190": "Dutch Originator's Identification Number (OIN)",
  "0191": "Centre of Registers and Information Systems (Estonia)",
  "0192": "Enhetsregisteret (Norway)",
  "0193": "UBL.BE party identifier",
  "0195": "Singapore UEN identifier",
  "0196": "Kennitala (Iceland)",
  "0198": "ERSTORG (Denmark)",
  "0199": "Legal Entity Identifier (LEI)",
  "0200": "Legal entity code (Lithuania)",
  "0201": "Codice Univoco Unità Organizzativa iPA (Italy)",
  "0202": "Indirizzo di Posta Elettronica Certificata (Italy)",
  "0204": "Leitweg-ID (Germany)",
  "0208": "Enterprise number (Belgium)",
  "0209": "GS1 identification keys",
  "0210": "Codice Fiscale (Italy)",
  "0211": "Partita IVA (Italy)",
  "0212": "Finnish Organization Identifier",
  "0213": "Finnish Organization Value Add Tax Identifier",
  "0215": "Net service ID (Finland)",
  "0216": "OVTcode (Finland)",
  "0218": "Unified registration number (Latvia)",
  "0221": "Registered number of the qualified invoice issuer (Japan)",
  "0230": "National e-Invoicing Framework (Malaysia)",
  "9910": "Hungary VAT number",
  "9913": "Business Registers Network",
  "9914": "Austria VAT number (UID)",
  "9915": "Austrian administration and organisation identifier",
  "9918": "SWIFT / BIC",
  "9919": "Kennziffer des Unternehmensregisters (Austria)",
  "9920": "Agencia Española de Administración Tributaria",
  ...Object.fromEntries(VAT_NUMBER_SCHEMES.map(([code, country]) => [code, `${country} VAT number`])),
  "9957": "France VAT number",
  "9959": "Employer Identification Number (EIN, USA)",
};

export function isKnownEasScheme(code: string): boolean {
  return EAS_CODES.has(code.trim());
}

// ---------------------------------------------------------------------------
// Units of measure (UNECE Recommendation 20)
// ---------------------------------------------------------------------------

const UNIT_LABELS: Readonly<Record<string, string>> = {
  each: "EA",
  ea: "EA",
  pcs: "H87",
  hr: "HUR",
  hour: "HUR",
  h: "HUR",
  day: "DAY",
  d: "DAY",
  week: "WEE",
  month: "MON",
  mo: "MON",
  m: "MTR",
  m2: "MTK",
  sqm: "MTK",
  m3: "MTQ",
  l: "LTR",
  kg: "KGM",
  t: "TNE",
  ton: "TNE",
  lb: "LBR",
  ft: "FOT",
  sqft: "FTK",
  yd: "YRD",
  lot: "LO",
  ls: "LS",
  "lump sum": "LS",
  "%": "P1",
  set: "SET",
  box: "BX",
  kwh: "KWH",
  km: "KMT",
};

/** Shape of a Recommendation 20 / 21 code a receiver can check against its list. */
export const UNIT_CODE_SHAPE = /^[A-Z0-9]{2,3}$/;

/**
 * Map a unit label to its UNECE Recommendation 20 code. A recognised label
 * maps case-insensitively; a value already written as a Rec 20 code passes
 * through. Anything else returns null, never a silent "one" (C62): an
 * invoice that misstates its unit misstates its quantity, so the caller
 * refuses instead.
 */
export function unitCode(label: string): string | null {
  const trimmed = label.trim();
  const mapped = UNIT_LABELS[trimmed.toLowerCase().replace(/\s+/g, " ")];
  if (mapped) return mapped;
  return UNIT_CODES.has(trimmed) ? trimmed : null;
}
