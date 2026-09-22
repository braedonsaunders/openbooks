import 'server-only'

import { getTranslations } from 'next-intl/server'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { HrmProcessError } from '@openbooks/engine/src/hrm/processes.ts'
import { getProcess, listProcesses, type ProcessDetail, type ProcessSegment } from '@openbooks/engine/src/hrm/processes-read.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmPeopleViewTabs } from './workspace-tabs'
import { can, type Authz } from '../authz'
import { loadAiDraftButton, loadAiDraftDrawer, type AiDraftDrawerData } from './ai-rails'

/**
 * Process checklists page loader — tabs, server-side segments, the active
 * segment's rows, and the URL-selected checklist, all resolved through the
 * canonical process read service (never a direct table read from the web
 * app, never a client collection fetch).
 *
 * Segments filter server-side: the loader lists each segment through
 * listProcesses and the pills navigate by href, so the selection is
 * shareable. A row opens the checklist drawer through the `process` search
 * param; a bookmarked id that no longer resolves (or leaves scope) renders
 * the drawer with the named load failure, never a broken list.
 */

const SEGMENTS: readonly ProcessSegment[] = ['open', 'overdue', 'completed', 'cancelled']

export interface ProcessSegmentView {
  key: string
  label: string
  href: string
  active: boolean
  count: number
}

export interface ProcessSegmentOption {
  value: string
  label: string
  count: number
}

export interface ProcessRow {
  id: string
  kind: string
  kindLabel: string
  effectiveDate: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  workerName: string
  progressLabel: string
  doneRequired: number
  required: number
  overdueSteps: number
  overdueBadge: string | null
  nextDueOn: string | null
  href: string
}

export interface ProcessesPageData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  viewTabs: Awaited<ReturnType<typeof hrmPeopleViewTabs>>
  listTitle: string
  segments: ProcessSegmentView[]
  segmentsLabel: string
  segmentOptions: ProcessSegmentOption[]
  currentParams: Record<string, string | string[] | undefined>
  columns: {
    employee: string
    kind: string
    status: string
    effective: string
    progress: string
    nextDue: string
  }
  rows: ProcessRow[]
  empty: string
  canManage: boolean
  newLabel: string
  newBusyLabel: string
  newChecklistLabel: string
  newTemplateLabel: string
  templatesLabel: string
  create: {
    closeHref: string
    effectiveDate: string
    templatesHref: string
  } | null
  detail: ProcessDetail | null
  missingDetail: string | null
  drawerOpen: boolean
  /** HR-21: the shared evidence-draft drawer (?draft=<kind>:<id>). */
  draftDrawer: AiDraftDrawerData | null
  draftDrawerOpen: boolean
  drawer: {
    closeHref: string
    title: string
    description: string | null
    detail: ProcessDetail | null
    missingDetail: string | null
    /** HR-21 "Draft from evidence" link (onboarding_plan kind). */
    draft: { href: string; label: string } | null
  } | null
}

function hrefFor(segment: ProcessSegment, processId: string | null): string {
  const params = new URLSearchParams({ segment })
  if (processId) params.set('process', processId)
  return `/hrm/processes?${params.toString()}`
}

export async function loadProcessesPage(authz: Authz, sp: Record<string, string | undefined>): Promise<ProcessesPageData> {
  // The caller (the /hrm/processes view) owns the page gate —
  // requirePermission plus the hrm switch with a 404. This loader never
  // re-checks either; it resolves data for the authorized session it is
  // given.
  const [t, tc] = await Promise.all([getTranslations('hrm'), getTranslations('common')])
  const segment: ProcessSegment =
    sp.segment === 'open' || sp.segment === 'overdue' || sp.segment === 'completed' || sp.segment === 'cancelled' ? sp.segment : 'open'
  const processId = typeof sp.process === 'string' && sp.process.length > 0 ? sp.process : null
  const canManage = can(authz, 'hrm.process.manage')
  const createOpen = sp.new === '1' && canManage

  const [openItems, overdueItems, completedItems, cancelledItems, effectiveDate] = await Promise.all([
    listProcesses({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      segment: 'open',
    }),
    listProcesses({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      segment: 'overdue',
    }),
    listProcesses({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      segment: 'completed',
    }),
    listProcesses({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      segment: 'cancelled',
    }),
    createOpen ? businessToday(authz.user.orgId) : Promise.resolve(''),
  ])
  const bySegment: Record<ProcessSegment, typeof openItems> = {
    open: openItems,
    overdue: overdueItems,
    completed: completedItems,
    cancelled: cancelledItems,
  }
  const kindLabel = (kind: string): string =>
    kind === 'onboarding'
      ? t('processes.kinds.onboarding')
      : kind === 'offboarding'
        ? t('processes.kinds.offboarding')
        : t('processes.kinds.transfer')

  const segmentLabel = (key: ProcessSegment): string =>
    key === 'open'
      ? t('processes.segments.open')
      : key === 'overdue'
        ? t('processes.segments.overdue')
        : key === 'completed'
          ? t('processes.segments.completed')
          : t('processes.segments.cancelled')
  const segments: ProcessSegmentView[] = SEGMENTS.map((key) => ({
    key,
    label: segmentLabel(key),
    href: hrefFor(key, null),
    active: segment === key,
    count: bySegment[key].length,
  }))

  const rows: ProcessRow[] = bySegment[segment].map((row) => ({
    id: row.id,
    kind: row.kind,
    kindLabel: kindLabel(row.kind),
    effectiveDate: row.effectiveDate,
    status: row.status,
    statusLabel:
      row.status === 'completed'
        ? t('processes.segments.completed')
        : row.status === 'cancelled'
          ? t('processes.segments.cancelled')
          : t('processes.segments.open'),
    statusVariant: row.status === 'completed' ? 'default' : row.status === 'cancelled' ? 'outline' : 'success',
    workerName: row.workerName,
    progressLabel: `${row.doneRequired}/${row.required}`,
    doneRequired: row.doneRequired,
    required: row.required,
    overdueSteps: row.overdueSteps,
    overdueBadge: row.overdueSteps > 0 ? t('processes.overdueBadge', { count: row.overdueSteps }) : null,
    nextDueOn: row.nextDueOn,
    href: hrefFor(segment, row.id),
  }))

  let detail: ProcessDetail | null = null
  let missingDetail: string | null = null
  if (processId !== null) {
    try {
      detail = await getProcess({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        processId,
      })
    } catch (error) {
      // A bookmarked id that no longer resolves (never a live list id), or
      // one that left the reader's subsidiary scope, renders the drawer
      // with the named load failure — the same message the client fetch
      // surfaced — never a broken list.
      if (error instanceof HrmProcessError && error.code === 'NOT_FOUND') {
        missingDetail = t('processes.detailFailed')
      } else if (error instanceof HrmAuthorizationError && /not visible in this organization/.test(error.message)) {
        missingDetail = t('processes.detailFailed')
      } else {
        throw error
      }
    }
  }

  const title = t('processes.title')
  const drawerOpen = detail !== null || missingDetail !== null
  // HR-21: "Draft from evidence" on the process drawer (onboarding_plan
  // from the process's template). The checklist has no editable plan
  // field, so Insert copies to the clipboard (the drawer's own fallback).
  const draftLabel = detail ? await loadAiDraftButton(authz.user.orgId) : null
  const processHref = processId !== null ? hrefFor(segment, processId) : null
  const draftDrawer = await loadAiDraftDrawer({
    draftParam: typeof sp.draft === 'string' ? sp.draft : null,
    closeHref: processHref ?? hrefFor(segment, null),
    fieldId: '',
  })
  return {
    title,
    description: t('processes.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/processes'),
    viewTabs: await hrmPeopleViewTabs(authz, '/hrm/processes'),
    listTitle: t('processes.listTitle'),
    segments,
    segmentsLabel: t('processes.segmentsLabel'),
    segmentOptions: SEGMENTS.map((key) => ({
      value: key,
      label: segmentLabel(key),
      count: bySegment[key].length,
    })),
    currentParams: { segment },
    columns: {
      employee: t('processes.columns.employee'),
      kind: t('processes.columns.kind'),
      status: t('processes.columns.status'),
      effective: t('processes.columns.effective'),
      progress: t('processes.columns.progress'),
      nextDue: t('processes.columns.nextDue'),
    },
    rows,
    empty: t('processes.empty'),
    canManage,
    newLabel: tc('actions.newRecord'),
    newBusyLabel: tc('actions.creating'),
    newChecklistLabel: t('processes.newChecklist'),
    newTemplateLabel: t('processes.templates.newTemplate'),
    templatesLabel: t('processes.templates.title'),
    create: createOpen
      ? {
          closeHref: hrefFor(segment, null),
          effectiveDate,
          templatesHref: '/hrm/processes/templates?template=new',
        }
      : null,
    detail,
    missingDetail,
    drawerOpen,
    draftDrawer,
    draftDrawerOpen: draftDrawer !== null,
    drawer: drawerOpen
      ? {
          closeHref: hrefFor(segment, null),
          title: detail ? `${detail.workerName} · ${kindLabel(detail.kind)}` : title,
          description: null,
          detail,
          missingDetail,
          draft:
            draftLabel && processId && processHref
              ? {
                  href: `${processHref}&draft=onboarding_plan:${processId}`,
                  label: draftLabel,
                }
              : null,
        }
      : null,
  }
}
