'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Select } from '@openbooks/ui'
import type {
  Form941Quarter, T4Slip, T4SummaryTotals, W2Slip,
} from '@openbooks/engine/src/payroll-yearend.ts'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useMoney } from '../../../../components/money-provider'

export function YearEndView({
  year,
  t4,
  summary,
  form941,
  w2,
}: {
  year: number
  t4: T4Slip[]
  summary: T4SummaryTotals
  form941: Form941Quarter[]
  w2: W2Slip[]
}) {
  const t = useTranslations('payroll.yearEnd')
  const router = useRouter()
  const { money } = useMoney()
  const years = Array.from({ length: 6 }, (_, i) => new Date().getUTCFullYear() - i)

  const t4Columns: PagedColumn<T4Slip>[] = [
    { key: 'employee', header: t('t4.employee'), search: (s) => s.employeeName, cell: (s) => s.employeeName },
    { key: 'province', header: t('t4.province'), cell: (s) => s.province },
    { key: 'box14', header: t('t4.box14'), align: 'right', cell: (s) => money(s.box14EmploymentIncome) },
    {
      key: 'box16', header: t('t4.box16'), align: 'right',
      cell: (s) => money(Number(s.box16Cpp) + Number(s.box16aCpp2)),
    },
    { key: 'box18', header: t('t4.box18'), align: 'right', cell: (s) => money(s.box18Ei) },
    { key: 'box22', header: t('t4.box22'), align: 'right', cell: (s) => money(s.box22IncomeTax) },
    { key: 'box24', header: t('t4.box24'), align: 'right', cell: (s) => money(s.box24EiInsurable) },
    { key: 'box26', header: t('t4.box26'), align: 'right', cell: (s) => money(s.box26CppPensionable) },
    { key: 'box44', header: t('t4.box44'), align: 'right', cell: (s) => money(s.box44UnionDues) },
  ]

  const w2Columns: PagedColumn<W2Slip>[] = [
    { key: 'employee', header: t('w2.employee'), search: (s) => s.employeeName, cell: (s) => s.employeeName },
    { key: 'state', header: t('w2.state'), cell: (s) => s.state },
    { key: 'box1', header: t('w2.box1'), align: 'right', cell: (s) => money(s.box1Wages) },
    { key: 'box2', header: t('w2.box2'), align: 'right', cell: (s) => money(s.box2FederalIncomeTax) },
    { key: 'box3', header: t('w2.box3'), align: 'right', cell: (s) => money(s.box3SsWages) },
    { key: 'box4', header: t('w2.box4'), align: 'right', cell: (s) => money(s.box4SsTax) },
    { key: 'box5', header: t('w2.box5'), align: 'right', cell: (s) => money(s.box5MedicareWages) },
    { key: 'box6', header: t('w2.box6'), align: 'right', cell: (s) => money(s.box6MedicareTax) },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 print:hidden">
        <Select
          aria-label={t('yearLabel')}
          value={String(year)}
          onChange={(e) => router.push(`/payroll/year-end?year=${e.target.value}` as never)}
          className="w-32"
        >
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </Select>
        <Button variant="outline" onClick={() => window.print()}>{t('print')}</Button>
        <Button variant="outline" asChild>
          <a href={`/api/payroll/year-end/t4-xml?year=${year}`} target="_blank" rel="noreferrer">
            {t('t4Xml.download')}
          </a>
        </Button>
        <span className="text-xs text-slate-400 dark:text-slate-500">{t('t4Xml.note')}</span>
      </div>

      <section>
        <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">{t('t4.title')}</h2>
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">{t('t4.description')}</p>
        {t4.length === 0 ? (
          <p className="text-sm text-slate-400">{t('t4.empty')}</p>
        ) : (
          <>
            <PagedTable
              rows={t4}
              columns={t4Columns}
              pageSize={25}
              searchable
              empty={t('t4.empty')}
              rowKey={(s) => s.employeePartyId}
            />
            <div className="mt-3 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.slips')}</div>
                <div className="font-semibold tabular-nums">{summary.slips}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.income')}</div>
                <div className="font-semibold tabular-nums">{money(summary.employmentIncome)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.cpp')}</div>
                <div className="font-semibold tabular-nums">
                  {money(
                    Number(summary.employeeCpp) + Number(summary.employeeCpp2) + Number(summary.employerCpp),
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.ei')}</div>
                <div className="font-semibold tabular-nums">
                  {money(Number(summary.employeeEi) + Number(summary.employerEi))}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.tax')}</div>
                <div className="font-semibold tabular-nums">{money(summary.incomeTax)}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t('summary.remitted')}</div>
                <div className="font-semibold tabular-nums">{money(summary.remitted)}</div>
              </div>
            </div>
          </>
        )}
      </section>

      {(form941.length > 0 || w2.length > 0) && (
        <section>
          <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">{t('us.title')}</h2>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">{t('us.description')}</p>
          {form941.length > 0 && (
            <table className="mb-4 w-full max-w-3xl text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase dark:text-slate-400">
                  <th className="py-1.5">{t('us.quarter')}</th>
                  <th className="py-1.5 text-right">{t('us.wages')}</th>
                  <th className="py-1.5 text-right">{t('us.fit')}</th>
                  <th className="py-1.5 text-right">{t('us.ssWages')}</th>
                  <th className="py-1.5 text-right">{t('us.ssTax')}</th>
                  <th className="py-1.5 text-right">{t('us.medicareTax')}</th>
                </tr>
              </thead>
              <tbody>
                {form941.map((q) => (
                  <tr key={q.quarter} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">Q{q.quarter}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(q.wages)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(q.federalIncomeTax)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(q.ssWages)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(q.ssTax)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(q.medicareTax)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {w2.length > 0 && (
            <PagedTable
              rows={w2}
              columns={w2Columns}
              pageSize={25}
              searchable
              empty={t('us.empty')}
              rowKey={(s) => s.employeePartyId}
            />
          )}
        </section>
      )}
    </div>
  )
}
