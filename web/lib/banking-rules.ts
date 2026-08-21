import 'server-only'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import { startReconciliation, createMatch, excludeStatementLine } from '@openbooks/engine/src/banking.ts'
import { controlDeps } from './documents'
import { nextDocumentNumber } from './bills'
import {
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
 * Find the account's open reconciliation, or start one at the latest statement
 * date/closing balance (today/0 if no statements). The single matching
 * container shared by Match Bank Data, rules, and reconciliation sign-off.
 */
export async function ensureOpenReconciliation(orgId: string, userId: string, accountId: string): Promise<string> {
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
  const rec = await startReconciliation({ accountId, throughDate, statementBalance }, { orgId, userId })
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
  const statusClause = status === 'unmatched' ? sql` and l.match_status = 'unmatched'` : sql``
  const windowClause =
    typeof windowDays === 'number'
      ? sql` and l.posted_on >= (current_date - ${windowDays}::int)`
      : sql``
  const res = (await db.execute<BankLine>(sql`
    select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref, l.currency, s.source
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
     where s.account_id = ${accountId} and s.org_id = ${orgId}${statusClause}${windowClause}
     order by l.posted_on desc, l.line_number
  `))
  return res.rows
}

/**
 * Apply active rules to every unmatched line on an account. `exclude` and
 * auto-mode `categorize` rules act on the ledger; suggest-mode categorize rules
 * are counted but left for the user to confirm in Match Bank Data. Rules are
 * evaluated by ascending priority; the first match wins.
 */
export async function applyRulesToAccount(orgId: string, userId: string, accountId: string): Promise<ApplyResult> {
  const ctx = { orgId, userId }
  const rules = await loadActiveRules(orgId)
  const result: ApplyResult = { matched: 0, excluded: 0, categorized: 0, suggested: 0, scanned: 0 }
  if (rules.length === 0) return result

  const lines = await loadLines(orgId, accountId, 'unmatched')
  result.scanned = lines.length
  if (lines.length === 0) return result

  let reconciliationId: string | null = null
  const ensureReconciliation = async (): Promise<string> => {
    if (!reconciliationId) reconciliationId = await ensureOpenReconciliation(orgId, userId, accountId)
    return reconciliationId
  }

  for (const line of lines) {
    const rule = firstMatchingRule(line, accountId, rules)
    if (!rule) continue
    const outcome = rule.outcome
    if (outcome.action === 'exclude') {
      await excludeStatementLine(
        line.id,
        `Excluded automatically by bank rule "${rule.name}" (${rule.id})`,
        ctx,
      )
      result.excluded++
      continue
    }
    // categorize
    if (isCategorizeOutcome(outcome) && outcome.mode === 'suggest') {
      // Left for the user to confirm in Match Bank Data.
      result.suggested++
      continue
    }
    const recId = await ensureReconciliation()
    await postCategorizeForLine(orgId, userId, ctx, recId, accountId, line, rule)
    result.categorized++
    result.matched++
  }

  return result
}

/**
 * Apply exactly one rule to one unmatched line and post + match it — the engine
 * behind confirming a suggestion, and behind "post & match" on a single line.
 */
export async function applyRuleToLine(
  orgId: string,
  userId: string,
  opts: { statementLineId: string; ruleId: string; reconciliationId?: string },
): Promise<void> {
  const ctx = { orgId, userId }
  const ruleRes = (await db.execute<RuleRow>(sql`
    select id, name, criteria, outcome, priority, is_active
      from bank_match_rules where id = ${opts.ruleId} and org_id = ${orgId}
  `))
  const rule = ruleRes.rows[0]
  if (!rule) throw new Error('Rule not found')
  const lineRes = (await db.execute<(BankLine & { account_id: string })>(sql`
    select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref, l.currency, s.source, s.account_id
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
     where l.id = ${opts.statementLineId} and l.org_id = ${orgId} and l.match_status = 'unmatched'
  `))
  const line = lineRes.rows[0]
  if (!line) throw new Error('Statement line not found or already matched')
  if (rule.outcome.action === 'exclude') {
    await excludeStatementLine(
      line.id,
      `Excluded by bank rule "${rule.name}" (${rule.id})`,
      ctx,
    )
    return
  }
  const recId = opts.reconciliationId ?? (await ensureOpenReconciliation(orgId, userId, line.account_id))
  await postCategorizeForLine(orgId, userId, ctx, recId, line.account_id, line, rule)
}

/** Post the categorizing journal for one line under one rule, then match it. */
async function postCategorizeForLine(
  orgId: string,
  userId: string,
  ctx: { orgId: string; userId: string },
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

  const bankJournalLineId = await createCategorizingJournal(orgId, userId, {
    bankAccountId,
    splits,
    headerPartyId: headerParty,
    amount: line.amount,
    date: line.posted_on,
    memo,
    currency: line.currency,
  })
  await createMatch(
    { reconciliationId, statementLineId: line.id, journalLineIds: [bankJournalLineId] },
    ctx,
  )
  await db.execute(sql`
    update reconciliation_matches set matched_by = 'rule'
     where reconciliation_id = ${reconciliationId} and statement_line_id = ${line.id} and org_id = ${orgId}
  `)
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
  } = {},
): Promise<PreviewResult> {
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
          r.priority < draftPriority &&
          ruleAppliesToAccount(r.criteria, accountId) &&
          lineMatchesRule(line, r.criteria),
      )
      if (stealer) conflicts++
      matches.push({
        ...toPreviewLine(line),
        ruleId: opts.draftRule.id ?? null,
        ruleName: null,
        stolenBy: stealer?.name ?? null,
        splitPreview: previewSplit(line, opts.draftRule.outcome),
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
        splitPreview: previewSplit(line, rule.outcome),
      })
    }
    if (opts.limit && matches.length >= opts.limit) break
  }

  return { scanned: lines.length, matched: matches.length, conflicts, matches }
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

function previewSplit(line: BankLine, outcome: RuleOutcome): { accountId: string; amount: string }[] | undefined {
  if (outcome.action !== 'categorize') return undefined
  return resolveSplitAmounts(line.amount, outcome.lines).map((r) => ({ accountId: r.line.accountId, amount: r.amount }))
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
  const submission = await submitAndReleaseIfUngated('journal', doc!.id, userId)
  if (submission.flowError) {
    throw new Error(`approval could not be routed: ${submission.flowError}`)
  }
  if (submission.gated) {
    throw new Error(
      'the categorizing journal was submitted for approval; match it after approval',
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
): Promise<void> {
  const ctx = { orgId, userId }
  const lineRes = (await db.execute<{ posted_on: string; amount: string; description: string | null; currency: string; account_id: string }>(sql`
    select l.posted_on, l.amount, l.description, l.currency, s.account_id
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
     where l.id = ${opts.statementLineId} and l.org_id = ${orgId} and l.match_status = 'unmatched'
  `))
  const line = lineRes.rows[0]
  if (!line) throw new Error('Statement line not found or already matched')
  const bankJournalLineId = await createCategorizingJournal(orgId, userId, {
    bankAccountId: line.account_id,
    splits: [{ accountId: opts.offsetAccountId, portion: { kind: 'remainder' } }],
    amount: line.amount,
    date: line.posted_on,
    memo: line.description,
    currency: line.currency,
  })
  await createMatch(
    { reconciliationId: opts.reconciliationId, statementLineId: opts.statementLineId, journalLineIds: [bankJournalLineId] },
    ctx,
  )
}
