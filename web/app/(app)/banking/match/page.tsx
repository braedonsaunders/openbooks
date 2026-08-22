import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { reconciliationTotals } from '@openbooks/engine/src/banking.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { requirePermission } from '../../../../lib/authz'
import { parsePrefixedListParams, pickString, isUuid } from '../../../../lib/list-params'
import { MatchWorkspace } from './MatchWorkspace'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('match.title') }
}

export default async function MatchBankData({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('banking.reconcile')
  const t = await getTranslations('banking')
  const orgId = authz.user.orgId
  const sp = await searchParams
  const accountId = pickString(sp.account)
  const tab = (pickString(sp.tab) ?? 'match') as 'match' | 'review' | 'excluded'

  // reconcilable accounts (the picker) + offset accounts (add-journal)
  const [accountsRes, offsetRes] = (await Promise.all([
    db.execute<any>(sql`
      select a.id, a.number, a.name,
             coalesce((select count(*) from bank_statement_lines l
                         join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
                        where s.account_id = a.id and s.org_id = a.org_id and l.org_id = a.org_id and l.match_status = 'unmatched'), 0) as unmatched
        from accounts a
       where a.org_id = ${orgId} and a.reconcilable and not a.is_summary and a.is_active
       order by a.number nulls last
    `),
    db.execute<any>(sql`
      select id, number, name from accounts
       where org_id = ${orgId} and is_active and not is_summary
       order by number nulls last limit 2000
    `),
  ]))

  const accounts = accountsRes.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(' · '),
    unmatched: Number(a.unmatched),
  }))
  const offsetAccounts = offsetRes.rows.map((a: any) => ({
    id: a.id,
    label: [a.number, a.name].filter(Boolean).join(' · '),
  }))

  const account = accountId && isUuid(accountId) ? accountsRes.rows.find((a: any) => a.id === accountId) : null

  // No account selected → just the picker.
  if (!account) {
    return (
      <ListPageLayout
        header={<PageHeader title={t('match.title')} description={t('match.description')} />}
      >
        <MatchWorkspace accounts={accounts} offsetAccounts={offsetAccounts} account={null} session={null}
          data={null} totals={null} currentParams={sp} tab={tab} />
      </ListPageLayout>
    )
  }

  // Find the account's open reconciliation (do NOT create on render).
  const openRes = (await db.execute<any>(sql`
    select id, through_date, statement_balance, status from reconciliations
     where org_id = ${orgId} and account_id = ${account.id} and status <> 'signed_off'
     order by created_at desc limit 1
  `))
  const session = openRes.rows[0] ?? null

  let data: any = null
  let totals: any = null
  if (session) {
    const ctx = { orgId, userId: authz.user.id }
    totals = await reconciliationTotals(session.id, ctx)

    const stmtParams = parsePrefixedListParams(sp, 'stmt', { sort: 'date', dir: 'asc', perPage: 15, allowedSorts: ['date'] as const })
    const glParams = parsePrefixedListParams(sp, 'gl', { sort: 'date', dir: 'asc', perPage: 15, allowedSorts: ['date'] as const })
    const exParams = parsePrefixedListParams(sp, 'ex', { sort: 'date', dir: 'asc', perPage: 15, allowedSorts: ['date'] as const })

    const stmtWhere = sql`s.account_id = ${account.id} and s.org_id = ${orgId}
      and l.match_status = 'unmatched' and l.posted_on <= ${session.through_date}
      ${stmtParams.q ? sql` and (l.description ilike ${'%' + stmtParams.q + '%'} or l.counterparty_ref ilike ${'%' + stmtParams.q + '%'} or l.amount::text ilike ${'%' + stmtParams.q + '%'})` : sql``}`
    const glWhere = sql`jl.account_id = ${account.id} and jl.org_id = ${orgId}
      and je.status = 'posted' and je.posting_date <= ${session.through_date}
      and jl.reconciled_at is null
      and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
      ${glParams.q ? sql` and (je.entry_number ilike ${'%' + glParams.q + '%'} or je.memo ilike ${'%' + glParams.q + '%'} or jl.memo ilike ${'%' + glParams.q + '%'} or jl.amount::text ilike ${'%' + glParams.q + '%'})` : sql``}`
    const exWhere = sql`s.account_id = ${account.id} and s.org_id = ${orgId} and l.match_status = 'excluded'
      ${exParams.q ? sql` and (l.description ilike ${'%' + exParams.q + '%'} or l.amount::text ilike ${'%' + exParams.q + '%'})` : sql``}`

    const [stmt, stmtC, gl, glC, review, ex, exC] = (await Promise.all([
      db.execute<any>(sql`
        select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref
          from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
         where ${stmtWhere} order by l.posted_on, l.line_number
         limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}`),
      db.execute<any>(sql`select count(*) as n from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id where ${stmtWhere}`),
      db.execute<any>(sql`
        select jl.id, je.posting_date, je.entry_number, jl.amount, coalesce(jl.memo, je.memo) as memo, p.display_name as party
          from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
          left join parties p on p.id = jl.party_id and p.org_id = jl.org_id
         where ${glWhere} order by je.posting_date, jl.line_number
         limit ${glParams.perPage} offset ${(glParams.page - 1) * glParams.perPage}`),
      db.execute<any>(sql`select count(*) as n from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id where ${glWhere}`),
      // Review: auto matches with low confidence in this session
      db.execute<any>(sql`
        select m.id, m.statement_line_id, m.confidence,
               sl.posted_on as stmt_date, sl.amount as stmt_amount, sl.description as stmt_description,
               je.entry_number, jl.amount as gl_amount, coalesce(jl.memo, je.memo) as gl_memo
          from reconciliation_matches m
          join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
          join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where m.reconciliation_id = ${session.id} and m.org_id = ${orgId}
           and m.matched_by = 'auto' and m.confidence is not null and m.confidence <= 0.7
         order by m.confidence asc, sl.posted_on limit 50`),
      db.execute<any>(sql`
        select l.id, l.posted_on, l.amount, l.description
          from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
         where ${exWhere} order by l.posted_on, l.line_number
         limit ${exParams.perPage} offset ${(exParams.page - 1) * exParams.perPage}`),
      db.execute<any>(sql`select count(*) as n from bank_statement_lines l join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id where ${exWhere}`),
    ]))

    data = {
      stmtRows: stmt.rows, stmtTotal: Number(stmtC.rows[0].n), stmtParams,
      glRows: gl.rows, glTotal: Number(glC.rows[0].n), glParams,
      reviewRows: review.rows,
      excludedRows: ex.rows, excludedTotal: Number(exC.rows[0].n), exParams,
    }
  }

  return (
    <ListPageLayout
      header={<PageHeader title={t('match.title')} description={t('match.description')} />}
    >
      <MatchWorkspace
        accounts={accounts}
        offsetAccounts={offsetAccounts}
        account={{ id: account.id, label: [account.number, account.name].filter(Boolean).join(' · ') }}
        session={session ? { id: session.id, throughDate: session.through_date, statementBalance: String(session.statement_balance) } : null}
        data={data}
        totals={totals}
        currentParams={sp}
        tab={tab}
      />
    </ListPageLayout>
  )
}
