/**
 * An explicit exchange rate records the rate a document is measured at in
 * its legal entity's functional currency, with where it came from and why.
 * The generic document editor accepts one only on customer invoices, vendor
 * bills and their credit memos (a credit can then be measured at the rate of
 * the receivable or payable it settles); the native payment editor accepts
 * one only on customer and
 * vendor payments. Posting accepts the union, so every editor's recorded
 * rate is honoured by the same stamping path; every other kind is measured
 * at the organization's exchange rates. The sets carry no dependencies, so
 * document forms offer a foreign currency on exactly the kinds the editor
 * accepts an explicit rate for.
 */
export const EXPLICIT_FX_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "customer_invoice",
  "vendor_bill",
  "customer_credit",
  "vendor_credit",
]);

/** Kinds whose native payment editor may record an explicit settlement rate. */
export const PAYMENT_FX_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "customer_payment",
  "vendor_payment",
]);

/** Kinds whose recorded explicit rate posting must honour and validate. */
export const POSTING_FX_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  ...EXPLICIT_FX_DOCUMENT_KINDS,
  ...PAYMENT_FX_DOCUMENT_KINDS,
]);
