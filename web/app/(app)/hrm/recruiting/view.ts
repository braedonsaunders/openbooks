import 'server-only'

import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  badge,
  column,
  field,
  grid,
  link,
  page,
  pageHeader,
  spanRow,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  getCandidateDetail,
  getOfferDetail,
  getRequisitionDetail,
  listRequisitions,
} from '@openbooks/engine/src/hrm/recruiting/recruiting-read.ts'
import { hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { rootSubsidiaryId, subsidiaryUiOptions } from '../../../../lib/subsidiaries'
import type { RecruitingCreateProps } from './RecruitingCreateForm'
import type { CandidateDrawerData, OfferDrawerData, RequisitionDrawerData } from './sections'

/**
 * Recruiting tab: requisitions as a shared `table` block with `filter-chips`
 * status segments, the header link-button opening the create form in the
 * URL drawer, and row links opening the requisition drawer (pipeline stage
 * chips, the applications table, and action islands) through the URL, so
 * every selection is shareable and closes by navigation. Candidate and
 * offer drawers ride their own params. Renders only when the hrm feature
 * gate is on and the actor holds hrm.recruiting.read — the view 404s
 * otherwise, the same gate the route-gate scanner reads on the cockpit.
 */

const STATUSES = ['draft', 'open', 'on_hold', 'filled', 'cancelled'] as const

export interface RecruitingRow {
  id: string
  number: string
  title: string
  position: string | null
  department: string | null
  headcount: string
  hiringManager: string | null
  opened: string | null
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  href: string
}

export interface RecruitingPageData {
  title: string
  description: string
  tabs: { href: string; label: string; active?: boolean }[]
  /** hrm.recruiting.manage: the header's New requisition button and the create form. */
  canManage: boolean
  addLabel: string
  /** The create form through the URL (`?requisition=new`). */
  addHref: string
  basePath: string
  segmentsLabel: string
  allLabel: string
  segmentOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  columns: {
    number: string
    title: string
    position: string
    department: string
    headcount: string
    hiringManager: string
    opened: string
    status: string
  }
  rows: RecruitingRow[]
  empty: string
  totalLabel: string
  totals: { headcount: string; filled: string }
  drawerOpen: boolean
  drawer: {
    closeHref: string
    title: string
    description: string | null
    requisition: RequisitionDrawerData | null
    candidate: CandidateDrawerData | null
    offer: OfferDrawerData | null
    missingDetail: string | null
    create?: RecruitingCreateProps | null
  } | null
}

const f = field
const item = field

function statusVariant(status: string): RecruitingRow['statusVariant'] {
  switch (status) {
    case 'open':
      return 'success'
    case 'on_hold':
      return 'warning'
    case 'cancelled':
      return 'destructive'
    case 'filled':
      return 'default'
    default:
      return 'secondary'
  }
}

export function recruitingSpec(data: RecruitingPageData): PageSpec {
  return page({
    route: '/hrm/recruiting',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          // The primary action first, the strip last — the house order on
          // every list page, so the switcher never moves between siblings.
          widget('link-button', { href: f('addHref'), label: f('addLabel'), iconKey: 'plus' }, f('canManage')),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        widgetBlock('filter-chips', {
          basePath: '/hrm/recruiting',
          currentParams: data.currentParams,
          paramKey: 'status',
          label: data.segmentsLabel,
          allLabel: data.allLabel,
          options: data.segmentOptions,
        }),
        table({
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          empty: { title: f('empty') },
          trailing:
            data.rows.length > 0
              ? [
                  spanRow({
                    label: f('totalLabel'),
                    labelColSpan: 5,
                    cells: [
                      { cell: text(f('totals.headcount')), align: 'right', className: 'font-semibold tabular-nums' },
                      { cell: text(f('totals.filled')), align: 'right', className: 'font-semibold tabular-nums' },
                    ],
                  }),
                ]
              : undefined,
          columns: [
            column(data.columns.number, link(item('number'), item('href'))),
            column(data.columns.title, text(item('title'))),
            column(data.columns.position, text(item('position'), { fallback: '—' })),
            column(data.columns.department, text(item('department'), { fallback: '—' })),
            column(data.columns.headcount, text(item('headcount')), { align: 'right', className: 'tabular-nums' }),
            column(data.columns.hiringManager, text(item('hiringManager'), { fallback: '—' })),
            column(data.columns.opened, text(item('opened'), { fallback: '—' })),
            column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
          ],
        }),
      ]),
      // URL-backed drawers, portaled to <body> wherever they render.
      {
        ...widgetBlock('hrm-recruiting-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
    ],
  })
}

function hrefFor(status: string | null, selection: { requisition?: string; candidate?: string; offer?: string } | null): string {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (selection?.requisition) params.set('requisition', selection.requisition)
  if (selection?.candidate) params.set('candidate', selection.candidate)
  if (selection?.offer) params.set('offer', selection.offer)
  const query = params.toString()
  return query ? `/hrm/recruiting?${query}` : '/hrm/recruiting'
}

export async function recruitingTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('recruiting.title')
}

export async function loadRecruitingPage(
  sp: Record<string, string | undefined>,
): Promise<RecruitingPageData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.recruiting.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz, '/hrm/recruiting')

  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
    ? sp.status
    : null
  const canManage = can(authz, 'hrm.recruiting.manage')
  const creating = sp.requisition === 'new' && canManage
  const requisitionId =
    typeof sp.requisition === 'string' && sp.requisition.length > 0 && sp.requisition !== 'new'
      ? sp.requisition
      : null
  const candidateId = typeof sp.candidate === 'string' && sp.candidate.length > 0 ? sp.candidate : null
  const offerId = typeof sp.offer === 'string' && sp.offer.length > 0 ? sp.offer : null

  const requisitions = await listRequisitions({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    ...(status ? { status } : {}),
  })
  const counts = new Map<string, number>()
  for (const row of requisitions) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  const statusLabel = (value: string): string => t(`recruiting.status.${value}`)

  const rows: RecruitingRow[] = requisitions.map((row) => ({
    id: row.id,
    number: row.requisitionNumber,
    title: row.title,
    position: row.positionCode,
    department: row.departmentName,
    headcount: `${row.filledCount}/${row.headcount}`,
    hiringManager: row.hiringManagerName,
    opened: row.openedOn,
    status: row.status,
    statusLabel: statusLabel(row.status),
    statusVariant: statusVariant(row.status),
    href: hrefFor(status, { requisition: row.id }),
  }))

  // The drawers resolve through the canonical read service (PII redaction
  // included); an id that no longer resolves renders the named absence.
  let requisition: RequisitionDrawerData | null = null
  let candidate: CandidateDrawerData | null = null
  let offer: OfferDrawerData | null = null
  let missingDetail: string | null = null
  if (requisitionId) {
    try {
      const detail = await getRequisitionDetail({ orgId: authz.user.orgId, actorId: authz.user.id, requisitionId })
      // Panel candidates: employees (parties holding an employment) inside
      // the viewer's subsidiary scope — ids, never labels; out-of-scope
      // holders stay absent rather than leaking existence.
      const employeeRows = (await db.execute<{ id: string; name: string }>(sql`
        select p.id::text as id, p.display_name as name
          from worker_employments e
          join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
         where e.org_id = ${authz.user.orgId}::uuid
           ${authz.allowedSubsidiaryIds ? sql`and e.employer_subsidiary_id in (${sql.join([...authz.allowedSubsidiaryIds].map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
         order by p.display_name limit 200`)).rows
      requisition = {
        ...detail,
        closeHref: hrefFor(status, null),
        stageLabels: Object.fromEntries(detail.stages.map((stage) => [stage.id, stage.name])),
        statusLabels: Object.fromEntries(STATUSES.map((value) => [value, statusLabel(value)])),
        labels: {
          pipeline: t('recruiting.drawer.pipeline'),
          applications: t('recruiting.drawer.applications'),
          noApplications: t('recruiting.drawer.noApplications'),
          candidate: t('recruiting.drawer.candidate'),
          stage: t('recruiting.drawer.stage'),
          applied: t('recruiting.drawer.applied'),
          lastEvent: t('recruiting.drawer.lastEvent'),
          interviews: t('recruiting.drawer.interviews'),
          offer: t('recruiting.drawer.offer'),
          timeToFill: t('recruiting.drawer.timeToFill'),
          days: t('recruiting.drawer.days'),
          attachTitle: t('recruiting.attach.title'),
          attachName: t('recruiting.attach.name'),
          attachEmail: t('recruiting.attach.email'),
          attachPhone: t('recruiting.attach.phone'),
          attachSubmit: t('recruiting.attach.submit'),
          attachFailed: t('recruiting.attach.failed'),
          moveTitle: t('recruiting.move.title'),
          moveSubmit: t('recruiting.move.submit'),
          moveFailed: t('recruiting.move.failed'),
          rejectTitle: t('recruiting.attach.rejectTitle'),
          rejectReason: t('recruiting.attach.rejectReason'),
          rejectSubmit: t('recruiting.move.reject'),
          rejectFailed: t('recruiting.move.failed'),
          withdrawLabel: t('recruiting.move.withdraw'),
          withdrawFailed: t('recruiting.move.failed'),
          interviewTitle: t('recruiting.interview.title'),
          interviewKind: t('recruiting.interview.kind'),
          interviewWhen: t('recruiting.interview.when'),
          interviewDuration: t('recruiting.interview.duration'),
          interviewLocation: t('recruiting.interview.location'),
          interviewPanel: t('recruiting.interview.panel'),
          interviewSubmit: t('recruiting.interview.submit'),
          interviewFailed: t('recruiting.interview.failed'),
          completeTitle: t('recruiting.interview.completeTitle'),
          completeOutcome: t('recruiting.interview.outcome'),
          completeFeedback: t('recruiting.interview.feedback'),
          completeSubmit: t('recruiting.interview.completeSubmit'),
          completeFailed: t('recruiting.interview.failed'),
          cancelLabel: t('recruiting.interview.cancel'),
          offerTitle: t('recruiting.offerCard.title'),
          offerJob: t('recruiting.offerCard.job'),
          offerStart: t('recruiting.offerCard.start'),
          offerAmount: t('recruiting.offerCard.amount'),
          offerCurrency: t('recruiting.offerCard.currency'),
          offerBasis: t('recruiting.offerCard.basis'),
          offerExpires: t('recruiting.offerCard.expires'),
          offerSubmit: t('recruiting.offerCard.submit'),
          offerFailed: t('recruiting.offerCard.failed'),
          offerSend: t('recruiting.offerActions.send'),
          offerAccept: t('recruiting.offerActions.accept'),
          offerDecline: t('recruiting.offerActions.decline'),
          offerWithdraw: t('recruiting.offerActions.withdraw'),
          offerReason: t('recruiting.offerActions.reason'),
          offerActionFailed: t('recruiting.offerActions.failed'),
          candidateOptions: [],
          employeeOptions: employeeRows.map((option) => ({ value: option.id, label: option.name })),
          kindOptions: ['phone', 'video', 'onsite', 'panel', 'assessment'].map((value) => ({
            value,
            label: t(`recruiting.interviewKind.${value}`),
          })),
          outcomeOptions: ['advance', 'hold', 'reject'].map((value) => ({
            value,
            label: t(`recruiting.interviewOutcome.${value}`),
          })),
          basisOptions: ['hourly', 'annual'].map((value) => ({ value, label: t(`recruiting.basis.${value}`) })),
        },
      }
    } catch {
      missingDetail = t('recruiting.drawer.missing')
    }
  } else if (candidateId) {
    try {
      const detail = await getCandidateDetail({ orgId: authz.user.orgId, actorId: authz.user.id, candidateId })
      candidate = {
        ...detail,
        closeHref: hrefFor(status, null),
        labels: {
          applications: t('recruiting.drawer.applications'),
          interviews: t('recruiting.drawer.interviews'),
          email: t('recruiting.candidate.email'),
          phone: t('recruiting.candidate.phone'),
          source: t('recruiting.candidate.source'),
        },
        outcomeOptions: ['advance', 'hold', 'reject'].map((value) => ({
          value,
          label: t(`recruiting.interviewOutcome.${value}`),
        })),
        actionLabels: {
          outcome: t('recruiting.interview.outcome'),
          feedback: t('recruiting.interview.feedback'),
          submit: t('recruiting.interview.completeSubmit'),
          cancel: t('recruiting.interview.cancel'),
          failed: t('recruiting.interview.failed'),
        },
      }
    } catch {
      missingDetail = t('recruiting.drawer.missing')
    }
  } else if (offerId) {
    try {
      const detail = await getOfferDetail({ orgId: authz.user.orgId, actorId: authz.user.id, offerId })
      offer = {
        ...detail,
        closeHref: hrefFor(status, null),
        labels: {
          send: t('recruiting.offerActions.send'),
          accept: t('recruiting.offerActions.accept'),
          decline: t('recruiting.offerActions.decline'),
          withdraw: t('recruiting.offerActions.withdraw'),
          reason: t('recruiting.offerActions.reason'),
          failed: t('recruiting.offerActions.failed'),
        },
      }
    } catch {
      missingDetail = t('recruiting.drawer.missing')
    }
  }

  // The create form's inputs, resolved here so nothing but strings and ids
  // cross into the client: the visible employers plus the active
  // departments a new opening may name.
  let create: RecruitingCreateProps | null = null
  if (creating) {
    const visible = await subsidiaryUiOptions(authz.user.orgId)
    const scoped = visible.filter((option) => authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(option.id))
    const employers = scoped.length > 0
      ? scoped.map((option) => ({ value: option.id, label: option.name }))
      : [{ value: await rootSubsidiaryId(), label: '' }]
    const departmentRows = (await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from departments
       where org_id = ${authz.user.orgId}::uuid and is_active
       order by name`)).rows
    create = {
      basePath: '/hrm/recruiting',
      employers,
      departments: departmentRows.map((row) => ({ value: row.id, label: row.name })),
      labels: {
        title: t('recruiting.create.titleField'),
        employer: t('recruiting.create.employer'),
        department: t('recruiting.create.department'),
        noDepartment: t('recruiting.create.noDepartment'),
        headcount: t('recruiting.create.headcount'),
        targetStart: t('recruiting.create.targetStart'),
        submit: t('recruiting.create.submit'),
        failed: t('recruiting.create.failed'),
      },
    }
  }

  const headcountTotal = requisitions.reduce((total, row) => total + row.headcount, 0)
  const filledTotal = requisitions.reduce((total, row) => total + row.filledCount, 0)
  const drawerOpen = requisition !== null || candidate !== null || offer !== null || missingDetail !== null || create !== null
  return {
    title: t('recruiting.title'),
    description: t('recruiting.description'),
    tabs,
    canManage,
    addLabel: t('recruiting.add'),
    addHref: hrefFor(status, { requisition: 'new' }),
    basePath: '/hrm/recruiting',
    segmentsLabel: t('recruiting.segmentsLabel'),
    allLabel: t('recruiting.statusAll'),
    segmentOptions: STATUSES.map((value) => ({ value, label: statusLabel(value), count: counts.get(value) ?? 0 })),
    currentParams: { ...(status ? { status } : {}) },
    columns: {
      number: t('recruiting.columns.number'),
      title: t('recruiting.columns.title'),
      position: t('recruiting.columns.position'),
      department: t('recruiting.columns.department'),
      headcount: t('recruiting.columns.headcount'),
      hiringManager: t('recruiting.columns.hiringManager'),
      opened: t('recruiting.columns.opened'),
      status: t('recruiting.columns.status'),
    },
    rows,
    empty: t('recruiting.empty'),
    totalLabel: t('recruiting.total'),
    totals: { headcount: String(headcountTotal), filled: String(filledTotal) },
    drawerOpen,
    drawer: drawerOpen
      ? {
          closeHref: hrefFor(status, null),
          title: t('recruiting.drawer.title'),
          description: null,
          requisition,
          candidate,
          offer,
          missingDetail,
          ...(create ? { create } : {}),
        }
      : null,
  }
}
