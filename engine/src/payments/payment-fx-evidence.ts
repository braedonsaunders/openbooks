import { compareDecimal } from "../money/exact-decimal.ts";
import {
  DocumentFxError,
  PAYMENT_FX_DOCUMENT_KINDS,
  planDocumentFxEdit,
  readDocumentFxRateEvidence,
  type DocumentFxEditPlan,
  type DocumentFxIdentity,
  type DocumentFxRateEvidence,
  type ExplicitFxInput,
} from "../ledger/document-fx.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";

export {
  PAYMENT_FX_DOCUMENT_KINDS,
  type DocumentFxEditPlan,
  type DocumentFxIdentity,
  type DocumentFxRateEvidence,
  type ExplicitFxInput,
};

/**
 * Settlement-rate evidence for payments lives in the same authoritative
 * home as invoice/bill explicit rates: `documents.document_fx_rate_evidence`
 * plus the document's stored `fx_rate`. This module only plans and guards
 * that evidence for the native payment editor. It carries no conversion
 * arithmetic of its own: posting measures the payment through the normal
 * subsidiary stamping path, which consumes the stored evidence for the
 * owning legal entity only, and the application ledger's
 * `settlement_*` conversion (payment currency into the settled invoice/bill
 * currency) stays independent of this functional measurement rate.
 */

/** The identity a payment's recorded rate is bound to. Payments post on
 *  their document date unless a posting date was stamped on the row. */
export function paymentFxIdentity(args: {
  currency: string;
  functionalCurrency: string | null;
  documentDate: string;
  postingDate?: string | null;
  subsidiaryId: string | null;
}): DocumentFxIdentity | null {
  if (!args.subsidiaryId || !args.functionalCurrency) return null;
  return {
    currency: args.currency,
    functionalCurrency: args.functionalCurrency,
    rateDate: args.postingDate ?? args.documentDate,
    subsidiaryId: args.subsidiaryId,
  };
}

/**
 * How a draft payment save changes its recorded settlement rate. An omitted
 * request keeps recorded evidence only while the payment still posts with
 * the identity it was recorded for (currency, legal entity, posting date);
 * null clears it; a request records a replacement bound to the payment's
 * own currency, live functional currency and effective posting date.
 */
export function planPaymentFxEdit(args: {
  kind: string;
  input: unknown;
  stored: unknown;
  identity: DocumentFxIdentity | null;
}): DocumentFxEditPlan {
  try {
    return planDocumentFxEdit({ ...args, allowedKinds: PAYMENT_FX_DOCUMENT_KINDS });
  } catch (error) {
    if (error instanceof DocumentFxError) throw new PaymentError(error.message, { cause: error });
    throw error;
  }
}

/** Stored settlement-rate evidence from the document's native
 *  `documentFxRateEvidence` value, through the one shared parser.
 *  Malformed evidence refuses. */
export function storedPaymentFxEvidence(value: unknown): DocumentFxRateEvidence | null {
  try {
    return readDocumentFxRateEvidence(value);
  } catch (error) {
    if (error instanceof DocumentFxError) throw new PaymentError(error.message, { cause: error });
    throw error;
  }
}

/**
 * A manually recorded rate replaces the ordinary organization exchange-rate
 * lookup: it is never required to agree with a global rate, and a global
 * lookup is never dressed up as an independent quote. The only conflicting
 * source is an actual provider/processor contractual quote presented to
 * the caller; when one is presented, the two must agree exactly.
 */
export function assertPaymentFxQuoteAgrees(args: {
  evidence: DocumentFxRateEvidence | null;
  quoteRate: string | null;
  quoteLabel: string;
}): void {
  if (!args.evidence || args.quoteRate === null) return;
  if (compareDecimal(args.evidence.rate, args.quoteRate) === 0) return;
  throw new PaymentError(
    `the recorded explicit exchange rate ${args.evidence.rate} (${args.evidence.fromCurrency} to ${args.evidence.toCurrency} on ${args.evidence.rateDate}) ` +
      `differs from the ${args.quoteLabel} rate ${args.quoteRate}; clear the explicit rate in this payment to use the ${args.quoteLabel} rate, ` +
      `or fund the payment from an account that does not impose that rate, before saving`,
  );
}

/** The fx_rate a draft payment save must stamp for the planned evidence:
 *  the recorded rate when evidence stands, otherwise the caller's basis. */
export function paymentFxRateForSave(args: {
  plan: DocumentFxEditPlan;
  stored: DocumentFxRateEvidence | null;
  basisRate: string | null;
  currentRate: string;
}): string {
  if (args.plan.action === "set") return args.plan.evidence.rate;
  if (args.plan.action === "clear") return args.basisRate ?? "1";
  return args.stored ? args.stored.rate : (args.basisRate ?? args.currentRate);
}
