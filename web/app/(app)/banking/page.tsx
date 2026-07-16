import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import {
  ArrowUpRight,
  Database,
  ListChecks,
  NotebookPen,
  Workflow,
  CheckCircle2,
} from 'lucide-react'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, cn } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'
import { requirePermission, can } from '../../../lib/authz'
import { money } from '../../../lib/format'
import { BANK_KINDS } from '../../../lib/documents'
import { DocTypeBadge } from '../../../components/doc-type-badge'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('banking')
  return { title: t('overview.title') }
}

export default async function BankingOverview() {
  const authz = await requirePermission('banking.read')
  const canReconcile = can(authz, 'banking.reconcile')
  const t = await getTranslations('banking')
  const orgId = authz.user.orgId

  const txList = sql`(${BANK_KINDS.map((k) => `'${k}'`).join(',')})`
  const [totals, recentTx, recentStmt] = (await Promise.all([
    db.execute(sql`
      select
        coalesce(sum(case when a.type = 'asset_bank' then bal.balance else 0 end), 0) as cash,
        coalesce(sum(case when a.type = 'liability_card' then bal.balance else 0 end), 0) as cards,
        coalesce(sum(unm.n), 0) as unmatched,
        coalesce(sum(case when openrec.id is not null then 1 else 0 end), 0) as open_recons
      from accounts a
      left join lateral (
        select sum(jl.amount) as balance from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
         where jl.account_id = a.id) bal on true
      left join lateral (
        select count(*) as n from bank_statement_lines l
          join bank_statements s on s.id = l.statement_id
         where s.account_id = a.id and l.match_status = 'unmatched') unm on true
      left join lateral (
        select r.id from reconciliations r
         where r.account_id = a.id and r.status <> 'signed_off' limit 1) openrec on true
      where a.org_id = ${orgId} and a.reconcilable and not a.is_summary
    `),
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date, d.status, d.total, d.memo
        from documents d
       where d.org_id = ${orgId} and d.kind in ${txList}
       order by d.document_date desc, d.created_at desc
       limit 6
    `),
    db.execute(sql`
      select s.id, s.statement_date, s.source, s.account_id,
             a.number as account_number, a.name as account_name,
             coalesce(lc.n, 0) as line_count, coalesce(lc.unmatched, 0) as unmatched_count
        from bank_statements s
        join accounts a on a.id = s.account_id
        left join lateral (
          select count(*) as n, count(*) filter (where l.match_status = 'unmatched') as unmatched
            from bank_statement_lines l where l.statement_id = s.id) lc on true
       where s.org_id = ${orgId}
       order by s.imported_at desc
       limit 6
    `),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }, { rows: any[] }]

  const stat = totals.rows[0]
  const tiles = [
    { key: 'cash', value: money(stat.cash), tone: 'text-slate-900 dark:text-slate-100' },
    { key: 'cards', value: money(stat.cards), tone: 'text-slate-900 dark:text-slate-100' },
    {
      key: 'unmatched',
      value: Number(stat.unmatched).toLocaleString(),
      tone: Number(stat.unmatched) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100',
    },
    {
      key: 'openRecons',
      value: Number(stat.open_recons).toLocaleString(),
      tone: Number(stat.open_recons) > 0 ? 'text-teal-600 dark:text-teal-400' : 'text-slate-900 dark:text-slate-100',
    },
  ]

  // Quick-link cards to each banking surface. Matching/rules are gated on
  // banking.reconcile; the read-only lists on banking.read.
  const links = [
    { href: '/banking/match', icon: <ListChecks size={18} />, key: 'match', gated: true },
    { href: '/banking/transactions', icon: <NotebookPen size={18} />, key: 'transactions', gated: false },
    { href: '/banking/reconciliations', icon: <CheckCircle2 size={18} />, key: 'reconciliations', gated: true },
    { href: '/banking/imports', icon: <Database size={18} />, key: 'imports', gated: false },
    { href: '/banking/rules', icon: <Workflow size={18} />, key: 'rules', gated: true },
  ].filter((l) => !l.gated || canReconcile)

  const tileCls = 'rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900'
  const tileLabel = 'text-[11px] font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400'

  return (
    <PageContainer>
      <div className="space-y-6">
        <PageHeader title={t('overview.title')} description={t('overview.description')} />

        {/* -- KPI tiles -------------------------------------------------- */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.key} className={tileCls}>
              <div className={tileLabel}>{t(`overview.tiles.${tile.key}`)}</div>
              <div className={cn('mt-1 text-lg font-semibold tabular-nums', tile.tone)}>{tile.value}</div>
            </div>
          ))}
        </section>

        {/* -- quick links ----------------------------------------------- */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href as any}
              title={t(`overview.links.${l.key}.description`)}
              className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-teal-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-teal-700"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-teal-50 text-teal-700 ring-1 ring-teal-100 dark:bg-teal-950/50 dark:text-teal-300">
                {l.icon}
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {t(`overview.links.${l.key}.title`)}
                </h3>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {t(`overview.links.${l.key}.description`)}
                </p>
              </div>
              <ArrowUpRight
                size={15}
                aria-hidden
                className="shrink-0 text-slate-300 opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:opacity-100 group-hover:text-teal-600 dark:text-slate-600 dark:group-hover:text-teal-300"
              />
            </Link>
          ))}
        </section>

        {/* -- recent activity ------------------------------------------- */}
        <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('overview.recentTransactions')}</h2>
              <Link href="/banking/transactions" className="text-xs text-teal-700 hover:underline dark:text-teal-300">
                {t('overview.viewAll')}
              </Link>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              {recentTx.rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('overview.noRecentTransactions')}</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {recentTx.rows.map((d: any) => (
                    <li key={d.id}>
                      <Link
                        href={`/banking/transactions?doc=${d.id}` as any}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <DocTypeBadge kind={d.kind} />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <span className="font-mono text-[13px] font-semibold text-slate-700 dark:text-slate-200">{d.document_number}</span>
                          {d.memo ? <span className="ml-2 text-slate-500 dark:text-slate-400">{d.memo}</span> : null}
                        </span>
                        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{d.document_date}</span>
                        <span className="w-24 shrink-0 text-right text-sm tabular-nums">{money(d.total)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('overview.recentImports')}</h2>
              <Link href="/banking/imports" className="text-xs text-teal-700 hover:underline dark:text-teal-300">
                {t('overview.viewAll')}
              </Link>
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
              {recentStmt.rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-slate-500 dark:text-slate-400">{t('overview.noRecentImports')}</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {recentStmt.rows.map((s: any) => (
                    <li key={s.id}>
                      <Link
                        href={`/banking/${s.account_id}?statement=${s.id}` as any}
                        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                      >
                        <Badge variant="outline">{s.source}</Badge>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          <span className="font-medium text-slate-700 dark:text-slate-200">{s.account_number}</span>
                          <span className="ml-2 text-slate-500 dark:text-slate-400">{s.account_name}</span>
                        </span>
                        {Number(s.unmatched_count) > 0 ? (
                          <Badge variant="secondary">{t('overview.unmatchedBadge', { count: Number(s.unmatched_count) })}</Badge>
                        ) : null}
                        <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{s.statement_date}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      </div>
    </PageContainer>
  )
}
