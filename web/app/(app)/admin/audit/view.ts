import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/business-date.ts'
import { grid, page, pageHeader, pagination, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import type { AuditListRow } from './AuditRows'
import type { AuditEvent } from './AuditEventDrawer'

/**
 * The company audit log, split into a loader and a spec.
 *
 * Two gates precede everything, and both are load-bearing. `admin.audit.read`
 * is the permission gate; the unrestricted-subsidiary check (`redirect('/')`)
 * is the scope gate — the log spans deleted records whose scope cannot be
 * inferred from a current row, so a subsidiary-restricted reader is bounced
 * to the home page rather than shown a filtered log. The loader reproduces
 * both verbatim, including the redirect.
 *
 * The rows table is a widget, not a `table` block: like the org-users table,
 * the native page hand-rolls its own table through a client component
 * (`AuditRows` owns row-click navigation via the router) and the spec's table
 * block offers only the two real table variants the app has. The event drawer
 * (`AuditEventDrawer`) is likewise interactive client chrome (tabs, local
 * state) placed whole through a slot. Everything around them — the header,
 * the search/filter/date row, the empty state, the pager — is ordinary spec.
 */

// Raw record-type tokens (table names or document kinds like "customer_invoice")
// → friendly labels: "Customer Invoice", "Journal Entry", "Budget Scenarios".
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Known audit actions with translated labels (admin.audit.actions.*); anything
// else in the log renders verbatim as the stored action code.
const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])

interface AuditRowMetadata extends Record<string, unknown> {
  id: string
  row_id: string
  action: string
  at: string
  actor_name: string | null
  rtype: string
}

interface AuditListSource extends AuditRowMetadata {
  summary_kind: AuditListRow['summaryKind']
  change_count: string
}

interface AuditEventSource extends AuditRowMetadata {
  request_id: string | null
  changes: unknown
}

const BASE = '/admin/audit'

export interface AuditData {
  title: string
  description: string
  backHref: string
  backLabel: string
  docsHref: string
  docsLabel: string
  searchPlaceholder: string
  recordTypeLabel: string
  recordTypeOptions: { value: string; label: string; count: number }[]
  userLabel: string
  userOptions: { value: string; label: string; count: number }[]
  actionLabel: string
  actionOptions: { value: string; label: string; count: number }[]
  dateFromLabel: string
  dateToLabel: string
  clearDatesLabel: string
  currentParams: Record<string, string | string[] | undefined>
  isEmpty: boolean
  hasRows: boolean
  emptyTitle: string
  emptyDescription: string
  rows: AuditListRow[]
  selectedId: string | undefined
  total: number
  currentPage: number
  perPage: number
  drawerOpen: boolean
  drawer: { event: AuditEvent; closeHref: string } | null
}

export async function loadAudit(
  sp: Record<string, string | string[] | undefined>,
): Promise<AuditData> {
  const authz = await requirePermission('admin.audit.read')
  // The company log spans configuration, multi-entity transactions and
  // deleted records whose scope cannot be inferred from a current row. Like
  // the raw query console, this whole-company surface requires an explicit
  // unrestricted grant. Record-specific audit routes retain their own scope.
  if (authz.allowedSubsidiaryIds !== null) redirect('/')
  const t = await getTranslations('admin.audit')
  const tHub = await getTranslations('admin.hub')
  const params = parseListParams(sp, { sort: 'at', allowedSorts: ['at'] as const, perPage: 50 })
  const action = pickString(sp.action)
  const rtype = pickString(sp.rtype)
  const actor = pickString(sp.actor)
  const from = pickString(sp.from)
  const to = pickString(sp.to)
  const eventId = pickString(sp.event)
  if ((actor && actor !== 'system' && !isUuid(actor))
    || (from && !isIsoCalendarDate(from)) || (to && !isIsoCalendarDate(to))) notFound()

  // Effective record type: the raw table for most rows, but the document's KIND
  // (customer_invoice, vendor_bill, journal_entry, …) for the shared `documents`
  // table so the filter splits it into its transaction types. Deleted documents
  // recover their kind from the immutable before snapshot.
  const rtypeExpr = sql`case when a.table_name = 'documents'
    then coalesce(d.kind, a.changes #>> '{before,document,kind}', 'documents')
    else a.table_name end`
  const auditFrom = sql`
    from audit_log a
    left join users u on u.id = a.actor_id and u.org_id = a.org_id
    left join documents d on a.table_name = 'documents' and d.id = a.row_id and d.org_id = a.org_id`

  const where = sql`a.org_id = ${authz.user.orgId}
    ${action ? sql` and a.action = ${action}` : sql``}
    ${rtype ? sql` and (${rtypeExpr}) = ${rtype}` : sql``}
    ${actor ? (actor === 'system' ? sql` and a.actor_id is null` : sql` and a.actor_id = ${actor}`) : sql``}
    ${from ? sql` and a.at >= ${from}::date` : sql``}
    ${to ? sql` and a.at < (${to}::date + interval '1 day')` : sql``}
    ${params.q ? sql` and ((${rtypeExpr}) ilike ${'%' + params.q + '%'} or u.name ilike ${'%' + params.q + '%'} or a.row_id::text = ${params.q})` : sql``}`

  const [rows, totalRow, actions, rtypes, users, selectedResult] = await Promise.all([
    (db.execute<AuditListSource>(sql`
      select a.id, a.row_id, a.action, a.at, u.name as actor_name, (${rtypeExpr}) as rtype,
             case
               when a.changes ? 'before' or a.changes ? 'after' then 'snapshot'
               when a.changes ->> 'source' = 'record_metadata' then 'metadata'
               else 'fields'
             end as summary_kind,
             (select count(*)
                from jsonb_object_keys(
                  case when jsonb_typeof(a.changes) = 'object' then a.changes else '{}'::jsonb end
                ) as changed_key(key)
               where changed_key.key not in ('source', 'mode', 'reason', 'before', 'after')) as change_count
        ${auditFrom}
       where ${where}
       order by a.at desc
       limit ${params.perPage} offset ${(params.page - 1) * params.perPage}
    `)),
    db.execute<{ n: string }>(sql`select count(*) as n ${auditFrom} where ${where}`),
    (db.execute<{ action: string; n: string }>(sql`
      select action, count(*) as n
        from audit_log
       where org_id = ${authz.user.orgId}
       group by 1 order by 2 desc
    `)),
    (db.execute<{ rtype: string; n: string }>(sql`
      select (${rtypeExpr}) as rtype, count(*) as n
        ${auditFrom}
       where a.org_id = ${authz.user.orgId}
       group by 1 order by 2 desc limit 60
    `)),
    (db.execute<{ actor_id: string | null; name: string | null; n: string }>(sql`
      select a.actor_id, u.name, count(*) as n
        from audit_log a left join users u on u.id = a.actor_id and u.org_id = a.org_id
       where a.org_id = ${authz.user.orgId}
       group by 1, 2 order by 3 desc limit 50
    `)),
    eventId && isUuid(eventId)
      ? (db.execute<AuditEventSource>(sql`
          select a.id, a.row_id, a.action, a.at, a.request_id, a.changes,
                 u.name as actor_name, (${rtypeExpr}) as rtype
            ${auditFrom}
           where a.id = ${eventId} and a.org_id = ${authz.user.orgId}
           limit 1
        `))
      : Promise.resolve({ rows: [] }),
  ])
  const total = Number(totalRow.rows[0]!.n)
  const actionLabel = (a: string) => (KNOWN_ACTIONS.has(a) ? t(`actions.${a}`) : a)
  const auditRows: AuditListRow[] = rows.rows.map((row) => ({
    id: row.id,
    rowId: row.row_id,
    at: new Date(row.at).toISOString(),
    actorName: row.actor_name,
    action: row.action,
    recordType: row.rtype,
    summaryKind: row.summary_kind,
    changeCount: Number(row.change_count),
  }))
  const selectedRow = selectedResult.rows[0]
  const drawer = selectedRow ? {
    event: {
      id: selectedRow.id,
      rowId: selectedRow.row_id,
      at: new Date(selectedRow.at).toISOString(),
      actorName: selectedRow.actor_name,
      action: selectedRow.action,
      recordType: selectedRow.rtype,
      requestId: selectedRow.request_id,
      changes: selectedRow.changes,
    },
    closeHref: mergeHref(BASE, sp, { event: null }),
  } : null

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin',
    backLabel: tHub('title'),
    docsHref: '/docs/audit-log',
    docsLabel: t('documentation'),
    searchPlaceholder: t('searchPlaceholder'),
    recordTypeLabel: t('recordTypeFilter'),
    recordTypeOptions: rtypes.rows.map((r) => ({ value: r.rtype, label: humanize(r.rtype), count: Number(r.n) })),
    userLabel: t('userFilter'),
    userOptions: users.rows.map((r) => ({
      value: r.actor_id ?? 'system',
      label: r.name ?? t('systemActor'),
      count: Number(r.n),
    })),
    actionLabel: t('actionFilter'),
    actionOptions: actions.rows.map((r) => ({ value: r.action, label: actionLabel(r.action), count: Number(r.n) })),
    dateFromLabel: t('dateFrom'),
    dateToLabel: t('dateTo'),
    clearDatesLabel: t('clearDates'),
    currentParams: sp,
    isEmpty: total === 0,
    hasRows: total > 0,
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
    rows: auditRows,
    selectedId: drawer?.event.id,
    total,
    currentPage: params.page,
    perPage: params.perPage,
    drawerOpen: Boolean(drawer),
    drawer,
  }
}

const f = ref<AuditData>()

export function auditSpec(data: AuditData): PageSpec {
  const docsButton = {
    widget: 'audit-docs-link',
    props: { href: data.docsHref, label: data.docsLabel },
  }
  return page({
    route: '/admin/audit',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [widget(docsButton.widget, docsButton.props)],
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', { placeholder: data.searchPlaceholder }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'rtype',
          label: data.recordTypeLabel,
          options: data.recordTypeOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'actor',
          label: data.userLabel,
          options: data.userOptions,
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'action',
          label: data.actionLabel,
          options: data.actionOptions,
        }),
        widgetBlock('date-range-filter', {
          fromLabel: data.dateFromLabel,
          toLabel: data.dateToLabel,
          clearLabel: data.clearDatesLabel,
        }),
      ]),
    ],
    body: [
      {
        // The native empty state carries the ScrollText glyph; the registry's
        // closed icon map has no `scroll-text` key yet.
        ...widgetBlock('empty-state', {
          icon: 'scroll-text',
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('isEmpty'),
      },
      {
        // The rows table is a hand-rolled client table with row-click
        // navigation, not either spec table variant — see ./sections.
        ...widgetBlock('audit-rows-table', {
          rows: data.rows,
          selectedId: data.selectedId ?? null,
        }),
        when: f('hasRows'),
      },
      {
        ...pagination({
          basePath: BASE,
          total: f('total'),
          page: f('currentPage'),
          perPage: f('perPage'),
        }),
        when: f('hasRows'),
      },
      // The event drawer is interactive client chrome (tabs, local state)
      // placed whole — see ./sections. `closeHref` drops `?event=` while
      // keeping every filter, exactly as the native page does.
      {
        ...widgetBlock('audit-event-drawer', {
          drawer: data.drawer,
        }),
        when: f('drawerOpen'),
      },
    ],
  })
}
