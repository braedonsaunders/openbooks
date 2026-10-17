import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/db'
import { fromUnits, toUnits } from '@openbooks/engine/money/money'
import { createMatchWithJournal, type ReconciliationTotals } from '@openbooks/engine/banking/banking'
import {
  rankOpenDocuments,
  suggestOffsetFromHistory,
  type MatchReason,
  type OffsetHistoryEntry,
  type OpenDocumentProposal,
  type RankedOpenDocument,
} from '@openbooks/engine/banking/match-scoring'
import { openItemsForParty, openItemsForSettlement } from '@openbooks/engine/payments/payment-queries'
import { createPaymentDocument, subsidiaryFunctionalCurrency, updateDraftPayment } from '@openbooks/engine/payments/payment-documents'
import { postPaymentWithApplications } from '@openbooks/engine/payments/payment-posting'
import { sameCurrencyAllocation } from '@openbooks/engine/payments/settlement-policy'
import type { PaymentKind } from '@openbooks/engine/payments/payment-contracts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/flows/module'
import { runPostDocumentEffects } from '@openbooks/engine/ledger/posting-dispatch'
import { lockLedgerSetupFence } from '@openbooks/engine/organization/ledger-setup'
import { ScopeNotFoundError, subsidiaryScopeAllows } from '@openbooks/engine/organization/scope'
import { can, resolveAuthzByUserId } from './authz'
import { bankLegAmountInGlTerms } from './banking-rules'

/**
 * Settling a bank line against the open invoices or bills it pays.
 *
 * An unmatched statement line whose amount equals the open balance of one
 * customer invoice (money in) or vendor bill (money out) — or of several
 * documents of one party on one control account — is proposed with the
 * reasons behind each proposal. "Record payment and match" then records the
 * native customer receipt or vendor bill payment through the same draft,
 * approval-routing and posting services the Receipts and Payments drawers
 * use, funded from the line's own account on the line's date, and matches
 * the payment's bank line to the statement line. Payment and match commit in
 * one transaction under the statement line's lock: a concurrent attempt
 * waits, then finds the line matched and creates nothing, and any refusal
 * (closed period, approval routing, changed balances, permission) rolls
 * back the payment with the match.
 */

/** Open items considered for one line: earliest due first, at most this many. */
const SETTLEMENT_CANDIDATE_LIMIT = 500
/** Most open documents one recorded payment may settle from this screen. */
const MAX_SETTLED_DOCUMENTS = 20
/** Confirmed matches consulted for offset-account suggestions. */
const OFFSET_HISTORY_LIMIT = 300

export class SettlementMatchRefusal extends Error {
  override readonly name = 'SettlementMatchRefusal'
  constructor(message: string, readonly status: number = 422, readonly remedy?: string) {
    super(message)
  }
}

export type SettlementSide = 'ar' | 'ap'

interface SettlementLine {
  id: string
  postedOn: string
  amount: string
  description: string | null
  counterpartyRef: string | null
  currency: string
  accountId: string
  accountType: string
  accountSubsidiaryId: string | null
  /** Statement amount in GL terms on the line's account (sign convention applied). */
  glAmount: string
  side: SettlementSide
  /** Positive magnitude the payment must total. */
  magnitude: string
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
  const row = (await db.execute<{
    id: string; posted_on: string; amount: string; description: string | null; counterparty_ref: string | null
    currency: string; account_id: string; account_type: string; account_subsidiary_id: string | null
    match_status: string; possible_duplicate_of: string | null
    recon_status: string | null; recon_currency: string | null; through_date: string | null
  }>(sql`
    select l.id, l.posted_on::text as posted_on, l.amount::text as amount, l.description, l.counterparty_ref,
           l.currency, l.account_id, a.type as account_type, a.subsidiary_id as account_subsidiary_id,
           l.match_status, l.possible_duplicate_of,
           r.status as recon_status, r.currency as recon_currency, r.through_date::text as through_date
      from bank_statement_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      left join reconciliations r on r.id = ${reconciliationId} and r.org_id = l.org_id and r.account_id = l.account_id
     where l.id = ${statementLineId} and l.org_id = ${orgId}
  `)).rows[0]
  if (!row || !subsidiaryScopeAllows(scope, row.account_subsidiary_id)) throw new ScopeNotFoundError()
  if (!row.recon_status) throw new ScopeNotFoundError()
  if (row.recon_status === 'signed_off') {
    throw new SettlementMatchRefusal('This reconciliation is signed off', 409, 'Open the account’s current reconciliation in Match Bank Data and match the line there.')
  }
  if (row.match_status !== 'unmatched') {
    throw new SettlementMatchRefusal('This statement line is already matched or excluded', 409, 'Refresh Match Bank Data to see its current state.')
  }
  if (row.possible_duplicate_of) {
    throw new SettlementMatchRefusal('This statement line is flagged as a possible duplicate of an earlier import', 409, 'Clear the duplicate flag or exclude the line before recording a payment for it.')
  }
  if (row.recon_currency !== row.currency || (row.through_date !== null && row.posted_on > row.through_date)) {
    throw new SettlementMatchRefusal('This statement line is outside the reconciliation’s currency or cutoff', 409, 'Extend the reconciliation through the line’s date, then try again.')
  }
  const glAmount = await bankLegAmountInGlTerms(orgId, row.account_id, row.account_type, reconciliationId, row.amount)
  const units = toUnits(glAmount)
  if (units === 0n) throw new SettlementMatchRefusal('A zero-amount statement line settles no invoice or bill', 422, 'Exclude the line instead.')
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
    side: units > 0n ? 'ar' : 'ap',
    magnitude: fromUnits(units < 0n ? -units : units),
  }
}

function paymentPermissionFor(side: SettlementSide): 'ar.pay' | 'ap.pay' {
  return side === 'ar' ? 'ar.pay' : 'ap.pay'
}

function permissionRefusal(side: SettlementSide): SettlementMatchRefusal {
  return side === 'ar'
    ? new SettlementMatchRefusal('missing permission: ar.pay — recording a customer receipt needs ar.pay', 403, 'Ask a user with Receive payments access to record it, or match an existing receipt from the ledger list.')
    : new SettlementMatchRefusal('missing permission: ap.pay — recording a vendor bill payment needs ap.pay', 403, 'Ask a user with Pay bills access to record it, or match an existing payment from the ledger list.')
}

export interface OpenDocumentCandidates {
  side: SettlementSide
  /** Positive amount the documents must total, in `currency`. */
  amount: string
  currency: string
  proposals: OpenDocumentProposal[]
  documents: (RankedOpenDocument & { documentKind: string | null; postingDate: string })[]
}

/**
 * Proposals for one unmatched line: open invoices (money in) or bills
 * (money out) in the line's currency, inside the bank account's legal entity
 * and the caller's scope, ranked with reasons. Disclosing open items needs
 * the matching payment permission, exactly as the open-items list does.
 */
export async function listOpenDocumentCandidates(
  orgId: string,
  userId: string,
  opts: { statementLineId: string; reconciliationId: string },
  scope: ReadonlySet<string> | null,
): Promise<OpenDocumentCandidates> {
  const line = await loadSettlementLine(orgId, opts.statementLineId, opts.reconciliationId, scope)
  const viewer = await resolveAuthzByUserId(orgId, userId)
  if (viewer === null || !can(viewer, paymentPermissionFor(line.side))) throw permissionRefusal(line.side)
  const items = await openItemsForSettlement({
    orgId,
    side: line.side,
    currency: line.currency,
    maxTransactionAmount: line.magnitude,
    subsidiaryId: line.accountSubsidiaryId,
    allowedSubsidiaryIds: scope,
    limit: SETTLEMENT_CANDIDATE_LIMIT,
  })
  const byLine = new Map(items.map((item) => [item.lineId, item]))
  const ranked = rankOpenDocuments(
    { postedOn: line.postedOn, amount: line.magnitude, description: line.description, counterpartyRef: line.counterpartyRef },
    items.map((item) => ({
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
    })),
  )
  return {
    side: line.side,
    amount: line.magnitude,
    currency: line.currency,
    proposals: ranked.proposals,
    documents: ranked.documents.map((doc) => ({
      ...doc,
      documentKind: byLine.get(doc.openLineId)?.documentKind ?? null,
      postingDate: byLine.get(doc.openLineId)?.postingDate ?? '',
    })),
  }
}

export interface RecordPaymentMatchInput {
  statementLineId: string
  reconciliationId: string
  /** Open journal lines of the invoices or bills to settle in full. */
  openLineIds: string[]
  /** The open balance the operator saw for each line; a change refuses. */
  expectedOpen: Record<string, string>
}

export interface RecordPaymentMatchResult {
  paymentId: string
  documentNumber: string
  kind: PaymentKind
  totals: ReconciliationTotals
  /** Set when the committed payment's follow-up effects need a retry from the payment. */
  effectsError: string | null
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
  const openLineIds = [...new Set(input.openLineIds)]
  if (openLineIds.length === 0) throw new SettlementMatchRefusal('Select at least one open invoice or bill', 422)
  if (openLineIds.length > MAX_SETTLED_DOCUMENTS) {
    throw new SettlementMatchRefusal(`Select at most ${MAX_SETTLED_DOCUMENTS} documents for one payment`, 422, 'Record the payment from Receipts or Payments to settle more documents at once.')
  }
  const preflight = await loadSettlementLine(orgId, input.statementLineId, input.reconciliationId, scope)
  const permission = paymentPermissionFor(preflight.side)
  // Re-resolved per request, never a cached grant: a revocation fails closed.
  const actor = await resolveAuthzByUserId(orgId, userId)
  if (actor === null || !can(actor, permission)) throw permissionRefusal(preflight.side)
  const kind: PaymentKind = preflight.side === 'ar' ? 'customer_payment' : 'vendor_payment'

  let recorded: { id: string; documentNumber: string } | null = null
  const totals = await withOrgTransaction(orgId, async () => {
    await db.execute(sql`select id from orgs where id = ${orgId} for no key update`)
    await lockLedgerSetupFence(db, orgId, 'shared')
    return createMatchWithJournal(
      {
        reconciliationId: input.reconciliationId,
        statementLineIds: [input.statementLineId],
        matchedBy: 'manual',
        createJournal: async () => {
          // The statement line is locked and unmatched here; re-read it so
          // the payment is built from the locked row, not the preflight.
          const line = await loadSettlementLine(orgId, input.statementLineId, input.reconciliationId, scope)
          if (line.side !== preflight.side || toUnits(line.magnitude) !== toUnits(preflight.magnitude)) {
            throw new SettlementMatchRefusal('This statement line changed while the payment was being prepared', 409, 'Refresh Match Bank Data and review the proposals again.')
          }
          const allocations = await settleableAllocations(orgId, line, openLineIds, input.expectedOpen, scope)
          const payment = await createPaymentDocument({
            orgId,
            kind,
            createdBy: userId,
            allowedSubsidiaryIds: scope,
            partyId: allocations.partyId,
            bankAccountId: line.accountId,
            documentDate: line.postedOn,
            memo: line.description,
            subsidiaryId: allocations.subsidiaryId,
            currency: line.currency,
          })
          recorded = payment
          await updateDraftPayment(
            payment.id,
            { allocations: allocations.allocations, referenceNumber: line.counterpartyRef },
            userId,
            orgId,
            { allowedSubsidiaryIds: scope },
          )
          const submission = await submitAndReleaseIfUngated(kind, payment.id, userId)
          if (submission.flowError) {
            throw new SettlementMatchRefusal(`The payment’s approval could not be routed: ${submission.flowError}`, 422, 'Fix the approval flow in Setup, or record the payment from Receipts or Payments.')
          }
          if (submission.gated) {
            throw new SettlementMatchRefusal(
              'Payments require approval in this organization, so this one cannot be posted and matched in one step; nothing was recorded',
              409,
              kind === 'customer_payment'
                ? 'Record the receipt from Receipts; once it is approved and posted, match its bank line to this statement line.'
                : 'Record the payment from Payments; once it is approved and posted, match its bank line to this statement line.',
            )
          }
          const { entryId } = await postPaymentWithApplications(payment.id, allocations.allocations, userId, 'ui', { deferEffects: true })
          const bankLines = (await db.execute<{ id: string }>(sql`
            select id from journal_lines
             where org_id = ${orgId} and entry_id = ${entryId} and account_id = ${line.accountId}
          `)).rows
          if (bankLines.length !== 1) {
            throw new SettlementMatchRefusal('The recorded payment did not post exactly one line to this bank account, so it cannot be matched to the statement line; nothing was recorded', 422, 'Record the payment from Receipts or Payments and match it manually.')
          }
          await db.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'bank_statement_lines', ${line.id}, 'update', ${JSON.stringify({
              operation: 'record_payment_match',
              reconciliationId: input.reconciliationId,
              paymentDocumentId: payment.id,
              paymentKind: kind,
              amount: line.magnitude,
              currency: line.currency,
              openLineIds: allocations.allocations.map((allocation) => allocation.openLineId),
              journalLineId: bankLines[0]!.id,
            })}::jsonb, ${userId})
          `)
          return bankLines[0]!.id
        },
      },
      { orgId, userId, allowedSubsidiaryIds: scope },
    )
  })
  const payment = recorded as { id: string; documentNumber: string } | null
  if (!payment) throw new Error('payment was not recorded')
  // Effects run after commit, as on the Receipts and Payments drawers. The
  // payment and match are durable either way; a failure is reported so the
  // operator can retry the effects from the payment record.
  let effectsError: string | null = null
  try {
    await runPostDocumentEffects(payment.id, 'draft')
  } catch (error) {
    effectsError = error instanceof Error ? error.message : String(error)
  }
  return { paymentId: payment.id, documentNumber: payment.documentNumber, kind, totals, effectsError }
}

/**
 * Validate the selection against live open items and build full-settlement
 * allocations: one party, one legal entity, one control account, the line's
 * currency, nothing reserved by a payment run, every open balance exactly
 * what the operator saw, and the total exactly the statement amount.
 */
async function settleableAllocations(
  orgId: string,
  line: SettlementLine,
  openLineIds: readonly string[],
  expectedOpen: Record<string, string>,
  scope: ReadonlySet<string> | null,
) {
  const owners = (await db.execute<{ id: string; party_id: string | null; subsidiary_id: string | null }>(sql`
    select id, party_id, subsidiary_id from journal_lines
     where org_id = ${orgId} and id = any(${sql.param([...openLineIds])}::uuid[]) and is_open_item
  `)).rows
  if (owners.length !== openLineIds.length || owners.some((owner) => !subsidiaryScopeAllows(scope, owner.subsidiary_id))) {
    throw new ScopeNotFoundError()
  }
  const partyIds = new Set(owners.map((owner) => owner.party_id))
  const subsidiaryIds = new Set(owners.map((owner) => owner.subsidiary_id))
  const partyId = owners[0]!.party_id
  const subsidiaryId = owners[0]!.subsidiary_id
  if (partyIds.size !== 1 || !partyId) {
    throw new SettlementMatchRefusal('One payment settles documents of a single customer or vendor', 422, 'Select documents of one party, or record separate payments.')
  }
  if (subsidiaryIds.size !== 1 || !subsidiaryId) {
    throw new SettlementMatchRefusal('One payment settles documents of a single legal entity', 422, 'Select documents of one subsidiary, or record separate payments.')
  }
  if (line.accountSubsidiaryId && line.accountSubsidiaryId !== subsidiaryId) {
    throw new SettlementMatchRefusal('These documents belong to a different legal entity than the bank account', 422, 'Settle them from a bank account of their own subsidiary, or record an intercompany transfer.')
  }
  const functionalCurrency = await subsidiaryFunctionalCurrency(db, orgId, subsidiaryId)
  if (functionalCurrency !== line.currency) {
    throw new SettlementMatchRefusal(
      `This ${line.currency} line settles in a legal entity whose functional currency is ${functionalCurrency ?? 'unavailable'}, which needs a settlement exchange rate`,
      422,
      line.side === 'ar'
        ? 'Record the receipt from Receipts with its exchange rate, then match its bank line to this statement line.'
        : 'Record the payment from Payments with its exchange rate, then match its bank line to this statement line.',
    )
  }
  const live = new Map((await openItemsForParty(partyId, line.side, orgId, new Set([subsidiaryId]))).map((item) => [item.lineId, item]))
  const allocations = []
  const accountIds = new Set<string>()
  let total = 0n
  for (const openLineId of openLineIds) {
    const item = live.get(openLineId)
    if (!item) {
      throw new SettlementMatchRefusal('A selected document is no longer open', 409, 'Refresh the proposals; it may have been paid, credited or voided.')
    }
    const label = item.documentNumber ?? item.entryNumber
    if (item.reservedByRun) {
      throw new SettlementMatchRefusal(`${label} is reserved by payment run ${item.reservedByRun.runNumber}, which will pay it`, 409, 'Pay it through that run, or release it from the run first.')
    }
    if (item.currency !== line.currency) {
      throw new SettlementMatchRefusal(`${label} is in ${item.currency}, but the statement line is in ${line.currency}`, 422, 'Select documents in the line’s currency.')
    }
    const expected = expectedOpen[openLineId]
    if (expected === undefined || toUnits(expected) !== toUnits(item.transactionOpen)) {
      throw new SettlementMatchRefusal(
        `${label}'s open balance is now ${fromUnits(toUnits(item.transactionOpen))}${expected === undefined ? '' : `, not ${fromUnits(toUnits(expected))}`}`,
        409,
        'Refresh the proposals and review the amounts again.',
      )
    }
    accountIds.add(item.accountId)
    total += toUnits(item.transactionOpen)
    allocations.push(sameCurrencyAllocation(openLineId, fromUnits(toUnits(item.transactionOpen))))
  }
  if (accountIds.size !== 1) {
    throw new SettlementMatchRefusal('One payment settles documents on a single receivable or payable account', 422, 'Select documents on one control account, or record separate payments.')
  }
  if (total !== toUnits(line.magnitude)) {
    throw new SettlementMatchRefusal(
      `The selected documents total ${fromUnits(total)}; the statement line is ${line.magnitude}`,
      422,
      'Select documents whose open balances add up to the statement amount exactly, or record the payment from Receipts or Payments for a partial settlement.',
    )
  }
  return { partyId, subsidiaryId, allocations }
}

// ---------------------------------------------------------------------------
// Offset account suggestions from history
// ---------------------------------------------------------------------------

export interface OffsetSuggestion {
  offsetAccountId: string
  reasons: MatchReason[]
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
  lines: ReadonlyArray<{ id: string; description: string | null; counterparty_ref?: string | null }>,
): Promise<Record<string, OffsetSuggestion>> {
  if (lines.length === 0) return {}
  const history: OffsetHistoryEntry[] = (await db.execute<{
    description: string | null; counterparty_ref: string | null; matched_on: string; offset_account_id: string
  }>(sql`
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
  `)).rows.map((row) => ({
    description: row.description,
    counterpartyRef: row.counterparty_ref,
    offsetAccountId: row.offset_account_id,
    matchedOn: row.matched_on,
  }))
  const out: Record<string, OffsetSuggestion> = {}
  for (const line of lines) {
    const suggestion = suggestOffsetFromHistory({ description: line.description, counterpartyRef: line.counterparty_ref ?? null }, history)
    if (suggestion) out[line.id] = suggestion
  }
  return out
}
