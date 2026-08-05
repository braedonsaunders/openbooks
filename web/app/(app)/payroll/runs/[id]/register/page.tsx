import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { getMoneyFormatter } from '@/lib/money-server'
import { ListPageLayout } from '../../../../../../components/page-layout'
import { requirePermission } from '../../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { PrintButton } from './PrintButton'

export const dynamic = 'force-dynamic'

/**
 * Payroll register — the classic per-run report: one row per employee with
 * gross, statutory splits, other deductions, net, and employer cost, plus a
 * totals row. Print-first: the header chrome hides in print CSS.
 */
export default async function PayRunRegisterPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const t = await getTranslations('payroll')
  const { money } = await getMoneyFormatter()

  const runRes = (await db.execute(sql`
    select d.document_number, r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, o.name as org_name
      from pay_runs r
      join documents d on d.id = r.document_id
      join orgs o on o.id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${id}
  `)) as unknown as { rows: Record<string, string>[] }
  const run = runRes.rows[0]
  if (!run) notFound()

  const stubs = (await db.execute(sql`
    select p.display_name as name, s.province, s.gross, s.net_pay, s.employer_cost,
           s.vacation_accrued, s.factors,
           (select coalesce(sum(l.amount), 0) from pay_stub_lines l
             join pay_components c on c.id = l.component_id
            where l.stub_id = s.id and l.kind = 'deduction' and c.system_key is null) as other_deductions
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${id}
     order by p.display_name
  `)) as unknown as {
    rows: {
      name: string; province: string; gross: string; net_pay: string; employer_cost: string;
      vacation_accrued: string; factors: Record<string, string>; other_deductions: string;
    }[]
  }

  const n = (v: string | undefined | null) => Number(v ?? 0) || 0
  const totals = stubs.rows.reduce(
    (acc, s) => {
      const f = s.factors ?? {}
      acc.gross += n(s.gross)
      acc.cpp += n(f.C) + n(f.C2) + n(f.SS) + n(f.MED) + n(f.MED2)
      acc.ei += n(f.EI)
      acc.tax += n(f.T) + n(f.TB) + n(f.FIT)
      acc.other += n(s.other_deductions)
      acc.net += n(s.net_pay)
      acc.employer += n(s.employer_cost)
      return acc
    },
    { gross: 0, cpp: 0, ei: 0, tax: 0, other: 0, net: 0, employer: 0 },
  )

  const cell = 'px-2.5 py-1.5 text-right tabular-nums'
  return (
    <ListPageLayout
      header={
        <div className="print:hidden">
          <PageHeader
            title={`${t('register.title')} — ${run.document_number}`}
            description={`${run.period_start} – ${run.period_end} · ${t('columns.payDate')} ${run.pay_date}`}
            back={{ href: `/payroll/runs/${id}`, label: run.document_number }}
            actions={<PrintButton />}
          />
        </div>
      }
    >
      <div className="hidden print:block print:mb-4">
        <h1 className="text-lg font-bold">{run.org_name} — {t('register.title')}</h1>
        <p className="text-sm">
          {run.document_number} · {run.period_start} – {run.period_end} · {t('columns.payDate')} {run.pay_date}
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-300 text-left text-xs uppercase">
            <th className="px-2.5 py-1.5">{t('run.stub.employee')}</th>
            <th className="px-2.5 py-1.5">{t('run.stub.province')}</th>
            <th className={cell}>{t('columns.gross')}</th>
            <th className={cell}>{t('register.cppFica')}</th>
            <th className={cell}>{t('run.stub.ei')}</th>
            <th className={cell}>{t('run.stub.tax')}</th>
            <th className={cell}>{t('register.otherDeductions')}</th>
            <th className={cell}>{t('columns.net')}</th>
            <th className={cell}>{t('run.employerCost')}</th>
          </tr>
        </thead>
        <tbody>
          {stubs.rows.map((s) => {
            const f = s.factors ?? {}
            return (
              <tr key={s.name} className="border-b border-slate-100">
                <td className="px-2.5 py-1.5">{s.name}</td>
                <td className="px-2.5 py-1.5">{s.province}</td>
                <td className={cell}>{money(s.gross)}</td>
                <td className={cell}>{money(n(f.C) + n(f.C2) + n(f.SS) + n(f.MED) + n(f.MED2))}</td>
                <td className={cell}>{money(n(f.EI))}</td>
                <td className={cell}>{money(n(f.T) + n(f.TB) + n(f.FIT))}</td>
                <td className={cell}>{money(s.other_deductions)}</td>
                <td className={`${cell} font-medium`}>{money(s.net_pay)}</td>
                <td className={cell}>{money(s.employer_cost)}</td>
              </tr>
            )
          })}
          <tr className="border-t-2 border-slate-400 font-semibold">
            <td className="px-2.5 py-1.5" colSpan={2}>{t('register.totals', { count: stubs.rows.length })}</td>
            <td className={cell}>{money(totals.gross)}</td>
            <td className={cell}>{money(totals.cpp)}</td>
            <td className={cell}>{money(totals.ei)}</td>
            <td className={cell}>{money(totals.tax)}</td>
            <td className={cell}>{money(totals.other)}</td>
            <td className={cell}>{money(totals.net)}</td>
            <td className={cell}>{money(totals.employer)}</td>
          </tr>
        </tbody>
      </table>
    </ListPageLayout>
  )
}
