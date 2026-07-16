import Link from 'next/link'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { Badge, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { ListPageLayout } from '../../../../components/page-layout'
import { SearchInput } from '../../../../components/search-input'
import { FilterChips } from '../../../../components/filter-bar'
import { Pagination } from '../../../../components/pagination'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'
import { listAppFiles, listListings } from '../../../../lib/apps/store'
import type { AppManifest } from '../../../../lib/apps/manifest'
import { AppsToolbar, AppDrawer, MarketplacePanel } from './AppDrawer'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function AppsAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('apps.manage')
  const orgId = authz.user.orgId
  const sp = await searchParams
  const params = parseListParams(sp, { sort: 'name', allowedSorts: ['name'] as const, perPage: 50 })
  const status = pickString(sp.status)
  const appKey = pickString(sp.app)

  const where = sql`a.org_id = ${orgId}
    ${status ? sql` and a.status = ${status}` : sql``}
    ${params.q ? sql` and (a.name ilike ${'%' + params.q + '%'} or a.key ilike ${'%' + params.q + '%'})` : sql``}`

  const [apps, statuses, totalRow, listings] = await Promise.all([
    db.execute(sql`
      select a.key, a.name, a.description, a.status, a.show_in_nav as "showInNav",
             a.granted_permissions as "grantedPermissions", a.updated_at as "updatedAt",
             v.version, v.manifest,
             (select count(*) from app_runs r where r.app_id = a.id) as run_count
        from apps a left join app_versions v on v.id = a.active_version_id
       where ${where}
       order by a.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `) as any,
    db.execute(sql`select status, count(*) as n from apps where org_id = ${orgId} group by 1`) as any,
    db.execute(sql`select count(*) as n from apps a where ${where}`) as any,
    listListings(),
  ])

  // Drawer payload for the selected app.
  let drawer: {
    app: Record<string, unknown>
    files: Awaited<ReturnType<typeof listAppFiles>>
    runs: Record<string, unknown>[]
    isPublished: boolean
  } | null = null
  if (appKey) {
    const detail = (await db.execute(sql`
      select a.id, a.key, a.name, a.description, a.icon_key as "iconKey", a.status,
             a.show_in_nav as "showInNav", a.granted_permissions as "grantedPermissions",
             v.version, v.manifest
        from apps a left join app_versions v on v.id = a.active_version_id
       where a.org_id = ${orgId} and a.key = ${appKey} limit 1
    `)) as any
    const app = detail.rows[0]
    if (app) {
      const [files, runs] = await Promise.all([
        listAppFiles(orgId, appKey).catch(() => []),
        db.execute(sql`
          select endpoint, status, units, logs, error_message, duration_ms, at
            from app_runs where app_id = ${app.id} order by at desc limit 25`) as any,
      ])
      drawer = {
        app,
        files,
        runs: runs.rows,
        isPublished: listings.some((l) => l.key === appKey),
      }
    }
  }

  const total = Number(totalRow.rows[0]?.n ?? 0)
  const endpointCount = (m: unknown) => ((m as AppManifest | null)?.endpoints?.length ?? 0)

  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            back={{ href: '/admin', label: 'Platform' }}
            title="Apps"
            description="Build and install app packages — a sandboxed frontend plus a governed backend, isolated per app."
            actions={<AppsToolbar />}
          />
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput placeholder="Search apps…" />
            <FilterChips
              basePath="/admin/apps"
              currentParams={sp}
              paramKey="status"
              label="Status"
              options={statuses.rows.map((r: any) => ({
                value: r.status,
                label: r.status,
                count: Number(r.n),
              }))}
            />
          </div>
        </>
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Endpoints</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                No apps yet. Create one to get a ready-to-open starter, or import a .zip package.
              </TableCell>
            </TableRow>
          ) : (
            apps.rows.map((a: any) => (
              <TableRow key={a.key}>
                <TableCell>
                  <Link
                    href={`/admin/apps?app=${encodeURIComponent(a.key)}`}
                    className="font-medium text-teal-700 hover:underline dark:text-teal-300"
                  >
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <code className="text-xs text-slate-500">{a.key}</code>
                </TableCell>
                <TableCell>{a.version ? `v${a.version}` : '—'}</TableCell>
                <TableCell className="tabular-nums">{endpointCount(a.manifest)}</TableCell>
                <TableCell className="tabular-nums">{Number(a.run_count)}</TableCell>
                <TableCell>
                  <Badge variant={a.status === 'installed' ? 'success' : 'outline'}>{a.status}</Badge>
                </TableCell>
                <TableCell className="text-xs text-slate-500">{dateTime(a.updatedAt)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <Pagination basePath="/admin/apps" currentParams={sp} page={params.page} perPage={params.perPage} total={total} />

      <MarketplacePanel
        listings={listings.map((l) => ({
          id: l.id,
          key: l.key,
          name: l.name,
          description: l.description,
          version: l.version,
          mine: l.publisherOrgId === orgId,
          installed: apps.rows.some((a: any) => a.key === l.key),
        }))}
      />

      {appKey && drawer ? (
        <AppDrawer
          app={drawer.app as any}
          files={drawer.files}
          runs={drawer.runs as any}
          isPublished={drawer.isPublished}
        />
      ) : null}
    </ListPageLayout>
  )
}
