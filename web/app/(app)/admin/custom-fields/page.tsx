import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { FieldDrawer, NewFieldButton } from './FieldDrawer'

export const dynamic = 'force-dynamic'

export default async function CustomFields({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'target', allowedSorts: ['target'] as const, perPage: 100 })
  const target = pickString(sp.target)
  const fieldId = pickString(sp.field)

  const where = sql`true
    ${target ? sql` and target_table = ${target}` : sql``}
    ${params.q ? sql` and (label ilike ${'%' + params.q + '%'} or key ilike ${'%' + params.q + '%'})` : sql``}`

  const [defs, counts, totalRow, open] = await Promise.all([
    db.execute(sql`
      select id, target_table, target_kind, key, label, field_type, config, is_required, is_active, sort_order
        from custom_field_defs where ${where}
       order by target_table, target_kind nulls first, sort_order, label
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select target_table, count(*) as n from custom_field_defs group by 1`) as any,
    db.execute(sql`select count(*) as n from custom_field_defs where ${where}`) as any,
    fieldId && fieldId !== 'new'
      ? (db.execute(sql`select * from custom_field_defs where id = ${fieldId}`) as any)
      : null,
  ])

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Custom Fields"
            description="Extend any module — document headers, transaction lines, parties, projects, accounts. Fields render everywhere the record does: drawers, line grids, and reporting."
            actions={<NewFieldButton />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search fields…" />
            <FilterChips
              basePath="/admin/custom-fields"
              currentParams={sp}
              paramKey="target"
              label="Target"
              options={counts.rows.map((r: any) => ({ value: r.target_table, label: r.target_table, count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Field</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Required</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {defs.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="text-slate-500 dark:text-slate-400">
                No custom fields yet.
              </TableCell>
            </TableRow>
          ) : null}
          {defs.rows.map((d: any) => (
            <TableRow key={d.id}>
              <TableCell>
                <a href={`/admin/custom-fields?field=${d.id}`} className="font-medium text-teal-700 hover:underline dark:text-teal-300">
                  {d.label}
                </a>
              </TableCell>
              <TableCell className="font-mono text-xs text-slate-500">{d.key}</TableCell>
              <TableCell className="font-mono text-xs">
                {d.target_table}
                {d.target_kind ? <span className="text-slate-400">:{d.target_kind}</span> : null}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{d.field_type}</Badge>
              </TableCell>
              <TableCell>{d.is_required ? 'Yes' : ''}</TableCell>
              <TableCell>
                <Badge variant={d.is_active ? 'success' : 'outline'}>{d.is_active ? 'active' : 'archived'}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="mt-3">
        <Pagination basePath="/admin/custom-fields" currentParams={sp} total={Number(totalRow.rows[0].n)} page={params.page} perPage={params.perPage} />
      </div>

      {fieldId ? <FieldDrawer def={open?.rows[0] ?? null} /> : null}
    </ListPageLayout>
  )
}
