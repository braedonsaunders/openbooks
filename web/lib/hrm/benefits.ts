import 'server-only'

import type { ModuleHomeTab } from '../../components/module-home/tab-types'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  listEnrollmentWindows,
  listEnrollments,
  type EnrollmentSummary,
  type EnrollmentWindowSummary,
} from '@openbooks/engine/src/hrm/benefits/benefits-read.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { benefitsCockpit } from '@openbooks/engine/src/hrm/benefits/benefits-read.ts'
import { can, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmRewardsViewTabs } from './workspace-tabs'
import { loadQueueLabels } from './change-requests'

/**
 * Benefits workspace loader — windows and enrolments behind the Benefits
 * tab. Rows come from the benefits read service (loader-resolved, newest
 * first, subsidiary scope inside), never a direct benefits-table read from
 * the web app. Worker names resolve through the shared loadQueueLabels
 * helper keyed strictly by ids the service already authorized. Segments
 * filter windows by status, plus an enrolments segment across windows.
 * Computed refusals travel as data: the page renders them beside the
 * segments, never an empty table pretending to be data.
 */

const LIST_LIMIT = 500

export interface BenefitsWindowRow extends EnrollmentWindowSummary {
  kindLabel: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  rangeLabel: string
  windowHref: string
  openLabel: string
}

export interface BenefitsEnrollmentRow extends EnrollmentSummary {
  employeeLabel: string
  employeeHref: string | null
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  openLabel: string
  windowHref: string | null
}

export interface BenefitsSegment {
  value: string
  label: string
  count: number
}

export interface BenefitsRefusal {
  title: string
  message: string
}

export interface WindowDrawerData {
  window: BenefitsWindowRow
  progressLabel: string
  progress: { value: string; label: string; count: number }[]
  enrolments: BenefitsEnrollmentRow[]
}

export interface BenefitsData {
  title: string
  description: string
  listTitle: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  refusal: BenefitsRefusal | null
  hasContent: boolean
  segmentsLabel: string
  /** Windows / Enrolments — the two views, on the shared subtab strip. */
  viewTabs: ModuleHomeTab[]
  allLabel: string
  segments: BenefitsSegment[]
  currentParams: Record<string, string | string[] | undefined>
  columns: { window: string; kind: string; range: string; elections: string; pending: string; status: string }
  enrollmentColumns: {
    employee: string
    plan: string
    coverage: string
    employeeAmount: string
    employerAmount: string
    status: string
  }
  windowRows: BenefitsWindowRow[]
  enrollmentRows: BenefitsEnrollmentRow[]
  showingEnrolments: boolean
  emptyTitle: string
  emptyDescription: string
  canManage: boolean
  newWindowButton: string
  newWindowHref: string
  dialogOpen: boolean
  dialogCloseHref: string
  subsidiaryOptions: { value: string; label: string }[]
  departmentOptions: { value: string; label: string }[]
  drawer: WindowDrawerData | null
  drawerCloseHref: string
  approveLabel: string
}

type BenefitsCatalog = {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

function benefitsHref(basePath: string, segment: string | undefined, extra: Record<string, string>): string {
  const params = new URLSearchParams()
  if (segment) params.set('segment', segment)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

function statusLabel(t: BenefitsCatalog, status: string): string {
  return t.has(`benefits.statusNames.${status}`) ? t(`benefits.statusNames.${status}`) : status
}

function statusVariant(status: string): BenefitsWindowRow['statusVariant'] {
  if (status === 'open' || status === 'active') return 'success'
  if (status === 'draft' || status === 'pending_approval' || status === 'elected') return 'warning'
  if (status === 'cancelled') return 'destructive'
  if (status === 'ended' || status === 'closed' || status === 'waived') return 'outline'
  return 'default'
}

function windowKindLabel(t: BenefitsCatalog, kind: string): string {
  return t.has(`benefits.windowKinds.${kind}`) ? t(`benefits.windowKinds.${kind}`) : kind
}

/**
 * Window STATUSES. `enrolments` used to sit in this list, so one control
 * mixed two axes: picking "Open" filtered the windows, picking "Enrolments"
 * swapped the table for a different entity. It is a view, and views are
 * tabs — see `viewTabs`.
 */
const SEGMENTS = ['all', 'open', 'draft', 'closed'] as const

export async function loadBenefits(authz: Authz, sp: Record<string, string | undefined>): Promise<BenefitsData> {
  const t = (await getTranslations('hrm')) as unknown as BenefitsCatalog
  const basePath = '/hrm/benefits'
  const orgId = authz.user.orgId
  const actorId = authz.user.id
  const canManage = can(authz, 'hrm.benefits.manage')
  const rawSegment = sp.segment ?? 'all'
  const segment = (SEGMENTS as readonly string[]).includes(rawSegment) ? rawSegment : null
  const showingEnrolments = sp.view === 'enrolments'
  const tabs = await hrmGroupTabs(authz, basePath)
  const keepView: Record<string, string> = showingEnrolments ? { view: 'enrolments' } : {}
  const currentParams: BenefitsData['currentParams'] = { ...keepView }
  if (sp.segment) currentParams.segment = sp.segment
  const viewTabs = await hrmRewardsViewTabs(
    authz,
    showingEnrolments ? '/hrm/benefits?view=enrolments' : '/hrm/benefits',
  )

  if (segment === null) {
    return {
      title: t('benefits.title'),
      description: t('benefits.description'),
      listTitle: '',
      tabs,
      refusal: { title: t('benefits.unknownSegmentTitle'), message: t('benefits.unknownSegment', { segment: rawSegment }) },
      hasContent: false,
      segmentsLabel: t('benefits.segmentsLabel'),
      allLabel: t('benefits.allLabel'),
      segments: [],
      viewTabs,
      currentParams,
      columns: { window: '', kind: '', range: '', elections: '', pending: '', status: '' },
      enrollmentColumns: { employee: '', plan: '', coverage: '', employeeAmount: '', employerAmount: '', status: '' },
      windowRows: [],
      enrollmentRows: [],
      showingEnrolments: false,
      emptyTitle: '',
      emptyDescription: '',
      canManage,
      newWindowButton: t('benefits.newWindow'),
      newWindowHref: benefitsHref(basePath, rawSegment, { ...keepView, window: 'new' }),
      dialogOpen: false,
      dialogCloseHref: basePath,
      subsidiaryOptions: [],
      departmentOptions: [],
      drawer: null,
      drawerCloseHref: basePath,
      approveLabel: t('benefits.approve'),
    }
  }

  const windows = await listEnrollmentWindows(db, orgId, actorId, {
    ...(segment === 'all' ? {} : { status: segment }),
  })
  const enrolments = await listEnrollments(db, orgId, actorId)
  const { workerByEmployment } = await loadQueueLabels(
    orgId,
    [...new Set(enrolments.map((e) => e.employmentId))],
    [],
  )

  const counts: Record<string, number> = { all: windows.length, open: 0, draft: 0, closed: 0 }
  for (const w of windows) {
    if (w.status === 'open' || w.status === 'draft' || w.status === 'closed') {
      counts[w.status] = (counts[w.status] ?? 0) + 1
    }
  }
  const segments: BenefitsSegment[] = (SEGMENTS as readonly string[]).map((value) => ({
    value,
    label: value === 'all' ? t('benefits.allLabel') : t(`benefits.segments.${value}`),
    count: counts[value] ?? 0,
  }))

  const windowRows: BenefitsWindowRow[] = windows.slice(0, LIST_LIMIT).map((w) => ({
    ...w,
    kindLabel: windowKindLabel(t, w.kind),
    statusLabel: statusLabel(t, w.status),
    statusVariant: statusVariant(w.status),
    rangeLabel: `${w.opensOn} – ${w.closesOn}`,
    windowHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, { window: w.id }),
    openLabel: t('benefits.openWindow'),
  }))

  const enrollmentRows: BenefitsEnrollmentRow[] = enrolments.slice(0, LIST_LIMIT).map((e) => {
    const worker = workerByEmployment.get(e.employmentId)
    const label = worker?.name ?? e.employeeName ?? e.employmentId
    return {
      ...e,
      employeeLabel: label,
      employeeHref: worker?.partyId ? `/entities/employees?party=${encodeURIComponent(worker.partyId)}` : null,
      statusLabel: statusLabel(t, e.status),
      statusVariant: statusVariant(e.status),
      openLabel: t('benefits.openEnrollment'),
      windowHref: null,
    }
  })

  const subsidiaries = (
    await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from subsidiaries where org_id = ${orgId}::uuid and is_active order by name
    `)
  ).rows
  const departments = (
    await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from departments where org_id = ${orgId}::uuid and is_active order by name
    `)
  ).rows
  const dialogOpen = sp.window === 'new' && canManage
  const subsidiaryOptions = subsidiaries.map((row) => ({ value: row.id, label: row.name }))
  const departmentOptions = departments.map((row) => ({ value: row.id, label: row.name }))
  let drawer: WindowDrawerData | null = null
  if (sp.window && sp.window !== 'new') {
    const found = windowRows.find((w) => w.id === sp.window) ?? null
    if (found) {
      const mine = enrolments.filter((e) => e.windowId === found.id)
      const byStatus = new Map<string, number>()
      for (const e of mine) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1)
      drawer = {
        window: found,
        progressLabel: t('benefits.drawerProgress'),
        progress: [...byStatus.entries()].map(([value, count]) => ({
          value,
          label: statusLabel(t, value),
          count,
        })),
        enrolments: enrollmentRows.filter((r) => mine.some((m) => m.id === r.id)),
      }
    }
  }

  return {
    title: t('benefits.title'),
    description: t('benefits.description'),
    listTitle: showingEnrolments ? t('benefits.enrolmentsTitle') : t('benefits.windowsTitle'),
    tabs,
    refusal: null,
    hasContent: true,
    segmentsLabel: t('benefits.segmentsLabel'),
    allLabel: t('benefits.allLabel'),
    segments,
    viewTabs,
    currentParams,
    columns: {
      window: t('benefits.columns.window'),
      kind: t('benefits.columns.kind'),
      range: t('benefits.columns.range'),
      elections: t('benefits.columns.elections'),
      pending: t('benefits.columns.pending'),
      status: t('benefits.columns.status'),
    },
    enrollmentColumns: {
      employee: t('benefits.columns.employee'),
      plan: t('benefits.columns.plan'),
      coverage: t('benefits.columns.coverage'),
      employeeAmount: t('benefits.columns.employeeAmount'),
      employerAmount: t('benefits.columns.employerAmount'),
      status: t('benefits.columns.status'),
    },
    windowRows,
    enrollmentRows,
    showingEnrolments,
    emptyTitle: showingEnrolments ? t('benefits.enrolmentsEmptyTitle') : t('benefits.windowsEmptyTitle'),
    emptyDescription: showingEnrolments ? t('benefits.enrolmentsEmpty') : t('benefits.windowsEmpty'),
    canManage,
    newWindowButton: t('benefits.newWindow'),
    newWindowHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, { window: 'new' }),
    dialogOpen,
    dialogCloseHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, {}),
    subsidiaryOptions,
    departmentOptions,
    drawer,
    drawerCloseHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, {}),
    approveLabel: t('benefits.approve'),
  }
}

export interface BenefitsPanelData {
  title: string
  openLabel: string
  openWindows: { id: string; name: string }[]
  openEmpty: string
  pendingCount: number
  pendingLabel: string
  missingCount: number
  missingLabel: string
  queueHref: string
}

/** Cockpit Benefits panel: open windows, pending approvals, months missing inputs. Null without the grant. */
export async function loadBenefitsPanel(authz: Authz): Promise<BenefitsPanelData | null> {
  if (!can(authz, 'hrm.benefits.read')) return null
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as BenefitsCatalog
  const month = (await businessToday(orgId)).slice(0, 7)
  const cockpit = await benefitsCockpit(db, orgId, authz.user.id, month)
  return {
    title: t('overview.benefits.title'),
    openLabel: t('overview.benefits.openWindows'),
    openWindows: cockpit.openWindows.map((w) => ({ id: w.id, name: w.name })),
    openEmpty: t('overview.benefits.noOpenWindow'),
    pendingCount: cockpit.pendingApprovals.length,
    pendingLabel: t('overview.benefits.pendingSub'),
    missingCount: cockpit.missingInputs.length,
    missingLabel: t('overview.benefits.missingSub'),
    queueHref: '/hrm/benefits?segment=enrolments',
  }
}
