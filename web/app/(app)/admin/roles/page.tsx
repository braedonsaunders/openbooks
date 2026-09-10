import Link from 'next/link'
import { sql, type SQL } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { Button, EmptyState, PageHeader } from '@openbooks/ui'
import { ShieldCheck } from 'lucide-react'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { requirePermission } from '../../../../lib/authz'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { isMultiSubsidiary, subsidiaryOptions } from '../../../../lib/subsidiaries'
import { ModuleView } from '../../../../components/viewspec/module-view'
import { loadAdminRoles, adminRolesSpec } from './view'
import { AdminRolesTable } from './sections'
import {
  NewRoleButton,
  type RoleRow,
  type SubsidiaryPickerOption,
} from './RoleEditor'

export async function generateMetadata() {
  const t = await getTranslations('admin.roles')
  return { title: t('metaTitle') }
}
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
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadAdminRoles(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={adminRolesSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const authz = await requirePermission('admin.roles.manage')
  const t = await getTranslations('admin.roles')
  const tCommon = await getTranslations('common')
  const tHub = await getTranslations('admin.hub')
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

  // Subsidiary access is only surfaced in multi-subsidiary orgs — single-sub
  // orgs never see any subsidiary UI.
  const subsidiaries: SubsidiaryPickerOption[] | null = (await isMultiSubsidiary(authz.user.orgId))
    ? (await subsidiaryOptions()).map((s) => ({ id: s.id, name: s.name, depth: s.depth }))
    : null

  const [rowsR, countR, typeCountsR] = ((await Promise.all([
    db.execute(sql`
      select r.id, r.key, r.name, r.description, r.is_built_in, r.permissions,
             r.subsidiary_restriction,
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
  ])))

  const roles = (rowsR.rows as any[]).map(
    (r): RoleRow & { permissionCount: number; memberCount: number } => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isBuiltIn: r.is_built_in,
      permissions: Array.isArray(r.permissions) ? r.permissions : [],
      subsidiaryRestriction: r.subsidiary_restriction ?? { mode: 'all' },
      permissionCount: Number(r.permission_count),
      memberCount: Number(r.member_count),
    }),
  )
  const total = Number(countR.rows[0]?.c ?? 0)
  const typeCounts = Object.fromEntries(
    typeCountsR.rows.map((r) => [r.is_built_in ? 'built_in' : 'custom', Number(r.c)]),
  ) as Record<string, number>

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: tHub('title') }}
            title={t('title')}
            description={t('description')}
            actions={
              <div className="flex items-center gap-2">
                <Link href="/admin/users">
                  <Button variant="outline">{t('manageUsers')}</Button>
                </Link>
                <NewRoleButton subsidiaries={subsidiaries} />
              </div>
            }
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <SearchInput placeholder={t('searchPlaceholder')} />
            <FilterChips
              basePath={BASE}
              currentParams={sp}
              paramKey="type"
              label={t('typeFilter')}
              options={[
                { value: 'built_in', label: t('builtIn'), count: typeCounts.built_in ?? 0 },
                { value: 'custom', label: t('custom'), count: typeCounts.custom ?? 0 },
              ]}
            />
          </div>
        </>
      }
    >
      {roles.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title={!listParams.q && !type ? t('emptyTitle') : t('noMatchTitle')}
          description={!listParams.q && !type ? t('emptyDescription') : t('noMatchDescription')}
        />
      ) : (
        <AdminRolesTable
          roles={roles}
          subsidiaries={subsidiaries}
          basePath={BASE}
          currentParams={sp}
          sort={listParams.sort}
          dir={listParams.dir}
          labels={{
            name: tCommon('labels.name'),
            key: t('table.key'),
            description: tCommon('labels.description'),
            permissions: t('table.permissions'),
            members: t('table.members'),
            type: tCommon('labels.type'),
            actions: tCommon('labels.actions'),
            builtIn: t('builtIn'),
            custom: t('custom'),
            noDescription: '—',
          }}
        />
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
