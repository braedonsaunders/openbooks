import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadEftSettings, paymentRunReadiness } from '@openbooks/engine/src/payments.ts'
import { Alert, AlertDescription, AlertTitle, Badge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { isUuid, parsePrefixedListParams, pickString } from '../../../lib/list-params'
import { money, dateTime } from '../../../lib/format'
import { RunBuilder, type RunBill } from './RunBuilder'
import { RunDrawer, type RunBlockerClient } from './RunDrawer'

/**
 * Payment-run view: pick posted-open bills across vendors into an EFT run,
 * manage existing runs, and open the ?run= flyout. Both sub-lists are
 * URL-driven with prefixed params (bills*, runs*).
 */

const RUN_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'outline' | 'default'> = {
  confirmed: 'success',
  exported: 'default',
  draft: 'secondary',
  cancelled: 'outline',
}

// payment_runs.status enum → common.status.* message keys (confirmed/exported
// live in payments.runs.status.*; fallback: raw value).
const RUN_STATUS_COMMON_KEY: Record<string, string> = {
  draft: 'draft',
  pending_approval: 'pendingApproval',
  approved: 'approved',
  cancelled: 'cancelled',
}

const BILL_SORTS = {
  number: sql`document_number`,
  vendor: sql`vendor`,
  due: sql`due_date`,
  open: sql`open`,
} as const

export async function RunsSection({
  sp,
  orgId,
}: {
  sp: Record<string, string | string[] | undefined>
  orgId: string
}) {
  const t = await getTranslations('payments')
  const tCommon = await getTranslations('common')
  const runStatusLabel = (status: string) => {
    if (status === 'confirmed' || status === 'exported') return t(`runs.status.${status}`)
    const key = RUN_STATUS_COMMON_KEY[status]
    return key ? tCommon(`status.${key}`) : status.replace('_', ' ')
  }
  const eft = await loadEftSettings(orgId)

  const billParams = parsePrefixedListParams(sp, 'bills', {
    sort: 'due',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['number', 'vendor', 'due', 'open'] as const,
  })
  const runParams = parsePrefixedListParams(sp, 'runs', {
    sort: 'created',
    dir: 'desc',
    perPage: 10,
    allowedSorts: ['created'] as const,
  })
  const runStatus = pickString(sp.runsStatus)

  const billWhere = billParams.q
    ? sql` and (document_number ilike ${'%' + billParams.q + '%'} or vendor ilike ${'%' + billParams.q + '%'} or reference_number ilike ${'%' + billParams.q + '%'})`
    : sql``
  const openBillsCte = sql`
    select d.id, d.document_number, d.document_date, d.due_date, d.reference_number,
           p.display_name as vendor,
           abs(jl.amount) - coalesce((
             select sum(a.amount) from applications a
              where a.to_line_id = jl.id and a.unapplied_at is null), 0) as open,
           exists (
             select 1 from party_bank_accounts b
              where b.party_id = d.party_id and b.is_active and b.approved_at is not null
           ) as has_bank
      from documents d
      join parties p on p.id = d.party_id
      join journal_entries je on je.id = d.posted_entry_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.is_open_item and jl.amount < 0
     where d.org_id = ${orgId} and d.kind = 'vendor_bill' and d.status = 'posted'`

  const [bills, billCount, runs, runCounts] = await Promise.all([
    db.execute(sql`
      with open_bills as (${openBillsCte})
      select * from open_bills where open > 0 ${billWhere}
      order by ${BILL_SORTS[billParams.sort]} ${billParams.dir === 'asc' ? sql`asc` : sql`desc`} nulls last, document_number
      limit ${billParams.perPage} offset ${(billParams.page - 1) * billParams.perPage}
    `) as any,
    db.execute(sql`
      with open_bills as (${openBillsCte})
      select count(*) as n from open_bills where open > 0 ${billWhere}
    `) as any,
    db.execute(sql`
      select r.id, r.run_number, r.status, r.scheduled_for, r.exported_at, r.created_at,
             a.number as bank_number, a.name as bank_name,
             count(i.id) filter (where i.status <> 'cancelled') as instruction_count,
             coalesce(sum(i.amount) filter (where i.status <> 'cancelled'), 0) as total
        from payment_runs r
        left join accounts a on a.id = r.bank_account_id
        left join payment_instructions i on i.payment_run_id = r.id
       where r.org_id = ${orgId} ${runStatus ? sql` and r.status = ${runStatus}` : sql``}
       group by r.id, a.number, a.name
       order by r.created_at desc
       limit ${runParams.perPage} offset ${(runParams.page - 1) * runParams.perPage}
    `) as any,
    db.execute(sql`
      select status, count(*) as n from payment_runs where org_id = ${orgId} group by status
    `) as any,
  ])

  const runsTotal = runCounts.rows.reduce((a: number, r: any) => a + Number(r.n), 0)
  const runsFilteredTotal = runStatus
    ? Number(runCounts.rows.find((r: any) => r.status === runStatus)?.n ?? 0)
    : runsTotal

  // -- ?run= flyout ----------------------------------------------------------
  const runId = typeof sp.run === 'string' && isUuid(sp.run) ? sp.run : undefined
  let drawer: React.ReactNode = null
  if (runId) {
    const run = (await db.execute(sql`
      select r.*, a.number as bank_number, a.name as bank_name
        from payment_runs r
        left join accounts a on a.id = r.bank_account_id
       where r.id = ${runId} and r.org_id = ${orgId}
    `)) as any
    if (run.rows[0]) {
      const [instructions, readiness] = await Promise.all([
        db.execute(sql`
          select i.id, i.amount, i.currency, i.status, p.display_name as payee,
                 i.payment_document_id, d.document_number, d.status as payment_status
            from payment_instructions i
            join parties p on p.id = i.payee_party_id
            left join documents d on d.id = i.payment_document_id
           where i.payment_run_id = ${runId}
           order by p.display_name
        `) as any,
        paymentRunReadiness(runId, orgId),
      ])
      drawer = (
        <RunDrawer
          run={run.rows[0]}
          instructions={instructions.rows}
          eftConfigured={readiness.eft.ok}
          eftMissing={readiness.eft.ok ? [] : readiness.eft.missing}
          blockers={readiness.blockers as RunBlockerClient[]}
        />
      )
    }
  }

  const bankAccounts = (await db.execute(sql`
    select id, number, name from accounts
     where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
     order by number nulls last, name
  `)) as any

  return (
    <div className="space-y-8">
      {!eft.ok ? (
        <Alert variant="warning">
          <AlertTitle>{t('eft.notConfiguredTitle')}</AlertTitle>
          <AlertDescription>
            {t.rich('eft.notConfiguredListDescription', {
              missing: eft.missing.join(', '),
              code: (chunks) => <code className="font-mono text-xs">{chunks}</code>,
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('runs.openBillsHeading')}
          </h2>
          <SearchInput placeholder={t('runs.billsSearchPlaceholder')} paramKey="billsQ" pageParamKey="billsPage" />
        </div>
        <RunBuilder
          bills={bills.rows as RunBill[]}
          bankAccounts={bankAccounts.rows}
          sp={sp}
          sort={billParams.sort}
          dir={billParams.dir}
        />
        <Pagination
          basePath="/payments"
          currentParams={sp}
          total={Number(billCount.rows[0].n)}
          page={billParams.page}
          perPage={billParams.perPage}
          pageParamKey="billsPage"
        />
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold text-slate-900 dark:text-slate-100">{t('runs.runsHeading')}</h2>
          <FilterChips
            basePath="/payments"
            currentParams={sp}
            paramKey="runsStatus"
            label={tCommon('labels.status')}
            pageParamKey="runsPage"
            options={runCounts.rows.map((r: any) => ({
              value: r.status,
              label: runStatusLabel(String(r.status)),
              count: Number(r.n),
            }))}
          />
        </div>
        {runsTotal === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-3 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            {t('runs.noRunsYet')}
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('runs.columns.run')}</TableHead>
                  <TableHead>{tCommon('labels.created')}</TableHead>
                  <TableHead>{t('runs.columns.bankAccount')}</TableHead>
                  <TableHead>{t('runs.columns.fundsDate')}</TableHead>
                  <TableHead className="text-right">{t('runs.columns.payments')}</TableHead>
                  <TableHead className="text-right">{tCommon('labels.total')}</TableHead>
                  <TableHead>{tCommon('labels.status')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.rows.map((r: any) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-[13px] font-semibold">
                      <Link
                        href={`/payments?view=runs&run=${r.id}` as any}
                        className="text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {r.run_number}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-300">{dateTime(r.created_at)}</TableCell>
                    <TableCell>{`${r.bank_number ?? ''} ${r.bank_name ?? ''}`.trim() || '—'}</TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-300">{r.scheduled_for ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.instruction_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.total)}</TableCell>
                    <TableCell>
                      <Badge variant={RUN_VARIANT[r.status] ?? 'secondary'}>
                        {runStatusLabel(String(r.status))}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              basePath="/payments"
              currentParams={sp}
              total={runsFilteredTotal}
              page={runParams.page}
              perPage={runParams.perPage}
              pageParamKey="runsPage"
            />
          </>
        )}
      </section>
      {drawer}
    </div>
  )
}
