import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, EmptyState, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { SearchInput } from '../../../components/search-input'
import { FilterChips } from '../../../components/filter-bar'
import { Pagination } from '../../../components/pagination'
import { SortTh } from '../../../components/sortable-th'
import { can, requirePermission } from '../../../lib/authz'
import { isUuid, parseListParams, pickString } from '../../../lib/list-params'
import { money } from '../../../lib/format'
import { loadProject } from '../../api/projects/_lib'
import { NewProjectButton } from './NewProjectButton'
import { NewProjectRedirect } from './NewProjectRedirect'
import { ProjectDrawer } from './ProjectDrawer'

export const dynamic = 'force-dynamic'

const SORT_COLUMNS = {
  name: sql`p.name`,
  code: sql`p.code`,
  customer: sql`cust.display_name`,
  contract: sql`(p.custom->>'contractValue')::numeric`,
  actual: sql`actual.cost`,
} as const

const STATUSES = ['quoted', 'awarded', 'active', 'substantially_complete', 'closed', 'cancelled'] as const
const STATUS_LABELS: Record<string, string> = {
  quoted: 'Quoted',
  awarded: 'Awarded',
  active: 'Active',
  substantially_complete: 'Substantially complete',
  closed: 'Closed',
  cancelled: 'Cancelled',
}
const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'outline' | 'destructive'> = {
  quoted: 'secondary',
  awarded: 'warning',
  active: 'success',
  substantially_complete: 'default',
  closed: 'outline',
  cancelled: 'destructive',
}

const BILLING_METHODS = ['time_and_materials', 'fixed_price', 'cost_plus'] as const
const BILLING_LABELS: Record<string, string> = {
  time_and_materials: 'Time & materials',
  fixed_price: 'Fixed price',
  cost_plus: 'Cost plus',
}

export default async function Projects({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('projects.read')
  const canManage = can(authz, 'projects.manage')
  const orgId = authz.user.orgId

  const sp = await searchParams
  const projectId = typeof sp.project === 'string' ? sp.project : undefined
  const params = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: ['name', 'code', 'customer', 'contract', 'actual'] as const,
  })
  const statusParam = pickString(sp.status)
  const status = statusParam && (STATUSES as readonly string[]).includes(statusParam) ? statusParam : undefined
  const billingParam = pickString(sp.billing)
  const billing = billingParam && (BILLING_METHODS as readonly string[]).includes(billingParam) ? billingParam : undefined

  // posted actual cost per project, tagged via journal lines
  const ACTUAL_JOIN = sql`
    left join lateral (
      select coalesce(sum(l.amount), 0) as cost
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where l.org_id = p.org_id and l.project_id = p.id and e.status = 'posted'
         and a.type in ('expense', 'cogs', 'expense_other', 'expense_deferred')
    ) actual on true`

  const where = sql`p.org_id = ${orgId}
    ${
      params.q
        ? sql` and (p.name ilike ${'%' + params.q + '%'} or p.code ilike ${'%' + params.q + '%'} or cust.display_name ilike ${'%' + params.q + '%'})`
        : sql``
    }
    ${status ? sql` and p.status = ${status}` : sql``}
    ${billing ? sql` and p.billing_method = ${billing}` : sql``}`

  const [projects, counts] = await Promise.all([
    db.execute(sql`
      select p.id, p.code, p.name, p.status, p.billing_method, p.is_active,
             cust.display_name as customer_name,
             coalesce((p.custom->>'contractValue')::numeric, 0) as contract_value,
             actual.cost as actual_cost
        from projects p
        left join parties cust on cust.id = p.customer_id
        ${ACTUAL_JOIN}
       where ${where}
       order by ${SORT_COLUMNS[params.sort]} ${params.dir === 'asc' ? sql`asc` : sql`desc`} nulls last
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`
      select count(*) as total, p.status, count(*) as status_count
        from projects p
       where p.org_id = ${orgId}
       group by rollup (p.status)
    `) as any,
  ])

  const grand = counts.rows.find((r: any) => r.status === null) ?? { total: 0 }
  const statusCounts = new Map<string, number>()
  for (const r of counts.rows as any[]) {
    if (r.status !== null) statusCounts.set(r.status, Number(r.status_count))
  }
  const total = Number(grand.total)
  const filteredTotal =
    params.q || status || billing
      ? Number(
          (
            (await db.execute(sql`
              select count(*) as n
                from projects p
                left join parties cust on cust.id = p.customer_id
               where ${where}`)) as any
          ).rows[0].n,
        )
      : total

  const openProject =
    projectId && projectId !== 'new' && isUuid(projectId) ? await loadProject(projectId, orgId) : null

  // party pickers for the drawer (customer/foreman/manager)
  const parties = projectId
    ? ((await db.execute(sql`
        select id, display_name from parties
         where org_id = ${orgId} and is_active
         order by display_name limit 2000`)) as any)
    : null

  const statusOptions = (STATUSES as readonly string[]).map((s) => ({
    value: s,
    label: STATUS_LABELS[s] ?? s,
    count: statusCounts.get(s) ?? 0,
  }))
  const billingOptions = (BILLING_METHODS as readonly string[]).map((b) => ({
    value: b,
    label: BILLING_LABELS[b] ?? b,
  }))

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Projects"
            description="Jobs, their contracts, and the cost budget behind every dollar posted to them."
            actions={canManage ? <NewProjectButton /> : undefined}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search name, code, customer…" />
            <FilterChips basePath="/projects" currentParams={sp} paramKey="status" label="Status" options={statusOptions} />
            <FilterChips basePath="/projects" currentParams={sp} paramKey="billing" label="Billing" options={billingOptions} />
          </div>
        </>
      }
    >
      {total === 0 ? (
        <EmptyState
          title="No projects yet"
          description="Create the first job to start tracking its contract, budget, and costs."
          action={canManage ? <NewProjectButton /> : undefined}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <SortTh basePath="/projects" currentParams={sp} column="code" sort={params.sort} dir={params.dir}>Code</SortTh>
                <SortTh basePath="/projects" currentParams={sp} column="name" sort={params.sort} dir={params.dir}>Name</SortTh>
                <SortTh basePath="/projects" currentParams={sp} column="customer" sort={params.sort} dir={params.dir}>Customer</SortTh>
                <TableHead>Status</TableHead>
                <TableHead>Billing</TableHead>
                <SortTh basePath="/projects" currentParams={sp} column="contract" sort={params.sort} dir={params.dir} align="right" className="text-right">Contract value</SortTh>
                <SortTh basePath="/projects" currentParams={sp} column="actual" sort={params.sort} dir={params.dir} align="right" className="text-right">Actual cost</SortTh>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.rows.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-[13px]">{p.code}</TableCell>
                  <TableCell className="font-semibold">
                    <Link href={`/projects/${p.id}`} className="text-teal-700 hover:underline dark:text-teal-300">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">{p.customer_name}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'secondary'}>{STATUS_LABELS[p.status] ?? p.status}</Badge>
                  </TableCell>
                  <TableCell className="text-slate-500 dark:text-slate-400">
                    {p.billing_method ? (BILLING_LABELS[p.billing_method] ?? p.billing_method) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.contract_value)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.actual_cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-3">
            <Pagination basePath="/projects" currentParams={sp} total={filteredTotal} page={params.page} perPage={params.perPage} />
          </div>
        </>
      )}
      {projectId === 'new' && canManage ? <NewProjectRedirect /> : null}
      {openProject && parties ? (
        <ProjectDrawer
          key={String(openProject.project.id)}
          payload={openProject as any}
          parties={parties.rows}
          canManage={canManage}
        />
      ) : null}
    </ListPageLayout>
  )
}
