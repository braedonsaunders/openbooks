import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { FilterChips } from '../../../components/filter-bar'
import { pickString } from '../../../lib/list-params'
import { requirePermission } from '../../../lib/authz'
import { money } from '../../../lib/format'
import { CloseButtons } from './CloseButtons'

export const dynamic = 'force-dynamic'

const MODULES = ['ar', 'ap', 'gl'] as const

export default async function PeriodClose({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('gl.close')
  const sp = await searchParams
  const currentFy = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() + 1 : new Date().getUTCFullYear()
  const fy = Number(pickString(sp.fy) ?? currentFy)

  const [periods, fys] = await Promise.all([
    db.execute(sql`
      select p.id, p.name, p.fiscal_year, p.period_number, p.starts_on, p.ends_on,
             p.ar_closed_at, p.ap_closed_at, p.gl_closed_at,
             coalesce(a.entries, 0) as entries,
             coalesce(a.debits, 0) as debits
        from accounting_periods p
        left join lateral (
          select count(distinct e.id) as entries,
                 sum(case when l.amount > 0 then l.amount else 0 end) as debits
            from journal_entries e
            join journal_lines l on l.entry_id = e.id
           where e.period_id = p.id
        ) a on true
       where p.fiscal_year = ${fy}
       order by p.period_number
    `) as any,
    db.execute(sql`
      select distinct p.fiscal_year, count(e.id) as n
        from accounting_periods p
        left join journal_entries e on e.period_id = p.id
       group by p.fiscal_year having count(e.id) > 0 or p.fiscal_year >= ${currentFy - 1}
       order by p.fiscal_year desc
    `) as any,
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Period Close"
            description="Close modules per period: AR and AP lock their subledgers; GL close locks the period for posting entirely (enforced by the kernel — a closed period refuses postings at the database)."
          />
          <FilterChips
            basePath="/close"
            currentParams={sp}
            paramKey="fy"
            label="Fiscal year"
            hideAll
            defaultValue={String(currentFy)}
            options={fys.rows.map((r: any) => ({ value: String(r.fiscal_year), label: `FY ${r.fiscal_year}` }))}
          />
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead>Range</TableHead>
            <TableHead className="text-right">Entries</TableHead>
            <TableHead className="text-right">Debits</TableHead>
            {MODULES.map((m) => (
              <TableHead key={m} className="uppercase">{m}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.rows.map((p: any) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell className="text-slate-500 dark:text-slate-400">
                {p.starts_on} → {p.ends_on}
              </TableCell>
              <TableCell className="text-right tabular-nums">{Number(p.entries).toLocaleString()}</TableCell>
              <TableCell className="text-right tabular-nums">{money(p.debits)}</TableCell>
              {MODULES.map((m) => {
                const closedAt = p[`${m}_closed_at`]
                return (
                  <TableCell key={m}>
                    <span className="flex items-center gap-2">
                      <Badge variant={closedAt ? 'success' : 'outline'}>{closedAt ? 'closed' : 'open'}</Badge>
                      <CloseButtons periodId={p.id} module={m} closed={!!closedAt} />
                    </span>
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ListPageLayout>
  )
}
