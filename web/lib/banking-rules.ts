import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { postDocument } from '@openbooks/engine/src/posting.ts'
import { startReconciliation, createMatch } from '@openbooks/engine/src/banking.ts'
import { controlDeps } from './documents'
import { nextDocumentNumber } from './bills'

/**
 * Reconciliation rules — the engine behind the dormant `bank_match_rules`
 * table. A rule matches unmatched imported bank lines by their description /
 * amount and either excludes them or auto-creates a categorizing journal (DR
 * the bank account, CR an offset account) which is then matched into the
 * account's open reconciliation. This is the open equivalent of NetSuite's
 * "Reconciliation Rules" that clear the To-Be-Matched queue automatically.
 *
 * Orchestration lives here (not the engine) because it composes web-layer
 * helpers — document numbering and org control accounts — with the engine's
 * posting + matching primitives. No new matching machinery is introduced.
 */

export interface RuleCriteria {
  /** Case-insensitive substring against the bank line description / counterparty. */
  descriptionContains?: string
  /** 'in' = money in (amount ≥ 0), 'out' = money out (amount < 0), 'any' = either. */
  amountSign?: 'in' | 'out' | 'any'
  /** Inclusive bounds on the absolute amount. */
  minAmount?: number
  maxAmount?: number
  /** Restrict to a single statement source (ofx/csv/…). */
  source?: string
}

export type RuleOutcome =
  | { action: 'exclude' }
  | { action: 'categorize'; accountId: string; partyId?: string | null }

export interface RuleRow {
  id: string
  name: string
  criteria: RuleCriteria
  outcome: RuleOutcome
  priority: number
  is_active: boolean
}

interface BankLine {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
  currency: string
  source: string
}

/** True when a bank line satisfies every populated criterion of a rule. */
export function matchesCriteria(line: BankLine, c: RuleCriteria): boolean {
  if (c.descriptionContains) {
    const hay = `${line.description ?? ''} ${line.counterparty_ref ?? ''}`.toLowerCase()
    if (!hay.includes(c.descriptionContains.toLowerCase())) return false
  }
  const amount = Number(line.amount)
  if (c.amountSign === 'in' && amount < 0) return false
  if (c.amountSign === 'out' && amount >= 0) return false
  const abs = Math.abs(amount)
  if (typeof c.minAmount === 'number' && abs < c.minAmount) return false
  if (typeof c.maxAmount === 'number' && abs > c.maxAmount) return false
  if (c.source && line.source !== c.source) return false
  return true
}

/**
 * Find the account's open reconciliation, or start one at the latest statement
 * date/closing balance (today/0 if no statements). The single matching
 * container shared by Match Bank Data, rules, and reconciliation sign-off.
 */
export async function ensureOpenReconciliation(orgId: string, userId: string, accountId: string): Promise<string> {
  const open = (await db.execute(sql`
    select id from reconciliations
     where org_id = ${orgId} and account_id = ${accountId} and status <> 'signed_off'
     order by created_at desc limit 1
  `)) as unknown as { rows: { id: string }[] }
  if (open.rows[0]) return open.rows[0].id
  const latest = (await db.execute(sql`
    select max(statement_date) as through_date,
           (select closing_balance from bank_statements
             where account_id = ${accountId} and org_id = ${orgId}
             order by statement_date desc, imported_at desc limit 1) as closing
      from bank_statements where account_id = ${accountId} and org_id = ${orgId}
  `)) as unknown as { rows: { through_date: string | null; closing: string | null }[] }
  const throughDate = latest.rows[0]?.through_date ?? new Date().toISOString().slice(0, 10)
  const statementBalance = latest.rows[0]?.closing ?? '0'
  const rec = await startReconciliation({ accountId, throughDate, statementBalance }, { orgId, userId })
  return rec.id
}

export interface ApplyResult {
  matched: number
  excluded: number
  categorized: number
  scanned: number
}

/**
 * Apply active rules to every unmatched line on an account. Ensures an open
 * reconciliation exists (creates one at the latest statement date/balance if
 * needed) so categorized lines are matched into it. Rules are evaluated by
 * ascending priority; the first match wins.
 */
export async function applyRulesToAccount(
  orgId: string,
  userId: string,
  accountId: string,
): Promise<ApplyResult> {
  const ctx = { orgId, userId }
  const rulesRes = (await db.execute(sql`
    select id, name, criteria, outcome, priority, is_active
      from bank_match_rules
     where org_id = ${orgId} and is_active
     order by priority asc, created_at asc
  `)) as unknown as { rows: RuleRow[] }
  const rules = rulesRes.rows
  if (rules.length === 0) return { matched: 0, excluded: 0, categorized: 0, scanned: 0 }

  const linesRes = (await db.execute(sql`
    select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref, l.currency, s.source
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
     where s.account_id = ${accountId} and s.org_id = ${orgId} and l.match_status = 'unmatched'
     order by l.posted_on, l.line_number
  `)) as unknown as { rows: BankLine[] }
  const lines = linesRes.rows
  if (lines.length === 0) return { matched: 0, excluded: 0, categorized: 0, scanned: 0 }

  const result: ApplyResult = { matched: 0, excluded: 0, categorized: 0, scanned: lines.length }

  // A reconciliation session is the matching container. Reuse the open one, or
  // open a session at the latest statement date/balance on the account.
  let reconciliationId: string | null = null
  async function ensureReconciliation(): Promise<string> {
    if (!reconciliationId) reconciliationId = await ensureOpenReconciliation(orgId, userId, accountId)
    return reconciliationId
  }

  for (const line of lines) {
    const rule = rules.find((r) => matchesCriteria(line, r.criteria))
    if (!rule) continue
    const outcome = rule.outcome
    if (outcome.action === 'exclude') {
      await db.execute(sql`
        update bank_statement_lines
           set match_status = 'excluded', updated_at = now(), updated_by = ${userId}
         where id = ${line.id} and org_id = ${orgId}
      `)
      result.excluded++
      continue
    }
    // categorize: create + post a two-line journal (DR/CR bank vs offset), then
    // match the statement line to the new bank-account journal line.
    const recId = await ensureReconciliation()
    const bankJournalLineId = await createCategorizingJournal(orgId, userId, {
      bankAccountId: accountId,
      offsetAccountId: outcome.accountId,
      partyId: outcome.partyId ?? null,
      amount: line.amount,
      date: line.posted_on,
      memo: line.description ?? rule.name,
      currency: line.currency,
    })
    result.categorized++
    await createMatch(
      { reconciliationId: recId, statementLineId: line.id, journalLineIds: [bankJournalLineId] },
      ctx,
    )
    // createMatch stamps matchedBy='manual'; re-attribute to the rule for audit.
    await db.execute(sql`
      update reconciliation_matches set matched_by = 'rule'
       where reconciliation_id = ${recId} and statement_line_id = ${line.id} and org_id = ${orgId}
    `)
    result.matched++
  }

  return result
}

/**
 * Create + post a manual journal that books a bank line against an offset
 * account, returning the id of the posted journal line on the bank account
 * (the one a reconciliation match points at). `amount` is signed from the
 * bank's perspective: the bank line carries it verbatim, the offset its neg.
 */
export async function createCategorizingJournal(
  orgId: string,
  userId: string,
  opts: {
    bankAccountId: string
    offsetAccountId: string
    partyId?: string | null
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
      partyId: opts.partyId ?? null,
      createdBy: userId,
    })
    .returning({ id: schema.documents.id })

  await db.insert(schema.documentLines).values([
    {
      orgId,
      documentId: doc!.id,
      lineNumber: 1,
      accountId: opts.bankAccountId,
      amount: opts.amount,
      description: opts.memo,
    },
    {
      orgId,
      documentId: doc!.id,
      lineNumber: 2,
      accountId: opts.offsetAccountId,
      amount: negateAmount(opts.amount),
      description: opts.memo,
    },
  ])

  const deps = await controlDeps(orgId)
  const entryId = await postDocument(doc!.id, deps)

  const jl = (await db.execute(sql`
    select id from journal_lines
     where entry_id = ${entryId} and account_id = ${opts.bankAccountId} and org_id = ${orgId}
     limit 1
  `)) as unknown as { rows: { id: string }[] }
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
  const lineRes = (await db.execute(sql`
    select l.posted_on, l.amount, l.description, l.currency, s.account_id
      from bank_statement_lines l
      join bank_statements s on s.id = l.statement_id
     where l.id = ${opts.statementLineId} and l.org_id = ${orgId} and l.match_status = 'unmatched'
  `)) as unknown as {
    rows: { posted_on: string; amount: string; description: string | null; currency: string; account_id: string }[]
  }
  const line = lineRes.rows[0]
  if (!line) throw new Error('Statement line not found or already matched')
  const bankJournalLineId = await createCategorizingJournal(orgId, userId, {
    bankAccountId: line.account_id,
    offsetAccountId: opts.offsetAccountId,
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

/** Negate a decimal string without float error (handles leading sign). */
function negateAmount(a: string): string {
  const t = a.trim()
  if (t.startsWith('-')) return t.slice(1)
  if (t.startsWith('+')) return '-' + t.slice(1)
  return '-' + t
}
