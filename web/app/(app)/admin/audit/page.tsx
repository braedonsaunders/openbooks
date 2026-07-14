import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ScrollText } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'

export const dynamic = 'force-dynamic'

const ACTION_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  insert: 'success',
  update: 'secondary',
  delete: 'destructive',
  post: 'success',
  void: 'warning',
  approve: 'success',
  reject: 'destructive',
}

export default async function Audit({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('admin.audit.read')
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'at', allowedSorts: ['at'] as const, perPage: 50 })
  const action = pickString(sp.action)

  const where = sql`true
    ${action ? sql` and a.action = ${action}` : sql``}
    ${params.q ? sql` and (a.table_name ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or a.row_id::text = ${params.q})` : sql``}`

  const [rows, totalRow, actions] = await Promise.all([
    db.execute(sql`
      select a.*, u.name as actor_name
        from audit_log a
        left join users u on u.id = a.actor_id
       where ${where}
       order by a.at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select count(*) as n from audit_log a left join users u on u.id = a.actor_id where ${where}`) as any,
    db.execute(sql`select action, count(*) as n from audit_log group by 1 order by 2 desc`) as any,
  ])
  const total = Number(totalRow.rows[0].n)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Audit Log"
            description="Field-level history of business-layer changes. The ledger needs no audit trail — it is append-only by construction."
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search table, actor, or row id…" />
            <FilterChips
              basePath="/admin/audit"
              currentParams={sp}
              paramKey="action"
              label="Action"
              options={actions.rows.map((r: any) => ({ value: r.action, label: r.action, count: Number(r.n) }))}
            />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          icon={<ScrollText />}
          title="No audit entries yet"
          description="Business-layer mutations will appear here as modules record their changes."
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Table</TableHead>
                <TableHead>Row</TableHead>
                <TableHead>Changes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{dateTime(r.at)}</TableCell>
                  <TableCell>{r.actor_name ?? <span className="text-slate-400">system</span>}</TableCell>
                  <TableCell>
                    <Badge variant={ACTION_VARIANT[r.action] ?? 'secondary'}>{r.action}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.table_name}</TableCell>
                  <TableCell className="font-mono text-xs text-slate-500">{String(r.row_id).slice(0, 8)}…</TableCell>
                  <TableCell className="max-w-md">
                    <pre className="overflow-x-auto font-mono text-[11px] text-slate-500 dark:text-slate-400">
                      {JSON.stringify(r.changes)}
                    </pre>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/admin/audit" currentParams={sp} total={total} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
    </ListPageLayout>
  )
}
