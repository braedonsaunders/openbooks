import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { fromUnits, toUnits } from '@openbooks/engine/money'
import { addCalendarDays } from '@openbooks/engine/platform/civil-date'
import { can, type Authz } from '../authz'
import { createManualJournal, JournalCreateError } from '../journal-create'
import { loadTransfer, transferAuthority } from '../data-io/transfer-store'
import { accountResolver, MAX_OPENING_ROWS, openingLinesFromRows, type AccountResolution, type OpeningColumns, type OpeningIssue, type OpeningLine } from './opening-lines'
import { readMigrationPlan, recordOpeningJournal } from './plan'
import { isCalendarDate } from './plan-model'

export class OpeningBalanceRefusal extends Error {
  readonly name = 'OpeningBalanceRefusal'
  constructor(message: string, readonly status = 422, readonly issues: OpeningIssue[] = []) { super(message) }
}

export interface OpeningBalanceRequest {
  transferId: string
  columns: OpeningColumns
  excludeRows?: number[]
  /** The day before the cutover: balances are as of the close of this date. */
  documentDate: string
  memo?: string | null
  subsidiaryId?: string | null
  /** An explicit, operator-approved account for an out-of-balance difference. */
  balancingAccountId?: string | null
  /** Account cell text → account id the row posts to instead (e.g. control lines to the clearing account). */
  accountRemap?: { from: string; toAccountId: string }[]
}

export interface OpeningBalancePreview {
  lines: OpeningLine[]
  totalDebits: string
  totalCredits: string
  net: string
  balancingLine: { accountId: string; accountLabel: string; amount: string } | null
  skippedZeroRows: number
  documentDate: string
}

async function stagedRows(authz: Authz, transferId: string) {
  const job = await loadTransfer(authz.user.orgId, transferId)
  await transferAuthority(job, authz)
  if (job.kind !== 'import' || !['mapping', 'ready'].includes(job.state)) {
    throw new OpeningBalanceRefusal('The trial-balance file is not staged yet — wait until it has been read, then try again.', 409)
  }
  if (job.totalRows > MAX_OPENING_ROWS) {
    throw new OpeningBalanceRefusal(`The file has ${job.totalRows} rows; an opening trial balance is limited to ${MAX_OPENING_ROWS} — summarize sub-accounts first.`)
  }
  const rows = (await db.execute<{ row_no: string; data: Record<string, unknown> }>(sql`
    select row_no::text, data from data_transfer_rows where org_id = ${job.orgId} and job_id = ${job.id} order by row_no limit ${MAX_OPENING_ROWS + 1}`)).rows
  return { job, rows: rows.map((row) => ({ rowNo: Number(row.row_no), data: row.data })) }
}

/**
 * Build (but do not write) the opening journal from a staged trial balance.
 * The review card shows exactly this; the commit recomputes it from the same
 * immutable staged rows, so what is approved is what is drafted.
 */
export async function previewOpeningBalances(authz: Authz, request: OpeningBalanceRequest): Promise<OpeningBalancePreview> {
  if (!can(authz, 'gl.post')) throw new OpeningBalanceRefusal('Drafting the opening-balance journal needs the gl.post permission.', 403)
  if (!can(authz, 'admin.setup.manage') || authz.allowedSubsidiaryIds !== null) {
    throw new OpeningBalanceRefusal('Organization opening balances need the setup permission and unrestricted subsidiary access.', 403)
  }
  if (!isCalendarDate(request.documentDate)) throw new OpeningBalanceRefusal('Use the day before the cutover date, in YYYY-MM-DD form, as the journal date.')
  const plan = await readMigrationPlan(authz.user.orgId)
  if (plan.goLive) throw new OpeningBalanceRefusal('These books are already live. Use the native journal workflow for subsequent adjustments.', 409)
  if (plan.cutoverDate && request.documentDate !== addCalendarDays(plan.cutoverDate, -1)) {
    throw new OpeningBalanceRefusal(`Date the opening balances ${addCalendarDays(plan.cutoverDate, -1)}, the day before the recorded cutover.`)
  }
  const { job, rows } = await stagedRows(authz, request.transferId)
  for (const column of [request.columns.account, request.columns.debit, request.columns.credit, request.columns.amount, request.columns.description]) {
    if (column && !job.headers.includes(column)) throw new OpeningBalanceRefusal(`The file has no column "${column}". Columns: ${job.headers.join(', ')}.`)
  }
  const accounts = (await db.execute<{ id: string; number: string | null; name: string; is_active: boolean; is_summary: boolean }>(sql`
    select id, number, name, is_active, is_summary from accounts where org_id = ${authz.user.orgId}`)).rows
  const resolve = accountResolver(accounts.map((account) => ({ id: account.id, number: account.number, name: account.name, isActive: account.is_active, isSummary: account.is_summary })))
  const remap = new Map<string, AccountResolution>()
  for (const entry of request.accountRemap ?? []) {
    const target = accounts.find((candidate) => candidate.id === entry.toAccountId)
    if (!target) throw new OpeningBalanceRefusal(`The remap target for "${entry.from}" is not an account in this organization.`)
    remap.set(entry.from.trim(), target.is_summary || !target.is_active
      ? { refusal: `${target.name} is not an active posting account.` }
      : { id: target.id, label: target.number ? `${target.number} ${target.name}` : target.name })
  }
  const result = openingLinesFromRows({ rows, columns: request.columns, excludeRows: new Set(request.excludeRows ?? []), resolveAccount: resolve, remap })
  if (!result.ok) throw new OpeningBalanceRefusal(result.issues.map((issue) => issue.message).slice(0, 8).join(' '), 422, result.issues)
  let balancingLine: OpeningBalancePreview['balancingLine'] = null
  if (toUnits(result.net) !== 0n) {
    if (!request.balancingAccountId) {
      throw new OpeningBalanceRefusal(`The trial balance does not balance: debits ${result.totalDebits}, credits ${result.totalCredits}, difference ${result.net}. Correct the file, or name the account the difference belongs to.`)
    }
    const account = accounts.find((candidate) => candidate.id === request.balancingAccountId)
    if (!account || !account.is_active || account.is_summary) throw new OpeningBalanceRefusal('The balancing account must be an active posting account in this organization.')
    balancingLine = { accountId: account.id, accountLabel: account.number ? `${account.number} ${account.name}` : account.name, amount: fromUnits(-toUnits(result.net)) }
  }
  return {
    lines: result.lines,
    totalDebits: result.totalDebits,
    totalCredits: result.totalCredits,
    net: result.net,
    balancingLine,
    skippedZeroRows: result.skippedZeroRows,
    documentDate: request.documentDate,
  }
}

/** A stable journal request identity for one operator command, so a replay finds the same draft. */
function journalRequestId(orgId: string, idempotencyKey: string): string {
  const hex = createHash('sha256').update(`migration.opening-balances:${orgId}:${idempotencyKey}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Draft the opening journal through the native journal writer and record it on the plan. */
export async function draftOpeningBalances(authz: Authz, request: OpeningBalanceRequest, idempotencyKey: string) {
  return withOrgTransaction(authz.user.orgId, async () => {
    // Serialize the opening journal with plan changes and go-live. A refusal
    // rolls the native journal and plan update back together.
    const locked = (await db.execute(sql`select id from orgs where id = ${authz.user.orgId} for update`)).rows[0]
    if (!locked) throw new OpeningBalanceRefusal('The organization was not found.', 404)
    const plan = await readMigrationPlan(authz.user.orgId)
    if (plan.openingJournalId && plan.openingJournalId !== journalRequestId(authz.user.orgId, idempotencyKey)) {
      throw new OpeningBalanceRefusal('An opening journal is already recorded. Review or correct that journal through the native journal workflow before continuing.', 409)
    }
    const preview = await previewOpeningBalances(authz, request)
    const lines = [
      ...preview.lines.map((line) => ({ accountId: line.accountId, amount: line.amount, description: line.description })),
      ...(preview.balancingLine ? [{ accountId: preview.balancingLine.accountId, amount: preview.balancingLine.amount, description: 'Opening balance difference' }] : []),
    ]
    try {
      const { journal } = await createManualJournal({
        orgId: authz.user.orgId,
        userId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        idempotencyKey: journalRequestId(authz.user.orgId, idempotencyKey),
        body: {
          documentDate: preview.documentDate,
          memo: request.memo?.trim() || `Opening balances as of ${preview.documentDate}`,
          subsidiaryId: request.subsidiaryId ?? null,
          lines,
        },
      })
      const id = String(journal.doc.id)
      await recordOpeningJournal({ orgId: authz.user.orgId, id: authz.user.id }, id)
      return {
        journalId: id,
        documentNumber: typeof journal.doc.document_number === 'string' ? journal.doc.document_number : null,
        status: 'draft',
        lineCount: lines.length,
        totalDebits: preview.balancingLine && toUnits(preview.balancingLine.amount) > 0n
          ? fromUnits(toUnits(preview.totalDebits) + toUnits(preview.balancingLine.amount))
          : preview.totalDebits,
        href: `/journal?journalTab=drafts&entry=${id}`,
      }
    } catch (error) {
      if (error instanceof JournalCreateError) throw new OpeningBalanceRefusal(error.message, error.status)
      throw error
    }
  })
}
