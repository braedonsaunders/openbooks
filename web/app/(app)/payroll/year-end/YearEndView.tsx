'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Input, Select } from '@openbooks/ui'
import type { YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import { PagedTable, type PagedColumn } from '../../../../components/paged-table'
import { useMoney } from '../../../../components/money-provider'

type FilingRow = Record<string, string | number | null>

/**
 * Generic year-end renderer: one section per pack-declared filing, driven
 * entirely by the declaration — columns, totals, the download button, and
 * the per-employee issue workflow (reason for issue + comment) when the
 * filing declares one. Column and reason labels are the statutory forms' own
 * field names, declared by the pack and rendered as-is.
 */
export function YearEndView({
  year,
  sections,
}: {
  year: number
  sections: YearEndFilingSection[]
}) {
  const t = useTranslations('payroll.yearEnd')
  const router = useRouter()
  const { money } = useMoney()
  const years = Array.from({ length: 6 }, (_, i) => new Date().getUTCFullYear() - i)
  // Issue declarations (the ROE's reason for issue) are the employer's own
  // statement: nothing is preselected, and a row without one stays out of
  // the file. Keyed by `country:filing:rowId` so two issue filings never
  // share state.
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [comments, setComments] = useState<Record<string, string>>({})

  const issueKey = (section: YearEndFilingSection, row: FilingRow) =>
    `${section.country}:${section.key}:${String(row[section.data.rowKey] ?? '')}`

  const fileHref = (section: YearEndFilingSection, extra?: string) =>
    `/api/payroll/year-end/file?country=${encodeURIComponent(section.country)}`
    + `&filing=${encodeURIComponent(section.key)}&year=${year}${extra ?? ''}`

  const issueSelection = (section: YearEndFilingSection): string => {
    if (!section.issue) return ''
    const idColumn = section.issue.idColumn
    return section.data.rows
      .filter((row) => reasons[issueKey(section, row)])
      .map((row) => [
        String(row[idColumn] ?? ''),
        reasons[issueKey(section, row)],
        encodeURIComponent(comments[issueKey(section, row)] ?? ''),
      ].join(':'))
      .join(',')
  }

  const cell = (section: YearEndFilingSection, row: FilingRow, key: string): string => {
    const column = section.data.columns.find((c) => c.key === key)
    const value = row[key]
    if (value == null || value === '') return '—'
    return column?.money ? money(String(value)) : String(value)
  }

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
      </div>

      {sections.map((section) => {
        const sectionKey = `${section.country}:${section.key}`
        const selection = issueSelection(section)
        const columns: PagedColumn<FilingRow>[] = section.data.columns.map((column) => ({
          key: column.key,
          header: column.label,
          align: column.align === 'right' ? 'right' : undefined,
          search: column.key === section.data.columns[0]?.key
            ? (row: FilingRow) => String(row[column.key] ?? '')
            : undefined,
          cell: (row: FilingRow) => cell(section, row, column.key),
        }))
        return (
          <section key={sectionKey}>
            <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-100">
              {section.label}
            </h2>
            {section.description && (
              <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">{section.description}</p>
            )}

            {section.data.rows.length === 0 ? (
              section.emptyText && <p className="text-sm text-slate-400">{section.emptyText}</p>
            ) : section.issue ? (
              /* Filings issued per employee with an employer declaration:
                 the declared columns plus a reason picker and comment. */
              <table className="w-full max-w-4xl text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 uppercase dark:text-slate-400">
                    {section.data.columns.map((column) => (
                      <th key={column.key} className="py-1.5">{column.label}</th>
                    ))}
                    <th className="py-1.5">{t('roe.reason')}</th>
                    <th className="py-1.5">{t('roe.comment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {section.data.rows.map((row) => {
                    const key = issueKey(section, row)
                    return (
                      <tr key={key} className="border-t border-slate-100 dark:border-slate-800">
                        {section.data.columns.map((column) => (
                          <td key={column.key} className="py-1.5 tabular-nums">
                            {cell(section, row, column.key)}
                          </td>
                        ))}
                        <td className="py-1.5">
                          <Select
                            aria-label={t('roe.reason')}
                            value={reasons[key] ?? ''}
                            onChange={(e) => setReasons((prev) => ({ ...prev, [key]: e.target.value }))}
                            className="w-56"
                          >
                            <option value="">—</option>
                            {section.issue!.reasonCodes.map((reason) => (
                              <option key={reason.code} value={reason.code}>
                                {reason.code} · {reason.label}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td className="py-1.5">
                          <Input
                            aria-label={t('roe.comment')}
                            value={comments[key] ?? ''}
                            onChange={(e) => setComments((prev) => ({ ...prev, [key]: e.target.value }))}
                            maxLength={section.issue!.commentMaxLength}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            ) : (
              <PagedTable
                rows={section.data.rows}
                columns={columns}
                pageSize={25}
                searchable
                empty={section.emptyText ?? ''}
                rowKey={(row) => String(row[section.data.rowKey] ?? '')}
              />
            )}

            {section.data.totals && section.data.rows.length > 0 && (
              <div className="mt-3 grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900">
                {section.data.totals.map((total) => (
                  <div key={total.label}>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{total.label}</div>
                    <div className="font-semibold tabular-nums">
                      {total.money ? money(total.value) : total.value}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {section.download && section.data.rows.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
                {section.issue ? (
                  <Button variant="outline" asChild={selection.length > 0} disabled={selection.length === 0}>
                    {selection.length > 0 ? (
                      <a
                        href={fileHref(section, `&${section.issue.param}=${selection}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {section.download.label}
                      </a>
                    ) : (
                      <span>{section.download.label}</span>
                    )}
                  </Button>
                ) : (
                  <Button variant="outline" asChild>
                    <a href={fileHref(section)} target="_blank" rel="noreferrer">
                      {section.download.label}
                    </a>
                  </Button>
                )}
                {section.download.note && (
                  <span className="text-xs text-slate-400 dark:text-slate-500">{section.download.note}</span>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
