import Link from 'next/link'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ShieldCheck } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { SortTh } from '../../../../components/sortable-th'
import { Pagination } from '../../../../components/pagination'
import { requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { EditRoleButton, NewRoleButton, type RoleRow } from './RoleEditor'

export const metadata = { title: 'Roles' }
export const dynamic = 'force-dynamic'

const BASE = '/admin/roles'
const SORTS = ['name', 'permissions', 'members'] as const
const ORDER: Record<(typeof SORTS)[number], string> = {
  name: 'lower(r.name)',
  permissions: 'permission_count',
  members: 'member_count',
}

export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.roles.manage')
  const orgId = authz.user.orgId
  const sp = await searchParams
  const listParams = parseListParams(sp, {
    sort: 'name',
    dir: 'asc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const typeParam = pickString(sp.type)
  const type = typeParam === 'built_in' || typeParam === 'custom' ? typeParam : undefined

  const filters: SQL[] = [sql`r.org_id = ${orgId}`]
  if (listParams.q) {
    const like = `%${listParams.q}%`
    filters.push(sql`(r.name ilike ${like} or r.description ilike ${like} or r.key ilike ${like})`)
  }
  const searchWhere = sql.join(filters, sql` and `)
  if (type) filters.push(sql`r.is_built_in = ${type === 'built_in'}`)
  const where = sql.join(filters, sql` and `)
  // Sort key is whitelisted through ORDER — never raw user input.
  const orderBy = sql.raw(
    `${ORDER[listParams.sort]} ${listParams.dir === 'asc' ? 'asc' : 'desc'}, lower(r.name) asc`,
  )

  const [rowsR, countR, typeCountsR] = (await Promise.all([
    db.execute(sql`
      select r.id, r.key, r.name, r.description, r.is_built_in, r.permissions,
             coalesce(jsonb_array_length(r.permissions), 0)::int as permission_count,
             (select count(*)::int from role_assignments a
               where a.role_id = r.id and a.org_id = r.org_id) as member_count
        from app_roles r
       where ${where}
       order by ${orderBy}
       limit ${listParams.perPage} offset ${(listParams.page - 1) * listParams.perPage}`),
    db.execute(sql`select count(*)::int as c from app_roles r where ${where}`),
    db.execute(sql`
      select r.is_built_in, count(*)::int as c from app_roles r
       where ${searchWhere} group by r.is_built_in`),
  ])) as any[]

  const roles = (rowsR.rows as any[]).map(
    (r): RoleRow & { permissionCount: number; memberCount: number } => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isBuiltIn: r.is_built_in,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      permissionCount: Number(r.permission_count),
      memberCount: Number(r.member_count),
    }),
  )
  const total = Number(countR.rows[0]?.c ?? 0)
  const typeCounts = Object.fromEntries(
    typeCountsR.rows.map((r: any) => [r.is_built_in ? 'built_in' : 'custom', Number(r.c)]),
  ) as Record<string, number>

  const sortProps = { basePath: BASE, currentParams: sp, sort: listParams.sort, dir: listParams.dir }

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title="Roles"
            description="Bundles of permissions you assign to users. Built-in roles ship with the app; create custom roles for anything finer-grained."
            actions={
              <div className="flex items-center gap-2">
                <Link href="/admin/users">
                  <Button variant="outline">Manage users</Button>
                </Link>
                <NewRoleButton />
              </div>
            }
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput placeholder="Search role name, key, or description…" />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="type"
              label="Type"
              options={[
                { value: 'built_in', label: 'Built-in', count: typeCounts.built_in ?? 0 },
                { value: 'custom', label: 'Custom', count: typeCounts.custom ?? 0 },
              ]}
            />
          </div>
        </>
      }
    >
      {roles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={!listParams.q && !type ? 'No roles yet' : 'No matching roles'}
          description={
            !listParams.q && !type
              ? 'Run the role seed script (engine/src/seed-roles.ts) to create the built-in roles, or create a custom role.'
              : 'Adjust the search or type filter.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:bg-slate-900/80 dark:text-slate-400">
                <SortTh column="name" {...sortProps}>
                  Name
                </SortTh>
                <th className="px-3 py-2">Key</th>
                <th className="px-3 py-2">Description</th>
                <SortTh column="permissions" {...sortProps}>
                  Permissions
                </SortTh>
                <SortTh column="members" {...sortProps}>
                  Members
                </SortTh>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {roles.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/60">
                  <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {r.name}
                  </td>
                  <td className="px-3 py-2 font-mono text-[13px] text-slate-600 dark:text-slate-400">
                    {r.key}
                  </td>
                  <td className="max-w-md px-3 py-2 text-slate-600 dark:text-slate-400">
                    <span className="line-clamp-1">{r.description ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                    {r.permissionCount}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-slate-600 dark:text-slate-400">
                    {r.memberCount}
                  </td>
                  <td className="px-3 py-2">
                    {r.isBuiltIn ? (
                      <Badge variant="secondary">Built-in</Badge>
                    ) : (
                      <Badge variant="outline">Custom</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <EditRoleButton role={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        basePath={BASE}
        currentParams={sp}
        total={total}
        page={listParams.page}
        perPage={listParams.perPage}
      />
    </ListPageLayout>
  )
}
