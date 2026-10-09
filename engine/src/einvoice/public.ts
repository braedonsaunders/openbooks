// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.

/**
 * Public surface of the EN 16931 e-invoicing library: the semantic model,
 * profiles, code lists, rule evaluation, XML rendering, hybrid PDF
 * embedding, and inbound parsing.
 */

export type {
  EInvoice,
  EInvoiceAddress,
  EInvoiceAllowanceCharge,
  EInvoiceAmountsInput,
  EInvoiceLine,
  EInvoiceParty,
  EInvoicePayment,
  EInvoiceTotals,
  EInvoiceVatBreakdown,
  VatCategory,
} from "./model.ts";
export { computeEInvoiceAmounts } from "./model.ts";

export type { EInvoiceProfile, EInvoiceProfileKey, EInvoiceRuleSetId, EInvoiceSyntax } from "./profiles.ts";
export {
  EINVOICE_PROFILES,
  EN16931_GUIDELINE,
  PEPPOL_BILLING_PROCESS,
  PEPPOL_BIS_GUIDELINE,
  XRECHNUNG_GUIDELINE,
  getEInvoiceProfile,
  isEInvoiceProfileKey,
} from "./profiles.ts";

export {
  CREDIT_NOTE_TYPE_CODES,
  CREDIT_TRANSFER_MEANS,
  DIRECT_DEBIT_MEANS,
  DOCUMENT_TYPE_LABELS,
  EAS_LABELS,
  INVOICE_TYPE_CODES,
  PAYMENT_CARD_MEANS,
  PAYMENT_MEANS_LABELS,
  PEPPOL_CREDIT_NOTE_TYPE_CODES,
  PEPPOL_INVOICE_TYPE_CODES,
  VATEX_LABELS,
  VAT_CATEGORIES,
  XRECHNUNG_TYPE_CODES,
  isCreditNoteTypeCode,
  isKnownEasScheme,
  isKnownPaymentMeansCode,
  isKnownVatexCode,
  isVatCategory,
  unitCode,
} from "./codes.ts";

export type { EInvoiceFinding, EInvoiceFindingSeverity } from "./rules.ts";
export { EInvoiceRefusal, fatalFindings, validateEInvoice } from "./rules.ts";

export type { RenderedEInvoice } from "./render.ts";
export { renderEInvoiceXml } from "./render.ts";

export type { FacturXMetadata } from "./facturx.ts";
export { FACTURX_ATTACHMENT_NAME, embedFacturX } from "./facturx.ts";

export type { ParsedAddress, ParsedEInvoice, ParsedLine, ParsedParty, ParsedVatBreakdown } from "./parse.ts";
export { EInvoiceParseError, MAX_EINVOICE_XML_BYTES, extractEmbeddedInvoiceXml, parseEInvoiceXml } from "./parse.ts";

export { loadNativeEInvoice, issueNativeEInvoice, EInvoiceConfigurationError } from './service.ts';
export type { EInvoiceActor, EInvoiceIssueOptions, IssuedEInvoice } from './service.ts';

export { validateEInvoiceXmlSchema } from './schema-validation.ts';
