import 'server-only'
import {listApplicationWorklist} from '@openbooks/engine/hrm/recruiting'

import { registeredListTable } from '../../../../lib/list/prepared-spec'
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
import { listActiveJobDescriptions } from '@openbooks/engine/src/hrm/recruiting/job-descriptions.ts'
import { hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { can, requirePermission, type Authz } from '../../../../lib/authz'

/**
 * Funnel move display gate: the org-wide manage grant, or the hiring
 * manager on their own requisition — the same authority the move
 * endpoint enforces (requireOwnRequisitionForHiringManager), probed
 * read-only. Anything else (including an outage of the probe) hides
 * Move; the endpoint stays authoritative on every attempt.
 */
async function canMoveFunnel(
  authz: Authz,
  requisitionId: string,
  canManage: boolean,
): Promise<boolean> {
  if (canManage) return true
  try {
    await requireOwnRequisitionForHiringManager(
      db,
      authz.user.orgId,
      authz.user.id,
      requisitionId,
    )
    return true
  } catch {
    return false
  }
}
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { setupSectionParams } from '../../../../lib/list-params'
import { recruitingHref } from '../../../../lib/hrm/workspace-href'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import {
  loadAiDraftButton,
  loadAiDraftDrawer,
  type AiDraftDrawerData,
} from '../../../../lib/hrm/ai-rails'
import {
  rootSubsidiary,
  subsidiaryUiOptions,
} from '../../../../lib/subsidiaries'
import { businessTimeZone } from '@openbooks/engine/src/platform/business-date.ts'
import { requireOwnRequisitionForHiringManager } from '@openbooks/engine/src/hrm/authorization.ts'
import type { RecruitingCreateProps } from './RecruitingCreateForm'
import type {
  CandidateDrawerData,
  OfferDrawerData,
  RequisitionDrawerData,
} from './sections'
import { drawerTitleKind } from './drawer-title'
import {
  hrefForDepth,
  isRecruitingAbsence,
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
  statusVariant:
    'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  href: string
}

export interface RecruitingPageData {
  title: string
  description: string
  tabs: { href: string; label: string; active?: boolean }[]
  /** hrm.recruiting.manage: the header's New requisition button and the create form. */
  canManage: boolean
  showCreate: boolean
  setupHref: string | null
  setupLabel: string
  poolCreate: {
    title: string
    closeHref: string
    nameLabel: string
    descriptionLabel: string
    submitLabel: string
    failed: string
  } | null
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
  applicationRows: {id:string;candidate:string;opening:string;stage:string;status:string;source:string|null;appliedOn:string;owner:string|null;href:string}[]
  applicationColumns:Record<string,string>
  applicationFilters:{paramKey:string;label:string;allLabel:string;options:{value:string;label:string}[]}[]
  applicationSelection:{id:string;candidate:string;opening:string;href:string}|null
  rows: RecruitingRow[]
  empty: string
  totalLabel: string
  totals: { headcount: string; filled: string }
  // The active depth view and its table payload (null on Openings).
  tab: DepthTab
  /** The status filter's own label — never the strip's. */
  statusLabel: string
  depthRows:
    InterviewTabRow[] | OfferTabRow[] | PostingTabRow[] | PoolTabRow[] | null
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
    /**
     * Drawer load failure (anything but a typed absence or scope
     * refusal): the message with a retry link back to the same drawer —
     * never the uniform "no longer exists".
     */
    detailError: {
      message: string
      retryHref: string
      retryLabel: string
    } | null
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
  return registeredListTable('hrm_recruiting_depth_rows', {
    variant: 'app',
    rows: f('depthRows'),
    rowKey: item('id'),
    empty: { title: f('depthEmpty') },
    columns: [
      ...(first
        ? [column(columns[first]!, link(item(first), item('href')))]
        : []),
      ...rest.map((key) => {
        const variantKey = chipKey(key)
        return variantKey
          ? column(
              columns[key]!,
              badge(item(key), { variant: item(variantKey) }),
            )
          : column(columns[key]!, text(item(key), { fallback: '—' }))
      }),
    ],
  })
}

export function recruitingSpec(data: RecruitingPageData): PageSpec {
  return page({
    route: '/hrm/recruiting',
    layout: 'list',
    // Whole-page scroll in normal block flow: the register tables stack
    // above rehomed setup sections with no internal scroll panel, so a
    // viewport-height flex lock would collapse the tables under the
    // sections and let them paint over the row links (CK-32b).
    bodyClassName: 'space-y-4',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          // The primary action first, the strip last — the house order on
          // every list page, so the switcher never moves between siblings.
          widget(
            'link-button',
            { href: f('addHref'), label: f('addLabel'), iconKey: 'plus' },
            f('showCreate'),
          ),
          ...(data.setupHref
            ? [
                widget('plain-link-button', {
                  href: data.setupHref,
                  label: data.setupLabel,
                  variant: 'outline',
                }),
              ]
            : []),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      // The register sizes to its content: a shrinkable flex item here
      // collapses below its rows and the setup sections spread below
      // paint over the overflowed row links (CK-32b). A single-column
      // grid cannot shrink under its content. The page scrolls as a whole.
      grid('grid gap-4', [
        // Openings and the enabled depth views are tabs on the Hiring strip
        // under the page header; only Openings has a status filter.
        ...(data.tab === 'openings'
          ? [
              grid('flex shrink-0 flex-wrap items-center gap-3', [
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
              ]),
            ]
          : []),
        ...(data.tab === 'applications' ? [
          widgetBlock('list-toolbar',{basePath:'/hrm/recruiting',currentParams:data.currentParams,filters:data.applicationFilters}),
          registeredListTable('hrm_application_worklist',{variant:'app',rows:f('applicationRows'),rowKey:item('id'),empty:{title:f('empty')},columns:[column(data.applicationColumns.candidate!,link(item('candidate'),item('href'))),...['opening','stage','status','source','appliedOn','owner'].map(key=>column(data.applicationColumns[key]!,text(item(key),{fallback:'—'})))]})
        ] : data.tab === 'openings'
          ? [
              registeredListTable('hrm_recruiting_rows', {
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
                            {
                              cell: text(f('totals.headcount')),
                              align: 'right',
                              className: 'font-semibold tabular-nums',
                            },
                            {
                              cell: text(f('totals.filled')),
                              align: 'right',
                              className: 'font-semibold tabular-nums',
                            },
                          ],
                        }),
                      ]
                    : undefined,
                columns: [
                  column(
                    data.columns.number,
                    link(item('number'), item('href')),
                  ),
                  column(data.columns.title, text(item('title'))),
                  column(
                    data.columns.position,
                    text(item('position'), { fallback: '—' }),
                  ),
                  column(
                    data.columns.department,
                    text(item('department'), { fallback: '—' }),
                  ),
                  column(data.columns.headcount, text(item('headcount')), {
                    align: 'right',
                    className: 'tabular-nums',
                  }),
                  column(
                    data.columns.hiringManager,
                    text(item('hiringManager'), { fallback: '—' }),
                  ),
                  column(
                    data.columns.opened,
                    text(item('opened'), { fallback: '—' }),
                  ),
                  column(
                    data.columns.status,
                    badge(item('statusLabel'), {
                      variant: item('statusVariant'),
                    }),
                  ),
                ],
              }),
            ]
          : [depthTable(data)]),
      ]),
      ...(data.poolCreate
        ? [widgetBlock('hrm-pool-create', { create: data.poolCreate })]
        : []),
      ...(data.applicationSelection?[widgetBlock('hrm-application-review',{selection:data.applicationSelection,queue:data.applicationRows,closeHref:recruitingHref(data.currentParams),canManage:data.canManage})]:[]),
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
  // Recruiting rides the HRM parent and is on wherever HRM is, by default.
  const authz = await requirePermission('hrm.recruiting.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmRecruiting')
  const t = await getTranslations('hrm')
  const tw = await getTranslations('hrm.talentWorkspace')
  const tc = await getTranslations('common')
  const tabs = await hrmGroupTabs(authz, '/hrm/recruiting')
  const status =
    typeof sp.status === 'string' &&
    (STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null
  // Route sub-tabs. An unknown tab param falls back to Openings.
  const tab: DepthTab = resolveDepthTab(sp.tab??(sp.requisition||sp.candidate||sp.offer?'openings':undefined))
  // Drawer hrefs preserve the depth tab, the status filter, and the
  // rehomed setup-section params through the ONE shared helper — closing a
  // drawer returns to the same tab/filter instead of the default view.
  const preservedParams = {
    ...(status ? { status } : {}),
    ...(tab==='applications'?{applicationStatus:sp.applicationStatus??'active',opening:sp.opening,stage:sp.stage}:{}),
    tab,
    ...setupSectionParams(sp),
  }
  const canManage = can(authz, 'hrm.recruiting.manage')
  const creating = sp.requisition === 'new' && canManage
  const requisitionId =
    typeof sp.requisition === 'string' &&
    sp.requisition.length > 0 &&
    sp.requisition !== 'new'
      ? sp.requisition
      : null
  const candidateId =
    typeof sp.candidate === 'string' && sp.candidate.length > 0
      ? sp.candidate
      : null
  const offerId =
    typeof sp.offer === 'string' && sp.offer.length > 0 ? sp.offer : null

  const applicationSource=tab==='applications'?await listApplicationWorklist({orgId:authz.user.orgId,actorId:authz.user.id,status:sp.applicationStatus==='all'?undefined:sp.applicationStatus??'active',opening:sp.opening,stage:sp.stage}):[]
  const filterSource=tab==='applications'&&(sp.opening||sp.stage)?await listApplicationWorklist({orgId:authz.user.orgId,actorId:authz.user.id,status:sp.applicationStatus==='all'?undefined:sp.applicationStatus??'active'}):applicationSource
  const applicationRows=applicationSource.map(row=>({...row,status:tw(`applicationStatuses.${row.status}`),href:recruitingHref(preservedParams,{application:row.id})}))
  const uniqueOptions=(key:'opening'|'stage',idKey:'requisitionId'|'stageId')=>Array.from(new Map(filterSource.map(row=>[row[idKey],{value:row[idKey],label:row[key]}])).values())
  const applicationFilters=[{paramKey:'applicationStatus',label:tw('status'),allLabel:tw('active'),options:['all','rejected','withdrawn','hired'].map(value=>({value,label:value==='all'?tw('allApplications'):tw(`applicationStatuses.${value}`)}))},{paramKey:'opening',label:tw('opening'),allLabel:tw('allOpenings'),options:uniqueOptions('opening','requisitionId')},{paramKey:'stage',label:tw('stage'),allLabel:tw('allStages'),options:uniqueOptions('stage','stageId')}]
  const applicationSelection=tab==='applications'&&sp.application?(applicationRows.find(row=>row.id===sp.application)??{id:sp.application,candidate:tw('application'),opening:'',href:recruitingHref(preservedParams,{application:sp.application})}):null
  const requisitions =
    tab === 'openings'
      ? await listRequisitions({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          ...(status ? { status } : {}),
        })
      : []
  const counts = new Map<string, number>()
  for (const row of requisitions)
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
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
  let detailError: NonNullable<
    NonNullable<RecruitingPageData['drawer']>['detailError']
  > | null = null
  const drawerLoadError = (retryHref: string) => ({
    message: t('recruiting.drawer.loadFailed'),
    retryHref,
    retryLabel: tc('actions.retry'),
  })
  // One shared "Draft from evidence" label for both draft hosts; null
  // (Human resources off, or no assistant access) hides both buttons.
  const draftLabel = await loadAiDraftButton(authz)
  if (requisitionId) {
    try {
      const detail = await getRequisitionDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        requisitionId,
      })
      // Panel candidates: employees (parties holding an employment) inside
      // the viewer's subsidiary scope — ids, never labels; out-of-scope
      // holders stay absent rather than leaking existence.
      const employeeRows = (
        await db.execute<{ id: string; name: string }>(sql`
        select p.id::text as id, p.display_name as name
          from worker_employments e
          join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
         where e.org_id = ${authz.user.orgId}::uuid
           ${
             authz.allowedSubsidiaryIds
               ? sql`and e.employer_subsidiary_id in (${sql.join(
                   [...authz.allowedSubsidiaryIds].map(
                     (id) => sql`${id}::uuid`,
                   ),
                   sql`, `,
                 )})`
               : sql``
           }
         order by p.display_name limit 200`)
      ).rows
      // The offer draft inherits the opening's legal entity: resolve its
      // display name (never the raw id) plus the authorized employers the
      // caller may instead choose. The POST route stays authoritative.
      const offerEmployerName = (
        await db.execute<{ name: string }>(sql`
        select name from subsidiaries
         where org_id = ${authz.user.orgId}::uuid and id = ${detail.employerSubsidiaryId}
         limit 1`)
      ).rows[0]?.name
      if (!offerEmployerName) {
        throw new Error(
          `requisition ${detail.requisitionNumber} names an employer outside this organization`,
        )
      }
      const offerVisible = await subsidiaryUiOptions(authz.user.orgId)
      const offerScoped = offerVisible.filter(
        (option) =>
          authz.allowedSubsidiaryIds === null ||
          authz.allowedSubsidiaryIds.has(option.id),
      )
      let offerEmployerOptions = offerScoped.map((option) => ({
        value: option.id,
        label: option.name,
      }))
      if (offerEmployerOptions.length === 0 && offerVisible.length === 0) {
        const root = await rootSubsidiary(authz.user.orgId)
        offerEmployerOptions = [{ value: root.id, label: root.name }]
      }
      requisition = {
        ...detail,
        closeHref: recruitingHref(preservedParams, { status }),
        draft: draftLabel
          ? {
              href: `${recruitingHref(preservedParams, { status, requisition: requisitionId })}&draft=job_description:${requisitionId}`,
              label: draftLabel,
            }
          : null,
        stageLabels: Object.fromEntries(
          detail.stages.map((stage) => [stage.id, stage.name]),
        ),
        statusLabels: Object.fromEntries(
          STATUSES.map((value) => [value, statusLabel(value)]),
        ),
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
          interviewInvalidTime: t('recruiting.depth.invalidTime'),
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
        postingLabels: {
          heading: t('recruiting.postingContent.description'),
          title: t('recruiting.postingContent.title'),
          employmentKind: t('recruiting.postingContent.employmentKind'),
          description: t('recruiting.postingContent.description'),
          empty: t('recruiting.postingContent.empty'),
          source: detail.jobDescriptionName
            ? t('recruiting.postingContent.source', { name: detail.jobDescriptionName })
            : '',
          copyTitle: t('recruiting.postingContent.copyTitle'),
          copyDescription: t('recruiting.postingContent.copyDescription'),
          copied: t('recruiting.postingContent.copied'),
          copyFailed: t('recruiting.postingContent.copyFailed'),
          edit: t('recruiting.postingContent.edit'),
          save: t('recruiting.postingContent.save'),
          cancel: t('recruiting.postingContent.cancel'),
          failed: t('recruiting.postingContent.failed'),
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
        // Funnel move rides the manage grant or the hiring manager's own
        // requisition — the same authority the move endpoint enforces, so
        // the Move control reaches exactly the hands that can use it.
        canMoveApplications: await canMoveFunnel(
          authz,
          requisitionId,
          canManage,
        ),
        offerEmployer: {
          value: detail.employerSubsidiaryId,
          label: offerEmployerName,
        },
        offerEmployerOptions,
        employeeOptions: employeeRows.map((option) => ({
          value: option.id,
          label: option.name,
        })),
        timeZone: await businessTimeZone(authz.user.orgId),
        kindOptions: ['phone', 'video', 'onsite', 'panel', 'assessment'].map(
          (value) => ({
            value,
            label: t(`recruiting.interviewKind.${value}`),
          }),
        ),
        outcomeOptions: ['advance', 'hold', 'reject'].map((value) => ({
          value,
          label: t(`recruiting.interviewOutcome.${value}`),
        })),
        basisOptions: ['hourly', 'annual'].map((value) => ({
          value,
          label: t(`recruiting.basis.${value}`),
        })),
        candidateOptions: [],
      }
    } catch (error) {
      // A typed absence or scope refusal reads as "no longer visible"
      // (never confirming existence); anything else — including the
      // employer-integrity refusal above — is a load failure with a
      // retry back to the same drawer.
      if (isRecruitingAbsence(error)) {
        missingDetail = t('recruiting.drawer.missing')
      } else {
        detailError = drawerLoadError(
          recruitingHref(preservedParams, { requisition: requisitionId }),
        )
      }
    }
  } else if (candidateId) {
    try {
      const detail = await getCandidateDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        candidateId,
      })
      candidate = {
        ...detail,
        canManage,
        interviews: detail.interviews.map((interview) => ({
          ...interview,
          kindLabel: t(`recruiting.interviewKind.${interview.kind}`),
        })),
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
    } catch (error) {
      if (isRecruitingAbsence(error)) {
        missingDetail = t('recruiting.drawer.missing')
      } else {
        detailError = drawerLoadError(
          recruitingHref(preservedParams, { candidate: candidateId }),
        )
      }
    }
  } else if (offerId) {
    try {
      const detail = await getOfferDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        offerId,
      })
      // The saved offer's legal entity: resolve the persisted employer's
      // display name (never the raw id) so the reviewer sees which entity
      // employs the candidate. Fail closed like the requisition branch.
      const offerEmployerName = (
        await db.execute<{ name: string }>(sql`
        select name from subsidiaries
         where org_id = ${authz.user.orgId}::uuid and id = ${detail.employerSubsidiaryId}
         limit 1`)
      ).rows[0]?.name
      if (!offerEmployerName) {
        throw new Error(
          `offer ${offerId} names an employer outside this organization`,
        )
      }
      offer = {
        ...detail,
        canManage,
        statusLabel: t(`recruiting.offerStatus.${detail.status}`),
        effectiveStatusLabel: t(
          `recruiting.offerStatus.${detail.effectiveStatus}`,
        ),
        employerName: offerEmployerName,
        closeHref: recruitingHref(preservedParams, { status }),
        draft: draftLabel
          ? {
              href: `${recruitingHref(preservedParams, { status, offer: offerId })}&draft=offer_letter_clauses:${offerId}`,
              label: draftLabel,
            }
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
    } catch (error) {
      if (isRecruitingAbsence(error)) {
        missingDetail = t('recruiting.drawer.missing')
      } else {
        detailError = drawerLoadError(
          recruitingHref(preservedParams, { offer: offerId }),
        )
      }
    }
  }

  // HR-18: depth drawers. URL-backed like the rest: ?tab=interviews&
  // interview= opens the kit/slots/scorecard drawer; ?tab=offers&offer=
  // gains versions + signature state; ?tab=postings&posting= the
  // disposition log; ?tab=pools&pool= members + rediscovery.
  const interviewParam =
    typeof sp.interview === 'string' && sp.interview.length > 0
      ? sp.interview
      : null
  const postingParam =
    typeof sp.posting === 'string' && sp.posting.length > 0 ? sp.posting : null
  const poolParam =
    typeof sp.pool === 'string' && sp.pool.length > 0 ? sp.pool : null
  let interview: InterviewDrawer | null = null
  let offerExtra: OfferDrawerExtra | null = null
  let postingExtra: PostingDrawerExtra | null = null
  let pool: PoolDrawer | null = null
  let consents: ConsentStatus | null = null
  if (interviewParam && !requisitionId && !candidateId && !offerId) {
    try {
      interview = await loadInterviewDrawer(authz, t, tab, interviewParam)
    } catch (error) {
      // The depth loaders return null on typed absence and throw on
      // anything else: absence reads as "no longer visible", failures
      // as a load error with a retry back to the same drawer.
      if (!isRecruitingAbsence(error)) {
        detailError = drawerLoadError(
          hrefForDepth(tab, { interview: interviewParam }),
        )
      }
    }
    if (!interview && !detailError)
      missingDetail = t('recruiting.drawer.missing')
  }
  if (offer && offerId) {
    try {
      offerExtra = await loadOfferDrawerExtra(authz, t, offerId)
    } catch (error) {
      if (!isRecruitingAbsence(error)) {
        detailError = drawerLoadError(hrefForDepth(tab, { offer: offerId }))
      }
    }
  }
  if (
    postingParam &&
    !requisitionId &&
    !candidateId &&
    !offerId &&
    !interviewParam
  ) {
    try {
      postingExtra = await loadPostingDrawerExtra(authz, t, postingParam)
    } catch (error) {
      if (!isRecruitingAbsence(error)) {
        detailError = drawerLoadError(
          hrefForDepth(tab, { posting: postingParam }),
        )
      }
    }
    if (!postingExtra && !detailError)
      missingDetail = t('recruiting.drawer.missing')
  }
  if (
    poolParam &&
    poolParam !== 'new' &&
    !requisitionId &&
    !candidateId &&
    !offerId &&
    !interviewParam &&
    !postingParam
  ) {
    try {
      pool = await loadPoolDrawer(authz, t, poolParam)
    } catch (error) {
      if (!isRecruitingAbsence(error)) {
        detailError = drawerLoadError(hrefForDepth(tab, { pool: poolParam }))
      }
    }
    if (!pool && !detailError) missingDetail = t('recruiting.drawer.missing')
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
    const scoped = visible.filter(
      (option) =>
        authz.allowedSubsidiaryIds === null ||
        authz.allowedSubsidiaryIds.has(option.id),
    )
    // The employer picker shows NAMES, never ids: a single-entity org
    // (picker off, nothing visible) creates against its named root, while a
    // caller scoped out of every visible entity is refused by name — never
    // offered an unauthorized root.
    let employers = scoped.map((option) => ({
      value: option.id,
      label: option.name,
    }))
    let employerRefusal: string | null = null
    if (employers.length === 0) {
      if (visible.length === 0) {
        const root = await rootSubsidiary(authz.user.orgId)
        employers = [{ value: root.id, label: root.name }]
      } else {
        employerRefusal = t('recruiting.create.noEmployer')
      }
    }
    const departmentRows = (
      await db.execute<{ id: string; name: string }>(sql`
      select id::text as id, name from departments
       where org_id = ${authz.user.orgId}::uuid and is_active
       order by name`)
    ).rows
    const jobDescriptions = await listActiveJobDescriptions({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    create = {
      basePath: '/hrm/recruiting',
      employers,
      employerRefusal,
      departments: departmentRows.map((row) => ({
        value: row.id,
        label: row.name,
      })),
      jobDescriptions: jobDescriptions.map((entry) => ({
        value: entry.id,
        label: entry.name,
        title: entry.title,
        description: entry.description,
      })),
      labels: {
        title: t('recruiting.create.titleField'),
        jobDescription: t('recruiting.create.jobDescription'),
        noJobDescription: t('recruiting.create.noJobDescription'),
        jobDescriptionNote: t('recruiting.create.jobDescriptionNote'),
        description: t('recruiting.create.description'),
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

  const headcountTotal = requisitions.reduce(
    (total, row) => total + row.headcount,
    0,
  )
  const filledTotal = requisitions.reduce(
    (total, row) => total + row.filledCount,
    0,
  )
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
              opening: t('recruiting.depth.columns.requisition'),
              status: t('recruiting.depth.columns.status'),
              applies: t('recruiting.depth.columns.applies'),
            }
          : tab === 'pools'
            ? {
                name: t('recruiting.depth.columns.name'),
                members: t('recruiting.depth.columns.members'),
              }
            : null
  // The Setup lists rehomed under this tab. Unknown keys stay absent
  // rather than rendering a section the registry cannot serve.
  const SETUP_BY_TAB: Record<
    Exclude<DepthTab, 'applications'>,
    readonly string[]
  > = {
    openings: ['hrm-job-descriptions'],
    interviews: ['hrm-interview-kits', 'hrm-interviewer-pools'],
    offers: ['hrm-offer-templates'],
    postings: [],
    pools: ['hrm-retention-rules'],
  }
  const setupSections: string[] =
    tab === 'applications'
      ? []
      : SETUP_BY_TAB[tab].filter((entityKey) =>
          SETUP_ENTITY_BY_KEY.has(entityKey),
        )
  const drawerOpen =
    requisition !== null ||
    candidate !== null ||
    offer !== null ||
    interview !== null ||
    postingExtra !== null ||
    pool !== null ||
    missingDetail !== null ||
    detailError !== null ||
    create !== null
  // CK-23b: which record owns the drawer title. Computed once here so the
  // pure drawerTitleKind branch (unit-tested) decides, while the translated
  // keys below stay literal for i18n extraction.
  const titleKind = drawerTitleKind({
    hasOffer: offer !== null,
    hasCandidate: candidate !== null,
  })
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
    description: tab==='applications'?tw('applicationsDescription'):t(`recruiting.workspace.${tab}`),
    tabs,
    canManage,
    showCreate: canManage && (tab === 'applications'||tab === 'openings' || tab === 'pools'),
    setupHref:
      can(authz, 'admin.setup.manage') && setupSections[0]
        ? `/admin/setup/${setupSections[0]}`
        : null,
    setupLabel: t('recruiting.workspace.configure'),
    poolCreate:
      canManage && tab === 'pools' && poolParam === 'new'
        ? {
            title: t('recruiting.workspace.newPool'),
            closeHref: hrefForDepth('pools', {}),
            nameLabel: t('recruiting.depth.columns.name'),
            descriptionLabel: t('recruiting.workspace.poolDescription'),
            submitLabel: t('recruiting.workspace.newPool'),
            failed: t('performance.actionFailed'),
          }
        : null,
    addLabel: t(
      tab === 'pools' ? 'recruiting.workspace.newPool' : 'recruiting.add',
    ),
    addHref:
      tab === 'pools'
        ? hrefForDepth('pools', { pool: 'new' })
        : recruitingHref(preservedParams, { status, requisition: 'new' }),
    basePath: '/hrm/recruiting',
    tab,
    statusLabel: tc('labels.status'),
    depthRows,
    depthColumns,
    depthEmpty: t('recruiting.depth.empty'),
    setupSections,
    segmentsLabel: t('recruiting.segmentsLabel'),
    allLabel: t('recruiting.statusAll'),
    segmentOptions: STATUSES.map((value) => ({
      value,
      label: statusLabel(value),
      count: counts.get(value) ?? 0,
    })),
    // Retain the workspace and filter when a work record opens or closes.
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
    applicationRows,applicationFilters,applicationSelection,applicationColumns:Object.fromEntries(['candidate','opening','stage','status','source','appliedOn','owner'].map(key=>[key,tw(key==='appliedOn'?'applied':key)])),
    rows,
    empty: tab==='applications'?tw('noApplications'):t('recruiting.empty'),
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
          title:
            titleKind === 'offer' && offer
              ? t('recruiting.drawer.offerTitle', {
                  employer: offer.employerName,
                })
              : titleKind === 'candidate' && candidate
                ? t('recruiting.drawer.candidateTitle', {
                    name: candidate.displayName,
                  })
                : t('recruiting.drawer.title', {
                    number: requisition?.requisitionNumber ?? '',
                  }),
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
          detailError,
          ...(create ? { create } : {}),
        }
      : null,
  }
}
