import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { fromUnits, mulRate, toUnits } from "@openbooks/engine/money/money";
import {
  createMatchWithJournal,
  type ReconciliationTotals,
} from "@openbooks/engine/banking/banking";
import {
  rankOpenDocuments,
  suggestOffsetFromHistory,
  type MatchReason,
  type OffsetHistoryEntry,
  type OpenDocumentProposal,
  type RankedOpenDocument,
} from "@openbooks/engine/banking/match-scoring";
import {
  creditItemsForParty,
  openItemsForParty,
  openItemsForSettlement,
  settlementRateObservations,
} from "@openbooks/engine/payments/payment-queries";
import {
  createPaymentDocument,
  subsidiaryFunctionalCurrency,
  updateDraftPayment,
} from "@openbooks/engine/payments/payment-documents";
import { postPaymentWithApplications } from "@openbooks/engine/payments/payment-posting";
import {
  canonicalSettlementRate,
  crossCurrencyAllocation,
  sameCurrencyAllocation,
  sourceSettlingTarget,
  type CrossCurrencyEvidence,
} from "@openbooks/engine/payments/settlement-policy";
import type { PaymentKind } from "@openbooks/engine/payments/payment-contracts";
import {
  resolvePaymentCurrencyBasis,
  runInvoiceWriteOffFlows,
  writeOffInvoiceInTransaction,
  type InvoiceWriteOffOutcome,
} from "@openbooks/engine/payments/documents";
import {
  planStatementSettlement,
  StatementSettlementError,
  type StatementSettlementPlan,
} from "@openbooks/engine/payments/statement-settlement";
import { PaymentError } from "@openbooks/engine/payments-core/payment-errors";
import { submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { runPostDocumentEffects } from "@openbooks/engine/ledger/posting-dispatch";
import { lockLedgerSetupFence } from "@openbooks/engine/organization/ledger-setup";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { can, resolveAuthzByUserId } from "./authz";
import { bankLegAmountInGlTerms } from "./banking-rules";
import { isFeatureEnabled } from "./features";

/**
 * Settling a bank line against the open invoices or bills it pays.
 *
 * An unmatched statement line whose amount equals the open balance of one
 * customer invoice (money in) or vendor bill (money out) — or of several
 * documents of one party on one control account — is proposed with the
 * reasons behind each proposal; so are, on document evidence, part payments
 * of a larger balance and overpayments of a smaller one. "Record payment and
 * match" then records the native customer receipt or vendor bill payment
 * through the same draft, approval-routing and posting services the Receipts
 * and Payments drawers use, funded from the line's own account on the line's
 * date, and matches the payment's bank line to the statement line.
 *
 * The operator decides how the line settles: the cash applied to each
 * document (oldest first by default), any cash left over (kept on account:
 * a customer's unapplied credit or a vendor prepayment), and whether a
 * short-paid remainder is written off — through the governed invoice
 * write-off on the customer side, or as a payment discount to a chosen
 * account on the vendor side. A line in a currency other than the legal
 * entity's functional currency is measured at the organization's evidenced
 * exchange rate, or at a rate the operator enters with its source and
 * reason; realized exchange differences post through the native settlement.
 *
 * Payment, write-offs and match commit in one transaction under the
 * statement line's lock: a concurrent attempt waits, then finds the line
 * matched and creates nothing, and any refusal (closed period, approval
 * routing, changed balances, permission, missing configuration) rolls back
 * the payment with the match.
 */

/** Open items considered for one line: earliest due first, at most this many. */
const SETTLEMENT_CANDIDATE_LIMIT = 500;
/** Documents in another currency with no recorded settlement rate listed for the operator, at most this many. */
const SETTLEMENT_UNRATED_LIMIT = 30;
/** Most open documents one recorded payment may settle from this screen. */
const MAX_SETTLED_DOCUMENTS = 20;
/** Confirmed matches consulted for offset-account suggestions. */
const OFFSET_HISTORY_LIMIT = 300;

export class SettlementMatchRefusal extends Error {
  override readonly name = "SettlementMatchRefusal";
  constructor(
    message: string,
    readonly status: number = 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

export type SettlementSide = "ar" | "ap";

interface SettlementLine {
  id: string;
  postedOn: string;
  amount: string;
  description: string | null;
  counterpartyRef: string | null;
  currency: string;
  accountId: string;
  accountType: string;
  accountSubsidiaryId: string | null;
  /** Statement amount in GL terms on the line's account (sign convention applied). */
  glAmount: string;
  side: SettlementSide;
  /** Positive magnitude the payment must total. */
  magnitude: string;
}

/**
 * Load an unmatched line on an open session of its own account, inside the
 * caller's scope. Out-of-scope or missing lines are the uniform not-found.
 */
async function loadSettlementLine(
  orgId: string,
  statementLineId: string,
  reconciliationId: string,
  scope: ReadonlySet<string> | null,
): Promise<SettlementLine> {
  const row = (
    await db.execute<{
      id: string;
      posted_on: string;
      amount: string;
      description: string | null;
      counterparty_ref: string | null;
      currency: string;
      account_id: string;
      account_type: string;
      account_subsidiary_id: string | null;
      match_status: string;
      possible_duplicate_of: string | null;
      recon_status: string | null;
      recon_currency: string | null;
      through_date: string | null;
    }>(
      sql`
    select l.id, l.posted_on::text as posted_on, l.amount::text as amount, l.description, l.counterparty_ref,
           l.currency, l.account_id, a.type as account_type, a.subsidiary_id as account_subsidiary_id,
           l.match_status, l.possible_duplicate_of,
           r.status as recon_status, r.currency as recon_currency, r.through_date::text as through_date
      from bank_statement_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join reconciliations r on r.id = ${reconciliationId} and r.org_id = l.org_id and r.account_id = l.account_id
     where l.id = ${statementLineId} and l.org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!row || !subsidiaryScopeAllows(scope, row.account_subsidiary_id))
    throw new ScopeNotFoundError();
  if (!row.recon_status) throw new ScopeNotFoundError();
  if (row.recon_status === "signed_off") {
    throw new SettlementMatchRefusal(
      "This reconciliation is signed off",
      409,
      "Open the account’s current reconciliation in Match Bank Data and match the line there.",
    );
  }
  if (row.match_status !== "unmatched") {
    throw new SettlementMatchRefusal(
      "This statement line is already matched or excluded",
      409,
      "Refresh Match Bank Data to see its current state.",
    );
  }
  if (row.possible_duplicate_of) {
    throw new SettlementMatchRefusal(
      "This statement line is flagged as a possible duplicate of an earlier import",
      409,
      "Clear the duplicate flag or exclude the line before recording a payment for it.",
    );
  }
  if (
    row.recon_currency !== row.currency ||
    (row.through_date !== null && row.posted_on > row.through_date)
  ) {
    throw new SettlementMatchRefusal(
      "This statement line is outside the reconciliation’s currency or cutoff",
      409,
      "Extend the reconciliation through the line’s date, then try again.",
    );
  }
  const glAmount = await bankLegAmountInGlTerms(
    orgId,
    row.account_id,
    row.account_type,
    reconciliationId,
    row.amount,
  );
  const units = toUnits(glAmount);
  if (units === 0n)
    throw new SettlementMatchRefusal(
      "A zero-amount statement line settles no invoice or bill",
      422,
      "Exclude the line instead.",
    );
  return {
    id: row.id,
    postedOn: row.posted_on,
    amount: row.amount,
    description: row.description,
    counterpartyRef: row.counterparty_ref,
    currency: row.currency,
    accountId: row.account_id,
    accountType: row.account_type,
    accountSubsidiaryId: row.account_subsidiary_id,
    glAmount,
    // Money into the bank account (a GL debit) is a customer receipt; money
    // out (a GL credit, including a card charge) pays a vendor bill.
    side: units > 0n ? "ar" : "ap",
    magnitude: fromUnits(units < 0n ? -units : units),
  };
}

function paymentPermissionFor(side: SettlementSide): "ar.pay" | "ap.pay" {
  return side === "ar" ? "ar.pay" : "ap.pay";
}

function permissionRefusal(side: SettlementSide): SettlementMatchRefusal {
  return side === "ar"
    ? new SettlementMatchRefusal(
        "missing permission: ar.pay — recording a customer receipt needs ar.pay",
        403,
        "Ask a user with Receive payments access to record it, or match an existing receipt from the ledger list.",
      )
    : new SettlementMatchRefusal(
        "missing permission: ap.pay — recording a vendor bill payment needs ap.pay",
        403,
        "Ask a user with Pay bills access to record it, or match an existing payment from the ledger list.",
      );
}

/** How a line in a foreign currency is measured in one legal entity's functional currency. */
export interface SettlementExchangeRate {
  functionalCurrency: string;
  /** The organization's evidenced rate on the line's date, or null when none is recorded. */
  rate: string | null;
  rateDate: string;
  /** Why no evidenced rate is available, when `rate` is null. */
  unavailable: string | null;
  /** Whether the operator may enter a rate (Multi-currency is on). */
  manualRateAllowed: boolean;
}

/** The organization's latest settlement-rate observation from the line's currency into a document's. */
export interface SettlementRateEvidence {
  fxRateId: string;
  /** Document-currency units per line-currency unit. */
  rate: string;
  asOf: string;
  source: string;
}

export interface CandidateDocument extends RankedOpenDocument {
  documentKind: string | null;
  postingDate: string;
  /** The document's transaction currency; `transactionOpen` is in it. */
  currency: string;
  /**
   * For a document in another currency: the line-currency cash that settles
   * its open balance at the evidenced rate, or null until a rate is entered.
   */
  lineEquivalent: string | null;
  /** The evidenced settlement rate for a document in another currency, if one is recorded. */
  settlementRate: SettlementRateEvidence | null;
}

/** Credit a party already has unapplied: receipts or payments on account and open credit memos. */
export interface UnappliedCredit {
  documentNumber: string;
  documentKind: string | null;
  currency: string;
  open: string;
}

export interface OpenDocumentCandidates {
  side: SettlementSide;
  /** Positive statement amount, in `currency`. */
  amount: string;
  currency: string;
  proposals: OpenDocumentProposal[];
  documents: CandidateDocument[];
  /** Unapplied credit of each listed party, which can settle its documents without this line. */
  unappliedCredits: Record<string, UnappliedCredit[]>;
  /** Exchange-rate basis per legal entity, for entities whose functional currency differs from the line's. */
  exchangeRates: Record<string, SettlementExchangeRate>;
  /** Whether the viewer may write off a short-paid remainder (ar.post on receipts; ap.pay already covers a bill payment's discount). */
  canWriteOff: boolean;
}

async function exchangeRateBasis(
  orgId: string,
  subsidiaryId: string,
  currency: string,
  onDate: string,
): Promise<{ fxRate: string; evidence: unknown }> {
  try {
    return await resolvePaymentCurrencyBasis(orgId, subsidiaryId, currency, onDate);
  } catch (error) {
    if (error instanceof PaymentError) {
      throw new SettlementMatchRefusal(
        error.message,
        422,
        "Record the dated rate in Setup → Exchange rates, or enter the rate this line was converted at with its source and reason.",
      );
    }
    throw error;
  }
}

async function exchangeRateFor(
  orgId: string,
  subsidiaryId: string,
  currency: string,
  onDate: string,
): Promise<SettlementExchangeRate | null> {
  const functionalCurrency = await subsidiaryFunctionalCurrency(db, orgId, subsidiaryId);
  if (!functionalCurrency || functionalCurrency === currency) return null;
  const manualRateAllowed = await isFeatureEnabled(orgId, "multiCurrency");
  try {
    const basis = await resolvePaymentCurrencyBasis(orgId, subsidiaryId, currency, onDate);
    return {
      functionalCurrency,
      rate: basis.fxRate,
      rateDate: onDate,
      unavailable: null,
      manualRateAllowed,
    };
  } catch (error) {
    if (!(error instanceof PaymentError)) throw error;
    return {
      functionalCurrency,
      rate: null,
      rateDate: onDate,
      unavailable: error.message,
      manualRateAllowed,
    };
  }
}

/**
 * Proposals for one unmatched line: open invoices (money in) or bills
 * (money out) in the line's currency, inside the bank account's legal entity
 * and the caller's scope, ranked with reasons — exact settlements first, then
 * evidenced part payments and overpayments. Disclosing open items needs the
 * matching payment permission, exactly as the open-items list does.
 */
export async function listOpenDocumentCandidates(
  orgId: string,
  userId: string,
  opts: { statementLineId: string; reconciliationId: string },
  scope: ReadonlySet<string> | null,
): Promise<OpenDocumentCandidates> {
  const line = await loadSettlementLine(orgId, opts.statementLineId, opts.reconciliationId, scope);
  const viewer = await resolveAuthzByUserId(orgId, userId);
  if (viewer === null || !can(viewer, paymentPermissionFor(line.side)))
    throw permissionRefusal(line.side);
  const items = await openItemsForSettlement({
    orgId,
    side: line.side,
    currency: line.currency,
    targetTransactionAmount: line.magnitude,
    includeOtherCurrencies: true,
    subsidiaryId: line.accountSubsidiaryId,
    allowedSubsidiaryIds: scope,
    limit: SETTLEMENT_CANDIDATE_LIMIT,
  });
  const byLine = new Map(items.map((item) => [item.lineId, item]));
  // A document in another currency is ranked by the line-currency cash that
  // settles it at the organization's latest settlement rate; without a rate
  // it is still listed, for the operator to state one.
  const foreignCurrencies = [
    ...new Set(items.map((item) => item.currency).filter((currency) => currency !== line.currency)),
  ];
  const rates = new Map(
    (
      await settlementRateObservations(orgId, line.currency, foreignCurrencies, line.postedOn, 1)
    ).map((rate) => [
      rate.toCurrency,
      { fxRateId: rate.id, rate: rate.rate, asOf: rate.asOf, source: rate.source },
    ]),
  );
  const lineEquivalent = new Map<string, string | null>();
  for (const item of items) {
    if (item.currency === line.currency) continue;
    const rate = rates.get(item.currency);
    lineEquivalent.set(
      item.lineId,
      rate ? sourceSettlingTarget(item.transactionOpen, rate.rate).source : null,
    );
  }
  const rankable = items.filter(
    (item) => item.currency === line.currency || lineEquivalent.get(item.lineId),
  );
  const ranked = rankOpenDocuments(
    {
      postedOn: line.postedOn,
      amount: line.magnitude,
      description: line.description,
      counterpartyRef: line.counterpartyRef,
    },
    rankable.map((item) => ({
      openLineId: item.lineId,
      partyId: item.partyId,
      partyName: item.partyName,
      accountId: item.accountId,
      subsidiaryId: item.subsidiaryId,
      documentNumber: item.documentNumber,
      referenceNumber: item.referenceNumber,
      entryNumber: item.entryNumber,
      dueDate: item.dueDate,
      transactionOpen:
        item.currency === line.currency ? item.transactionOpen : lineEquivalent.get(item.lineId)!,
    })),
  );
  const unrated = items
    .filter((item) => item.currency !== line.currency && !lineEquivalent.get(item.lineId))
    .slice(0, SETTLEMENT_UNRATED_LIMIT)
    .map((item): RankedOpenDocument => ({
      openLineId: item.lineId,
      partyId: item.partyId,
      partyName: item.partyName,
      accountId: item.accountId,
      subsidiaryId: item.subsidiaryId,
      documentNumber: item.documentNumber,
      referenceNumber: item.referenceNumber,
      entryNumber: item.entryNumber,
      dueDate: item.dueDate,
      transactionOpen: item.transactionOpen,
      score: 0,
      reasons: [],
    }));
  const documents: CandidateDocument[] = [...ranked.documents, ...unrated].map((doc) => {
    const item = byLine.get(doc.openLineId)!;
    const foreign = item.currency !== line.currency;
    return {
      ...doc,
      // Every document states its own open balance in its own currency.
      transactionOpen: fromUnits(toUnits(item.transactionOpen)),
      documentKind: item.documentKind,
      postingDate: item.postingDate,
      currency: item.currency,
      lineEquivalent: foreign ? (lineEquivalent.get(doc.openLineId) ?? null) : null,
      settlementRate: foreign ? (rates.get(item.currency) ?? null) : null,
    };
  });
  const exchangeRates: Record<string, SettlementExchangeRate> = {};
  for (const subsidiaryId of new Set(
    documents.map((doc) => doc.subsidiaryId).filter((id): id is string => !!id),
  )) {
    const basis = await exchangeRateFor(orgId, subsidiaryId, line.currency, line.postedOn);
    if (basis) exchangeRates[subsidiaryId] = basis;
  }
  // A party that already holds unapplied credit may not need this line at
  // all for some of its documents: the drawer suggests applying it first.
  const unappliedCredits: Record<string, UnappliedCredit[]> = {};
  for (const partyId of new Set(documents.map((doc) => doc.partyId))) {
    const credits = await creditItemsForParty(partyId, line.side, orgId, scope, {
      includeUnappliedPayments: true,
    });
    if (credits.length > 0) {
      unappliedCredits[partyId] = credits.map((credit) => ({
        documentNumber: credit.documentNumber ?? credit.entryNumber,
        documentKind: credit.documentKind,
        currency: credit.currency,
        open: fromUnits(toUnits(credit.transactionOpen)),
      }));
    }
  }
  return {
    side: line.side,
    amount: line.magnitude,
    currency: line.currency,
    proposals: ranked.proposals,
    documents,
    unappliedCredits,
    exchangeRates,
    canWriteOff: line.side === "ar" ? can(viewer, "ar.create") && can(viewer, "ar.post") : true,
  };
}

export interface RecordPaymentMatchInput {
  statementLineId: string;
  reconciliationId: string;
  /** Open journal lines of the invoices or bills the line settles. */
  openLineIds: string[];
  /** The open balance the operator saw for each line; a change refuses. */
  expectedOpen: Record<string, string>;
  /**
   * Cash applied to each selected document. Absent settles every selected
   * document in full, which the statement amount must then equal exactly.
   * Cash beyond the applications stays on account for the party.
   */
  applied?: Record<string, string> | null;
  /** Write off each selected document's short-paid remainder, with the reason (and, on a bill payment, the discount account). */
  writeOff?: { reason: string; discountAccountId?: string | null } | null;
  /** A rate the operator enters for a foreign-currency line, overriding the evidenced rate. */
  exchangeRate?: { rate: string; source: string; reason: string } | null;
  /**
   * Settlement rate for each selected document in another currency than the
   * line (document-currency units per line-currency unit): a recorded
   * observation by id, or a rate the operator states with its source and
   * reason. A document with neither settles at the organization's latest
   * recorded observation on the line's date.
   */
  settlementRates?: Record<
    string,
    { fxRateId: string } | { rate: string; source: string; reason: string }
  > | null;
}

export interface RecordPaymentMatchResult {
  paymentId: string;
  documentNumber: string;
  kind: PaymentKind;
  totals: ReconciliationTotals;
  /** Cash kept on account for the party (unapplied credit or vendor prepayment). */
  onAccount: string;
  /** Short-paid balances written off, in total. */
  writeOffTotal: string;
  /** Credit memos the customer-side write-offs were recorded as. */
  writeOffDocuments: string[];
  /** Set when the committed payment's follow-up effects need a retry from the payment. */
  effectsError: string | null;
}

/**
 * Record the receipt or bill payment a statement line represents and match
 * it, in one transaction. Lock order follows payment posting — organization
 * row, ledger-setup fence, then the bank account, session and statement line
 * (createMatchWithJournal) — so the payment kernel's own fences are already
 * held when it runs inside the line lock.
 */
export async function recordPaymentAndMatch(
  orgId: string,
  userId: string,
  input: RecordPaymentMatchInput,
  scope: ReadonlySet<string> | null,
): Promise<RecordPaymentMatchResult> {
  const openLineIds = [...new Set(input.openLineIds)];
  if (openLineIds.length === 0)
    throw new SettlementMatchRefusal("Select at least one open invoice or bill", 422);
  if (openLineIds.length > MAX_SETTLED_DOCUMENTS) {
    throw new SettlementMatchRefusal(
      `Select at most ${MAX_SETTLED_DOCUMENTS} documents for one payment`,
      422,
      "Record the payment from Receipts or Payments to settle more documents at once.",
    );
  }
  const writeOffReason = input.writeOff ? input.writeOff.reason.trim() : null;
  if (input.writeOff && !writeOffReason) {
    throw new SettlementMatchRefusal(
      "A write-off needs a reason",
      422,
      "State why the short-paid balance is written off.",
    );
  }
  const preflight = await loadSettlementLine(
    orgId,
    input.statementLineId,
    input.reconciliationId,
    scope,
  );
  const permission = paymentPermissionFor(preflight.side);
  // Re-resolved per request, never a cached grant: a revocation fails closed.
  const actor = await resolveAuthzByUserId(orgId, userId);
  if (actor === null || !can(actor, permission)) throw permissionRefusal(preflight.side);
  // A customer write-off creates and posts a native credit memo. A vendor
  // payment discount remains part of the payment authorized by ap.pay.
  if (input.writeOff && preflight.side === "ar") {
    for (const required of ["ar.create", "ar.post"]) {
      if (!can(actor, required))
        throw new SettlementMatchRefusal(
          `missing permission: ${required} — writing off a short-paid invoice balance creates and posts a credit memo`,
          403,
          "Ask a user who can create and post customer credits to record it, or record the receipt without the write-off.",
        );
    }
  }
  const kind: PaymentKind = preflight.side === "ar" ? "customer_payment" : "vendor_payment";

  let recorded: { id: string; documentNumber: string } | null = null;
  let plan: StatementSettlementPlan | null = null;
  const writeOffs: InvoiceWriteOffOutcome[] = [];
  const totals = await withOrgTransaction(orgId, async () => {
    await db.execute(sql`select id from orgs where id = ${orgId} for no key update`);
    await lockLedgerSetupFence(db, orgId, "shared");
    return createMatchWithJournal(
      {
        reconciliationId: input.reconciliationId,
        statementLineIds: [input.statementLineId],
        matchedBy: "manual",
        createJournal: async () => {
          // The statement line is locked and unmatched here; re-read it so
          // the payment is built from the locked row, not the preflight.
          const line = await loadSettlementLine(
            orgId,
            input.statementLineId,
            input.reconciliationId,
            scope,
          );
          if (
            line.side !== preflight.side ||
            toUnits(line.magnitude) !== toUnits(preflight.magnitude)
          ) {
            throw new SettlementMatchRefusal(
              "This statement line changed while the payment was being prepared",
              409,
              "Refresh Match Bank Data and review the proposals again.",
            );
          }
          const settlement = await settleableAllocations(orgId, line, openLineIds, input, scope);
          plan = settlement.plan;
          const payment = await createPaymentDocument({
            orgId,
            kind,
            createdBy: userId,
            allowedSubsidiaryIds: scope,
            partyId: settlement.partyId,
            bankAccountId: line.accountId,
            documentDate: line.postedOn,
            memo: line.description,
            subsidiaryId: settlement.subsidiaryId,
            currency: line.currency,
            ...(settlement.currencyBasis ? { currencyBasis: settlement.currencyBasis } : {}),
          });
          recorded = payment;
          try {
            await updateDraftPayment(
              payment.id,
              {
                allocations: settlement.allocations,
                referenceNumber: line.counterpartyRef,
                onAccountAmount: settlement.plan.onAccount,
                ...(settlement.discount
                  ? {
                      discountAmount: settlement.discount.amount,
                      discountAccountId: settlement.discount.accountId,
                    }
                  : {}),
                ...(settlement.explicitFx ? { explicitFx: settlement.explicitFx } : {}),
              },
              userId,
              orgId,
              { allowedSubsidiaryIds: scope },
            );
          } catch (error) {
            if (error instanceof PaymentError)
              throw new SettlementMatchRefusal(
                error.message,
                422,
                "Review the settlement amounts, account and exchange rate, then record it again.",
              );
            throw error;
          }
          // The bank leg must move exactly the statement amount: a payment
          // that withholds contractor tax pays less than it settles.
          const saved = (
            await db.execute<{ total: string }>(
              sql`
            select total::text as total from documents where org_id = ${orgId} and id = ${payment.id}`,
              "objects",
            )
          )[0];
          if (!saved || toUnits(saved.total) !== toUnits(line.magnitude)) {
            throw new SettlementMatchRefusal(
              `The payment would move ${saved ? fromUnits(toUnits(saved.total)) : "nothing"} through the bank, not the statement line's ${line.magnitude}; nothing was recorded`,
              422,
              "Record the payment from Payments, where its withholding is shown, and match its bank line to this statement line.",
            );
          }
          const submission = await submitAndReleaseIfUngated(kind, payment.id, userId);
          if (submission.flowError) {
            throw new SettlementMatchRefusal(
              `The payment’s approval could not be routed: ${submission.flowError}`,
              422,
              "Fix the approval flow in Setup, or record the payment from Receipts or Payments.",
            );
          }
          if (submission.gated) {
            throw new SettlementMatchRefusal(
              "Payments require approval in this organization, so this one cannot be posted and matched in one step; nothing was recorded",
              409,
              kind === "customer_payment"
                ? "Record the receipt from Receipts; once it is approved and posted, match its bank line to this statement line."
                : "Record the payment from Payments; once it is approved and posted, match its bank line to this statement line.",
            );
          }
          const { entryId } = await postPaymentWithApplications(
            payment.id,
            settlement.allocations,
            userId,
            "ui",
            { deferEffects: true },
          );
          const bankLines = await db.execute<{ id: string }>(
            sql`
            select id from journal_lines
             where org_id = ${orgId} and entry_id = ${entryId} and account_id = ${line.accountId}
          `,
            "objects",
          );
          if (bankLines.length !== 1) {
            throw new SettlementMatchRefusal(
              "The recorded payment did not post exactly one line to this bank account, so it cannot be matched to the statement line; nothing was recorded",
              422,
              "Record the payment from Receipts or Payments and match it manually.",
            );
          }
          // A customer's short-paid remainder is written off through the
          // governed invoice write-off, after the receipt applied its cash.
          for (const doc of settlement.writeOffDocuments) {
            try {
              writeOffs.push(
                await writeOffInvoiceInTransaction(
                  orgId,
                  userId,
                  {
                    invoiceId: doc.documentId,
                    amount: doc.amount,
                    date: line.postedOn,
                    reason: writeOffReason!,
                    idempotencyKey: randomUUID(),
                  },
                  scope,
                ),
              );
            } catch (error) {
              if (error instanceof PaymentError) {
                throw new SettlementMatchRefusal(
                  `${doc.label} cannot be written off: ${error.message}`,
                  422,
                  "Record the receipt without the write-off, or correct the cause and record it again.",
                );
              }
              throw error;
            }
          }
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'bank_statement_lines', ${line.id}, 'update', ${JSON.stringify({
              operation: "record_payment_match",
              reconciliationId: input.reconciliationId,
              paymentDocumentId: payment.id,
              paymentKind: kind,
              amount: line.magnitude,
              currency: line.currency,
              openLineIds: settlement.allocations.map((allocation) => allocation.openLineId),
              applied: Object.fromEntries(
                settlement.plan.documents.map((doc) => [doc.openLineId, doc.applied]),
              ),
              onAccount: settlement.plan.onAccount,
              writeOff: input.writeOff
                ? {
                    total: settlement.plan.writeOffTotal,
                    reason: writeOffReason,
                    creditMemoIds: writeOffs.map((outcome) => outcome.result.creditMemoId),
                    discountAccountId: settlement.discount?.accountId ?? null,
                  }
                : null,
              exchangeRate: settlement.explicitFx
                ? {
                    rate: settlement.explicitFx.rate,
                    source: settlement.explicitFx.source,
                    reason: settlement.explicitFx.reason,
                  }
                : settlement.currencyBasis
                  ? { rate: settlement.currencyBasis.fxRate, source: "exchange_rates" }
                  : null,
              journalLineId: bankLines[0]!.id,
            })}::jsonb, ${userId})
          `);
          return bankLines[0]!.id;
        },
      },
      { orgId, userId, allowedSubsidiaryIds: scope },
    );
  });
  const payment = recorded as { id: string; documentNumber: string } | null;
  const settled = plan as StatementSettlementPlan | null;
  if (!payment || !settled) throw new Error("payment was not recorded");
  // Effects run after commit, as on the Receipts and Payments drawers. The
  // payment and match are durable either way; a failure is reported so the
  // operator can retry the effects from the payment record.
  let effectsError: string | null = null;
  try {
    await runPostDocumentEffects(payment.id, "draft");
  } catch (error) {
    effectsError = error instanceof Error ? error.message : String(error);
  }
  for (const outcome of writeOffs) await runInvoiceWriteOffFlows(orgId, userId, outcome);
  return {
    paymentId: payment.id,
    documentNumber: payment.documentNumber,
    kind,
    totals,
    onAccount: settled.onAccount,
    writeOffTotal: settled.writeOffTotal,
    writeOffDocuments: writeOffs.map((outcome) => outcome.result.creditMemoNumber),
    effectsError,
  };
}

/**
 * The settlement-rate evidence for a document in another currency than the
 * line, as the payment drawers record it: a recorded observation (provider
 * evidence, cited by id and re-validated at posting), or a rate the operator
 * states with its source and reason (manual evidence). With neither, the
 * organization's latest observation on the line's date; with none recorded,
 * the line refuses.
 */
async function crossCurrencyEvidence(
  orgId: string,
  line: SettlementLine,
  currency: string,
  label: string,
  stated: { fxRateId: string } | { rate: string; source: string; reason: string } | null,
): Promise<CrossCurrencyEvidence> {
  if (stated && "rate" in stated) {
    const source = stated.source.trim();
    const reason = stated.reason.trim();
    if (!source || reason.length < 8) {
      throw new SettlementMatchRefusal(
        `The settlement rate for ${label} needs its source and a reason of at least eight characters`,
        422,
        "State where the rate comes from and why it applies.",
      );
    }
    let rate: string;
    try {
      rate = canonicalSettlementRate(stated.rate);
    } catch (error) {
      if (error instanceof PaymentError)
        throw new SettlementMatchRefusal(
          `The settlement rate for ${label}: ${error.message}`,
          422,
          "Enter a positive rate with at most ten decimal places.",
        );
      throw error;
    }
    return { rate, source: "manual", reference: `${source} · ${reason}` };
  }
  const observations = await settlementRateObservations(
    orgId,
    line.currency,
    [currency],
    line.postedOn,
    10,
  );
  const observation = stated
    ? observations.find((row) => row.id === stated.fxRateId)
    : observations[0];
  if (!observation) {
    throw new SettlementMatchRefusal(
      stated
        ? `The settlement rate chosen for ${label} is not a recorded ${line.currency}→${currency} rate on or before ${line.postedOn}`
        : `${label} is in ${currency} and no ${line.currency}→${currency} settlement rate is recorded on or before ${line.postedOn}`,
      422,
      "Record the dated rate in Setup → Exchange rates, or enter the rate the bank applied with its source and reason.",
    );
  }
  return {
    rate: observation.rate,
    source: "provider",
    reference: `${observation.source} · ${observation.asOf}`,
    fxRateId: observation.id,
  };
}

/**
 * Validate the selection against live open items and build the settlement:
 * one party, one legal entity, one control account, settlement-rate evidence
 * for every document in another currency than the line,
 * nothing reserved by a payment run, every open balance exactly what the
 * operator saw, and the operator's allocation (or, absent one, every
 * document in full, equal to the statement amount exactly). A foreign
 * currency line carries its exchange-rate evidence; a write-off names how
 * each side records it.
 */
async function settleableAllocations(
  orgId: string,
  line: SettlementLine,
  openLineIds: readonly string[],
  input: RecordPaymentMatchInput,
  scope: ReadonlySet<string> | null,
) {
  const owners = await db.execute<{
    id: string;
    party_id: string | null;
    subsidiary_id: string | null;
  }>(
    sql`
    select id, party_id, subsidiary_id from journal_lines
     where org_id = ${orgId} and id = any(${sql.param([...openLineIds])}::uuid[]) and is_open_item
  `,
    "objects",
  );
  if (
    owners.length !== openLineIds.length ||
    owners.some((owner) => !subsidiaryScopeAllows(scope, owner.subsidiary_id))
  ) {
    throw new ScopeNotFoundError();
  }
  const partyIds = new Set(owners.map((owner) => owner.party_id));
  const subsidiaryIds = new Set(owners.map((owner) => owner.subsidiary_id));
  const partyId = owners[0]!.party_id;
  const subsidiaryId = owners[0]!.subsidiary_id;
  if (partyIds.size !== 1 || !partyId) {
    throw new SettlementMatchRefusal(
      "One payment settles documents of a single customer or vendor",
      422,
      "Select documents of one party, or record separate payments.",
    );
  }
  if (subsidiaryIds.size !== 1 || !subsidiaryId) {
    throw new SettlementMatchRefusal(
      "One payment settles documents of a single legal entity",
      422,
      "Select documents of one subsidiary, or record separate payments.",
    );
  }
  if (line.accountSubsidiaryId && line.accountSubsidiaryId !== subsidiaryId) {
    throw new SettlementMatchRefusal(
      "These documents belong to a different legal entity than the bank account",
      422,
      "Settle them from a bank account of their own subsidiary, or record an intercompany transfer.",
    );
  }
  const functionalCurrency = await subsidiaryFunctionalCurrency(db, orgId, subsidiaryId);
  if (!functionalCurrency) {
    throw new SettlementMatchRefusal(
      "The legal entity of these documents has no functional currency",
      422,
      "Set the subsidiary’s base currency in Setup, then record the payment again.",
    );
  }
  // A foreign line is measured at the operator's entered rate, else at the
  // organization's evidenced rate on the line's date; with neither it refuses.
  let explicitFx: {
    rate: string;
    source: string;
    reason: string;
    fromCurrency: string;
    toCurrency: string;
    rateDate: string;
  } | null = null;
  let currencyBasis: { fxRate: string; evidence: unknown } | null = null;
  if (functionalCurrency !== line.currency) {
    if (input.exchangeRate) {
      explicitFx = {
        rate: input.exchangeRate.rate,
        source: input.exchangeRate.source,
        reason: input.exchangeRate.reason,
        fromCurrency: line.currency,
        toCurrency: functionalCurrency,
        rateDate: line.postedOn,
      };
    } else {
      currencyBasis = await exchangeRateBasis(orgId, subsidiaryId, line.currency, line.postedOn);
    }
  } else if (input.exchangeRate) {
    throw new SettlementMatchRefusal(
      `This ${line.currency} line is in the legal entity’s functional currency, so it takes no exchange rate`,
      422,
      "Remove the exchange rate and record the payment again.",
    );
  }
  const live = new Map(
    (await openItemsForParty(partyId, line.side, orgId, new Set([subsidiaryId]))).map((item) => [
      item.lineId,
      item,
    ]),
  );
  const accountIds = new Set<string>();
  const documents = [];
  for (const openLineId of openLineIds) {
    const item = live.get(openLineId);
    if (!item) {
      throw new SettlementMatchRefusal(
        "A selected document is no longer open",
        409,
        "Refresh the proposals; it may have been paid, credited or voided.",
      );
    }
    const label = item.documentNumber ?? item.entryNumber;
    if (item.reservedByRun) {
      throw new SettlementMatchRefusal(
        `${label} is reserved by payment run ${item.reservedByRun.runNumber}, which will pay it`,
        409,
        "Pay it through that run, or release it from the run first.",
      );
    }
    const evidence =
      item.currency === line.currency
        ? null
        : await crossCurrencyEvidence(
            orgId,
            line,
            item.currency,
            label,
            input.settlementRates?.[openLineId] ?? null,
          );
    const expected = input.expectedOpen[openLineId];
    if (expected === undefined || toUnits(expected) !== toUnits(item.transactionOpen)) {
      throw new SettlementMatchRefusal(
        `${label}'s open balance is now ${fromUnits(toUnits(item.transactionOpen))}${expected === undefined ? "" : `, not ${fromUnits(toUnits(expected))}`}`,
        409,
        "Refresh the proposals and review the amounts again.",
      );
    }
    accountIds.add(item.accountId);
    // The settlement works in the line's currency: a document in another
    // currency is open for the cash that settles its balance at its rate.
    const settling = evidence ? sourceSettlingTarget(item.transactionOpen, evidence.rate) : null;
    documents.push({
      item,
      label,
      evidence,
      open: settling ? settling.source : fromUnits(toUnits(item.transactionOpen)),
    });
  }
  if (accountIds.size !== 1) {
    throw new SettlementMatchRefusal(
      "One payment settles documents on a single receivable or payable account",
      422,
      "Select documents on one control account, or record separate payments.",
    );
  }
  const fullSettlement = input.applied === undefined || input.applied === null;
  if (fullSettlement) {
    const total = documents.reduce((sum, doc) => sum + toUnits(doc.open), 0n);
    if (total !== toUnits(line.magnitude)) {
      throw new SettlementMatchRefusal(
        `The selected documents total ${fromUnits(total)}; the statement line is ${line.magnitude}`,
        422,
        "Select documents whose open balances add up to the statement amount, or review the settlement to pay part of a balance or keep the rest on account.",
      );
    }
  }
  let plan: StatementSettlementPlan;
  try {
    plan = planStatementSettlement({
      lineAmount: line.magnitude,
      documents: documents.map((doc) => ({
        openLineId: doc.item.lineId,
        open: doc.open,
        dueDate: doc.item.dueDate,
        postingDate: doc.item.postingDate,
        label: doc.label,
      })),
      applied: fullSettlement
        ? Object.fromEntries(documents.map((doc) => [doc.item.lineId, doc.open]))
        : input.applied!,
      writeOff: !!input.writeOff,
    });
  } catch (error) {
    if (error instanceof StatementSettlementError)
      throw new SettlementMatchRefusal(error.message, 422, error.remedy);
    throw error;
  }
  const byLine = new Map(documents.map((doc) => [doc.item.lineId, doc]));
  // A bill payment records the written-off remainder as its discount: each
  // bill is settled in full, the bank pays the cash, and the discount
  // account takes the difference. A receipt applies only its cash; the
  // invoice write-off clears the rest after posting.
  let discount: { amount: string; accountId: string } | null = null;
  const writeOffDocuments: { documentId: string; amount: string; label: string }[] = [];
  if (input.writeOff && toUnits(plan.writeOffTotal) > 0n) {
    if (line.side === "ap") {
      const accountId = input.writeOff.discountAccountId ?? null;
      if (!accountId) {
        throw new SettlementMatchRefusal(
          "Choose the account the short-paid difference is written off to",
          422,
          "Pick a discount or write-off account, then record the payment again.",
        );
      }
      discount = { amount: plan.writeOffTotal, accountId };
    } else {
      for (const planned of plan.documents) {
        if (toUnits(planned.writeOff) === 0n) continue;
        const doc = byLine.get(planned.openLineId)!;
        if (doc.item.documentKind !== "customer_invoice" || !doc.item.documentId) {
          throw new SettlementMatchRefusal(
            `${doc.label} is not a customer invoice, so its short-paid balance cannot be written off here`,
            422,
            "Apply the full amount to it, or leave its remainder open.",
          );
        }
        // The invoice keeps, in its own currency, what the cash did not settle;
        // the invoice write-off states that to two decimal places, and a
        // remainder finer than that cannot be written off exactly.
        const settledTarget = doc.evidence
          ? toUnits(mulRate(planned.applied, doc.evidence.rate))
          : toUnits(planned.applied);
        const units = toUnits(doc.item.transactionOpen) - settledTarget;
        if (units % 100n !== 0n) {
          throw new SettlementMatchRefusal(
            `${doc.label}'s remainder of ${fromUnits(units)} has more than two decimal places, so it cannot be written off exactly`,
            422,
            "Apply an amount with at most two decimal places so the remainder can be written off.",
          );
        }
        writeOffDocuments.push({
          documentId: doc.item.documentId,
          amount: fromUnits(units).slice(0, -2),
          label: doc.label,
        });
      }
    }
  }
  // A bill payment's discount settles with its cash: the allocation consumes
  // both from the payment, in the payment's currency, and a document in
  // another currency extinguishes exactly their cross-rate.
  const allocations = plan.documents.map((planned) => {
    const source = discount
      ? fromUnits(toUnits(planned.applied) + toUnits(planned.writeOff))
      : planned.applied;
    const evidence = byLine.get(planned.openLineId)!.evidence;
    return evidence
      ? crossCurrencyAllocation(planned.openLineId, source, evidence)
      : sameCurrencyAllocation(planned.openLineId, source);
  });
  return {
    partyId,
    subsidiaryId,
    allocations,
    plan,
    discount,
    writeOffDocuments,
    explicitFx,
    currencyBasis,
  };
}

// ---------------------------------------------------------------------------
// Offset account suggestions from history
// ---------------------------------------------------------------------------

export interface OffsetSuggestion {
  offsetAccountId: string;
  reasons: MatchReason[];
}

/**
 * For each line, the offset account most recently used by a confirmed match
 * (manual or rule, or automatic inside a signed-off session) whose statement
 * line names the same payee. Only categorizing journals count — a single
 * offset account, no invoice or payment behind it. Suggestions only: the
 * reviewer confirms through the add-journal action, which re-validates the
 * account against the caller's scope.
 */
export async function offsetSuggestionsFromHistory(
  orgId: string,
  accountId: string,
  lines: ReadonlyArray<{
    id: string;
    description: string | null;
    counterparty_ref?: string | null;
  }>,
): Promise<Record<string, OffsetSuggestion>> {
  if (lines.length === 0) return {};
  const history: OffsetHistoryEntry[] = (
    await db.execute<{
      description: string | null;
      counterparty_ref: string | null;
      matched_on: string;
      offset_account_id: string;
    }>(
      sql`
    select sl.description, sl.counterparty_ref, sl.posted_on::text as matched_on,
           min(other.account_id::text) as offset_account_id
      from reconciliation_matches m
      join reconciliations r on r.id = m.reconciliation_id and r.org_id = m.org_id
      join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
      join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      -- Live entries only: a reversed categorization is not a precedent to suggest again.
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
      left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
      join journal_lines other on other.entry_id = jl.entry_id and other.org_id = jl.org_id
                              and other.account_id <> r.account_id
     where m.org_id = ${orgId} and r.account_id = ${accountId}
       and (m.matched_by in ('manual', 'rule') or r.status = 'signed_off')
       and (je.source_document_id is null or d.kind = 'journal')
     group by m.id, m.created_at, sl.description, sl.counterparty_ref, sl.posted_on
    having count(distinct other.account_id) = 1
     order by m.created_at desc, m.id
     limit ${OFFSET_HISTORY_LIMIT}
  `,
      "objects",
    )
  ).map((row) => ({
    description: row.description,
    counterpartyRef: row.counterparty_ref,
    offsetAccountId: row.offset_account_id,
    matchedOn: row.matched_on,
  }));
  const out: Record<string, OffsetSuggestion> = {};
  for (const line of lines) {
    const suggestion = suggestOffsetFromHistory(
      { description: line.description, counterpartyRef: line.counterparty_ref ?? null },
      history,
    );
    if (suggestion) out[line.id] = suggestion;
  }
  return out;
}
