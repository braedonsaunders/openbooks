import 'server-only'

import { getMoneyFormatter } from '@/lib/money-server'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { reconciliationBookId, reconciliationTotals } from '@openbooks/engine/src/banking.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../../../lib/authz'
import { isUuid, parsePrefixedListParams } from '../../../../../../lib/list-params'

/**
 * A single reconciliation session, split into a loader and a spec.
 *
 * The page is a header plus one stateful workspace — the same archetype as
 * `/banking/match` (see `../../match/view.ts` for the division and its
 * rationale): the spec composes the header and the stat tiles, and the
 * `ReconcileWorkspace` stays whole. It owns selection state across three
 * paginated panes, the match/unmatch/sign-off calls, and an adjust drawer.
 * Decomposing it would strand the selection from the actions it drives, and
 * its tables carry per-row client state (radio/checkbox selection) no `table`
 * block can express.
 *
 * The loader below copies `page.tsx`'s query, permission and formatting logic
 * verbatim: the `banking.read` gate (which also decides the row counts), the
 * `banking.reconcile` boolean (data, not a capability — the workspace's
 * mutations ride the session cookie inside the shared component), the
 * `signed_off` short-circuits that zero the two open panes, and the unknown-
 * status fallback that renders the raw code with underscores spaced out.
 *
 * `canReconcile` travels as a plain boolean for the same reason
 * `canManageAccounts` does on the accounts page: a spec that could name an
 * Authz, an org id or a user id is a cross-tenant read.
 */

const STMT_SORTS = {
  date: sql`l.posted_on`,
  amount: sql`l.amount`,
  description: sql`l.description`,
} as const

const GL_SORTS = {
  date: sql`je.posting_date`,
  amount: sql`jl.txn_amount`,
  entry: sql`je.entry_number`,
} as const

const M_SORTS = {
  date: sql`sl.posted_on`,
  amount: sql`sl.amount`,
  by: sql`m.matched_by`,
} as const

// Known reconciliation statuses — unknown values render as the raw code with
// underscores spaced out.
const RECON_STATUS_KEYS = ['signed_off', 'balanced', 'in_progress']

interface ReconciliationRow extends Record<string, unknown> {
  id: string
  account_id: string
  through_date: string
  statement_balance: string
  currency: string
  status: string
  signed_off_at: string | null
  signed_off_by_name: string | null
  account_number: string | null
  account_name: string
}

export interface ReconcileStmtRow extends Record<string, unknown> {
  id: string
  posted_on: string
  amount: string
  description: string | null
  counterparty_ref: string | null
}

export interface ReconcileGlRow extends Record<string, unknown> {
  id: string
  posting_date: string
  entry_number: string
  amount: string
  memo: string | null
  party: string | null
}

export interface ReconcileMatchedRow extends Record<string, unknown> {
  id: string
  statement_line_id: string
  matched_by: string
  confidence: string | null
  stmt_date: string
  stmt_amount: string
  stmt_description: string | null
  entry_number: string
  gl_date: string
  gl_amount: string
  gl_memo: string | null
}

interface CountRow extends Record<string, unknown> { n: string | number }

export interface ReconcilePaneParams {
  q: string | undefined
  sort: string
  dir: 'asc' | 'desc'
  page: number
  perPage: number
}

export interface ReconciliationData {
  backHref: string
  backLabel: string
  headerTitle: string
  headerDescription: string
  badgeLabel: string
  badgeVariant: 'success' | 'warning' | 'secondary'
  statementBalanceLabel: string
  statementBalanceValue: string
  clearedBalanceLabel: string
  clearedBalanceValue: string
  differenceLabel: string
  difference: string
  differenceCurrency: string
  matchedLabel: string
  matchedValue: string
  basePath: string
  accountPath: string
  currentParams: Record<string, string | string[] | undefined>
  canReconcile: boolean
  reconciliation: {
    id: string
    status: string
    throughDate: string
    statementBalance: string
    currency: string
  }
  stmtRows: ReconcileStmtRow[]
  stmtTotal: number
  stmtParams: ReconcilePaneParams
  glRows: ReconcileGlRow[]
  glTotal: number
  glParams: ReconcilePaneParams
  matchedRows: ReconcileMatchedRow[]
  matchedTotal: number
  mParams: ReconcilePaneParams
}

export async function loadReconciliation(
  accountId: string,
  reconciliationId: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<ReconciliationData> {
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  if (!isUuid(accountId) || !isUuid(reconciliationId)) notFound()
  const basePath = `/banking/${accountId}/reconcile/${reconciliationId}`

  const reconRes = (await db.execute<ReconciliationRow>(sql`
    select r.id, r.account_id, r.through_date, r.statement_balance, r.currency, r.status,
           r.signed_off_at, u.name as signed_off_by_name,
           a.number as account_number, a.name as account_name
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
      left join users u on u.id = r.signed_off_by
     where r.id = ${reconciliationId} and r.account_id = ${accountId}
       and r.org_id = ${authz.user.orgId}
  `))
  const recon = reconRes.rows[0]
  if (!recon) notFound()
  const { money } = await getMoneyFormatter(authz.user.orgId, recon.currency)

  const ctx = { orgId: authz.user.orgId, userId: authz.user.id }
  const totals = await reconciliationTotals(reconciliationId, ctx)
  const bookId = await reconciliationBookId(db, ctx.orgId)
  const signedOff = recon.status === 'signed_off'

  // -- left pane: unmatched statement lines (prefix stmt*) -------------------
  const stmtParams = parsePrefixedListParams(sp, 'stmt', {
    sort: 'date',
    dir: 'asc',
    perPage: 15,
    allowedSorts: ['date', 'amount', 'description'] as const,
  })
  const stmtWhere = sql`s.account_id = ${accountId} and s.org_id = ${ctx.orgId}
    and l.currency = ${recon.currency} and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
    ${stmtParams.q ? sql` and (l.description ilike ${'%' + stmtParams.q + '%'} or l.counterparty_ref ilike ${'%' + stmtParams.q + '%'} or l.amount::text ilike ${'%' + stmtParams.q + '%'})` : sql``}`

  // -- right pane: unreconciled, unclaimed GL lines (prefix gl*) --------------
  const glParams = parsePrefixedListParams(sp, 'gl', {
    sort: 'date',
    dir: 'asc',
    perPage: 15,
    allowedSorts: ['date', 'amount', 'entry'] as const,
  })
  const glWhere = sql`jl.account_id = ${accountId} and jl.org_id = ${ctx.orgId}
    and je.book_id = ${bookId} and jl.currency = ${recon.currency}
    and je.status = 'posted' and je.posting_date <= ${recon.through_date}
    and jl.reconciled_at is null
    and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
    ${glParams.q ? sql` and (je.entry_number ilike ${'%' + glParams.q + '%'} or je.memo ilike ${'%' + glParams.q + '%'} or jl.memo ilike ${'%' + glParams.q + '%'} or jl.txn_amount::text ilike ${'%' + glParams.q + '%'})` : sql``}`

  // -- matched this session (prefix m*) ---------------------------------------
  const mParams = parsePrefixedListParams(sp, 'm', {
    sort: 'date',
    dir: 'asc',
    perPage: 15,
    allowedSorts: ['date', 'amount', 'by'] as const,
  })
  const mWhere = sql`m.reconciliation_id = ${reconciliationId} and m.org_id = ${ctx.orgId}
    ${mParams.q ? sql` and (sl.description ilike ${'%' + mParams.q + '%'} or je.entry_number ilike ${'%' + mParams.q + '%'} or jl.memo ilike ${'%' + mParams.q + '%'})` : sql``}`

  const [stmtRows, stmtCount, glRows, glCount, mRows, mCount] = (await Promise.all([
    signedOff
      ? Promise.resolve({ rows: [] })
      : db.execute<ReconcileStmtRow>(sql`
          select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
           where ${stmtWhere}
           order by ${STMT_SORTS[stmtParams.sort]} ${stmtParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, l.line_number
           limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}
        `),
    signedOff
      ? Promise.resolve({ rows: [{ n: 0 }] })
      : db.execute<CountRow>(sql`
          select count(*) as n from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
           where ${stmtWhere}`),
    signedOff
      ? Promise.resolve({ rows: [] })
      : db.execute<ReconcileGlRow>(sql`
          select jl.id, je.posting_date, je.entry_number, jl.txn_amount as amount,
                 coalesce(jl.memo, je.memo) as memo, p.display_name as party
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
            left join parties p on p.id = jl.party_id and p.org_id = jl.org_id
           where ${glWhere}
           order by ${GL_SORTS[glParams.sort]} ${glParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, jl.line_number
           limit ${glParams.perPage} offset ${(glParams.page - 1) * glParams.perPage}
        `),
    signedOff
      ? Promise.resolve({ rows: [{ n: 0 }] })
      : db.execute<CountRow>(sql`
          select count(*) as n from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where ${glWhere}`),
    db.execute<ReconcileMatchedRow>(sql`
      select m.id, m.statement_line_id, m.matched_by, m.confidence,
             sl.posted_on as stmt_date, sl.amount as stmt_amount, sl.description as stmt_description,
             je.entry_number, je.posting_date as gl_date, jl.txn_amount as gl_amount,
             coalesce(jl.memo, je.memo) as gl_memo
        from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
        join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}
       order by ${M_SORTS[mParams.sort]} ${mParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, m.created_at
       limit ${mParams.perPage} offset ${(mParams.page - 1) * mParams.perPage}
    `),
    db.execute<CountRow>(sql`
      select count(*) as n from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
        join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}`),
  ]))

  return {
    backHref: `/banking/${accountId}`,
    backLabel: [recon.account_number, recon.account_name].filter(Boolean).join(' · '),
    headerTitle: t('reconcile.title', { date: recon.through_date }),
    headerDescription: signedOff
      ? recon.signed_off_by_name
        ? t('reconcile.signedOffByDescription', {
            date: new Date(recon.signed_off_at ?? recon.through_date).toLocaleDateString('en-CA'),
            name: recon.signed_off_by_name,
          })
        : t('reconcile.signedOffDescription', {
            date: new Date(recon.signed_off_at ?? recon.through_date).toLocaleDateString('en-CA'),
          })
      : t('reconcile.description'),
    badgeLabel: RECON_STATUS_KEYS.includes(recon.status)
      ? t(`reconStatus.${recon.status}`)
      : String(recon.status).replace(/_/g, ' '),
    badgeVariant: signedOff ? 'success' : recon.status === 'balanced' ? 'warning' : 'secondary',
    statementBalanceLabel: t('labels.statementBalance'),
    statementBalanceValue: money(totals.statementBalance, { maximumFractionDigits: 4 }),
    clearedBalanceLabel: t('reconcile.stats.clearedGlBalance'),
    clearedBalanceValue: money(totals.clearedBalance, { maximumFractionDigits: 4 }),
    differenceLabel: t('reconcile.stats.difference'),
    difference: totals.difference,
    differenceCurrency: recon.currency,
    matchedLabel: t('reconcile.stats.matched'),
    matchedValue: t('reconcile.matchedCounts', {
      bank: totals.matchedStatementLines,
      gl: totals.matchedJournalLines,
    }),
    basePath,
    accountPath: `/banking/${accountId}`,
    currentParams: sp,
    canReconcile,
    reconciliation: {
      id: recon.id,
      status: recon.status,
      throughDate: recon.through_date,
      statementBalance: String(recon.statement_balance),
      currency: recon.currency,
    },
    stmtRows: stmtRows.rows,
    stmtTotal: Number(stmtCount.rows[0]?.n ?? 0),
    stmtParams,
    glRows: glRows.rows,
    glTotal: Number(glCount.rows[0]?.n ?? 0),
    glParams,
    matchedRows: mRows.rows,
    matchedTotal: Number(mCount.rows[0]?.n ?? 0),
    mParams,
  }
}

const f = ref<ReconciliationData>()

export function reconcileSpec(data: ReconciliationData): PageSpec {
  return page({
    route: '/banking/[accountId]/reconcile/[reconciliationId]',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('headerTitle'),
        description: f('headerDescription'),
        // One badge, so no actionsClassName: the native header renders the
        // Badge unwrapped.
        actions: [
          widget('reconcile-status-badge', { label: data.badgeLabel, variant: data.badgeVariant }),
        ],
      }),
      widgetBlock('reconcile-stats', {
        statementBalanceLabel: data.statementBalanceLabel,
        statementBalanceValue: data.statementBalanceValue,
        clearedBalanceLabel: data.clearedBalanceLabel,
        clearedBalanceValue: data.clearedBalanceValue,
        differenceLabel: data.differenceLabel,
        difference: data.difference,
        differenceCurrency: data.differenceCurrency,
        matchedLabel: data.matchedLabel,
        matchedValue: data.matchedValue,
      }),
    ],
    body: [
      // The matching workspace, placed through one widget: it owns selection
      // state across three paginated panes plus every mutation, so it stays
      // whole like the match workspace does. The spec supplies only
      // loader-resolved data; `canReconcile` is a boolean, never an Authz.
      widgetBlock('reconcile-workspace', {
        basePath: data.basePath,
        accountPath: data.accountPath,
        currentParams: data.currentParams,
        reconciliation: data.reconciliation,
        difference: data.difference,
        canReconcile: data.canReconcile,
        stmtRows: data.stmtRows,
        stmtTotal: data.stmtTotal,
        stmtParams: data.stmtParams,
        glRows: data.glRows,
        glTotal: data.glTotal,
        glParams: data.glParams,
        matchedRows: data.matchedRows,
        matchedTotal: data.matchedTotal,
        mParams: data.mParams,
      }),
    ],
  })
}
