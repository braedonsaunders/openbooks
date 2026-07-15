import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { Table, TableBody, TableCell, TableRow, cn } from '@openbooks/ui'
import type { StatementRow } from '../../../lib/reports'
import { money } from '../../../lib/format'

export async function StatementTable({
  sections,
  grandTotal,
}: {
  sections: { title: string; types: string[]; rows: StatementRow[]; total: number }[]
  grandTotal?: { label: string; value: number }
}) {
  const t = await getTranslations('reports')
  return (
    <Table>
      <TableBody>
        {sections.map((s) => {
          const rows = s.rows
            .filter((r) => s.types.includes(r.type))
            // The computed accumulated-earnings row is code-defined (lib/reports.ts),
            // not an account from the database — translate its label here.
            .map((r) =>
              r.id === 'computed-earnings' ? { ...r, name: t('statement.accumulatedEarnings') } : r,
            )
          if (rows.length === 0) return null
          return (
            <SectionRows
              key={s.title}
              title={s.title}
              rows={rows}
              total={s.total}
              totalLabel={t('statement.sectionTotal', { section: s.title })}
            />
          )
        })}
        {grandTotal ? (
          <TableRow>
            <TableCell className="font-bold">{grandTotal.label}</TableCell>
            <TableCell className={cn('text-right font-bold tabular-nums', grandTotal.value < 0 && 'text-red-600 dark:text-red-400')}>
              {money(grandTotal.value)}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

function SectionRows({
  title,
  rows,
  total,
  totalLabel,
}: {
  title: string
  rows: StatementRow[]
  total: number
  totalLabel: string
}) {
  return (
    <>
      <TableRow>
        <TableCell
          colSpan={2}
          className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase dark:bg-slate-900 dark:text-slate-300"
        >
          {title}
        </TableCell>
      </TableRow>
      {rows.map((r) => (
        <TableRow key={r.id}>
          <TableCell className={cn(r.depth === 1 && 'pl-8', r.depth >= 2 && 'pl-12', r.isSummary && 'font-semibold')}>
            <Link href={`/accounts/${r.id}`} className="hover:text-teal-700 dark:hover:text-teal-300">
              <span className="mr-1.5 font-mono text-xs text-slate-500 dark:text-slate-400">{r.number}</span>
              {r.name}
            </Link>
          </TableCell>
          <TableCell className={cn('text-right tabular-nums', r.balance < 0 && 'text-red-600 dark:text-red-400')}>
            {money(r.balance)}
          </TableCell>
        </TableRow>
      ))}
      <TableRow>
        <TableCell className="font-semibold">{totalLabel}</TableCell>
        <TableCell className={cn('text-right font-semibold tabular-nums', total < 0 && 'text-red-600 dark:text-red-400')}>
          {money(total)}
        </TableCell>
      </TableRow>
    </>
  )
}
