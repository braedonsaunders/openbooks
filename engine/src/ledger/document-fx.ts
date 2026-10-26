import { sql } from "drizzle-orm";
import type { DocumentFxRateEvidence } from "@openbooks/schema";
import type { SqlExecutor } from "../platform/db.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";

export type { DocumentFxRateEvidence };

/**
 * An explicit exchange rate records the rate a document is measured at in
 * its legal entity's functional currency, with where it came from and why.
 * The generic document editor accepts one only on customer invoices, vendor
 * bills and their credit memos (a credit can then be measured at the rate of
 * the receivable or payable it settles); the native payment editor accepts
 * one only on customer and
 * vendor payments. Posting accepts the union, so every editor's recorded
 * rate is honoured by the same stamping path; every other kind is measured
 * at the organization's exchange rates.
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

const KIND_LABEL: Record<string, string> = {
  customer_invoice: "customer invoices",
  vendor_bill: "vendor bills",
  customer_credit: "customer credits",
  vendor_credit: "vendor credits",
  customer_payment: "customer payments",
  vendor_payment: "vendor payments",
};

/** The allowed kinds named for an operator-facing refusal, in set order. */
function allowedKindsLabel(allowedKinds: ReadonlySet<string>): string {
  const labels = [...allowedKinds].map((kind) => KIND_LABEL[kind] ?? kind.replaceAll("_", " "));
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : (labels[0] ?? "");
}

/** An explicit-rate request: the rate and the conversion it was quoted for. */
export interface ExplicitFxInput {
  rate: string;
  source: string;
  reason: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: string;
}

/** The posting identity a rate is recorded for. */
export interface DocumentFxIdentity {
  /** Document (transaction) currency. */
  currency: string;
  /** Functional currency of the owning legal entity. */
  functionalCurrency: string;
  /** Effective posting date: the posting date, else the document date. */
  rateDate: string;
  subsidiaryId: string;
}

export class DocumentFxError extends Error {}

export type DocumentFxEditPlan =
  { action: "keep" } | { action: "set"; evidence: DocumentFxRateEvidence } | { action: "clear" };

const EVIDENCE_KEYS = "fromCurrency,rate,rateDate,reason,source,subsidiaryId,toCurrency,version";
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The canonical exact rate, or null when the value is not a positive decimal
 * that fits the stored rate (nine whole digits, ten decimal places). The
 * grammar is the manual journal rate grammar; nothing is rounded.
 */
export function explicitFxRate(value: unknown): string | null {
  const rate = canonicalDecimal(value, 10);
  if (rate === null || compareDecimal(rate, "0") <= 0) return null;
  return rate.split(".")[0]!.length > 9 ? null : rate;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

/**
 * Stored evidence as a typed record. Evidence that does not have the
 * recorded shape refuses: a document is never measured at a guessed rate.
 */
export function readDocumentFxRateEvidence(value: unknown): DocumentFxRateEvidence | null {
  if (value === null || value === undefined) return null;
  const malformed = new DocumentFxError(
    "this document's recorded exchange rate evidence is malformed; return it to draft and record the rate again or clear it",
  );
  if (typeof value !== "object" || Array.isArray(value)) throw malformed;
  const evidence = value as Record<string, unknown>;
  if (Object.keys(evidence).sort().join(",") !== EVIDENCE_KEYS || evidence.version !== 1)
    throw malformed;
  const rate = explicitFxRate(evidence.rate);
  const source = boundedText(evidence.source, 1, 120);
  const reason = boundedText(evidence.reason, 8, 500);
  const { fromCurrency, toCurrency, rateDate, subsidiaryId } = evidence;
  if (
    rate === null ||
    source === null ||
    reason === null ||
    typeof fromCurrency !== "string" ||
    !CURRENCY_CODE.test(fromCurrency) ||
    typeof toCurrency !== "string" ||
    !CURRENCY_CODE.test(toCurrency) ||
    fromCurrency === toCurrency ||
    typeof rateDate !== "string" ||
    !isIsoCalendarDate(rateDate) ||
    typeof subsidiaryId !== "string" ||
    !isUuid(subsidiaryId)
  )
    throw malformed;
  return { version: 1, rate, source, reason, fromCurrency, toCurrency, rateDate, subsidiaryId };
}

/** What separates the identity stored evidence was recorded for from the document's current one. */
export function documentFxIdentityChanges(
  evidence: DocumentFxRateEvidence,
  identity: DocumentFxIdentity,
): ("currency" | "legal entity" | "posting date")[] {
  const changes: ("currency" | "legal entity" | "posting date")[] = [];
  if (evidence.fromCurrency !== identity.currency) changes.push("currency");
  if (
    evidence.subsidiaryId !== identity.subsidiaryId ||
    evidence.toCurrency !== identity.functionalCurrency
  )
    changes.push("legal entity");
  if (evidence.rateDate !== identity.rateDate) changes.push("posting date");
  return changes;
}

/**
 * Evidence for an explicit-rate request, bound to the identity the edited
 * document will post with. The request names the conversion and date it was
 * quoted for, so a rate is never applied to a pair or day it was not meant
 * for; the legal entity is the document's own.
 */
export function explicitFxEvidence(
  input: unknown,
  identity: DocumentFxIdentity,
): DocumentFxRateEvidence {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DocumentFxError(
      "an explicit exchange rate needs its rate, source, reason, currencies and rate date",
    );
  }
  const request = input as Record<string, unknown>;
  const rate = explicitFxRate(request.rate);
  if (rate === null) {
    throw new DocumentFxError(
      "enter the exchange rate as a positive exact decimal with at most 9 whole digits and 10 decimal places",
    );
  }
  const source = boundedText(request.source, 1, 120);
  if (source === null)
    throw new DocumentFxError("name where the exchange rate came from, in 1 to 120 characters");
  const reason = boundedText(request.reason, 8, 500);
  if (reason === null)
    throw new DocumentFxError(
      "state why this document uses an explicit exchange rate, in 8 to 500 characters",
    );
  if (identity.currency === identity.functionalCurrency) {
    throw new DocumentFxError(
      `this document is in ${identity.currency}, the functional currency of its legal entity, so it has no exchange rate to record`,
    );
  }
  if (
    request.fromCurrency !== identity.currency ||
    request.toCurrency !== identity.functionalCurrency
  ) {
    throw new DocumentFxError(
      `the exchange rate must convert ${identity.currency} to ${identity.functionalCurrency}, the functional currency of the document's legal entity`,
    );
  }
  if (request.rateDate !== identity.rateDate) {
    throw new DocumentFxError(
      `the exchange rate must be for ${identity.rateDate}, the date this document posts on`,
    );
  }
  return {
    version: 1,
    rate,
    source,
    reason,
    fromCurrency: identity.currency,
    toCurrency: identity.functionalCurrency,
    rateDate: identity.rateDate,
    subsidiaryId: identity.subsidiaryId,
  };
}

/**
 * How a draft edit changes the explicit rate. An omitted request keeps the
 * recorded evidence only while the document still posts with the identity it
 * was recorded for; a change of currency, legal entity or posting date must
 * carry a replacement rate or clear it. Null clears recorded evidence; with
 * none recorded it changes nothing, so a rate the document already carries
 * is preserved.
 *
 * `stored` is the evidence column as read; `identity` is null when the
 * document's legal entity cannot be resolved.
 */
export function planDocumentFxEdit(args: {
  kind: string;
  input: unknown;
  stored: unknown;
  identity: DocumentFxIdentity | null;
  /**
   * Kinds this editor may record a rate on. Defaults to the generic
   * document editor's invoice/bill set; the native payment editor passes
   * the payment set, so each editor stays restricted to its own kinds.
   */
  allowedKinds?: ReadonlySet<string>;
}): DocumentFxEditPlan {
  const { kind, input, identity } = args;
  const allowedKinds = args.allowedKinds ?? EXPLICIT_FX_DOCUMENT_KINDS;
  if (input === null) return args.stored == null ? { action: "keep" } : { action: "clear" };
  if (input === undefined) {
    const stored = readDocumentFxRateEvidence(args.stored);
    if (!stored) return { action: "keep" };
    const changes = identity
      ? documentFxIdentityChanges(stored, identity)
      : (["legal entity"] as const);
    if (changes.length === 0) return { action: "keep" };
    const changed = changes.join(" and ");
    throw new DocumentFxError(
      `the recorded ${stored.fromCurrency} to ${stored.toCurrency} exchange rate for ${stored.rateDate} belongs to this document's ` +
        `previous ${changed}; record a rate for the new ${changed} with this change, or clear the explicit rate`,
    );
  }
  if (!allowedKinds.has(kind)) {
    throw new DocumentFxError(
      `an explicit exchange rate can be recorded only on ${allowedKindsLabel(allowedKinds)}`,
    );
  }
  if (!identity) {
    throw new DocumentFxError(
      "assign the document an active subsidiary before recording an explicit exchange rate",
    );
  }
  return { action: "set", evidence: explicitFxEvidence(input, identity) };
}

/**
 * Posting-time proof that recorded evidence still describes the document
 * being posted: its kind, currency, legal entity and functional currency,
 * effective posting date, and the rate the document carries. Null when it
 * does.
 */
export function documentFxPostingRefusal(
  kind: string,
  evidence: DocumentFxRateEvidence,
  identity: DocumentFxIdentity,
  documentRate: string,
): string | null {
  if (!POSTING_FX_DOCUMENT_KINDS.has(kind)) {
    return `an explicit exchange rate can be recorded only on ${allowedKindsLabel(POSTING_FX_DOCUMENT_KINDS)}; return the document to draft and clear it`;
  }
  const changes = documentFxIdentityChanges(evidence, identity);
  if (changes.length > 0) {
    return (
      `the recorded ${evidence.fromCurrency} to ${evidence.toCurrency} exchange rate for ${evidence.rateDate} no longer matches ` +
      `this document's ${changes.join(" and ")}; return it to draft and record the rate it posts with, or clear the explicit rate`
    );
  }
  if (compareDecimal(evidence.rate, documentRate) !== 0) {
    return "this document's exchange rate differs from its recorded rate evidence; return it to draft and record the rate again";
  }
  return null;
}

/** The locked draft's stored currency, dates and evidence as stored. */
export async function documentFxState(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  documentId: string,
): Promise<{
  currency: string;
  documentDate: string;
  postingDate: string | null;
  evidence: unknown;
}> {
  const row = (
    await runner.execute<{
      currency: string;
      document_date: string;
      posting_date: string | null;
      evidence: unknown;
    }>(
      sql`
    select currency, document_date::text as document_date, posting_date::text as posting_date,
           document_fx_rate_evidence as evidence
      from documents
     where org_id = ${orgId} and id = ${documentId}`,
      "objects",
    )
  )[0];
  if (!row) throw new DocumentFxError("the document was not found in this organization");
  return {
    currency: row.currency,
    documentDate: row.document_date,
    postingDate: row.posting_date,
    evidence: row.evidence,
  };
}

/**
 * A legal entity's functional currency, share-locked for the caller's
 * transaction so the identity evidence is bound to cannot change before the
 * write commits. Null when it is not an active, non-elimination entity of
 * this organization.
 */
export async function subsidiaryFunctionalCurrency(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  subsidiaryId: string,
): Promise<string | null> {
  return (
    (
      await runner.execute<{ base_currency: string }>(
        sql`
    select base_currency from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination
     for share`,
        "objects",
      )
    )[0]?.base_currency ?? null
  );
}
