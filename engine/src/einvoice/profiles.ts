// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * E-invoice profiles: one EN 16931 semantic model bound to a syntax, the
 * specification identifier a receiver dispatches on (BT-24), the business
 * process (BT-23) and the rule sets the document must satisfy.
 *
 * Everything that differs between specifications is declared here as data.
 * The rule evaluator branches only on the rule-set ids a profile lists, and
 * national rule sets are keyed by the seller's country, so no generic code
 * ever compares against a literal country code.
 */

import { PINT_INVOICE_CODES, PINT_CREDITNOTE_CODES, SG_GST_CODES } from "./standard-codes.ts";
import {
  CREDIT_NOTE_TYPE_CODES,
  INVOICE_TYPE_CODES,
  PEPPOL_CREDIT_NOTE_TYPE_CODES,
  PEPPOL_INVOICE_TYPE_CODES,
  SUPPLEMENTARY_INVOICE_TYPE_CODES,
  XRECHNUNG_TYPE_CODES,
} from "./codes.ts";

export type EInvoiceProfileKey =
  | "en16931-cii"
  | "en16931-ubl"
  | "xrechnung-cii"
  | "xrechnung-ubl"
  | "facturx"
  | "peppol-bis"
  | "nlcius" | "ehf" | "peppol-aunz" | "peppol-sg" | "pint-aunz" | "pint-sg";

export type EInvoiceSyntax = "cii" | "ubl";

/** Rule families the evaluator knows. A profile lists the ones its documents must satisfy. */
export type EInvoiceRuleSetId = "en16931" | "xrechnung" | "peppol" | "peppol-nl" | "nlcius" | "norway" | "gst-shared" | "aunz" | "sg" | "house";

export interface EInvoiceProfile {
  key: EInvoiceProfileKey;
  syntax: EInvoiceSyntax;
  taxSchemeId: "VAT" | "GST";
  taxCategories: readonly string[];
  specificationVersion: string;
  label: string;
  /** BT-24 specification identifier. */
  guidelineId: string;
  /** BT-23 business process type, or null when the specification defines none. */
  businessProcessId: string | null;
  /** True when the XML travels inside a PDF/A-3 container (Factur-X / ZUGFeRD). */
  hybridPdf: boolean;
  /** Embedded attachment name and XMP conformance level, for hybrid profiles only. */
  hybrid: { attachmentFileName: string; conformanceLevel: "EN 16931" } | null;
  /** BT-10 must be present. */
  buyerReferenceRequired: boolean;
  /** An order reference (BT-13) satisfies the buyer-reference requirement. */
  orderReferenceSatisfiesBuyerReference: boolean;
  /** Seller and buyer electronic addresses (BT-34, BT-49) are mandatory. */
  electronicAddressesRequired: boolean;
  /** BT-3 codes the specification admits. */
  allowedTypeCodes: readonly string[];
  ruleSets: readonly EInvoiceRuleSetId[];
  /** National rule sets, keyed by seller country (BT-40). */
  nationalRuleSets: Readonly<Record<string, EInvoiceRuleSetId>>;
}

export const EN16931_GUIDELINE = "urn:cen.eu:en16931:2017";
export const XRECHNUNG_GUIDELINE = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";
export const PEPPOL_BIS_GUIDELINE = "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
export const PEPPOL_BILLING_PROCESS = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

const EN16931_TYPE_CODES: readonly string[] = [
  ...INVOICE_TYPE_CODES,
  ...SUPPLEMENTARY_INVOICE_TYPE_CODES,
  ...CREDIT_NOTE_TYPE_CODES,
];

const en16931Base = {
  taxSchemeId: "VAT",
  taxCategories: ["S", "Z", "E", "AE", "K", "G", "O", "L", "M"],
  specificationVersion: "EN 16931 validation 1.3.16",
  guidelineId: EN16931_GUIDELINE,
  businessProcessId: null,
  hybridPdf: false,
  hybrid: null,
  buyerReferenceRequired: false,
  orderReferenceSatisfiesBuyerReference: false,
  electronicAddressesRequired: false,
  allowedTypeCodes: EN16931_TYPE_CODES,
  ruleSets: ["en16931", "house"],
  nationalRuleSets: {},
} as const satisfies Partial<EInvoiceProfile>;

const xrechnungBase = {
  taxSchemeId: "VAT",
  taxCategories: en16931Base.taxCategories,
  specificationVersion: "XRechnung 3.0.2 / 2026-08-31",
  guidelineId: XRECHNUNG_GUIDELINE,
  // XRechnung 3.0 makes BT-23 mandatory in both syntaxes.
  businessProcessId: PEPPOL_BILLING_PROCESS,
  hybridPdf: false,
  hybrid: null,
  buyerReferenceRequired: true,
  orderReferenceSatisfiesBuyerReference: false,
  electronicAddressesRequired: true,
  allowedTypeCodes: XRECHNUNG_TYPE_CODES,
  ruleSets: ["en16931", "xrechnung", "house"],
  nationalRuleSets: {},
} as const satisfies Partial<EInvoiceProfile>;

export const SG_GST_CATEGORIES = [...SG_GST_CODES];

function gstProfile(key: EInvoiceProfileKey, label: string, specificationVersion: string, guidelineId: string, businessProcessId: string, rules: "aunz" | "sg"): EInvoiceProfile {
  return {
    ...en16931Base, key, syntax: "ubl", label, specificationVersion, guidelineId, businessProcessId,
    taxSchemeId: "GST", taxCategories: rules === "sg" ? SG_GST_CATEGORIES : ["S", "Z", "E", "G", "O"],
    buyerReferenceRequired: true, orderReferenceSatisfiesBuyerReference: true, electronicAddressesRequired: true,
    allowedTypeCodes: [...PINT_INVOICE_CODES, ...PINT_CREDITNOTE_CODES],
    ruleSets: ["gst-shared", rules, "house"],
  };
}

export const EINVOICE_PROFILES: Readonly<Record<EInvoiceProfileKey, EInvoiceProfile>> = {
  "en16931-cii": { key: "en16931-cii", syntax: "cii", label: "EN 16931 (CII)", ...en16931Base },
  "en16931-ubl": { key: "en16931-ubl", syntax: "ubl", label: "EN 16931 (UBL)", ...en16931Base },
  "xrechnung-cii": { key: "xrechnung-cii", syntax: "cii", label: "XRechnung 3.0 (CII)", ...xrechnungBase },
  "xrechnung-ubl": { key: "xrechnung-ubl", syntax: "ubl", label: "XRechnung 3.0 (UBL)", ...xrechnungBase },
  facturx: {
    key: "facturx",
    syntax: "cii",
    label: "Factur-X / ZUGFeRD (EN 16931)",
    ...en16931Base,
    hybridPdf: true,
    hybrid: { attachmentFileName: "factur-x.xml", conformanceLevel: "EN 16931" },
  },
  "peppol-bis": {
    key: "peppol-bis",
    taxSchemeId: "VAT",
    taxCategories: en16931Base.taxCategories,
    specificationVersion: "Peppol BIS Billing 3.0 / May 2026",
    syntax: "ubl",
    label: "Peppol BIS Billing 3.0",
    guidelineId: PEPPOL_BIS_GUIDELINE,
    businessProcessId: PEPPOL_BILLING_PROCESS,
    hybridPdf: false,
    hybrid: null,
    buyerReferenceRequired: true,
    orderReferenceSatisfiesBuyerReference: true,
    electronicAddressesRequired: true,
    allowedTypeCodes: [...PEPPOL_INVOICE_TYPE_CODES, ...PEPPOL_CREDIT_NOTE_TYPE_CODES],
    ruleSets: ["en16931", "peppol", "house"],
    nationalRuleSets: { NL: "peppol-nl", NO: "norway" },
  },
  nlcius: {
    key: "nlcius", syntax: "ubl", label: "NLCIUS 1.0 (SI-UBL 2.0.3.13)", ...en16931Base,
    specificationVersion: "SI-UBL 2.0.3.13 / 2026-05-21",
    guidelineId: "urn:cen.eu:en16931:2017#compliant#urn:fdc:nen.nl:nlcius:v1.0",
    businessProcessId: PEPPOL_BILLING_PROCESS,
    ruleSets: ["en16931", "nlcius", "house"],
  },
  ehf: {
    key: "ehf", syntax: "ubl", label: "EHF Billing 3.0 (May 2026)", ...en16931Base,
    specificationVersion: "Peppol BIS Billing 3.0 / May 2026",
    guidelineId: PEPPOL_BIS_GUIDELINE, businessProcessId: PEPPOL_BILLING_PROCESS,
    buyerReferenceRequired: true, orderReferenceSatisfiesBuyerReference: true, electronicAddressesRequired: true,
    allowedTypeCodes: [...PEPPOL_INVOICE_TYPE_CODES, ...PEPPOL_CREDIT_NOTE_TYPE_CODES],
    ruleSets: ["en16931", "peppol", "house"], nationalRuleSets: { NO: "norway" },
  },
  "peppol-aunz": gstProfile("peppol-aunz", "A-NZ BIS Billing 3.0 (legacy 1.0.12)", "BIS A-NZ 1.0.12", "urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:aunz:3.0", PEPPOL_BILLING_PROCESS, "aunz"),
  "peppol-sg": gstProfile("peppol-sg", "Singapore BIS Billing 3.0 (legacy)", "Singapore BIS Billing 3.0", "urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:sg:3.0", PEPPOL_BILLING_PROCESS, "sg"),
  "pint-aunz": gstProfile("pint-aunz", "PINT A-NZ Billing 1.1.3", "PINT A-NZ 1.1.3 / 2026-05-21", "urn:peppol:pint:billing-1@aunz-1", "urn:peppol:bis:billing", "aunz"),
  "pint-sg": gstProfile("pint-sg", "PINT Singapore Billing 1.4.1", "PINT SG 1.4.1 / 2026-05-25", "urn:peppol:pint:billing-1@sg-1", "urn:peppol:bis:billing", "sg"),

};

export function isEInvoiceProfileKey(key: string): key is EInvoiceProfileKey {
  return Object.hasOwn(EINVOICE_PROFILES, key);
}

/** The profile for a key, or null when the key names no profile. */
export function getEInvoiceProfile(key: string): EInvoiceProfile | null {
  return isEInvoiceProfileKey(key) ? EINVOICE_PROFILES[key] : null;
}
