import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { quoteSignatureReminderEmail } from "@openbooks/emails";
import { db, withBypass, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { enqueueFlowEmail } from "../delivery/outbox-enqueue.ts";
import { appBaseUrl } from "../flows/email-tokens.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { add, cmp, mul, mulPercent, roundDiv, toUnits } from "../money/money.ts";
import { addMonthsClamped, addMonthsStart } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  hashPossessionToken,
  mintPossessionToken,
  verifyPossessionToken,
} from "../platform/signing-tokens.ts";
import { submitForApproval, SubmitError } from "../flows/submit.ts";
import { ensureScopedContract, revenueContractsEnabled } from "../revenue/contract-scope.ts";
import {
  activateLifecycle,
  applyAmendment,
  createPlanVersion,
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
// The engine system actor attributes unattended activation (auto-activate on
// signature arrives with no user). Interactive calls must pass a real actor:
// applyAmendment refuses SYSTEM_ACTOR_ID without a system source marker.
import { SYSTEM_ACTOR_ID as SYSTEM_ACTOR_ID_VALUE } from "../banking/banking.ts";

/**
 * Quote-to-cash: a SaaS deal is quoted, approved, signed and activated
 * without re-keying. Subscription terms and ramp steps priced on a quote
 * resolve to a deterministic per-period schedule (total contract value and
 * annualized value at every step); an over-threshold discount or a
 * below-floor line routes the quote through Flows approval; the customer
 * signs on a hosted possession-token link; activation creates the billed
 * subscription (with the ramp as scheduled amendments) and, when scoped
 * revenue contracts are on, the subscription's contract — all idempotent
 * per quote.
 *
 * Money stays in house numeric(19,4) strings through engine/src/money/money.ts;
 * escalator-derived prices round half away from zero to currency minor units
 * (2dp), explicit step prices keep ledger precision. Dates step through the
 * house civil-date helpers.
 */

export class QuoteToCashError extends Error {
  readonly name = "QuoteToCashError";
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

/** Token domain: a quote signature link can never verify as any HRM token. */
const QUOTE_SIGN_DOMAIN = "quote-signature:v1";

/** The consent paragraph presented on the hosted signing page, versioned here
 * so the stored copy stays comparable. Tendered text, never signer-authored. */
export const QUOTE_SIGNATURE_CONSENT =
  "By typing my name below I accept this order as the customer's authorized signatory. " +
  "I agree the subscription starts on the stated start date and bills at the stated prices, " +
  "and I understand this electronic signature carries the same effect as a handwritten one.";

/** A signed quote activates one subscription per non-co-term line. */
export const QUOTE_SUBJECT_TABLE = "documents";

export type QuoteStartRule = "quote_date" | "first_of_next_month" | "custom";
export type QuoteBillingTiming = "advance" | "arrears";

export interface QuoteToCashSettings {
  /** Discount percent above which the quote must be Flows-approved. */
  maxDiscountPercent: string;
  /** Activate automatically when the signature lands instead of waiting. */
  autoActivateOnSign: boolean;
  /** Billing timing for terms that do not name one. */
  defaultBillingTiming: QuoteBillingTiming;
  /** Start rule for terms that do not name one. */
  defaultStartRule: QuoteStartRule;
  /** Days a signing link stays valid. */
  signatureExpiryDays: number;
}

const SETTINGS_DEFAULTS: QuoteToCashSettings = {
  maxDiscountPercent: "10",
  autoActivateOnSign: false,
  defaultBillingTiming: "advance",
  defaultStartRule: "quote_date",
  signatureExpiryDays: 14,
};

/**
 * Read the org's quote-to-cash policy from its Setup row. An absent row
 * reads as the working defaults above, so the surface needs zero setup —
 * defaults over setup, one source of truth per key. Storage checks bound
 * every column, so a stored row is trusted as-is.
 */
export async function getQuoteToCashSettings(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): Promise<QuoteToCashSettings> {
  const row = (
    await (runner as SqlExecutor).execute<{
      max_discount_percent: string;
      auto_activate_on_sign: boolean;
      default_billing_timing: string;
      default_start_rule: string;
      signature_expiry_days: number;
    }>(sql`
      select max_discount_percent::text as max_discount_percent, auto_activate_on_sign,
             default_billing_timing, default_start_rule, signature_expiry_days
        from quote_to_cash_settings where org_id = ${orgId}`)
  ).rows[0];
  if (!row) return { ...SETTINGS_DEFAULTS };
  return {
    maxDiscountPercent: row.max_discount_percent,
    autoActivateOnSign: row.auto_activate_on_sign,
    defaultBillingTiming: row.default_billing_timing as QuoteBillingTiming,
    defaultStartRule: row.default_start_rule as QuoteStartRule,
    signatureExpiryDays: row.signature_expiry_days,
  };
}

/** Fail closed unless the quote-to-cash switchboard entry (and, through the
 * registry chain, orders + subscriptionBilling) resolves on. */
async function assertQuoteToCashEnabled(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "quoteToCash"))) {
    throw new QuoteToCashError(
      "Quote-to-cash is off — turn it on in Company Settings → Features (needs Orders and Subscription billing) before quoting subscription terms",
    );
  }
}

export interface QuoteRow {
  id: string;
  documentNumber: string;
  status: string;
  partyId: string | null;
  currency: string;
  documentDate: string;
  total: string;
}

async function loadQuote(runner: SqlExecutor, orgId: string, quoteId: string): Promise<QuoteRow> {
  const row = (
    await runner.execute<{
      id: string;
      document_number: string;
      status: string;
      party_id: string | null;
      currency: string;
      document_date: string;
      total: string;
      kind: string;
    }>(sql`
      select id, document_number, status, party_id, currency,
             document_date::text as document_date, total::text as total, kind
        from documents where id = ${quoteId} and org_id = ${orgId} for update`)
  ).rows[0];
  // Under row-level security an unscoped read silently matches nothing, so a
  // missing row is raised, never treated as an empty quote.
  if (!row) throw new QuoteToCashError("Quote not found — it may belong to another organization");
  if (row.kind !== "quote") {
    throw new QuoteToCashError(
      `Document ${row.document_number} is a ${row.kind}, not a quote — quote-to-cash runs on quotes (Estimates) only`,
    );
  }
  return {
    id: row.id,
    documentNumber: row.document_number,
    status: row.status,
    partyId: row.party_id,
    currency: row.currency,
    documentDate: row.document_date,
    total: row.total,
  };
}

export interface RampStepInput {
  id: string;
  periodIndex: number;
  startsAfterMonths: number;
  unitPrice: string;
  quantity: string;
  escalatorPercent: string | null;
}

export interface RampPeriod {
  periodIndex: number;
  startsAfterMonths: number;
  months: number;
  unitPrice: string;
  quantity: string;
  periodAmount: string;
  /** Annualized run-rate at this step's price and quantity. */
  arr: string;
}

export interface RampSchedule {
  periods: RampPeriod[];
  /** Total contract value across the whole term. */
  tcv: string;
}

/**
 * Resolve one term's ramp to its per-period schedule. Pure.
 *
 * Price rule: period 0 bills its explicit price; a later period bills the
 * previous period's escalator when the previous step carries one, else its
 * own explicit price. Escalator-derived prices round half away from zero to
 * currency minor units (2dp); explicit prices keep ledger precision. The
 * unit price is per unit per month; a period covering several months bills
 * price × quantity × months. Steps must start at month 0 and climb — a gap
 * or overlap is refused by name rather than guessed.
 */
export function resolveRampSchedule(termMonths: number, steps: RampStepInput[]): RampSchedule {
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || termMonths > 120) {
    throw new QuoteToCashError("Term length must be between 1 and 120 months");
  }
  if (!steps.length) throw new QuoteToCashError("A subscription term needs at least one ramp period");
  const ordered = [...steps].sort((a, b) => a.periodIndex - b.periodIndex);
  ordered.forEach((step, i) => {
    if (step.periodIndex !== i) {
      throw new QuoteToCashError(
        `Ramp periods must run 0, 1, 2… without gaps — period ${step.periodIndex} is out of sequence`,
      );
    }
    if (i === 0 && step.startsAfterMonths !== 0) {
      throw new QuoteToCashError("The first ramp period must start at month 0");
    }
    if (i > 0 && step.startsAfterMonths <= ordered[i - 1]!.startsAfterMonths) {
      throw new QuoteToCashError("Ramp periods must start later than the previous period");
    }
    if (step.startsAfterMonths >= termMonths) {
      throw new QuoteToCashError(
        `Ramp period ${step.periodIndex} starts after the ${termMonths}-month term ends`,
      );
    }
  });
  const periods: RampPeriod[] = [];
  let previousPrice: string | null = null;
  let previousEscalator: string | null = null;
  for (const step of ordered) {
    const price: string =
      previousPrice !== null && previousEscalator !== null
        ? add(previousPrice, mulPercent(previousPrice, previousEscalator, 2))
        : step.unitPrice;
    const nextStart = ordered[step.periodIndex + 1]?.startsAfterMonths ?? termMonths;
    const months = nextStart - step.startsAfterMonths;
    const periodAmount = mul(mul(price, step.quantity), String(months));
    periods.push({
      periodIndex: step.periodIndex,
      startsAfterMonths: step.startsAfterMonths,
      months,
      unitPrice: price,
      quantity: step.quantity,
      periodAmount,
      arr: mul(mul(price, step.quantity), "12"),
    });
    previousPrice = price;
    previousEscalator = step.escalatorPercent;
  }
  return { periods, tcv: periods.reduce((acc, p) => add(acc, p.periodAmount), "0.0000") };
}

/**
 * Discount percent of actual against list, to two decimals, as a plain
 * string ("7.50" means seven and a half percent). Exact bigint arithmetic,
 * halves away from zero. A non-positive list prices zero discount — free
 * plans are not infinitely discounted.
 */
export function discountPercent(listTotal: string, actualTotal: string): string {
  const list = toUnits(listTotal);
  if (list <= 0n) return "0.00";
  const basisPoints = roundDiv((list - toUnits(actualTotal)) * 10000n, list);
  const negative = basisPoints < 0n;
  const abs = negative ? -basisPoints : basisPoints;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

export interface QuoteTerm {
  id: string;
  quoteLineId: string;
  planId: string;
  planName: string;
  planAmount: string;
  planCurrency: string | null;
  planInterval: string;
  planIntervalCount: number;
  planIncomeAccountId: string | null;
  planItemId: string | null;
  planTaxCodeId: string | null;
  /** Catalog version the line was priced from; activation freezes the agreed
   * prices into a new version rather than adopting it. */
  planVersionId: string | null;
  termMonths: number;
  startRule: QuoteStartRule;
  billingTiming: QuoteBillingTiming;
  cotermSubscriptionId: string | null;
  steps: RampStepInput[];
}

export interface TermValuation {
  term: QuoteTerm;
  schedule: RampSchedule;
  /** List TCV at the plan's catalog price across the ramp quantities. */
  listTcv: string;
  /** Below-floor periods: step price under the plan's catalog price. */
  floorBreaches: number[];
}

/** Load a quote's subscription terms with ramp steps and plan prices. */
export async function loadQuoteTerms(
  runner: SqlExecutor,
  orgId: string,
  quoteId: string,
): Promise<QuoteTerm[]> {
  const rows = (
    await runner.execute<{
      id: string;
      quote_line_id: string;
      plan_id: string;
      plan_name: string;
      plan_amount: string;
      plan_currency: string | null;
      plan_interval: string;
      plan_interval_count: number;
      plan_income_account_id: string | null;
      plan_item_id: string | null;
      plan_tax_code_id: string | null;
      plan_version_id: string | null;
      term_months: number;
      start_rule: string;
      billing_timing: string;
      coterm_subscription_id: string | null;
    }>(sql`
      select t.id, t.quote_line_id, t.plan_id, p.name as plan_name, p.amount::text as plan_amount,
             p.currency_code as plan_currency, p.interval as plan_interval, p.interval_count as plan_interval_count,
             p.income_account_id as plan_income_account_id, p.item_id as plan_item_id, p.tax_code_id as plan_tax_code_id,
             t.plan_version_id, t.term_months, t.start_rule, t.billing_timing, t.coterm_subscription_id
        from quote_subscription_terms t
        join subscription_plans p on p.id = t.plan_id and p.org_id = t.org_id
       where t.org_id = ${orgId} and t.quote_id = ${quoteId}
       order by t.created_at, t.id`)
  ).rows;
  const terms: QuoteTerm[] = [];
  for (const row of rows) {
    const steps = (
      await runner.execute<{
        id: string;
        period_index: number;
        starts_after_months: number;
        unit_price: string;
        quantity: string;
        escalator_percent: string | null;
      }>(sql`
        select id, period_index, starts_after_months, unit_price::text as unit_price,
               quantity::text as quantity, escalator_percent::text as escalator_percent
          from quote_ramp_steps
         where org_id = ${orgId} and term_id = ${row.id}
         order by period_index`)
    ).rows.map((s) => ({
      id: s.id,
      periodIndex: s.period_index,
      startsAfterMonths: s.starts_after_months,
      unitPrice: s.unit_price,
      quantity: s.quantity,
      escalatorPercent: s.escalator_percent,
    }));
    if (row.start_rule !== "quote_date" && row.start_rule !== "first_of_next_month" && row.start_rule !== "custom") {
      throw new QuoteToCashError(`Term ${row.id} names an unknown start rule — fix it to quote_date, first_of_next_month or custom`);
    }
    if (row.billing_timing !== "advance" && row.billing_timing !== "arrears") {
      throw new QuoteToCashError(`Term ${row.id} names an unknown billing timing — fix it to advance or arrears`);
    }
    terms.push({
      id: row.id,
      quoteLineId: row.quote_line_id,
      planId: row.plan_id,
      planName: row.plan_name,
      planAmount: row.plan_amount,
      planCurrency: row.plan_currency,
      planInterval: row.plan_interval,
      planIntervalCount: row.plan_interval_count,
      planIncomeAccountId: row.plan_income_account_id,
      planItemId: row.plan_item_id,
      planTaxCodeId: row.plan_tax_code_id,
      planVersionId: row.plan_version_id,
      termMonths: row.term_months,
      startRule: row.start_rule as QuoteStartRule,
      billingTiming: row.billing_timing as QuoteBillingTiming,
      cotermSubscriptionId: row.coterm_subscription_id,
      steps,
    });
  }
  return terms;
}

/** Value every term of a quote: schedule, list TCV, and floor breaches. */
export function valueQuoteTerms(terms: QuoteTerm[]): {
  valuations: TermValuation[];
  tcv: string;
  listTcv: string;
  discountPct: string;
  floorBreached: boolean;
} {
  const valuations = terms.map((term) => {
    const schedule = resolveRampSchedule(term.termMonths, term.steps);
    let listTcv = "0.0000";
    const floorBreaches: number[] = [];
    for (const period of schedule.periods) {
      listTcv = add(listTcv, mul(mul(term.planAmount, period.quantity), String(period.months)));
      if (cmp(period.unitPrice, term.planAmount) < 0) floorBreaches.push(period.periodIndex);
    }
    return { term, schedule, listTcv, floorBreaches };
  });
  const tcv = valuations.reduce((acc, v) => add(acc, v.schedule.tcv), "0.0000");
  const listTcv = valuations.reduce((acc, v) => add(acc, v.listTcv), "0.0000");
  return {
    valuations,
    tcv,
    listTcv,
    discountPct: discountPercent(listTcv, tcv),
    floorBreached: valuations.some((v) => v.floorBreaches.length > 0),
  };
}

/**
 * The exact presentation the signer is shown, hashed at send time and
 * re-checked at signing: quote identity, totals, every line, and every term
 * and step. Key order is fixed by construction, so the hash is stable.
 */
export async function quotePresentationHash(
  runner: SqlExecutor,
  orgId: string,
  quoteId: string,
): Promise<string> {
  const quote = await loadQuote(runner, orgId, quoteId);
  const lines = (
    await runner.execute<{ line_number: number; amount: string; quantity: string; unit_price: string }>(sql`
      select line_number, amount::text as amount, quantity::text as quantity, unit_price::text as unit_price
        from document_lines where org_id = ${orgId} and document_id = ${quoteId}
        order by line_number`)
  ).rows;
  const terms = await loadQuoteTerms(runner, orgId, quoteId);
  const canonical = JSON.stringify({
    quote: {
      id: quote.id,
      number: quote.documentNumber,
      status: quote.status,
      party: quote.partyId,
      currency: quote.currency,
      date: quote.documentDate,
      total: quote.total,
    },
    lines,
    terms: terms.map((t) => ({
      id: t.id,
      line: t.quoteLineId,
      plan: t.planId,
      version: t.planVersionId,
      months: t.termMonths,
      start: t.startRule,
      timing: t.billingTiming,
      coterm: t.cotermSubscriptionId,
      steps: t.steps.map((s) => [s.periodIndex, s.startsAfterMonths, s.unitPrice, s.quantity, s.escalatorPercent]),
    })),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface SignatureRequestRow {
  id: string;
  status: string;
  signerName: string;
  signerEmail: string;
  expiresAt: Date;
  documentHash: string;
  consentText: string | null;
}

/** The open or latest signature request for a subject, if any. */
export async function latestSignatureRequest(
  runner: SqlExecutor,
  orgId: string,
  subjectTable: string,
  subjectId: string,
): Promise<SignatureRequestRow | null> {
  const row = (
    await runner.execute<{
      id: string;
      status: string;
      signer_name: string;
      signer_email: string;
      expires_at: Date | string;
      document_hash: string;
      consent_text: string | null;
    }>(sql`
      select id, status, signer_name, signer_email, expires_at, document_hash, consent_text
        from signature_requests
       where org_id = ${orgId} and subject_table = ${subjectTable} and subject_id = ${subjectId}
       order by sent_at desc, id desc limit 1`)
  ).rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    documentHash: row.document_hash,
    consentText: row.consent_text,
  };
}

/**
 * Route an over-threshold discount (or a below-floor line) through Flows.
 * Under-threshold quotes need no approval and pass through. An approved
 * quote passes; a pending one refuses by name. Otherwise the quote is
 * submitted — the single Flows entry point — and a gated quote refuses as
 * pending while an ungated one refuses naming the missing approval flow,
 * because an over-threshold discount must never self-approve.
 */
export async function ensureQuoteDiscountApproved(
  runner: SqlExecutor,
  orgId: string,
  quote: QuoteRow,
  valuation: { discountPct: string; floorBreached: boolean },
  settings: QuoteToCashSettings,
  actorId: string | null,
): Promise<void> {
  const overThreshold = cmp(valuation.discountPct, settings.maxDiscountPercent) > 0;
  if (!overThreshold && !valuation.floorBreached) return;
  const reason = overThreshold
    ? `quote discount ${valuation.discountPct}% is over the ${settings.maxDiscountPercent}% approval threshold`
    : "a ramp line is priced below its plan's catalog price (floor)";
  if (quote.status === "approved") return;
  if (quote.status === "pending_approval") {
    throw new QuoteToCashError(
      `This quote cannot be sent while its discount approval is pending (${reason}) — approve it in Flows first`,
    );
  }
  if (quote.status !== "draft") {
    throw new QuoteToCashError(
      `This quote is ${quote.status} — only draft or approved quotes go for signature (${reason})`,
    );
  }
  let gated: boolean;
  let flowError: string | null;
  try {
    ({ gated, flowError } = await submitForApproval("quote", quote.id, actorId));
  } catch (error) {
    if (error instanceof SubmitError) {
      throw new QuoteToCashError(
        `Discount approval could not be requested: ${error.message} — resolve it and send again`,
      );
    }
    throw error;
  }
  // A matched-but-errored flow must fail closed: the quote is neither gated
  // nor approved, so sending it would let an over-threshold discount skip
  // review entirely.
  if (flowError) {
    throw new QuoteToCashError(
      `Discount approval could not be routed: ${flowError} — fix the quote approval flow in Flows and send again`,
    );
  }
  if (gated) {
    throw new QuoteToCashError(
      `This quote was routed for discount approval (${reason}) — it can be sent once Flows approves it`,
    );
  }
  throw new QuoteToCashError(
    `${reason}, and no approval flow is configured for quotes — set one up in Flows or bring the discount within ${settings.maxDiscountPercent}%`,
  );
}

export interface RequestSignatureInput {
  orgId: string;
  actorId: string;
  quoteId: string;
  signerName: string;
  signerEmail: string;
  expiresInDays?: number | null;
}

export interface RequestSignatureResult {
  requestId: string;
  /** The raw link token — returned once for the delivery email, never stored. */
  token: string;
  expiresAt: Date;
  documentHash: string;
}

/**
 * Send a quote for signature: discount-gate first (which may route the
 * quote into Flows and refuse), then mint the signer's possession token and
 * persist only its hash with the exact presentation hash. A second send
 * while one is open refuses — void the open request and re-send instead.
 * The caller delivers `token` to the signer out of band.
 */
export async function requestQuoteSignature(
  input: RequestSignatureInput,
): Promise<RequestSignatureResult> {
  const signerName = input.signerName.trim().slice(0, 120);
  const signerEmail = input.signerEmail.trim().slice(0, 320);
  if (!signerName) throw new QuoteToCashError("A signer name is required to send for signature");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(signerEmail)) {
    throw new QuoteToCashError("A valid signer email is required to send for signature");
  }
  return withOrgTransaction(input.orgId, async () => {
    await assertQuoteToCashEnabled(db, input.orgId);
    const quote = await loadQuote(db, input.orgId, input.quoteId);
    if (quote.status !== "draft" && quote.status !== "approved" && quote.status !== "pending_approval") {
      throw new QuoteToCashError(
        `This quote is ${quote.status} — only draft or approved quotes go for signature`,
      );
    }
    const settings = await getQuoteToCashSettings(input.orgId, db);
    const terms = await loadQuoteTerms(db, input.orgId, input.quoteId);
    if (!terms.length) {
      throw new QuoteToCashError(
        "This quote has no subscription lines — add a plan, quantity and term before sending for signature",
      );
    }
    const valuation = valueQuoteTerms(terms);
    await ensureQuoteDiscountApproved(db, input.orgId, quote, valuation, settings, input.actorId);
    const expiresInDays =
      input.expiresInDays ?? settings.signatureExpiryDays;
    if (!Number.isSafeInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 90) {
      throw new QuoteToCashError("Signature expiry must be between 1 and 90 days");
    }
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const documentHash = await quotePresentationHash(db, input.orgId, input.quoteId);
    const requestId = randomUUID();
    const token = mintPossessionToken(QUOTE_SIGN_DOMAIN, input.orgId, requestId, expiresAt);
    try {
      const inserted = await (db).execute<{ id: string }>(sql`
        insert into signature_requests
          (id, org_id, subject_table, subject_id, signer_name, signer_email, token_hash,
           status, expires_at, sent_at, document_hash, consent_text, created_by, updated_by)
        values (${requestId}, ${input.orgId}, ${QUOTE_SUBJECT_TABLE}, ${input.quoteId},
                ${signerName}, ${signerEmail}, ${hashPossessionToken(token)},
                'sent', ${expiresAt}, now(), ${documentHash}, ${QUOTE_SIGNATURE_CONSENT},
                ${input.actorId}, ${input.actorId})
        returning id`);
      if (!inserted.rows[0]) throw new QuoteToCashError("The signature request was not recorded");
    } catch (error) {
      // The open-subject uniqueness is the concurrency authority: a twin
      // send converges on one request, and the loser names the remedy.
      if (isUniqueViolation(error)) {
        throw new QuoteToCashError(
          "A signature request is already open on this quote — void it before re-sending",
        );
      }
      throw error;
    }
    await (db).execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'signature_requests', ${requestId}, 'insert',
              ${JSON.stringify({ after: { subject: input.quoteId, signerEmail, documentHash } })}::jsonb,
              ${input.actorId})`);
    return { requestId, token, expiresAt, documentHash };
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "23505"
  );
}

interface OpenSignatureRow {
  id: string;
  orgId: string;
  subjectId: string;
  status: string;
  signerName: string;
  signerEmail: string;
  expiresAt: Date;
  documentHash: string;
  consentText: string | null;
}

/** Load the request a token addresses, re-validating row state. The token's
 * embedded org must match the row's org — a cross-org token never resolves. */
async function loadRequestByToken(runner: SqlExecutor, token: string): Promise<OpenSignatureRow> {
  const claims = verifyPossessionToken(QUOTE_SIGN_DOMAIN, token);
  if (!claims) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  const row = (
    await runner.execute<{
      id: string;
      org_id: string;
      subject_id: string;
      status: string;
      signer_name: string;
      signer_email: string;
      expires_at: Date | string;
      document_hash: string;
      consent_text: string | null;
    }>(sql`
      select id, org_id, subject_id, status, signer_name, signer_email, expires_at, document_hash, consent_text
        from signature_requests where token_hash = ${hashPossessionToken(token)} for update`)
  ).rows[0];
  if (!row || row.org_id !== claims.orgId || row.id !== claims.rowId) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    subjectId: row.subject_id,
    status: row.status,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    // Raw SQL returns timestamptz as a string; the liveness check below
    // needs a real Date, so coerce here rather than trusting the type.
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
    documentHash: row.document_hash,
    consentText: row.consent_text,
  };
}

/** Mark an open request expired once its time passes. Returns true when the
 * request already lapsed (the caller refuses); never reports expiry twice. */
async function expireIfLapsed(runner: SqlExecutor, request: OpenSignatureRow): Promise<boolean> {
  if (request.status !== "sent" && request.status !== "viewed") return false;
  if (request.expiresAt.getTime() >= Date.now()) return false;
  const updated = (
    await runner.execute<{ id: string }>(sql`
      update signature_requests set status = 'expired', updated_at = now()
       where id = ${request.id} and org_id = ${request.orgId} and status in ('sent', 'viewed')
      returning id`)
  ).rows;
  if (updated.length !== 1) throw new QuoteToCashError("The signature request changed under its expiry");
  return true;
}

export interface SignatureView {
  requestId: string;
  quoteId: string;
  status: string;
  signerName: string;
  documentHash: string;
  consentText: string | null;
}

/** Open the hosted signing page: records first view, refuses lapsed links. */
export async function viewQuoteSignature(token: string): Promise<SignatureView> {
  const claims = verifyPossessionToken(QUOTE_SIGN_DOMAIN, token);
  if (!claims) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  return withOrgTransaction(claims.orgId, async () => {
    const runner = db;
    const request = await loadRequestByToken(runner, token);
    if (await expireIfLapsed(runner, request)) {
      throw new QuoteToCashError("This signing link expired — ask the sender to re-send it");
    }
    if (request.status === "sent") {
      const updated = (
        await runner.execute<{ id: string }>(sql`
          update signature_requests set status = 'viewed', viewed_at = now(), updated_at = now()
           where id = ${request.id} and org_id = ${request.orgId} and status = 'sent'
          returning id`)
      ).rows;
      if (updated.length !== 1) throw new QuoteToCashError("The signature request changed while opening");
      request.status = "viewed";
    }
    return {
      requestId: request.id,
      quoteId: request.subjectId,
      status: request.status,
      signerName: request.signerName,
      documentHash: request.documentHash,
      consentText: request.consentText,
    };
  });
}

export interface SignQuoteInput {
  token: string;
  /** Typed name — the signature itself. */
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  /** Optional hand-drawn signature captured on the hosted page (SVG). */
  signatureSvg?: string | null;
}

export interface SignQuoteResult {
  requestId: string;
  quoteId: string;
  signedAt: Date;
  /** Present when the org activates on signature. */
  subscriptionIds: string[];
}

/**
 * Sign the quote. The presentation is re-hashed and compared to the hash
 * stored at send time: a quote edited after sending refuses here (and the
 * edit path voids the request), so nobody ever signs stale terms. One
 * signature per request — replaying a signed link refuses.
 */
export async function signQuoteSignature(input: SignQuoteInput): Promise<SignQuoteResult> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new QuoteToCashError("Your name is required to sign");
  const claims = verifyPossessionToken(QUOTE_SIGN_DOMAIN, input.token);
  if (!claims) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  return withOrgTransaction(claims.orgId, async () => {
    const runner = db;
    const request = await loadRequestByToken(runner, input.token);
    // The hosted page carries no session, so the engine fences the
    // switched-off surface here: a signature (which can auto-activate the
    // quote into live subscriptions) must refuse while quote-to-cash is
    // off, in the signer's words rather than the operator's.
    if (!(await lockAndCheckOrgFeature(runner, request.orgId, "quoteToCash"))) {
      throw new QuoteToCashError("This signing link is no longer available — ask the sender to re-send it");
    }
    if (await expireIfLapsed(runner, request)) {
      throw new QuoteToCashError("This signing link expired — ask the sender to re-send it");
    }
    if (request.status === "signed") {
      throw new QuoteToCashError("This link already recorded a signature — a signature is recorded once and never replayed");
    }
    if (request.status === "declined") {
      throw new QuoteToCashError("This link recorded a decline — ask the sender to re-issue the quote to sign");
    }
    if (request.status === "voided") {
      throw new QuoteToCashError("This request was voided when the quote changed — ask the sender to re-send it");
    }
    if (request.status !== "sent" && request.status !== "viewed") {
      throw new QuoteToCashError("This signing link is no longer open — ask the sender to re-send it");
    }
    const currentHash = await quotePresentationHash(runner, request.orgId, request.subjectId);
    if (currentHash !== request.documentHash) {
      throw new QuoteToCashError(
        "The quote changed after this request was sent — the signature was refused so nobody signs stale terms. Void this request and send it again",
      );
    }
    const signedAt = new Date();
    const updated = (
      await runner.execute<{ id: string }>(sql`
        update signature_requests
           set status = 'signed', signed_at = ${signedAt}, signer_ip = ${input.ip ?? null},
               signer_user_agent = ${input.userAgent ?? null},
               signature_svg = ${input.signatureSvg ?? null}, updated_at = now()
         where id = ${request.id} and org_id = ${request.orgId} and status in ('sent', 'viewed')
        returning id`)
    ).rows;
    // The conditional update is the replay authority: a twin signature
    // converges on one signed row, and the loser finds zero rows.
    if (updated.length !== 1) {
      throw new QuoteToCashError("This link already recorded a signature — a signature is recorded once and never replayed");
    }
    // The invited identity stays on signer_name/signer_email; the typed name,
    // the tendered consent and the hashed terms land in the audit trail, so
    // the recorded signature stays attributable without rewriting the invite.
    await runner.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${request.orgId}, 'signature_requests', ${request.id}, 'update',
              ${JSON.stringify({ before: { status: request.status }, after: { status: "signed", signedAt: signedAt.toISOString(), signedName: name, signerIp: input.ip ?? null, consentText: request.consentText, documentHash: request.documentHash } })}::jsonb,
              null)`);
    const settings = await getQuoteToCashSettings(request.orgId, runner);
    let subscriptionIds: string[] = [];
    if (settings.autoActivateOnSign) {
      ({ subscriptionIds } = await activateQuoteLocked(runner, request.orgId, null, request.subjectId, {}));
    }
    return { requestId: request.id, quoteId: request.subjectId, signedAt, subscriptionIds };
  });
}

/** Decline the quote on the hosted page: records who declined and when. */
export async function declineQuoteSignature(input: { token: string; name: string }): Promise<{ requestId: string }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new QuoteToCashError("Your name is required to decline");
  const claims = verifyPossessionToken(QUOTE_SIGN_DOMAIN, input.token);
  if (!claims) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  return withOrgTransaction(claims.orgId, async () => {
    const runner = db;
    const request = await loadRequestByToken(runner, input.token);
    // Same switched-off fence as signing: the decline is a quote-to-cash
    // write, and the remedy (re-send after re-enabling) is the sender's.
    if (!(await lockAndCheckOrgFeature(runner, request.orgId, "quoteToCash"))) {
      throw new QuoteToCashError("This signing link is no longer available — ask the sender to re-send it");
    }
    if (request.status !== "sent" && request.status !== "viewed") {
      throw new QuoteToCashError("This signing link is no longer open");
    }
    const updated = (
      await runner.execute<{ id: string }>(sql`
        update signature_requests
           set status = 'declined', declined_at = now(), updated_at = now()
         where id = ${request.id} and org_id = ${request.orgId} and status in ('sent', 'viewed')
        returning id`)
    ).rows;
    if (updated.length !== 1) throw new QuoteToCashError("The signature request changed while declining");
    // The decline records who declined and when: the typed name lands in the
    // audit trail while the invited identity stays on the row. No sender
    // notice is enqueued here — the sender sees the declined state.
    await runner.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${request.orgId}, 'signature_requests', ${request.id}, 'update',
              ${JSON.stringify({ before: { status: request.status }, after: { status: "declined", declinedAt: new Date().toISOString(), declinedName: name } })}::jsonb,
              null)`);
    return { requestId: request.id };
  });
}

/**
 * Void the open requests on a subject — the edit path calls this whenever
 * the subject changes, so a sent quote's terms can never be signed after
 * an edit. Absence is a normal no-op (most edits land on unsigned quotes),
 * and the count is returned for the audit trail.
 */
export async function voidSignatureRequestsForSubject(
  runner: SqlExecutor,
  orgId: string,
  subjectTable: string,
  subjectId: string,
): Promise<{ voided: number }> {
  const updated = await runner.execute<{ id: string }>(sql`
    update signature_requests set status = 'voided', voided_at = now(), updated_at = now()
     where org_id = ${orgId} and subject_table = ${subjectTable} and subject_id = ${subjectId}
       and status in ('sent', 'viewed')
    returning id`);
  // Zero rows is the normal no-op (most subjects have nothing open to
  // void); the count is returned for the caller's audit trail.
  return { voided: updated.rows.length };
}

export interface SaveQuoteTermStepInput {
  startsAfterMonths: number;
  unitPrice: string;
  quantity: string;
  escalatorPercent?: string | null;
}

export interface SaveQuoteTermInput {
  /** Null to open a new term on the line; set to re-price it. */
  termId?: string | null;
  quoteLineId: string;
  planId: string;
  planVersionId?: string | null;
  termMonths: number;
  startRule?: QuoteStartRule | null;
  billingTiming?: QuoteBillingTiming | null;
  cotermSubscriptionId?: string | null;
  steps: SaveQuoteTermStepInput[];
}

export interface SaveQuoteTermResult {
  termId: string;
  schedule: RampSchedule;
  tcv: string;
  /** Open signature requests voided by this re-price (re-send to sign). */
  voided: number;
}

function exactMoneyInput(value: string, label: string, min: "zero" | "positive"): string {
  let units: bigint;
  try {
    units = toUnits(value);
  } catch {
    throw new QuoteToCashError(`${label} is not a readable amount — enter it as digits with up to four decimals`);
  }
  if (min === "positive" ? units <= 0n : units < 0n) {
    throw new QuoteToCashError(
      min === "positive"
        ? `${label} must be more than zero`
        : `${label} cannot be negative`,
    );
  }
  return value;
}

function exactPercentInput(value: string | null | undefined, label: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new QuoteToCashError(`${label} is not a readable percent — enter it as digits, for example 7.5 for seven and a half percent`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < -100 || numeric > 100) {
    throw new QuoteToCashError(`${label} must sit between -100 and 100 percent`);
  }
  return value.trim();
}

/**
 * Save a quote's subscription term: validate the plan, price and ramp,
 * replace the term's steps, and void any open signature request — the
 * presentation hash changed, so a sent quote must be re-sent, never signed
 * stale. Only draft quotes re-price; approval locks the terms.
 */
export async function saveQuoteTerm(
  orgId: string,
  actorId: string,
  quoteId: string,
  input: SaveQuoteTermInput,
): Promise<SaveQuoteTermResult> {
  if (!Number.isSafeInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 120) {
    throw new QuoteToCashError("Term length must be between 1 and 120 months");
  }
  if (!input.steps.length) throw new QuoteToCashError("A subscription term needs at least one ramp period");
  const steps: RampStepInput[] = input.steps.map((step, index) => {
    if (!Number.isSafeInteger(step.startsAfterMonths) || step.startsAfterMonths < 0) {
      throw new QuoteToCashError(`Ramp period ${index} must start a whole number of months into the term`);
    }
    return {
      id: "",
      periodIndex: index,
      startsAfterMonths: step.startsAfterMonths,
      unitPrice: exactMoneyInput(step.unitPrice, `Ramp period ${index} price`, "zero"),
      quantity: exactMoneyInput(step.quantity, `Ramp period ${index} quantity`, "positive"),
      escalatorPercent: exactPercentInput(step.escalatorPercent, `Ramp period ${index} escalator`),
    };
  });
  // Pure validation first: gaps, overlaps, and out-of-term periods refuse
  // before anything is written.
  const schedule = resolveRampSchedule(input.termMonths, steps);
  return withOrgTransaction(orgId, async () => {
    await assertQuoteToCashEnabled(db, orgId);
    const settings = await getQuoteToCashSettings(orgId, db);
    const quote = await loadQuote(db, orgId, quoteId);
    if (quote.status !== "draft") {
      throw new QuoteToCashError(
        `This quote is ${quote.status} — only draft quotes re-price their subscription terms; void and re-draft to change them`,
      );
    }
    const line = (
      await db.execute<{ id: string }>(sql`
        select id from document_lines
         where id = ${input.quoteLineId} and org_id = ${orgId} and document_id = ${quoteId}`)
    ).rows[0];
    if (!line) {
      throw new QuoteToCashError("That quote line is not on this quote — refresh the quote and try again");
    }
    const plan = (
      await db.execute<{ id: string }>(sql`
        select id from subscription_plans where id = ${input.planId} and org_id = ${orgId} and is_active`)
    ).rows[0];
    if (!plan) throw new QuoteToCashError("That plan is not an active plan — pick an active subscription plan");
    if (input.planVersionId) {
      const version = (
        await db.execute<{ id: string }>(sql`
          select id from subscription_plan_versions
           where id = ${input.planVersionId} and org_id = ${orgId} and plan_id = ${input.planId}`)
      ).rows[0];
      if (!version) throw new QuoteToCashError("That plan version is not on this plan — re-price from the plan's versions");
    }
    if (input.cotermSubscriptionId) {
      const anchor = (
        await db.execute<{ id: string }>(sql`
          select id from subscriptions where id = ${input.cotermSubscriptionId} and org_id = ${orgId}`)
      ).rows[0];
      if (!anchor) {
        throw new QuoteToCashError("That co-term subscription is not in this organization — pick a live subscription");
      }
    }
    const startRule = input.startRule ?? settings.defaultStartRule;
    const billingTiming = input.billingTiming ?? settings.defaultBillingTiming;
    let termId = input.termId ?? null;
    if (termId) {
      const updated = (
        await db.execute<{ id: string }>(sql`
          update quote_subscription_terms
             set plan_id = ${input.planId}, plan_version_id = ${input.planVersionId ?? null},
                 term_months = ${input.termMonths}, start_rule = ${startRule},
                 billing_timing = ${billingTiming}, coterm_subscription_id = ${input.cotermSubscriptionId ?? null},
                 updated_at = now(), updated_by = ${actorId}
           where id = ${termId} and org_id = ${orgId} and quote_id = ${quoteId}
          returning id`)
      ).rows[0];
      // Under row-level security an unscoped update silently matches nothing,
      // so zero rows is raised, never treated as a saved term.
      if (!updated) throw new QuoteToCashError("That subscription term is not on this quote — refresh the quote and try again");
      await db.execute(sql`delete from quote_ramp_steps where org_id = ${orgId} and term_id = ${termId}`);
    } else {
      try {
        termId = (
          await db.execute<{ id: string }>(sql`
            insert into quote_subscription_terms
              (org_id, quote_id, quote_line_id, plan_id, plan_version_id, term_months,
               start_rule, billing_timing, coterm_subscription_id, created_by, updated_by)
            values (${orgId}, ${quoteId}, ${input.quoteLineId}, ${input.planId}, ${input.planVersionId ?? null},
                    ${input.termMonths}, ${startRule}, ${billingTiming}, ${input.cotermSubscriptionId ?? null},
                    ${actorId}, ${actorId})
            returning id`)
        ).rows[0]?.id ?? null;
      } catch (error) {
        // One term per quote line: a twin save converges on the existing
        // term instead of pricing the line twice.
        if (!isUniqueViolation(error)) throw error;
        termId = (
          await db.execute<{ id: string }>(sql`
            select id from quote_subscription_terms
             where org_id = ${orgId} and quote_id = ${quoteId} and quote_line_id = ${input.quoteLineId}`)
        ).rows[0]?.id ?? null;
      }
      if (!termId) throw new QuoteToCashError("The subscription term was not recorded");
    }
    for (const step of steps) {
      await db.execute(sql`
        insert into quote_ramp_steps
          (org_id, term_id, period_index, starts_after_months, unit_price, quantity, escalator_percent, created_by, updated_by)
        values (${orgId}, ${termId}, ${step.periodIndex}, ${step.startsAfterMonths},
                ${step.unitPrice}, ${step.quantity}, ${step.escalatorPercent}, ${actorId}, ${actorId})`);
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'quote_subscription_terms', ${termId}, ${input.termId ? "update" : "insert"},
              ${JSON.stringify({ after: { quote: quoteId, plan: input.planId, months: input.termMonths } })}::jsonb,
              ${actorId})`);
    const { voided } = await voidSignatureRequestsForSubject(db, orgId, QUOTE_SUBJECT_TABLE, quoteId);
    if (voided > 0) {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'documents', ${quoteId}, 'update',
                ${JSON.stringify({ after: { quoteToCash: "terms repriced, signature voided" } })}::jsonb,
                ${actorId})`);
    }
    return { termId, schedule, tcv: schedule.tcv, voided };
  });
}

/**
 * Remove a quote's subscription term with its ramp. Only draft quotes shed
 * terms; the voided signature requests (if any) force a re-send.
 */
export async function deleteQuoteTerm(
  orgId: string,
  actorId: string,
  quoteId: string,
  termId: string,
): Promise<{ voided: number }> {
  return withOrgTransaction(orgId, async () => {
    await assertQuoteToCashEnabled(db, orgId);
    const quote = await loadQuote(db, orgId, quoteId);
    if (quote.status !== "draft") {
      throw new QuoteToCashError(`This quote is ${quote.status} — only draft quotes shed subscription terms`);
    }
    const deleted = (
      await db.execute<{ id: string }>(sql`
        delete from quote_subscription_terms
         where id = ${termId} and org_id = ${orgId} and quote_id = ${quoteId}
        returning id`)
    ).rows;
    if (deleted.length !== 1) {
      throw new QuoteToCashError("That subscription term is not on this quote — refresh the quote and try again");
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'quote_subscription_terms', ${termId}, 'delete',
              ${JSON.stringify({ before: { quote: quoteId } })}::jsonb,
              ${actorId})`);
    const { voided } = await voidSignatureRequestsForSubject(db, orgId, QUOTE_SUBJECT_TABLE, quoteId);
    return { voided };
  });
}

export interface SaveQuoteToCashSettingsInput {
  maxDiscountPercent: string;
  autoActivateOnSign: boolean;
  defaultBillingTiming: QuoteBillingTiming;
  defaultStartRule: QuoteStartRule;
  signatureExpiryDays: number;
  orderFormTemplateId?: string | null;
}

type QuoteToCashPolicyRow = {
  id: string;
  max_discount_percent: string;
  auto_activate_on_sign: boolean;
  default_billing_timing: string;
  default_start_rule: string;
  signature_expiry_days: number;
  order_form_template_id: string | null;
};

function policyEvidence(row: QuoteToCashPolicyRow) {
  return {
    maxDiscountPercent: row.max_discount_percent,
    autoActivateOnSign: row.auto_activate_on_sign,
    defaultBillingTiming: row.default_billing_timing,
    defaultStartRule: row.default_start_rule,
    signatureExpiryDays: row.signature_expiry_days,
    orderFormTemplateId: row.order_form_template_id,
  };
}

/** Serialize singleton creation, replacement and reset before taking org locks. */
async function lockQuoteToCashPolicy(orgId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'quote-to-cash-policy:' + orgId}, 0))`);
}

/**
 * Save the org's quote-to-cash policy (Setup's single policy row). Every
 * field is validated by name before the upsert; an unknown template refuses
 * with the re-pick remedy instead of storing a dangling reference.
 */
export async function saveQuoteToCashSettings(
  orgId: string,
  actorId: string,
  input: SaveQuoteToCashSettingsInput,
): Promise<QuoteToCashSettings> {
  if (!/^\d+(\.\d+)?$/.test(input.maxDiscountPercent.trim()) || Number(input.maxDiscountPercent) < 0 || Number(input.maxDiscountPercent) > 100) {
    throw new QuoteToCashError("The discount threshold must be a percent between 0 and 100");
  }
  if (!Number.isSafeInteger(input.signatureExpiryDays) || input.signatureExpiryDays < 1 || input.signatureExpiryDays > 90) {
    throw new QuoteToCashError("Signature expiry must be between 1 and 90 days");
  }
  if (input.orderFormTemplateId !== undefined && input.orderFormTemplateId !== null) {
    if (!isUuid(input.orderFormTemplateId)) {
      throw new QuoteToCashError("That order-form template is not a template id — pick one in the PDF template designer");
    }
  }
  return withOrgTransaction(orgId, async () => {
    await lockQuoteToCashPolicy(orgId);
    await assertQuoteToCashEnabled(db, orgId);
    if (input.orderFormTemplateId) {
      const template = (
        await db.execute<{ id: string }>(sql`
          select id from pdf_templates
           where id = ${input.orderFormTemplateId} and org_id = ${orgId} and is_active`)
      ).rows[0];
      if (!template) {
        throw new QuoteToCashError("That order-form template is not an active template of this organization — pick one in the PDF template designer");
      }
    }
    const before = (await db.execute<QuoteToCashPolicyRow>(sql`
      select id, max_discount_percent::text as max_discount_percent, auto_activate_on_sign,
             default_billing_timing, default_start_rule, signature_expiry_days, order_form_template_id
        from quote_to_cash_settings where org_id = ${orgId} for update`)).rows[0];
    const row = (
      await db.execute<QuoteToCashPolicyRow>(sql`
        insert into quote_to_cash_settings
          (org_id, max_discount_percent, auto_activate_on_sign, default_billing_timing,
           default_start_rule, signature_expiry_days, order_form_template_id, created_by, updated_by)
        values (${orgId}, ${input.maxDiscountPercent.trim()}, ${input.autoActivateOnSign},
                ${input.defaultBillingTiming}, ${input.defaultStartRule}, ${input.signatureExpiryDays},
                ${input.orderFormTemplateId ?? null}, ${actorId}, ${actorId})
        -- Singleton policy row: a twin save converges on one row per org.
        on conflict (org_id) do update
           set max_discount_percent = excluded.max_discount_percent,
               auto_activate_on_sign = excluded.auto_activate_on_sign,
               default_billing_timing = excluded.default_billing_timing,
               default_start_rule = excluded.default_start_rule,
               signature_expiry_days = excluded.signature_expiry_days,
               order_form_template_id = excluded.order_form_template_id,
               updated_at = now(), updated_by = excluded.updated_by
        returning id, max_discount_percent::text as max_discount_percent, auto_activate_on_sign,
                  default_billing_timing, default_start_rule, signature_expiry_days, order_form_template_id`)
    ).rows[0];
    // The org-scoped upsert always writes exactly one row; zero rows is raised.
    if (!row) throw new QuoteToCashError("The quote-to-cash policy was not recorded");
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
      values (${orgId}, 'quote_to_cash_settings', ${row.id},
              ${before ? 'update' : 'insert'}, ${JSON.stringify({ before: before ? policyEvidence(before) : null, after: policyEvidence(row) })}::jsonb, ${actorId}, clock_timestamp())`);
    return {
      maxDiscountPercent: row.max_discount_percent,
      autoActivateOnSign: row.auto_activate_on_sign,
      defaultBillingTiming: row.default_billing_timing as QuoteBillingTiming,
      defaultStartRule: row.default_start_rule as QuoteStartRule,
      signatureExpiryDays: row.signature_expiry_days,
    };
  });
}

/**
 * Clear the org's quote-to-cash policy back to the working defaults. The row
 * must exist — resetting defaults that already apply is a caller error, not
 * a second success.
 */
export async function clearQuoteToCashSettings(orgId: string, actorId: string): Promise<{ cleared: boolean }> {
  return withOrgTransaction(orgId, async () => {
    await lockQuoteToCashPolicy(orgId);
    await assertQuoteToCashEnabled(db, orgId);
    const deleted = (
      await db.execute<QuoteToCashPolicyRow>(sql`
        delete from quote_to_cash_settings where org_id = ${orgId}
        returning id, max_discount_percent::text as max_discount_percent, auto_activate_on_sign,
                  default_billing_timing, default_start_rule, signature_expiry_days, order_form_template_id`)
    ).rows;
    if (deleted.length !== 1) {
      throw new QuoteToCashError("No quote-to-cash policy is saved — the working defaults already apply");
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
      values (${orgId}, 'quote_to_cash_settings', ${deleted[0]!.id}, 'delete',
              ${JSON.stringify({ before: policyEvidence(deleted[0]!), after: { ...SETTINGS_DEFAULTS, orderFormTemplateId: null }, reason: "Reset to defaults" })}::jsonb,
              ${actorId}, clock_timestamp())`);
    return { cleared: true };
  });
}

export interface QuoteCashPreview {
  quote: QuoteRow;
  terms: TermValuation[];
  tcv: string;
  listTcv: string;
  discountPct: string;
  floorBreached: boolean;
  signature: SignatureRequestRow | null;
  settings: QuoteToCashSettings;
  advancedSubscriptions: boolean;
  revenueContracts: boolean;
}

/** One ramp-priced term as the hosted signing page renders it. */
export interface PublicQuoteSignTerm {
  planName: string;
  termMonths: number;
  startRule: QuoteStartRule;
  billingTiming: QuoteBillingTiming;
  periods: Array<{ unitPrice: string; quantity: string; periodAmount: string }>;
  tcv: string;
}

/** Everything the hosted signing page renders. Null signature means no open
 * signing request remains — the page refuses with a re-send remedy instead
 * of rendering a form that cannot sign. */
export interface PublicQuoteSignView {
  quoteNumber: string;
  status: string;
  currency: string;
  total: string;
  documentDate: string;
  terms: PublicQuoteSignTerm[];
  tcv: string;
  signature: {
    status: string;
    signerName: string;
    signerEmail: string;
    expiresAt: string;
    consentText: string;
  } | null;
}

/**
 * The anonymous signing page's view: the possession token both authenticates
 * and scopes (no session, no org parameter). Re-validates by name first —
 * voided, expired and consumed links refuse through viewQuoteSignature —
 * then values the quoted terms off the same preview the drawer shows, so the
 * customer signs exactly what the sender priced.
 */
export async function publicQuoteSignView(token: string): Promise<PublicQuoteSignView> {
  const claims = verifyPossessionToken(QUOTE_SIGN_DOMAIN, token);
  if (!claims) {
    throw new QuoteToCashError("This signing link is invalid or expired — ask the sender to re-send it");
  }
  const view = await viewQuoteSignature(token);
  const preview = await quoteCashPreview(claims.orgId, view.quoteId);
  const signature = preview.signature;
  return {
    quoteNumber: preview.quote.documentNumber,
    status: preview.quote.status,
    currency: preview.quote.currency,
    total: preview.quote.total,
    documentDate: preview.quote.documentDate,
    terms: preview.terms.map((valuation) => ({
      planName: valuation.term.planName,
      termMonths: valuation.term.termMonths,
      startRule: valuation.term.startRule,
      billingTiming: valuation.term.billingTiming,
      periods: valuation.schedule.periods.map((period) => ({
        unitPrice: period.unitPrice,
        quantity: period.quantity,
        periodAmount: period.periodAmount,
      })),
      tcv: valuation.schedule.tcv,
    })),
    tcv: preview.tcv,
    signature: signature
      ? {
          status: signature.status,
          signerName: signature.signerName,
          signerEmail: signature.signerEmail,
          expiresAt: signature.expiresAt.toISOString(),
          consentText: signature.consentText ?? QUOTE_SIGNATURE_CONSENT,
        }
      : null,
  };
}

/**
 * Everything the quote drawer and the activation preview render: the quote,
 * every term valued, the open or latest signature request, and the policy
 * and capability flags the preview branches on. Read-only.
 */
export async function quoteCashPreview(orgId: string, quoteId: string): Promise<QuoteCashPreview> {
  return withOrgTransaction(orgId, async () => {
    const quote = await loadQuote(db, orgId, quoteId);
    const terms = await loadQuoteTerms(db, orgId, quoteId);
    const valuation = valueQuoteTerms(terms);
    const signature = await latestSignatureRequest(db, orgId, QUOTE_SUBJECT_TABLE, quoteId);
    const settings = await getQuoteToCashSettings(orgId, db);
    return {
      quote,
      terms: valuation.valuations,
      tcv: valuation.tcv,
      listTcv: valuation.listTcv,
      discountPct: valuation.discountPct,
      floorBreached: valuation.floorBreached,
      signature,
      settings,
      advancedSubscriptions: await orgFeatureEnabled(orgId, "advancedSubscriptions", db),
      revenueContracts: await revenueContractsEnabled(db, orgId),
    };
  });
}

export interface ActivateQuoteOptions {
  /** Explicit term start for custom start rules (YYYY-MM-DD). */
  startOn?: string | null;
  /** Subsidiary scope the caller was granted; null is unrestricted. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

export interface ActivateQuoteResult {
  subscriptionIds: string[];
  /** False when the quote was already activated (the existing subscriptions). */
  created: boolean;
  /** The subscription-scoped revenue contract, when contracts are on. */
  contractId: string | null;
}

/** Resolve a term's start date from its rule. Custom rules name no date on
 * the term itself, so they refuse unless the caller supplies one. */
export function resolveTermStart(
  term: Pick<QuoteTerm, "startRule">,
  quoteDate: string,
  startOn?: string | null,
): string {
  if (term.startRule === "quote_date") return quoteDate;
  if (term.startRule === "first_of_next_month") return addMonthsStart(quoteDate, 1);
  if (!startOn || !/^\d{4}-\d{2}-\d{2}$/.test(startOn)) {
    throw new QuoteToCashError(
      "This term starts on a custom date — supply the start date to activate it",
    );
  }
  return startOn;
}

/** Billing interval of a plan in months. Weekly plans bill too often for a
 * month-stepped ramp to schedule against. */
function planIntervalMonths(term: QuoteTerm): number {
  const count = term.planIntervalCount > 0 ? term.planIntervalCount : 1;
  if (term.planInterval === "monthly") return count;
  if (term.planInterval === "quarterly") return 3 * count;
  if (term.planInterval === "annually") return 12 * count;
  throw new QuoteToCashError(
    `Plan ${term.planName} bills ${term.planInterval} — ramp schedules need a monthly, quarterly or annual plan; activate a flat single-period term instead`,
  );
}

/**
 * The revenue-contract hook for activation: when scoped revenue contracts
 * are on, the new subscription gets its contract now (first billing then
 * converges on the same idempotent row); when off, nothing is written and
 * the caller sees exactly why. One named place owns the decision.
 */
async function maybeCreateActivationRevenueContract(
  runner: SqlExecutor,
  orgId: string,
  subscriptionId: string,
  contractName: string,
  partyId: string,
  currency: string | null,
  actorId: string | null,
): Promise<{ contractId: string | null }> {
  if (!(await revenueContractsEnabled(runner, orgId))) return { contractId: null };
  const { id } = await ensureScopedContract(
    runner,
    orgId,
    { kind: "subscription", id: subscriptionId, number: contractName },
    partyId,
    currency,
    actorId,
  );
  return { contractId: id };
}

/**
 * Activate a signed quote: one subscription per term, the agreed ramp frozen
 * into a minted plan version and scheduled as amendments, plus the
 * subscription-scoped revenue contract when contracts are on. One atomic
 * transaction; the (quote, term) uniqueness is the exactly-once authority —
 * a twin activation finds the existing subscriptions and creates nothing.
 */
export async function activateQuote(
  orgId: string,
  actorId: string | null,
  quoteId: string,
  opts: ActivateQuoteOptions = {},
): Promise<ActivateQuoteResult> {
  return withOrgTransaction(orgId, async () => {
    return activateQuoteLocked(db, orgId, actorId, quoteId, opts);
  });
}

async function activateQuoteLocked(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  quoteId: string,
  opts: ActivateQuoteOptions,
): Promise<ActivateQuoteResult> {
  // The gate lives on the locked path, not the wrappers: signing a quote
  // with auto-activation reaches this same function, and a disable racing
  // the signature must refuse the activation rather than post subscriptions
  // for a switched-off surface.
  await assertQuoteToCashEnabled(runner, orgId);
  const quote = await loadQuote(runner, orgId, quoteId);
  if (quote.status === "voided" || quote.status === "posted") {
    throw new QuoteToCashError(`This quote is ${quote.status} and can no longer be activated`);
  }
  if (!quote.partyId) {
    throw new QuoteToCashError(
      `Quote ${quote.documentNumber} names no customer — assign the quote's customer before activating it`,
    );
  }
  const terms = await loadQuoteTerms(runner, orgId, quoteId);
  if (!terms.length) {
    throw new QuoteToCashError(
      "This quote has no subscription lines — add a plan, quantity and term before activating it",
    );
  }
  // Already activated: converge on the existing subscriptions. The row lock
  // in loadQuote serializes twins, so the second activation always observes
  // the first one's rows.
  const prior = (
    await runner.execute<{ id: string }>(sql`
      select id from subscriptions
       where org_id = ${orgId} and source_quote_id = ${quoteId} order by created_at, id`)
  ).rows;
  if (prior.length > 0) {
    return { subscriptionIds: prior.map((r) => r.id), created: false, contractId: null };
  }
  const signature = await latestSignatureRequest(runner, orgId, QUOTE_SUBJECT_TABLE, quoteId);
  if (!signature || signature.status !== "signed") {
    throw new QuoteToCashError(
      "This quote has no signed signature — send it for signature and collect the customer's signature before activating it",
    );
  }
  const currentHash = await quotePresentationHash(runner, orgId, quoteId);
  if (currentHash !== signature.documentHash) {
    throw new QuoteToCashError(
      "The quote changed after it was signed — void the signature request, re-send it, and activate once it is signed again",
    );
  }
  const settings = await getQuoteToCashSettings(orgId, runner);
  const valuation = valueQuoteTerms(terms);
  const overThreshold = cmp(valuation.discountPct, settings.maxDiscountPercent) > 0;
  if ((overThreshold || valuation.floorBreached) && quote.status !== "approved") {
    throw new QuoteToCashError(
      "This quote's discount still needs Flows approval — approve it there before activating it",
    );
  }
  const advanced = await orgFeatureEnabled(orgId, "advancedSubscriptions", runner);
  for (const term of terms) {
    if (term.planCurrency && quote.currency && term.planCurrency !== quote.currency) {
      throw new QuoteToCashError(
        `Plan ${term.planName} prices in ${term.planCurrency} but the quote bills in ${quote.currency} — re-price the term in the quote's currency`,
      );
    }
    if (!advanced && term.steps.length > 1) {
      throw new QuoteToCashError(
        "This quote ramps prices across periods — turn on Advanced subscriptions (Company Settings → Features) so the ramp schedules as amendments, or flatten the term to one period",
      );
    }
    if (!advanced && term.cotermSubscriptionId) {
      throw new QuoteToCashError(
        "Co-term lines ride an advanced lifecycle — turn on Advanced subscriptions (Company Settings → Features) or clear the co-term target",
      );
    }
  }
  const actor = actorId ?? SYSTEM_ACTOR_ID_VALUE;
  const systemSource = actorId ? undefined : { origin: "quote-to-cash", detail: { quoteId } };

  // Freeze the agreed prices into one version per (plan, timing) group, then
  // activate each term onto its group's version. The quote is the commercial
  // agreement; the version is its effective-dated record. Each term's
  // component key is recorded here so the ramp amends the exact component
  // the version minted for it.
  const versionByGroup = new Map<string, { versionId: string; componentKey: string }>();
  if (advanced) {
    const groups = new Map<string, QuoteTerm[]>();
    for (const term of terms) {
      const key = `${term.planId}|${term.billingTiming}`;
      const group = groups.get(key) ?? [];
      group.push(term);
      groups.set(key, group);
    }
    let componentOrdinal = 0;
    for (const groupTerms of groups.values()) {
      const first = groupTerms[0]!;
      const starts = groupTerms.map((t) => resolveTermStart(t, quote.documentDate, opts.startOn));
      const earliest = starts.sort()[0]!;
      const versionId = await createPlanVersion(orgId, actor, {
        planId: first.planId,
        effectiveFrom: earliest,
        name: first.planName,
        currency: first.planCurrency,
        interval: (["weekly", "monthly", "quarterly", "annually"].includes(first.planInterval)
          ? first.planInterval
          : "monthly") as "weekly" | "monthly" | "quarterly" | "annually",
        intervalCount: first.planIntervalCount,
        billingTiming: first.billingTiming,
        changeSummary: `Quoted on ${quote.documentNumber}`,
        components: groupTerms.map((term) => {
          componentOrdinal += 1;
          const componentKey = `quote-term-${componentOrdinal}`;
          versionByGroup.set(term.id, { versionId: "", componentKey });
          const schedule = resolveRampSchedule(term.termMonths, term.steps);
          return {
            componentKey,
            name: term.planName,
            quantity: schedule.periods[0]!.quantity,
            unitPrice: schedule.periods[0]!.unitPrice,
            incomeAccountId: term.planIncomeAccountId,
            itemId: term.planItemId,
            taxCodeId: term.planTaxCodeId,
          };
        }),
      }, opts.allowedSubsidiaryIds ?? null);
      await publishPlanVersion(orgId, actor, versionId, opts.allowedSubsidiaryIds ?? null);
      for (const term of groupTerms) versionByGroup.get(term.id)!.versionId = versionId;
    }
  }

  const subscriptionIds: string[] = [];
  let contractId: string | null = null;
  for (const term of terms) {
    const termStart = resolveTermStart(term, quote.documentDate, opts.startOn);
    const termEnd = addMonthsClamped(termStart, term.termMonths);
    const schedule = resolveRampSchedule(term.termMonths, term.steps);
    const first = schedule.periods[0]!;
    const intervalMonths = term.billingTiming === "advance" ? 0 : planIntervalMonths(term);
    const nextBillOn = intervalMonths === 0 ? termStart : addMonthsClamped(termStart, intervalMonths);
    const inserted = (
      await runner.execute<{ id: string }>(sql`
        insert into subscriptions
          (org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on,
           current_period_start, auto_post, memo, source_quote_id, source_term_id, created_by, updated_by)
        values (${orgId}, ${quote.partyId}, ${term.planId}, ${first.quantity}, ${first.unitPrice}, 'active',
                ${termStart}, ${nextBillOn}, ${termStart}, false,
                ${`Activated from quote ${quote.documentNumber}`},
                ${quoteId}, ${term.id}, ${actor}, ${actor})
        -- An activation replay reuses the subscription selected below for this quote term.
        on conflict (org_id, source_quote_id, source_term_id) where source_quote_id is not null do nothing
        returning id`)
    ).rows[0];
    // The conflict above is expected and benign: a replayed activation
    // converges on the row its first attempt wrote.
    const subscriptionId =
      inserted?.id ??
      (
        await runner.execute<{ id: string }>(sql`
          select id from subscriptions
           where org_id = ${orgId} and source_quote_id = ${quoteId} and source_term_id = ${term.id}`)
      ).rows[0]?.id;
    if (!subscriptionId) throw new QuoteToCashError("The subscription was not recorded");
    await runner.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'subscriptions', ${subscriptionId}, 'insert',
              ${JSON.stringify({ after: { sourceQuote: quoteId, sourceTerm: term.id, plan: term.planId } })}::jsonb,
              ${actor})`);
    subscriptionIds.push(subscriptionId);

    if (advanced) {
      const frozen = versionByGroup.get(term.id);
      if (!frozen?.versionId) throw new QuoteToCashError("The agreed plan version was not recorded");
      await activateLifecycle(orgId, actor, {
        subscriptionId,
        planVersionId: frozen.versionId,
        termStartsOn: termStart,
        termEndsOn: termEnd,
      }, opts.allowedSubsidiaryIds ?? null);
      for (const period of schedule.periods.slice(1)) {
        const effectiveOn = addMonthsClamped(termStart, period.startsAfterMonths);
        await applyAmendment(orgId, systemSource ? SYSTEM_ACTOR_ID_VALUE : actor, {
          subscriptionId,
          type: "change_component",
          effectiveOn,
          idempotencyKey: `quote-activation:${quoteId}:${term.id}:p${period.periodIndex}`,
          componentKey: frozen.componentKey,
          quantity: period.quantity,
          unitPrice: period.unitPrice,
          reason: `Ramp period ${period.periodIndex} of quote ${quote.documentNumber}`,
        }, systemSource ? { system: systemSource, allowedSubsidiaryIds: opts.allowedSubsidiaryIds ?? null } : { allowedSubsidiaryIds: opts.allowedSubsidiaryIds ?? null });
      }
      if (term.cotermSubscriptionId) {
        await applyAmendment(orgId, systemSource ? SYSTEM_ACTOR_ID_VALUE : actor, {
          subscriptionId,
          type: "coterm",
          effectiveOn: termStart,
          idempotencyKey: `quote-activation:${quoteId}:${term.id}:coterm`,
          anchorSubscriptionId: term.cotermSubscriptionId,
          reason: `Co-term with subscription to quote ${quote.documentNumber}`,
        }, systemSource ? { system: systemSource, allowedSubsidiaryIds: opts.allowedSubsidiaryIds ?? null } : { allowedSubsidiaryIds: opts.allowedSubsidiaryIds ?? null });
      }
    }
    ({ contractId } = await maybeCreateActivationRevenueContract(
      runner, orgId, subscriptionId, `${quote.documentNumber} · ${term.planName}`,
      quote.partyId, quote.currency, actor,
    ).then((r) => ({ contractId: r.contractId ?? contractId })));
  }
  await runner.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'documents', ${quoteId}, 'update',
            ${JSON.stringify({ after: { quoteToCash: "activated", subscriptions: subscriptionIds, contract: contractId } })}::jsonb,
            ${actor})`);
  return { subscriptionIds, created: true, contractId };
}

/** One signature_reminder tick: requests seen, lapsed requests expired, reminders sent. */
export interface SignatureReminderScanResult {
  scanned: number;
  expired: number;
  reminded: number;
  orgErrors: Array<{ orgId: string; error: string }>;
}

/** Hours before expiry a still-open request earns its single reminder. */
const REMINDER_WINDOW_HOURS = 72;

/**
 * The signature_reminder scan: expire lapsed requests and send each
 * soon-expiring request its single reminder. The reminder rotates the
 * possession token (the stored hash is replaced, so the emailed link is
 * fresh and any earlier copy dies) and defers the email through a
 * deterministic flow_email row — the occurrence key is the once-guard, so
 * twin ticks converge on one email and a loser restores the hash it
 * replaced instead of stranding two live links.
 */
export async function runSignatureReminderScan(): Promise<SignatureReminderScanResult> {
  const result: SignatureReminderScanResult = { scanned: 0, expired: 0, reminded: 0, orgErrors: [] };
  const orgRows = (
    // bypass: scheduler-tick — the unscoped run lists every production
    // organization that switched quote-to-cash on.
    await withBypass(async () => {
      return await db.execute<{ orgId: string }>(sql`
        select distinct organization.id as "orgId"
          from orgs organization
         where organization.env_kind = 'production'
           and (organization.settings->'features'->>'quoteToCash') = 'true'
      `);
    })
  ).rows;
  for (const { orgId } of orgRows) {
    try {
      const one = await runOneOrgSignatureReminders(orgId);
      result.scanned += one.scanned;
      result.expired += one.expired;
      result.reminded += one.reminded;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.orgErrors.push({ orgId, error: message.slice(0, 500) });
    }
  }
  return result;
}

async function runOneOrgSignatureReminders(
  orgId: string,
): Promise<{ scanned: number; expired: number; reminded: number }> {
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, "quoteToCash"))) return { scanned: 0, expired: 0, reminded: 0 };
    const expired = (
      await db.execute<{ id: string }>(sql`
        update signature_requests set status = 'expired', updated_at = now()
         where org_id = ${orgId} and status in ('sent', 'viewed') and expires_at < now()
        returning id`)
    ).rows.length;
    const due = (
      await db.execute<{
        id: string;
        subject_id: string;
        signer_name: string;
        signer_email: string;
        token_hash: string;
        expires_at: Date | string;
      }>(sql`
        select r.id, r.subject_id, r.signer_name, r.signer_email, r.token_hash, r.expires_at
          from signature_requests r
         where r.org_id = ${orgId} and r.status in ('sent', 'viewed')
           and r.expires_at >= now()
           and r.expires_at < now() + (${REMINDER_WINDOW_HOURS} || ' hours')::interval
           and not exists (
             select 1 from scheduler_outbox o
              where o.kind = 'flow_email'
                and o.occurrence_key = ${"signature-reminder:"} || r.id::text
           )
         order by r.expires_at`)
    ).rows;
    let reminded = 0;
    // Sequential rotation keeps twin ticks ordered per request.
    for (const request of due) {
      if (await remindOneSignatureRequest(orgId, request)) reminded += 1;
    }
    return { scanned: due.length, expired, reminded };
  });
}

async function remindOneSignatureRequest(
  orgId: string,
  request: {
    id: string;
    subject_id: string;
    signer_name: string;
    signer_email: string;
    token_hash: string;
    expires_at: Date | string;
  },
): Promise<boolean> {
  const quote = (
    await db.execute<{ document_number: string }>(sql`
      select document_number from documents
       where id = ${request.subject_id} and org_id = ${orgId}`)
  ).rows[0];
  if (!quote) return false;
  const orgName = (
    await db.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`)
  ).rows[0]?.name;
  if (!orgName) return false;
  const expiresAt = request.expires_at instanceof Date ? request.expires_at : new Date(request.expires_at);
  // A fresh possession token over the same request and expiry: the emailed
  // link verifies through the signing page exactly like the original send.
  const fresh = mintPossessionToken(QUOTE_SIGN_DOMAIN, orgId, request.id, expiresAt);
  const rotated = (
    await db.execute<{ id: string }>(sql`
      update signature_requests
         set token_hash = ${hashPossessionToken(fresh)}, updated_at = now()
       where id = ${request.id} and org_id = ${orgId} and token_hash = ${request.token_hash}
         and status in ('sent', 'viewed')
      returning id`)
  ).rows;
  // A twin tick rotated first: its email carries the live link, so this
  // rotation loses and nothing is sent twice.
  if (rotated.length !== 1) return false;
  const email = quoteSignatureReminderEmail({
    orgName,
    quoteNumber: quote.document_number,
    signerName: request.signer_name,
    signUrl: `${appBaseUrl()}/sign/quotes/${fresh}`,
    expiresDate: expiresAt.toISOString().slice(0, 10),
  });
  const enqueued = await enqueueFlowEmail({
    orgId,
    runId: request.id,
    occurrenceKey: `signature-reminder:${request.id}`,
    payload: { to: [request.signer_email], subject: email.subject, html: email.html, text: email.text },
  });
  if (!enqueued) {
    // The reminder already left on an earlier tick: restore the hash it
    // replaced so exactly one link stays live.
    await db.execute(sql`
      update signature_requests set token_hash = ${request.token_hash}, updated_at = now()
       where id = ${request.id} and org_id = ${orgId}`);
    return false;
  }
  return true;
}
