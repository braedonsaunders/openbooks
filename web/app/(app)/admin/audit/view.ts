import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { grid, page, pageHeader, pagination, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { isUuid, mergeHref, parseListParams, pickString } from '../../../../lib/list-params'
import { requirePermission } from '../../../../lib/authz'
import { accessDeniedHref } from '../../../../lib/gate-targets'
import type { AuditListRow } from './AuditRows'
import type { AuditEvent } from './AuditEventDrawer'
import { readAuditEvent, readAuditPage } from '../../../../lib/audit-reader'

/** The company audit log requires both audit permission and unrestricted
 * subsidiary access because deleted records have no current scope row. */

// Raw record-type tokens (table names or document kinds like "customer_invoice")
// → friendly labels: "Customer Invoice", "Journal Entry", "Budget Scenarios".
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Known audit actions with translated labels (admin.audit.actions.*); anything
// else in the log renders verbatim as the stored action code.
const KNOWN_ACTIONS = new Set(['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'])

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
  if (authz.allowedSubsidiaryIds !== null) {
    redirect(accessDeniedHref({ permission: 'unrestricted subsidiary access' }))
  }
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

  const [result, selectedEvent] = await Promise.all([
    readAuditPage(authz.user.orgId, { ...params, action, rtype, actor, from, to }),
    eventId && isUuid(eventId) ? readAuditEvent(authz.user.orgId, eventId) : Promise.resolve(null),
  ])
  const total = result.total
  const actionLabel = (a: string) => (KNOWN_ACTIONS.has(a) ? t(`actions.${a}`) : a)
  const drawer = selectedEvent ? {
    event: selectedEvent,
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
    recordTypeOptions: result.recordTypes.map((r) => ({ value: r.rtype!, label: humanize(r.rtype!), count: Number(r.n) })),
    userLabel: t('userFilter'),
    userOptions: result.actors.map((r) => ({
      value: r.actor_id ?? 'system',
      label: r.actor_name ?? t('systemActor'),
      count: Number(r.n),
    })),
    actionLabel: t('actionFilter'),
    actionOptions: result.actions.map((r) => ({ value: r.action!, label: actionLabel(r.action!), count: Number(r.n) })),
    dateFromLabel: t('dateFrom'),
    dateToLabel: t('dateTo'),
    clearDatesLabel: t('clearDates'),
    currentParams: sp,
    isEmpty: total === 0,
    hasRows: total > 0,
    emptyTitle: t('empty.title'),
    emptyDescription: t('empty.description'),
    rows: result.rows,
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
      // Keep the URL-driven event host mounted even before an event is selected.
      {
        ...widgetBlock('audit-event-drawer', {
          drawer: data.drawer,
        }),
      },
    ],
  })
}
