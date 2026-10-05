import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db, schema, withOrgTransaction, withTransactionSavepoint } from '@openbooks/engine/src/platform/db.ts'
import { PostingError } from '@openbooks/engine/src/journal/posting-contracts.ts'
import { typedRefusal } from './api/error-response'
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { startReconciliation, createMatchWithJournal, excludeStatementLine } from '@openbooks/engine/src/banking/banking.ts'
import { ScopeNotFoundError, subsidiaryScopeAllows } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { controlDeps } from "../../engine/src/ledger/document-service.ts";
import { can, resolveAuthzByUserId } from "./authz";
import { nextDocumentNumber } from "./bills.ts";
import { lockBankMatchRuleSet } from './banking-rule-set-lock'
import {
  BankRuleRefusal,
  type RuleCriteria,
  type RuleOutcome,
  type BankLine,
  type RuleRow,
  type RuleSplitLine,
  firstMatchingRule,
  isCategorizeOutcome,
  lineMatchesRule,
  resolveSplitAmounts,
  ruleAppliesToAccount,
} from './banking-rules-core'

/**
 * Reconciliation rules — the engine behind the `bank_match_rules` table. A rule
 * tests unmatched imported bank lines against a nested and/or condition tree and
 * either excludes them or auto-creates a categorizing journal (DR the bank
 * account, CR one or more offset lines with their own dimensions / party / tax)
 * which is then matched into the account's open reconciliation. This is the open
 * equivalent of source platform's "Reconciliation Rules" / source platform + source platform "Bank Rules",
 * extended with split lines, boolean grouping, a suggest-vs-auto posture, and a
 * dry-run preview that never touches the ledger. Orchestration lives here;
 * the pure condition + split logic lives in banking-rules-core.ts.
 */

// Re-export the pure model + logic so existing importers keep one entry point.
export * from './banking-rules-core'

// ---------------------------------------------------------------------------
// Reconciliation container
// ---------------------------------------------------------------------------

/**
 * The subsidiary owning a bank account, for scope gating. Missing accounts
 * resolve null here so each caller keeps its own not-found contract; scope
 * denials always refuse the uniform not-found.
 */
async function bankAccountSubsidiary(orgId: string, accountId: string, lock = false): Promise<string | null | undefined> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from accounts
     where id = ${accountId} and org_id = ${orgId}
     ${lock ? sql`for share` : sql``}
  `)).rows[0]
  return row?.subsidiaryId
}

/**
 * Scope-gate a bank account through the canonical module: out-of-scope is
 * uniform not-found. Contra-leg callers pass `orgWideNull` so org-wide
 * shared accounts stay usable; the primary/bank leg always fails closed.
 */
function requireBankAccountInScope(
  subsidiaryId: string | null | undefined,
  scope: ReadonlySet<string> | null,
  opts: { orgWideNull?: boolean } = {},
): void {
  if (!subsidiaryScopeAllows(scope, subsidiaryId ?? null, opts)) {
    throw new ScopeNotFoundError()
  }
}

/**
 * Find the account's open reconciliation, or start one at the latest statement
 * date/closing balance (today/0 if no statements). The single matching
 * container shared by Match Bank Data, rules, and reconciliation sign-off.
 */
export async function ensureOpenReconciliation(
  orgId: string,
  userId: string,
  accountId: string,
  scope: ReadonlySet<string> | null,
): Promise<string> {
  requireBankAccountInScope(await bankAccountSubsidiary(orgId, accountId), scope)
  const open = (await db.execute<{ id: string }>(sql`
    select id from reconciliations
     where org_id = ${orgId} and account_id = ${accountId} and status <> 'signed_off'
     order by created_at desc limit 1
  `))
  if (open.rows[0]) return open.rows[0].id
  const latest = (await db.execute<{ through_date: string | null; closing: string | null }>(sql`
    select max(statement_date) as through_date,
           (select closing_balance from bank_statements
             where account_id = ${accountId} and org_id = ${orgId}
             order by statement_date desc, imported_at desc limit 1) as closing
      from bank_statements where account_id = ${accountId} and org_id = ${orgId}
  `))
  const throughDate = latest.rows[0]?.through_date ?? await businessToday(orgId)
  const statementBalance = latest.rows[0]?.closing ?? '0'
  const rec = await startReconciliation(
    { accountId, throughDate, statementBalance },
    { orgId, userId, allowedSubsidiaryIds: scope },
  )
  return rec.id
}

// ---------------------------------------------------------------------------
// Apply / preview
// ---------------------------------------------------------------------------

export interface ApplyResult {
  matched: number
  excluded: number
  categorized: number
  suggested: number
  scanned: number
  /**
   * Lines a matching rule could not act on, each with the refusal that names
   * its remedy. A refused line is left unmatched and untouched; the rest of
   * the run still applies.
   */
  refused: { lineId: string; ruleId: string; ruleName: string; reason: string }[]
}

/**
 * The operator-facing reason for a per-line refusal, or null when the error
 * must abort the whole run: unexpected failures, and a missing gl.post grant,
 * which is about the applier rather than any one line.
 */
function lineRefusalReason(error: unknown): string | null {
  if (error instanceof JournalPostingDeniedError) return null
  if (error instanceof PostingError) return error.message
  return typedRefusal(error) ? error.message : null
}

async function loadActiveRules(orgId: string): Promise<RuleRow[]> {
  const res = (await db.execute<RuleRow>(sql`
    select id, name, criteria, outcome, priority, is_active
      from bank_match_rules
     where org_id = ${orgId} and is_active
     order by priority asc, created_at asc
  `))
  return res.rows
}

async function loadLines(orgId: string, accountId: string, status: 'unmatched' | 'any', windowDays?: number): Promise<BankLine[]> {
  const today = await businessToday(orgId)
  const statusClause = status === 'unmatched' ? sql` and l.match_status = 'unmatched'` : sql``
  const windowClause =
    typeof windowDays === 'number'
      ? sql` and l.posted_on >= (${today}::date - ${windowDays}::int)`
      : sql``
  const res = (await db.execute<BankLine>(sql`
    select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref, l.currency, s.source
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
     where s.account_id = ${accountId} and s.org_id = ${orgId}${statusClause}${windowClause}
     order by l.posted_on desc, l.line_number
  `))
  return res.rows
}

type RuleApplyOutcome = 'excluded' | 'categorized' | 'suggested' | null

/**
 * Re-read the rule at the moment a bulk scan is about to use it. The read
 * deliberately takes no row lock: under read-committed every line observes
 * the latest committed rule state, so an edit that commits between two
 * lines stops the later line. A row lock here would be held
 * for the whole bulk run by the outer transaction, forcing every concurrent
 * edit to wait behind the run and turning the re-read into the very
 * whole-run snapshot it exists to prevent. Product-path edits still
 * serialize against the run through the rule-set advisory lock
 * A direct edit racing one line's read-and-apply affects
 * the following lines, not the in-flight one.
 */
async function applyRuleIfStillCurrent(
  orgId: string,
  userId: string,
  accountId: string,
  line: BankLine,
  scannedRule: RuleRow,
  ctx: { orgId: string; userId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
  ensureReconciliation: () => Promise<string>,
): Promise<RuleApplyOutcome> {
  return withOrgTransaction(orgId, async () => {
    // The rule-set advisory lock serializes product-path edits against bulk
    // scans. The re-read below is lock-free on purpose (see
    // above): locking the row would pin it for the whole outer transaction.
    await lockBankMatchRuleSet(db, orgId)
    const current = (await db.execute<RuleRow>(sql`
      select id, name, criteria, outcome, priority, is_active
        from bank_match_rules
       where id = ${scannedRule.id} and org_id = ${orgId}
    `)).rows[0]
    if (!current?.is_active) return null
    if (!ruleAppliesToAccount(current.criteria, accountId) || !lineMatchesRule(line, current.criteria)) return null

    if (current.outcome.action === 'exclude') {
      await excludeStatementLine(
        line.id,
        `Excluded automatically by bank rule "${current.name}" (${current.id})`,
        ctx,
      )
      return 'excluded'
    }
    if (isCategorizeOutcome(current.outcome) && current.outcome.mode === 'suggest') {
      return 'suggested'
    }
    const recId = await ensureReconciliation()
    await postCategorizeForLine(orgId, userId, ctx, recId, accountId, line, current)
    return 'categorized'
  })
}

/**
 * Apply active rules to every unmatched line on an account. `exclude` and
 * auto-mode `categorize` rules act on the ledger; suggest-mode categorize rules
 * are counted but left for the user to confirm in Match Bank Data. Rules are
 * evaluated by ascending priority; the first match wins.
 */
export async function applyRulesToAccount(
  orgId: string,
  userId: string,
  accountId: string,
  scope: ReadonlySet<string> | null,
): Promise<ApplyResult> {
  const ctx = { orgId, userId, allowedSubsidiaryIds: scope }
  const result: ApplyResult = { matched: 0, excluded: 0, categorized: 0, suggested: 0, scanned: 0, refused: [] }
  return withOrgTransaction(orgId, async () => {
    // Rule create/edit/delete takes this same tenant lock. Keep it from the
    // candidate snapshot through the final line so a new higher-priority rule
    // cannot appear between scan and apply.
    await lockBankMatchRuleSet(db, orgId)
    requireBankAccountInScope(await bankAccountSubsidiary(orgId, accountId), scope)
    const rules = await loadActiveRules(orgId)
    if (rules.length === 0) return result
    const lines = await loadLines(orgId, accountId, 'unmatched')
    result.scanned = lines.length
    if (lines.length === 0) return result
    let reconciliationId: string | null = null
    const ensureReconciliation = async (): Promise<string> => {
      if (!reconciliationId) reconciliationId = await ensureOpenReconciliation(orgId, userId, accountId, scope)
      return reconciliationId
    }
    for (const line of lines) {
      const rule = firstMatchingRule(line, accountId, rules)
      if (!rule) continue
      // Each line applies inside its own savepoint: a refusal on one line
      // (an unpostable split, a closed period, an approval-gated journal)
      // rolls back that line's writes only and is reported by line, so one
      // ineligible line never aborts the whole run. Unexpected failures still
      // abort it. A reconciliation opened inside a rolled-back savepoint is
      // gone, so its cached id is forgotten with it.
      const reconciliationBefore = reconciliationId
      let applied: RuleApplyOutcome
      try {
        applied = await withTransactionSavepoint(db, () => applyRuleIfStillCurrent(
          orgId, userId, accountId, line, rule, ctx, ensureReconciliation,
        ))
      } catch (error) {
        const reason = lineRefusalReason(error)
        if (reason === null) throw error
        reconciliationId = reconciliationBefore
        result.refused.push({ lineId: line.id, ruleId: rule.id, ruleName: rule.name, reason })
        continue
      }
      if (applied === 'excluded') result.excluded++
      if (applied === 'categorized') {
        result.categorized++
        result.matched++
      }
      if (applied === 'suggested') result.suggested++
    }
    return result
  })
}

/**
 * Apply exactly one rule to one unmatched line and post + match it — the engine
 * behind confirming a suggestion, and behind "post & match" on a single line.
 */
export async function applyRuleToLine(
  orgId: string,
  userId: string,
  opts: { statementLineId: string; ruleId: string; reconciliationId?: string },
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const ctx = { orgId, userId, allowedSubsidiaryIds: scope }
  const ruleRes = (await db.execute<RuleRow>(sql`
    select id, name, criteria, outcome, priority, is_active
      from bank_match_rules where id = ${opts.ruleId} and org_id = ${orgId}
  `))
  const rule = ruleRes.rows[0]
  if (!rule) throw new BankRuleRefusal('Rule not found', 404)
  // A disabled rule must never post: without this, deactivation is enforced
  // only by the UI hiding the rule while the API still fires it.
  if (!rule.is_active) throw new BankRuleRefusal(`Rule "${rule.name}" is not active; activate it on the Rules page before applying it`, 409)
  const lineRes = (await db.execute<(BankLine & { account_id: string; subsidiaryId: string | null })>(sql`
    select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref, l.currency, s.source, s.account_id,
           a.subsidiary_id as "subsidiaryId"
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.id = ${opts.statementLineId} and l.org_id = ${orgId} and l.match_status = 'unmatched'
  `))
  const line = lineRes.rows[0]
  if (!line) throw new BankRuleRefusal('Statement line not found or already matched; refresh Match Bank Data and pick an unmatched line', 409)
  requireBankAccountInScope(line.subsidiaryId, scope)
  if (rule.outcome.action === 'exclude') {
    await excludeStatementLine(
      line.id,
      `Excluded by bank rule "${rule.name}" (${rule.id})`,
      ctx,
    )
    return
  }
  const recId = opts.reconciliationId ?? (await ensureOpenReconciliation(orgId, userId, line.account_id, scope))
  await postCategorizeForLine(orgId, userId, ctx, recId, line.account_id, line, rule)
}

/** Post the categorizing journal for one line under one rule, then match it. */
async function postCategorizeForLine(
  orgId: string,
  userId: string,
  ctx: { orgId: string; userId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
  reconciliationId: string,
  bankAccountId: string,
  line: BankLine,
  rule: RuleRow,
): Promise<void> {
  const outcome = rule.outcome
  if (outcome.action !== 'categorize') return
  const splits: RuleSplitLine[] = outcome.lines
  const headerParty = outcome.partyId ?? null
  const memo = outcome.memo ?? line.description ?? rule.name

  await createMatchWithJournal(
    {
      reconciliationId,
      statementLineId: line.id,
      matchedBy: 'rule',
      additionalAccountIds: splits.map((split) => split.accountId),
      createJournal: () => createCategorizingJournal(orgId, userId, {
        bankAccountId,
        splits,
        headerPartyId: headerParty,
        amount: line.amount,
        date: line.posted_on,
        memo,
        currency: line.currency,
      }),
    },
    ctx,
  )
}

export interface PreviewMatch {
  lineId: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
  currency: string
  ruleId: string | null
  ruleName: string | null
  /** The matching rule's action + posture (aggregate preview only). */
  action?: 'exclude' | 'categorize'
  ruleMode?: 'auto' | 'suggest' | null
  /** True when a higher-priority rule than the one under test claims this line. */
  stolenBy?: string | null
  /** Resolved split preview (categorize outcomes only). */
  splitPreview?: { accountId: string; amount: string }[]
  /** Why the rule's split cannot post on this line, when it cannot. */
  splitRefusal?: string
}

export interface PreviewResult {
  scanned: number
  matched: number
  conflicts: number
  matches: PreviewMatch[]
}

/**
 * Dry-run a set of rules (or one draft rule) against an account's lines WITHOUT
 * touching the ledger — the engine behind the builder's live preview, the
 * suggest surface in Match Bank Data, and rule-health telemetry. When
 * `draftRule` is supplied, its matches are highlighted and any line a
 * higher-priority saved rule would steal is flagged.
 */
export async function previewRules(
  orgId: string,
  accountId: string,
  opts: {
    /** A single unsaved rule to test; when omitted, previews all active rules. */
    draftRule?: { criteria: RuleCriteria; outcome: RuleOutcome; priority?: number; id?: string }
    /** Look back this many days (default 90); use 'unmatched' status when false. */
    windowDays?: number
    onlyUnmatched?: boolean
    limit?: number
    /**
     * Canonical scope, required from every caller: restricted callers
     * preview only their own subsidiaries' accounts.
     */
    allowedSubsidiaryIds: ReadonlySet<string> | null
  } = { allowedSubsidiaryIds: null },
): Promise<PreviewResult> {
  return withOrgTransaction(orgId, async () => {
    // Keep the account's ownership stable while collecting its statement
    // lines; account rehome takes an incompatible row lock.
    requireBankAccountInScope(
      await bankAccountSubsidiary(orgId, accountId, true),
      opts.allowedSubsidiaryIds ?? null,
    )
    const windowDays = opts.windowDays ?? 90
    const lines = await loadLines(orgId, accountId, opts.onlyUnmatched ? 'unmatched' : 'any', windowDays)
    const saved = await loadActiveRules(orgId)

    const matches: PreviewMatch[] = []
    let conflicts = 0

    for (const line of lines) {
      if (opts.draftRule) {
        const applies = ruleAppliesToAccount(opts.draftRule.criteria, accountId)
        if (!applies || !lineMatchesRule(line, opts.draftRule.criteria)) continue
        // Would a higher-priority saved rule claim it first?
        const draftPriority = opts.draftRule.priority ?? 100
        const stealer = saved.find(
          (r) =>
            r.id !== opts.draftRule?.id &&
            r.priority <= draftPriority &&
            ruleAppliesToAccount(r.criteria, accountId) &&
            lineMatchesRule(line, r.criteria),
        )
        if (stealer) conflicts++
        matches.push({
          ...toPreviewLine(line),
          ruleId: opts.draftRule.id ?? null,
          ruleName: null,
          stolenBy: stealer?.name ?? null,
          ...previewSplit(line, opts.draftRule.outcome),
        })
      } else {
        const rule = firstMatchingRule(line, accountId, saved)
        if (!rule) continue
        matches.push({
          ...toPreviewLine(line),
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.outcome.action,
          ruleMode: isCategorizeOutcome(rule.outcome) ? rule.outcome.mode : null,
          ...previewSplit(line, rule.outcome),
        })
      }
      if (opts.limit && matches.length >= opts.limit) break
    }

    return { scanned: lines.length, matched: matches.length, conflicts, matches }
  })
}

function toPreviewLine(line: BankLine): Omit<PreviewMatch, 'ruleId' | 'ruleName'> {
  return {
    lineId: line.id,
    posted_on: line.posted_on,
    amount: line.amount,
    description: line.description,
    counterparty_ref: line.counterparty_ref,
    currency: line.currency,
  }
}

/**
 * The split a rule would post for one line. A split the line cannot carry is
 * reported on that line (`splitRefusal`) instead of failing the whole preview,
 * so one misconfigured rule does not hide every other rule's matches.
 */
function previewSplit(line: BankLine, outcome: RuleOutcome): Pick<PreviewMatch, 'splitPreview' | 'splitRefusal'> {
  if (outcome.action !== 'categorize') return {}
  try {
    return { splitPreview: resolveSplitAmounts(line.amount, outcome.lines).map((r) => ({ accountId: r.line.accountId, amount: r.amount })) }
  } catch (error) {
    if (error instanceof BankRuleRefusal) return { splitRefusal: error.message }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

/**
 * Create + post a manual journal that books a bank line against one or more
 * offset lines (each with its own dimensions / party / tax code), returning the
 * id of the posted journal line on the bank account (the one a reconciliation
 * match points at). `amount` is signed from the bank's perspective: the bank
 * line carries it verbatim, the offsets its negation, split per `resolveSplit`.
 */
/**
 * Posting a categorizing journal writes the GL, so creating one takes
 * gl.post on top of banking.reconcile — the same authority the journals
 * actions route demands. The grant is re-resolved per journal (never a
 * saved permission set), so a revocation fails closed mid-batch, and the
 * refusal lands before any document, line, submission, or posting write.
 */
export class JournalPostingDeniedError extends Error {
  override readonly name = 'JournalPostingDeniedError'
  readonly status = 403
}

export async function createCategorizingJournal(
  orgId: string,
  userId: string,
  opts: {
    bankAccountId: string
    splits: RuleSplitLine[]
    headerPartyId?: string | null
    amount: string
    date: string
    memo: string | null
    currency: string
  },
): Promise<string> {
  const poster = await resolveAuthzByUserId(orgId, userId)
  if (poster === null || !can(poster, 'gl.post')) {
    throw new JournalPostingDeniedError(
      'missing permission: gl.post — categorizing journals post to the ledger; leave the line unmatched for a gl.post holder',
    )
  }
  const documentNumber = await nextDocumentNumber(orgId, 'journal', 'JE-')
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind: 'journal',
      documentNumber,
      documentDate: opts.date,
      currency: opts.currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      memo: opts.memo,
      partyId: opts.headerPartyId ?? null,
      createdBy: userId,
    })
    .returning({ id: schema.documents.id })

  const resolved = resolveSplitAmounts(opts.amount, opts.splits)
  const offsetLines = resolved.map((r, i) => ({
    orgId,
    documentId: doc!.id,
    lineNumber: i + 2,
    accountId: r.line.accountId,
    amount: r.amount,
    description: r.line.description ?? opts.memo,
    partyId: r.line.partyId ?? null,
    departmentId: r.line.departmentId ?? null,
    projectId: r.line.projectId ?? null,
    locationId: r.line.locationId ?? null,
    classId: r.line.classId ?? null,
    taxCodeId: r.line.taxCodeId ?? null,
  }))

  await db.insert(schema.documentLines).values([
    {
      orgId,
      documentId: doc!.id,
      lineNumber: 1,
      accountId: opts.bankAccountId,
      amount: opts.amount,
      description: opts.memo,
    },
    ...offsetLines,
  ])

  const deps = await controlDeps(orgId)
  // The submission runs in this transaction so a refused routing throws
  // inside it: without the wrapper the submission's own transaction would
  // commit its before_submit script effects before the error propagates.
  const submission = await withOrgTransaction(orgId, async () => {
    const inner = await submitAndReleaseIfUngated('journal', doc!.id, userId)
    if (inner.flowError) {
      throw new BankRuleRefusal(`the categorizing journal's approval could not be routed: ${inner.flowError}`)
    }
    return inner
  })
  // An approval-gated journal cannot be posted and matched in this one
  // step, and this whole unit (journal included) rolls back on refusal, so
  // nothing is left pending. The remedy is the manual path that exists:
  // record the journal, let it route for approval, then match the posted
  // line in Match Bank Data.
  if (submission.gated) {
    throw new BankRuleRefusal(
      'journal entries require approval in this organization, so this line cannot be categorized automatically and nothing was posted; record the journal from Journals, and once it is approved and posted, match it to this line in Match Bank Data',
      409,
    )
  }
  const entryId = await postDocument(doc!.id, deps)

  const jl = (await db.execute<{ id: string }>(sql`
    select id from journal_lines
     where entry_id = ${entryId} and account_id = ${opts.bankAccountId} and org_id = ${orgId}
     limit 1
  `))
  if (!jl.rows[0]) throw new Error('categorizing journal did not post a bank line')
  return jl.rows[0].id
}

/**
 * Manually create a categorizing journal from a single unmatched bank line and
 * match it into the reconciliation — the Match Bank Data "Add journal" action.
 * The line's own account is the bank leg; `offsetAccountId` the contra.
 */
export async function addJournalMatchFromLine(
  orgId: string,
  userId: string,
  opts: { statementLineId: string; offsetAccountId: string; reconciliationId: string },
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const ctx = { orgId, userId, allowedSubsidiaryIds: scope }
  const lineRes = (await db.execute<{ posted_on: string; amount: string; description: string | null; currency: string; account_id: string; subsidiaryId: string | null }>(sql`
    select l.posted_on, l.amount, l.description, l.currency, s.account_id,
           a.subsidiary_id as "subsidiaryId"
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.id = ${opts.statementLineId} and l.org_id = ${orgId} and l.match_status = 'unmatched'
  `))
  const line = lineRes.rows[0]
  if (!line) throw new BankRuleRefusal('Statement line not found or already matched; refresh Match Bank Data and pick an unmatched line', 409)
  // Both legs stay inside the caller's boundary: the bank leg's account and
  // the chosen offset account. The session itself is gated again inside
  // createMatchWithJournal.
  requireBankAccountInScope(line.subsidiaryId, scope)
  // The contra leg follows the shared-account policy: the offset picker
  // offers the caller's own subsidiaries' accounts plus org-wide shared
  // accounts (listScopedAccountOptions with orgWideNull), and journal
  // posting itself validates line accounts by org-postability rather than
  // subsidiary — the same rule that lets auto-categorize rules post shared
  // splits with no per-split gate above. Another subsidiary's account stays
  // refused here. A missing account is still uniform not-found: without the
  // explicit check it would resolve null and pass as shared.
  const offsetSubsidiary = await bankAccountSubsidiary(orgId, opts.offsetAccountId)
  if (offsetSubsidiary === undefined) throw new ScopeNotFoundError()
  requireBankAccountInScope(offsetSubsidiary, scope, { orgWideNull: true })
  await createMatchWithJournal(
    {
      reconciliationId: opts.reconciliationId,
      statementLineId: opts.statementLineId,
      matchedBy: 'manual',
      additionalAccountIds: [opts.offsetAccountId],
      createJournal: () => createCategorizingJournal(orgId, userId, {
        bankAccountId: line.account_id,
        splits: [{ accountId: opts.offsetAccountId, portion: { kind: 'remainder' } }],
        amount: line.amount,
        date: line.posted_on,
        memo: line.description,
        currency: line.currency,
      }),
    },
    ctx,
  )
}
