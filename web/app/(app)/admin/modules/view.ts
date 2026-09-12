import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { MODULE_VERSION_APPROVAL_SUBJECT } from '@openbooks/engine/src/modules/lifecycle.ts'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { buildListDrawerHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { dateTime } from '../../../../lib/format'

/**
 * Installed modules, split into a loader and a spec.
 *
 * An admin list page — search bar, status filter chips, a module-variant table
 * with an in-table spanning empty row, pagination, and the module flyout
 * (`?module=<key>`). The table decomposes into a `table` block exactly like
 * the sibling apps list: every cell is one element (the status badge owns its
 * own variant), so no composite cell component is needed. The Key column
 * reuses the apps list's `app-key-cell` — a shared presentational cell, not a
 * fork.
 *
 * The flyout is NOT a spec widget. Every drawer in the widget registry is a
 * bespoke client workspace with its own registration; this surface needs none
 * of that — the detail is read-only evidence (lifecycle state, pending
 * approvals, granted permissions, contents, audit trail) plus links into the
 * existing approval worklist, where decisions already happen through
 * decideGate. So `page.tsx` renders the shared server-side `UrlDrawer`
 * directly around loader-resolved data, and this spec owns only PageHeader +
 * list. No new widget, no parallel drawer system.
 *
 * The permission is `apps.manage` — the same authority that governs the app
 * builder list, because it is the same decision: what composed software runs
 * for everyone in the org. There is deliberately no feature gate here. The
 * `apps` feature flag governs the apps runtime; installed modules project
 * into live surfaces (page_specs resolution does not consult it), so gating
 * this admin door on that flag would hide the controls for projections that
 * are still rendering. No `modules.*` permission exists in the catalogue yet;
 * minting one is a permissions-model change, not an admin page.
 *
 * Approval decisions are never taken here. A pending proposal is decided in
 * the approvals worklist (authz, quorum, delegation, signature enforcement
 * all come from the engine); this page links to it and shows the wait.
 * Deactivation and reactivation ride `/api/admin/modules`, which calls the
 * lifecycle functions that already audit every transition.
 */

export interface AdminModuleRow {
  key: string
  name: string
  href: string
  versionLabel: string
  contributionCount: number
  statusLabel: string
  statusVariant: 'success' | 'outline' | 'warning'
  updated: string
}

export interface AdminModuleVersionInfo {
  version: string
  statusLabel: string
  created: string
}

export interface AdminModuleGateInfo {
  gateId: string
  version: string
  waitingSince: string
}

export interface AdminModuleContributionInfo {
  kind: string
  target: string
}

export interface AdminModuleAuditInfo {
  at: string
  actorLabel: string
  event: string
  reason: string
}

/** Everything the `?module=<key>` flyout renders. All copy resolved here. */
export interface AdminModuleDrawer {
  key: string
  name: string
  description: string
  statusLabel: string
  versionLabel: string
  versionStatusLabel: string
  noLiveVersion: boolean
  grantedPermissions: string[]
  contributions: AdminModuleContributionInfo[]
  versions: AdminModuleVersionInfo[]
  pendingGates: AdminModuleGateInfo[]
  approvalsHref: string
  audit: AdminModuleAuditInfo[]
}

export interface AdminModulesData {
  title: string
  description: string
  backHref: string
  backLabel: string
  searchPlaceholder: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  emptyLabel: string
  columnName: string
  columnKey: string
  columnVersion: string
  columnContents: string
  columnStatus: string
  columnUpdated: string
  rows: AdminModuleRow[]
  total: number
  currentPage: number
  perPage: number
  /** Present only while a drawer key is in the query and resolves to a module. */
  drawerOpen: boolean
  drawer: AdminModuleDrawer | null
}

function contributionTarget(c: unknown): string {
  if (typeof c !== 'object' || c === null) return ''
  const r = c as Record<string, unknown>
  for (const k of ['route', 'key', 'name'] as const) {
    const v = r[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

export async function loadAdminModules(
  sp: Record<string, string | string[] | undefined>,
): Promise<AdminModulesData> {
  const authz = await requirePermission('apps.manage')
  const tHub = await getTranslations('admin.hub')
  const t = await getTranslations('admin.modules')
  const orgId = authz.user.orgId
  const params = parseListParams(sp, {
    sort: 'name',
    allowedSorts: ['name'] as const,
    perPage: 50,
  })
  const status = pickString(sp.status)
  const moduleKey = pickString(sp.module)

  const where = sql`m.org_id = ${orgId}
    ${status ? sql` and m.status = ${status}` : sql``}
    ${params.q ? sql` and (m.name ilike ${'%' + params.q + '%'} or m.key ilike ${'%' + params.q + '%'})` : sql``}`

  const [modules, statuses, totalRow] = await Promise.all([
    db.execute(sql`
      select m.key, m.name, m.status, m.updated_at as "updatedAt",
             v.version, v.status as "versionStatus", v.manifest,
             (select count(*) from flow_gates g
               where g.org_id = m.org_id
                 and g.subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
                 and g.subject_id = m.id
                 and g.status = 'pending') as pending_count
        from modules m
        left join module_versions v on v.id = m.active_version_id and v.org_id = m.org_id
       where ${where}
       order by m.name
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `),
    db.execute(sql`select status, count(*) as n from modules where org_id = ${orgId} group by 1`),
    db.execute(sql`select count(*) as n from modules m where ${where}`),
  ])

  // Drawer payload for the selected module: identity, lifecycle, pending
  // approvals, grant, contents, and the audit evidence — newest first.
  let drawer: AdminModuleDrawer | null = null
  if (moduleKey) {
    const detail = (
      await db.execute(sql`
        select m.id, m.key, m.name, m.description, m.status,
               m.granted_permissions as "grantedPermissions",
               v.version, v.status as "versionStatus", v.manifest
          from modules m
          left join module_versions v on v.id = m.active_version_id and v.org_id = m.org_id
         where m.org_id = ${orgId} and m.key = ${moduleKey} limit 1
      `)
    ).rows[0] as
      | {
          id: string
          key: string
          name: string
          description: string | null
          status: string
          grantedPermissions: unknown
          version: string | null
          versionStatus: string | null
          manifest: unknown
        }
      | undefined
    if (detail) {
      const versions = (
        await db.execute(sql`
          select id, version, status, created_at as "createdAt"
            from module_versions
           where org_id = ${orgId} and module_id = ${detail.id}
           order by created_at desc`)
      ).rows as { id: string; version: string; status: string; createdAt: string }[]
      const gates = (
        await db.execute(sql`
          select g.id as "gateId", coalesce(r.context->>'version', '') as version,
                 g.created_at as "createdAt"
            from flow_gates g
            join flow_runs r on r.org_id = g.org_id and r.id = g.run_id
           where g.org_id = ${orgId}
             and g.subject_kind = ${MODULE_VERSION_APPROVAL_SUBJECT}
             and g.subject_id = ${detail.id}
             and g.status = 'pending'
           order by g.created_at`)
      ).rows as { gateId: string; version: string; createdAt: string }[]
      const versionIds = versions.map((v) => v.id)
      const auditRows = (
        await db.execute(sql`
          select a.action, a.changes, a.at,
                 coalesce(u.name, u.email, '') as "actorLabel"
            from audit_log a
            left join users u on u.id = a.actor_id
           where a.org_id = ${orgId}
             ${versionIds.length > 0
               ? sql`and ((a.table_name = 'modules' and a.row_id = ${detail.id})
                       or (a.table_name = 'module_versions' and a.row_id in (${sql.join(versionIds.map((id) => sql`${id}`), sql`, `)})))`
               : sql`and a.table_name = 'modules' and a.row_id = ${detail.id}`}
           order by a.at desc limit 25`)
      ).rows as { action: string; changes: unknown; at: string; actorLabel: string }[]

      const manifest =
        typeof detail.manifest === 'object' && detail.manifest !== null
          ? (detail.manifest as { contributions?: unknown })
          : null
      const rawContributions = Array.isArray(manifest?.contributions) ? manifest.contributions : []
      const granted = Array.isArray(detail.grantedPermissions)
        ? detail.grantedPermissions.filter((p): p is string => typeof p === 'string')
        : []
      drawer = {
        key: String(detail.key),
        name: String(detail.name),
        description: detail.description ?? t('drawer.noDescription'),
        statusLabel: t(`statuses.${detail.status}`),
        versionLabel: detail.version ? `v${detail.version}` : '—',
        versionStatusLabel: detail.versionStatus
          ? t(`drawer.versionStatus.${detail.versionStatus}`)
          : t('drawer.noLiveVersion'),
        noLiveVersion: detail.version === null,
        grantedPermissions: granted,
        contributions: rawContributions.map((c) => ({
          kind: typeof (c as { kind?: unknown })?.kind === 'string' ? String((c as { kind: unknown }).kind) : '?',
          target: contributionTarget(c),
        })),
        versions: versions.map((v) => ({
          version: `v${v.version}`,
          statusLabel: t(`drawer.versionStatus.${v.status}`),
          created: dateTime(v.createdAt),
        })),
        pendingGates: gates.map((g) => ({
          gateId: String(g.gateId),
          version: g.version ? `v${g.version}` : '—',
          waitingSince: dateTime(g.createdAt),
        })),
        approvalsHref: '/approvals',
        audit: auditRows.map((a) => {
          const changes =
            typeof a.changes === 'object' && a.changes !== null
              ? (a.changes as Record<string, unknown>)
              : null
          const event = typeof changes?.event === 'string' ? changes.event : String(a.action)
          const reason = typeof changes?.reason === 'string' ? changes.reason : ''
          return {
            at: dateTime(a.at),
            actorLabel: a.actorLabel || t('drawer.unknownActor'),
            event,
            reason,
          }
        }),
      }
    }
  }

  const total = Number((totalRow.rows[0] as { n: unknown } | undefined)?.n ?? 0)

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    searchPlaceholder: t('searchPlaceholder'),
    statusLabel: t('status'),
    statusOptions: (statuses.rows as { status: string; n: unknown }[]).map((r) => ({
      value: r.status,
      label: t(`statuses.${r.status}`),
      count: Number(r.n),
    })),
    currentParams: sp,
    emptyLabel: t('empty'),
    columnName: t('columns.name'),
    columnKey: t('columns.key'),
    columnVersion: t('columns.version'),
    columnContents: t('columns.contents'),
    columnStatus: t('columns.status'),
    columnUpdated: t('columns.updated'),
    rows: (modules.rows as {
      key: string
      name: string
      status: string
      updatedAt: string
      version: string | null
      manifest: unknown
      pending_count: unknown
    }[]).map((m) => {
      const pending = Number(m.pending_count ?? 0) > 0
      const manifest =
        typeof m.manifest === 'object' && m.manifest !== null
          ? (m.manifest as { contributions?: unknown })
          : null
      return {
        key: String(m.key),
        name: String(m.name),
        href: buildListDrawerHref('/admin/modules', sp, 'module', String(m.key)),
        versionLabel: m.version ? `v${m.version}` : '—',
        contributionCount: Array.isArray(manifest?.contributions) ? manifest.contributions.length : 0,
        statusLabel: pending ? t('statuses.awaitingApproval') : t(`statuses.${m.status}`),
        statusVariant: (pending ? 'warning' : m.status === 'installed' ? 'success' : 'outline') as
          | 'success'
          | 'outline'
          | 'warning',
        updated: dateTime(m.updatedAt),
      }
    }),
    total,
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(moduleKey && drawer),
    drawer,
  }
}

const f = ref<AdminModulesData>()
const item = field
const rootF = rootRef<AdminModulesData>()

const EMPTY_ROW_CLASS = 'py-10 text-center text-sm text-slate-500'
const LINK_CLASS = 'font-medium text-teal-700 hover:underline dark:text-teal-300'
const MUTED = 'text-xs text-slate-500'

export function adminModulesSpec(data: AdminModulesData): PageSpec {
  return page({
    route: '/admin/modules',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: '/admin/modules',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.statusLabel,
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('key'),
        emptyRow: { text: f('emptyLabel'), colSpan: 6, className: EMPTY_ROW_CLASS },
        columns: [
          column(rootF('columnName'), link(item('name'), item('href'), LINK_CLASS)),
          column(
            rootF('columnKey'),
            widgetCell('app-key-cell', { appKey: item('key') }),
          ),
          column(rootF('columnVersion'), text(item('versionLabel'))),
          column(rootF('columnContents'), text(item('contributionCount')), {
            className: 'tabular-nums',
          }),
          column(
            rootF('columnStatus'),
            badge(item('statusLabel'), { variant: item('statusVariant') }),
          ),
          column(rootF('columnUpdated'), text(item('updated')), {
            className: MUTED,
          }),
        ],
      }),
      pagination({
        basePath: '/admin/modules',
        total: f('total'),
        page: f('currentPage'),
        perPage: f('perPage'),
        // The native pager sits directly under the table — no `mt-3` spacer.
        bare: true,
      }),
    ],
  })
}
