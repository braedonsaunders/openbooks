import { getMoneyFormatter } from '@/lib/money-server'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { reconciliationTotals } from '@openbooks/engine/src/banking.ts'
import { Badge, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../../../components/page-layout'
import { requirePermission, can } from '../../../../../../lib/authz'
import { isUuid, parsePrefixedListParams } from '../../../../../../lib/list-params'
import { ReconcileWorkspace } from './ReconcileWorkspace'
import { DifferenceBadge } from './DifferenceBadge'

export const dynamic = 'force-dynamic'

const STMT_SORTS = {
  date: sql`l.posted_on`,
  amount: sql`l.amount`,
  description: sql`l.description`,
} as const

const GL_SORTS = {
  date: sql`je.posting_date`,
  amount: sql`jl.amount`,
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

export default async function ReconcilePage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string; reconciliationId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { money } = await getMoneyFormatter()
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const { accountId, reconciliationId } = await params
  if (!isUuid(accountId) || !isUuid(reconciliationId)) notFound()
  const sp = await searchParams
  const basePath = `/banking/${accountId}/reconcile/${reconciliationId}`

  const reconRes = (await db.execute<any>(sql`
    select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
           r.signed_off_at, u.name as signed_off_by_name,
           a.number as account_number, a.name as account_name
      from reconciliations r
      join accounts a on a.id = r.account_id
      left join users u on u.id = r.signed_off_by
     where r.id = ${reconciliationId} and r.account_id = ${accountId}
       and r.org_id = ${authz.user.orgId}
  `))
  const recon = reconRes.rows[0]
  if (!recon) notFound()

  const ctx = { orgId: authz.user.orgId, userId: authz.user.id }
  const totals = await reconciliationTotals(reconciliationId, ctx)
  const signedOff = recon.status === 'signed_off'

  // -- left pane: unmatched statement lines (prefix stmt*) -------------------
  const stmtParams = parsePrefixedListParams(sp, 'stmt', {
    sort: 'date',
    dir: 'asc',
    perPage: 15,
    allowedSorts: ['date', 'amount', 'description'] as const,
  })
  const stmtWhere = sql`s.account_id = ${accountId} and s.org_id = ${ctx.orgId}
    and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
    ${stmtParams.q ? sql` and (l.description ilike ${'%' + stmtParams.q + '%'} or l.counterparty_ref ilike ${'%' + stmtParams.q + '%'} or l.amount::text ilike ${'%' + stmtParams.q + '%'})` : sql``}`

  // -- right pane: unreconciled, unclaimed GL lines (prefix gl*) --------------
  const glParams = parsePrefixedListParams(sp, 'gl', {
    sort: 'date',
    dir: 'asc',
    perPage: 15,
    allowedSorts: ['date', 'amount', 'entry'] as const,
  })
  const glWhere = sql`jl.account_id = ${accountId} and jl.org_id = ${ctx.orgId}
    and je.status = 'posted' and je.posting_date <= ${recon.through_date}
    and jl.reconciled_at is null
    and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id)
    ${glParams.q ? sql` and (je.entry_number ilike ${'%' + glParams.q + '%'} or je.memo ilike ${'%' + glParams.q + '%'} or jl.memo ilike ${'%' + glParams.q + '%'} or jl.amount::text ilike ${'%' + glParams.q + '%'})` : sql``}`

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
      : db.execute<any>(sql`
          select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id
           where ${stmtWhere}
           order by ${STMT_SORTS[stmtParams.sort]} ${stmtParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, l.line_number
           limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}
        `),
    signedOff
      ? Promise.resolve({ rows: [{ n: 0 }] })
      : db.execute<any>(sql`
          select count(*) as n from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id
           where ${stmtWhere}`),
    signedOff
      ? Promise.resolve({ rows: [] })
      : db.execute<any>(sql`
          select jl.id, je.posting_date, je.entry_number, jl.amount,
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
      : db.execute<any>(sql`
          select count(*) as n from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where ${glWhere}`),
    db.execute<any>(sql`
      select m.id, m.statement_line_id, m.matched_by, m.confidence,
             sl.posted_on as stmt_date, sl.amount as stmt_amount, sl.description as stmt_description,
             je.entry_number, je.posting_date as gl_date, jl.amount as gl_amount,
             coalesce(jl.memo, je.memo) as gl_memo
        from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id
        join journal_lines jl on jl.id = m.journal_line_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}
       order by ${M_SORTS[mParams.sort]} ${mParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, m.created_at
       limit ${mParams.perPage} offset ${(mParams.page - 1) * mParams.perPage}
    `),
    db.execute<any>(sql`
      select count(*) as n from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id
        join journal_lines jl on jl.id = m.journal_line_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}`),
  ]))

  const stat = 'rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900'
  const statLabel = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: `/banking/${accountId}`, label: [recon.account_number, recon.account_name].filter(Boolean).join(' · ') }}
            title={t('reconcile.title', { date: recon.through_date })}
            description={
              signedOff
                ? recon.signed_off_by_name
                  ? t('reconcile.signedOffByDescription', {
                      date: new Date(recon.signed_off_at).toLocaleDateString('en-CA'),
                      name: recon.signed_off_by_name,
                    })
                  : t('reconcile.signedOffDescription', {
                      date: new Date(recon.signed_off_at).toLocaleDateString('en-CA'),
                    })
                : t('reconcile.description')
            }
            actions={
              <Badge variant={signedOff ? 'success' : recon.status === 'balanced' ? 'warning' : 'secondary'}>
                {RECON_STATUS_KEYS.includes(recon.status)
                  ? t(`reconStatus.${recon.status}`)
                  : String(recon.status).replace(/_/g, ' ')}
              </Badge>
            }
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className={stat}>
              <div className={statLabel}>{t('labels.statementBalance')}</div>
              <div className="text-sm font-semibold tabular-nums">{money(totals.statementBalance)}</div>
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('reconcile.stats.clearedGlBalance')}</div>
              <div className="text-sm font-semibold tabular-nums">{money(totals.clearedBalance)}</div>
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('reconcile.stats.difference')}</div>
              <DifferenceBadge difference={totals.difference} />
            </div>
            <div className={stat}>
              <div className={statLabel}>{t('reconcile.stats.matched')}</div>
              <div className="text-sm font-semibold tabular-nums">
                {t('reconcile.matchedCounts', {
                  bank: totals.matchedStatementLines,
                  gl: totals.matchedJournalLines,
                })}
              </div>
            </div>
          </div>
        </>
      }
    >
      <ReconcileWorkspace
        basePath={basePath}
        accountPath={`/banking/${accountId}`}
        currentParams={sp}
        reconciliation={{
          id: recon.id,
          status: recon.status,
          throughDate: recon.through_date,
          statementBalance: String(recon.statement_balance),
        }}
        difference={totals.difference}
        canReconcile={canReconcile}
        stmtRows={stmtRows.rows}
        stmtTotal={Number(stmtCount.rows[0].n)}
        stmtParams={stmtParams}
        glRows={glRows.rows}
        glTotal={Number(glCount.rows[0].n)}
        glParams={glParams}
        matchedRows={mRows.rows}
        matchedTotal={Number(mCount.rows[0].n)}
        mParams={mParams}
      />
    </ListPageLayout>
  )
}
