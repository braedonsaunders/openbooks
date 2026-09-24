import 'server-only'

import type { ModuleHomeTab } from '../../../../components/module-home/tab-types'

import { getTranslations } from 'next-intl/server'
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
import { hrmHiringViewTabs } from '../../../../lib/hrm/workspace-tabs'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { setupSectionParams } from '../../../../lib/list-params'
import { recruitingHref } from '../../../../lib/hrm/workspace-href'
import { isFeatureEnabled } from '../../../../lib/features'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { loadAiDraftButton, loadAiDraftDrawer, type AiDraftDrawerData } from '../../../../lib/hrm/ai-rails'
import { rootSubsidiary, subsidiaryUiOptions } from '../../../../lib/subsidiaries'
import type { RecruitingCreateProps } from './RecruitingCreateForm'
import type { CandidateDrawerData, OfferDrawerData, RequisitionDrawerData } from './sections'
import { drawerTitleKind } from './drawer-title'
import {
  depthTabOptions,
  loadInterviewDrawer,
  loadInterviewsTab,
  loadConsentStatus,
  loadOfferDrawerExtra,
  loadOffersTab,
  loadPostingDrawerExtra,
  loadPostingsTab,
  loadPoolDrawer,
  loadPoolsTab,
  resolveDepthTab,
  type DepthTab,
  type InterviewTabRow,
  type OfferTabRow,
  type PostingTabRow,
  type PoolTabRow,
  type InterviewDrawer,
  type OfferDrawerExtra,
  type PostingDrawerExtra,
  type PoolDrawer,
  type ConsentStatus,
} from './depth-view'

/**
 * Recruiting tab: requisitions as a shared `table` block with a shared
 * `list-toolbar` status filter, the header link-button opening the create form in the
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
  // HR-18: sub-tab strip + depth table payload (null on Openings).
  tab: DepthTab
  depthTabs: { value: string; label: string; href: string }[]
  /** The depth tabs as the shared strip reads them. */
  viewTabs: ModuleHomeTab[]
  /** The status filter's own label — never the strip's. */
  statusLabel: string
  depthRows: InterviewTabRow[] | OfferTabRow[] | PostingTabRow[] | PoolTabRow[] | null
  depthColumns: Record<string, string> | null
  depthEmpty: string
  /** Registry keys of the Setup sections rehomed under this tab (feature-gated). */
  setupSections: string[]
  drawerOpen: boolean
  draftDrawer: AiDraftDrawerData | null
  draftDrawerOpen: boolean
  drawer: {
    closeHref: string
    title: string
    description: string | null
    requisition: RequisitionDrawerData | null
    candidate: CandidateDrawerData | null
    offer: OfferDrawerData | null
    // HR-18: depth drawer payloads (null unless their param opened).
    interview: InterviewDrawer | null
    offerExtra: OfferDrawerExtra | null
    postingExtra: PostingDrawerExtra | null
    pool: PoolDrawer | null
    consents: ConsentStatus | null
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

/**
 * HR-18 depth table: one linked first column plus text cells, with badge
 * chips for the known status fields (scorecards, signature, status). The
 * rows are loader-resolved through the depth services, so the table binds
 * fields exactly like the openings table above it.
 */
function depthTable(data: RecruitingPageData) {
  const columns = data.depthColumns ?? {}
  const keys = Object.keys(columns)
  const [first, ...rest] = keys
  const chipKey = (key: string): string | null => {
    if (key === 'scorecards') return 'scorecardsVariant'
    if (key === 'signature') return 'signatureVariant'
    if (key === 'status') return 'statusVariant'
    return null
  }
  return table({
    variant: 'app',
    rows: f('depthRows'),
    rowKey: item('id'),
    empty: { title: f('depthEmpty') },
    columns: [
      ...(first ? [column(columns[first]!, link(item(first), item('href')))] : []),
      ...rest.map((key) => {
        const variantKey = chipKey(key)
        return variantKey
          ? column(columns[key]!, badge(item(key), { variant: item(variantKey) }))
          : column(columns[key]!, text(item(key), { fallback: '—' }))
      }),
    ],
  })
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
        // HR-18: Openings and the enabled depth tabs are VIEWS, so they ride
        // the shared subtab strip — the same component as the route strip in
        // the header. They used to render as a `filter-chips` dropdown, which
        // put a control reading "Status: Openings" directly above a second,
        // identical-looking control that really was the status filter.
        grid('flex shrink-0 flex-wrap items-center gap-3', [
          widgetBlock('module-home-tabs', { tabs: data.viewTabs }),
          ...(data.tab === 'openings'
            ? [
                widgetBlock('list-toolbar', {
                  basePath: '/hrm/recruiting',
                  currentParams: data.currentParams,
                  filters: [
                    {
                      paramKey: 'status',
                      label: data.statusLabel,
                      allLabel: data.allLabel,
                      options: data.segmentOptions,
                    },
                  ],
                }),
              ]
            : []),
        ]),
        ...(data.tab === 'openings'
          ? [
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
            ]
          : [depthTable(data)]),
        // HR-18: the Setup lists rehomed under this tab (kits + pools on
        // Interviews, templates on Offers, retention rules on Pools) ride
        // the shared setup-section widget — same component as Compliance,
        // never a fork. Boards ride the existing sync-connections
        // connector registry, so Postings mounts no section.
        ...data.setupSections.map((entityKey) =>
          widgetBlock('setup-section', {
            entityKey,
            sp: data.currentParams,
            basePath: '/hrm/recruiting',
          }),
        ),
      ]),
      // URL-backed drawers, portaled to <body> wherever they render.
      {
        ...widgetBlock('hrm-recruiting-drawer', { drawer: data.drawer }),
        when: f('drawerOpen'),
      },
      // HR-21: the shared evidence-draft drawer (?draft=<kind>:<id>).
      {
        ...widgetBlock('hrm-ai-draft-drawer', { draft: data.draftDrawer }),
        when: f('draftDrawerOpen'),
      },
    ],
  })
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
  // HR-18: the HR-6 funnel rides the hrmRecruiting parent (on wherever hrm
  // is on) — the wrap is additive and changes nothing by default.
  const authz = await requirePermission('hrm.recruiting.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmRecruiting')
  const t = await getTranslations('hrm')
  const tc = await getTranslations('common')
  const tabs = await hrmGroupTabs(authz, '/hrm/recruiting')
  const status = typeof sp.status === 'string' && (STATUSES as readonly string[]).includes(sp.status)
    ? sp.status
    : null
  // HR-18: route sub-tabs. A tab naming a switched-off surface falls back
  // to Openings, so feature-off tabs are absent, not errors.
  const tab: DepthTab = await resolveDepthTab(authz, sp.tab)
  // F3-56: drawer hrefs preserve the depth tab, the status filter, and the
  // rehomed setup-section params through the ONE shared helper — closing a
  // drawer returns to the same tab/filter instead of the default view.
  const preservedParams = { ...(status ? { status } : {}), tab, ...setupSectionParams(sp) }
  const depthTabs = await depthTabOptions(authz, t, status)
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
    href: recruitingHref(preservedParams, { status, requisition: row.id }),
  }))

  // The drawers resolve through the canonical read service (PII redaction
  // included); an id that no longer resolves renders the named absence.
  let requisition: RequisitionDrawerData | null = null
  let candidate: CandidateDrawerData | null = null
  let offer: OfferDrawerData | null = null
  let missingDetail: string | null = null
  // HR-21: one shared "Draft from evidence" label for both draft hosts;
  // null while hrmDrafting is off hides both buttons.
  const draftLabel = await loadAiDraftButton(authz.user.orgId)
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
      // The offer draft inherits the opening's legal entity: resolve its
      // display name (never the raw id) plus the authorized employers the
      // caller may instead choose. The POST route stays authoritative.
      const offerEmployerName = (await db.execute<{ name: string }>(sql`
        select name from subsidiaries
         where org_id = ${authz.user.orgId}::uuid and id = ${detail.employerSubsidiaryId}
         limit 1`)).rows[0]?.name
      if (!offerEmployerName) {
        throw new Error(`requisition ${detail.requisitionNumber} names an employer outside this organization`)
      }
      const offerVisible = await subsidiaryUiOptions(authz.user.orgId)
      const offerScoped = offerVisible.filter(
        (option) => authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(option.id),
      )
      let offerEmployerOptions = offerScoped.map((option) => ({ value: option.id, label: option.name }))
      if (offerEmployerOptions.length === 0 && offerVisible.length === 0) {
        const root = await rootSubsidiary()
        offerEmployerOptions = [{ value: root.id, label: root.name }]
      }
      requisition = {
        ...detail,
        closeHref: recruitingHref(preservedParams, { status }),
        draft: draftLabel
          ? { href: `${recruitingHref(preservedParams, { status, requisition: requisitionId })}&draft=job_description:${requisitionId}`, label: draftLabel }
          : null,
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
          attachMergedNote: t('recruiting.attach.mergedNote'),
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
          offerEmployer: t('recruiting.offerCard.employer'),
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
          description: t('recruiting.drawer.description'),
        },
        lifecycle: {
          canManage,
          labels: {
            title: t('recruiting.lifecycle.title'),
            open: t('recruiting.lifecycle.open'),
            hold: t('recruiting.lifecycle.hold'),
            resume: t('recruiting.lifecycle.resume'),
            cancel: t('recruiting.lifecycle.cancel'),
            reason: t('recruiting.lifecycle.reasonLabel'),
            failed: t('recruiting.lifecycle.failed'),
          },
        },
        offerEmployer: { value: detail.employerSubsidiaryId, label: offerEmployerName },
        offerEmployerOptions,
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
          candidateOptions: [],
        }
    } catch {
      missingDetail = t('recruiting.drawer.missing')
    }
  } else if (candidateId) {
    try {
      const detail = await getCandidateDetail({ orgId: authz.user.orgId, actorId: authz.user.id, candidateId })
      candidate = {
        ...detail,
        closeHref: recruitingHref(preservedParams, { status }),
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
      // The saved offer's legal entity: resolve the persisted employer's
      // display name (never the raw id) so the reviewer sees which entity
      // employs the candidate. Fail closed like the requisition branch.
      const offerEmployerName = (await db.execute<{ name: string }>(sql`
        select name from subsidiaries
         where org_id = ${authz.user.orgId}::uuid and id = ${detail.employerSubsidiaryId}
         limit 1`)).rows[0]?.name
      if (!offerEmployerName) {
        throw new Error(`offer ${offerId} names an employer outside this organization`)
      }
      offer = {
        ...detail,
        employerName: offerEmployerName,
        closeHref: recruitingHref(preservedParams, { status }),
        draft: draftLabel
          ? { href: `${recruitingHref(preservedParams, { status, offer: offerId })}&draft=offer_letter_clauses:${offerId}`, label: draftLabel }
          : null,
        labels: {
          employer: t('recruiting.drawer.employer'),
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

  // HR-18: depth drawers. URL-backed like the rest: ?tab=interviews&
  // interview= opens the kit/slots/scorecard drawer; ?tab=offers&offer=
  // gains versions + signature state; ?tab=postings&posting= the
  // disposition log; ?tab=pools&pool= members + rediscovery.
  const interviewParam = typeof sp.interview === 'string' && sp.interview.length > 0 ? sp.interview : null
  const postingParam = typeof sp.posting === 'string' && sp.posting.length > 0 ? sp.posting : null
  const poolParam = typeof sp.pool === 'string' && sp.pool.length > 0 ? sp.pool : null
  let interview: InterviewDrawer | null = null
  let offerExtra: OfferDrawerExtra | null = null
  let postingExtra: PostingDrawerExtra | null = null
  let pool: PoolDrawer | null = null
  let consents: ConsentStatus | null = null
  if (interviewParam && !requisitionId && !candidateId && !offerId) {
    interview = await loadInterviewDrawer(authz, t, tab, interviewParam)
    if (!interview) missingDetail = t('recruiting.drawer.missing')
  }
  if (offer && offerId) {
    offerExtra = await loadOfferDrawerExtra(authz, t, offerId)
  }
  if (postingParam && !requisitionId && !candidateId && !offerId && !interviewParam) {
    postingExtra = await loadPostingDrawerExtra(authz, t, postingParam)
    if (!postingExtra) missingDetail = t('recruiting.drawer.missing')
  }
  if (poolParam && !requisitionId && !candidateId && !offerId && !interviewParam && !postingParam) {
    pool = await loadPoolDrawer(authz, t, poolParam)
    if (!pool) missingDetail = t('recruiting.drawer.missing')
  }
  if (candidate) {
    consents = await loadConsentStatus(authz, t, candidateId!)
  }

  // The create form's inputs, resolved here so nothing but strings and ids
  // cross into the client: the visible employers plus the active
  // departments a new opening may name.
  let create: RecruitingCreateProps | null = null
  if (creating) {
    const visible = await subsidiaryUiOptions(authz.user.orgId)
    const scoped = visible.filter((option) => authz.allowedSubsidiaryIds === null || authz.allowedSubsidiaryIds.has(option.id))
    // The employer picker shows NAMES, never ids: a single-entity org
    // (picker off, nothing visible) creates against its named root, while a
    // caller scoped out of every visible entity is refused by name — never
    // offered an unauthorized root.
    let employers = scoped.map((option) => ({ value: option.id, label: option.name }))
    let employerRefusal: string | null = null
    if (employers.length === 0) {
      if (visible.length === 0) {
        const root = await rootSubsidiary()
        employers = [{ value: root.id, label: root.name }]
      } else {
        employerRefusal = t('recruiting.create.noEmployer')
      }
    }
    const departmentRows = (await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from departments
       where org_id = ${authz.user.orgId}::uuid and is_active
       order by name`)).rows
    create = {
      basePath: '/hrm/recruiting',
      employers,
      employerRefusal,
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
  // HR-18: depth tab tables resolve here, beside the openings rows, so the
  // spec branches on data it already holds.
  const depthRows =
    tab === 'interviews'
      ? await loadInterviewsTab(authz, t, tab)
      : tab === 'offers'
        ? await loadOffersTab(authz, t, tab)
        : tab === 'postings'
          ? await loadPostingsTab(authz, t, tab)
          : tab === 'pools'
            ? await loadPoolsTab(authz, t, tab)
            : null
  const depthColumns: Record<string, string> | null =
    tab === 'interviews'
      ? {
          candidate: t('recruiting.depth.columns.candidate'),
          requisition: t('recruiting.depth.columns.requisition'),
          kind: t('recruiting.depth.columns.kind'),
          when: t('recruiting.depth.columns.when'),
          slots: t('recruiting.depth.columns.slots'),
          scorecards: t('recruiting.depth.columns.scorecards'),
        }
      : tab === 'offers'
        ? {
            candidate: t('recruiting.depth.columns.candidate'),
            job: t('recruiting.depth.columns.job'),
            status: t('recruiting.depth.columns.status'),
            signature: t('recruiting.depth.columns.signature'),
            versions: t('recruiting.depth.columns.versions'),
          }
        : tab === 'postings'
          ? {
              board: t('recruiting.depth.columns.board'),
              status: t('recruiting.depth.columns.status'),
              applies: t('recruiting.depth.columns.applies'),
            }
          : tab === 'pools'
            ? { name: t('recruiting.depth.columns.name'), members: t('recruiting.depth.columns.members') }
            : null
  // HR-18: the Setup lists rehomed under this tab, each behind its own
  // sub-switch (a tab being on never implies its Setup surface is — the
  // interviews tab covers two switches, pools covers two). Unknown keys
  // stay absent rather than rendering a section the registry cannot serve.
  const SETUP_BY_TAB: Record<Exclude<DepthTab, 'openings'>, readonly string[]> = {
    interviews: ['hrm-interview-kits', 'hrm-interviewer-pools'],
    offers: ['hrm-offer-templates'],
    postings: [],
    pools: ['hrm-retention-rules'],
  }
  const setupSections: string[] = []
  if (tab !== 'openings') {
    for (const entityKey of SETUP_BY_TAB[tab]) {
      const entry = SETUP_ENTITY_BY_KEY.get(entityKey)
      if (entry?.featureKey && (await isFeatureEnabled(authz.user.orgId, entry.featureKey))) {
        setupSections.push(entityKey)
      }
    }
  }
  const drawerOpen =
    requisition !== null ||
    candidate !== null ||
    offer !== null ||
    interview !== null ||
    postingExtra !== null ||
    pool !== null ||
    missingDetail !== null ||
    create !== null
  // CK-23b: which record owns the drawer title. Computed once here so the
  // pure drawerTitleKind branch (unit-tested) decides, while the translated
  // keys below stay literal for i18n extraction.
  const titleKind = drawerTitleKind({ hasOffer: offer !== null, hasCandidate: candidate !== null })
  // HR-21: the shared evidence-draft drawer. No host field is editable
  // here, so Insert copies to the clipboard (the drawer's own fallback).
  const drawerBase = requisitionId
    ? recruitingHref(preservedParams, { status, requisition: requisitionId })
    : candidateId
      ? recruitingHref(preservedParams, { status, candidate: candidateId })
      : offerId
        ? recruitingHref(preservedParams, { status, offer: offerId })
        : recruitingHref(preservedParams, { status })
  const draftDrawer = await loadAiDraftDrawer({
    draftParam: typeof sp.draft === 'string' ? sp.draft : null,
    closeHref: drawerBase,
    fieldId: '',
  })
  return {
    title: t('recruiting.title'),
    description: t('recruiting.description'),
    tabs,
    canManage,
    addLabel: t('recruiting.add'),
    addHref: recruitingHref(preservedParams, { status, requisition: 'new' }),
    basePath: '/hrm/recruiting',
    // HR-18: sub-tab strip + depth table payload (null on Openings).
    tab,
    depthTabs,
    viewTabs: await hrmHiringViewTabs(
      authz,
      '/hrm/recruiting',
      depthTabs.map((option) => ({
        href: option.href,
        label: option.label,
        active: option.value === tab,
      })),
    ),
    statusLabel: tc('labels.status'),
    depthRows,
    depthColumns,
    depthEmpty: t('recruiting.depth.empty'),
    setupSections,
    segmentsLabel: t('recruiting.segmentsLabel'),
    allLabel: t('recruiting.statusAll'),
    segmentOptions: STATUSES.map((value) => ({ value, label: statusLabel(value), count: counts.get(value) ?? 0 })),
    // OM-18: the rehomed depth-tab sections read their New/edit drawer
    // from sp.row (SetupEntitySection) — the tab and the status filter
    // ride beside the section's list params, never instead of them.
    currentParams: preservedParams,
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
    draftDrawer,
    draftDrawerOpen: draftDrawer !== null,
    drawer: drawerOpen
      ? {
          closeHref: recruitingHref(preservedParams, { status }),
          // Record-type-correct drawer titles (CK-23b): the winning kind
          // comes from the pure drawerTitleKind branch so it stays
          // unit-testable; the translated keys stay literal for i18n
          // extraction. An open offer or candidate drawer is titled for
          // its own record, never for the requisition.
          title: titleKind === 'offer' && offer
            ? t('recruiting.drawer.offerTitle', { employer: offer.employerName })
            : titleKind === 'candidate' && candidate
              ? t('recruiting.drawer.candidateTitle', { name: candidate.displayName })
              : t('recruiting.drawer.title', { number: requisition?.requisitionNumber ?? '' }),
          description: null,
          requisition,
          candidate,
          offer,
          // HR-18: depth drawer payloads (null unless their param opened).
          interview,
          offerExtra,
          postingExtra,
          pool,
          consents,
          missingDetail,
          ...(create ? { create } : {}),
        }
      : null,
  }
}
