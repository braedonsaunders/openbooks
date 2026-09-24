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
  ref,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  getCycleDetail,
  getRetentionOverview,
  getReviewDetail,
  listCycleProgress,
  listGoals,
  listMyReviews,
} from '@openbooks/engine/src/hrm/performance/performance-read.ts'
import { isUuid } from '@/lib/list-params'
import { listReviewTemplates } from '@openbooks/engine/src/hrm/performance/review-cycles.ts'
import { listExitRecords } from '@openbooks/engine/src/hrm/performance/exits.ts'
import { loadAiDraftButton, loadAiDraftDrawer, type AiDraftDrawerData } from '../../../../lib/hrm/ai-rails'
import { hrmGroupTabs } from '../../../../components/module-home/group-tabs'
import { can, getAuthz } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { continuousBlocks, continuousTabChips, loadContinuousTab, type ContinuousData } from './continuous-view'
import { performanceHref } from '../../../../lib/hrm/workspace-href'

/**
 * Performance tab: review cycles as loader-resolved rows, the cycle drawer
 * with its reviews table and calibration island, the review drawer with
 * the snapshot answer form and the goals section, the self-service "My
 * reviews" segment, and the Retention panel for HR.
 *
 * Follows the positions list archetype: ViewSpec composes the header and
 * the grid; status segments filter server-side through the shared
 * `list-toolbar`; rows stay loader-resolved (the performance read
 * service narrows every row to the actor's privacy scope, so an ungranted
 * manager still gets the tab with only their reviews); drawers open from
 * URL search params through small client islands. Renders when the hrm
 * feature gate is on for any authenticated viewer — the service (never the
 * page) decides which rows each viewer sees.
 */

const STATUSES = ['draft', 'open', 'calibrating', 'closed'] as const

export interface PerformanceCycleRow {
  id: string
  name: string
  period: string
  template: string
  selfProgress: string
  managerProgress: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  href: string
}

export interface PerformanceSegmentOption {
  value: string
  label: string
  count: number
}

export interface PerformanceReviewRow {
  id: string
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  rating: string | null
  href: string
}

export interface PerformanceAnswer {
  id: string
  sectionTitle: string
  questionPrompt: string | null
  answerKind: string
  rating: string | null
  text: string | null
  required: boolean
}

export interface PerformanceGoalRow {
  id: string
  title: string
  status: string
  progress: number
}

export interface PerformancePageData {
  title: string
  description: string
  tabs: { href: string; label: string; active?: boolean }[]
  canManage: boolean
  canRetain: boolean
  addLabel: string
  addHref: string
  basePath: string
  segmentsLabel: string
  allLabel: string
  segmentOptions: PerformanceSegmentOption[]
  currentParams: Record<string, string | string[] | undefined>
  columns: {
    name: string
    period: string
    template: string
    self: string
    manager: string
    status: string
  }
  rows: PerformanceCycleRow[]
  empty: string
  detail: {
    cycleId: string
    cycleName: string
    cycleStatus: string
    templateName: string
    period: string
    reviews: PerformanceReviewRow[]
    reviewsTitle: string
    reviewsEmpty: string
    cols: { kind: string; status: string; rating: string }
    calibration: {
      canMove: boolean
      canForce: boolean
      canClose: boolean
      moveLabel: string
      forceLabel: string
      forceReasonLabel: string
      forceReasonPlaceholder: string
      closeLabel: string
      gapNote: string | null
      failed: string
    }
    closeHref: string
  } | null
  missingDetail: string | null
  review: {
    id: string
    kindLabel: string
    statusLabel: string
    overallLabel: string
    overallRating: string | null
    calibratedLabel: string
    calibratedRating: string | null
    calibrationReason: string | null
    answers: PerformanceAnswer[]
    goals: PerformanceGoalRow[]
    goalsTitle: string
    goalsEmpty: string
    canAnswer: boolean
    canShare: boolean
    canAcknowledge: boolean
    canCalibrate: boolean
    canReopen: boolean
    submitLabel: string
    shareLabel: string
    acknowledgeLabel: string
    calibrateLabel: string
    calibrateRatingLabel: string
    reasonLabel: string
    reopenLabel: string
    answerRatingLabel: string
    answerTextLabel: string
    requiredLabel: string
    failed: string
    cycleId: string
    closeHref: string
    draft: { href: string; label: string } | null
  } | null
  missingReview: string | null
  retention: {
    title: string
    turnoverLabel: string
    turnoverValue: string
    regrettableLabel: string
    regrettableValue: string
    gapsTitle: string
    gapsEmpty: string
    gaps: {
      employmentHref: string
      employmentLabel: string
      terminatedFrom: string
    }[]
    noInterviewTitle: string
    noInterviewCount: number
  } | null
  exit: {
    employmentId: string
    voluntaryLabel: string
    involuntaryLabel: string
    existing: {
      id: string
      reasonKind: string
      isVoluntary: boolean
      destination: string | null
      notes: string | null
      revision: number
    } | null
    canRecord: boolean
    title: string
    closeHref: string
  } | null
  missingExit: string | null
  create: {
    /** The drawer's accessible name — a dialog must never render untitled. */
    title: string
    closeHref: string
    templates: { value: string; label: string }[]
    templateLabel: string
    nameLabel: string
    startLabel: string
    endLabel: string
    submitLabel: string
    cancelLabel: string
    setupHint: string
    setupHref: string
    failed: string
  } | null
  drawerOpen: boolean
  reviewOpen: boolean
  exitOpen: boolean
  // HR-17: route sub-tabs Cycles / Calibration / Talent / Retention /
  // Settings, on the shared subtab strip. The cycles table renders only on
  // the Cycles tab; every other tab renders its own surface and nothing
  // else.
  cyclesTab: boolean
  continuous: ContinuousData
  draftDrawer: AiDraftDrawerData | null
  draftDrawerOpen: boolean
}

const f = ref<PerformancePageData>()
const item = field

export function performanceSpec(data: PerformancePageData): PageSpec {
  return page({
    route: '/hrm/performance',
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
      // Same bounded, gapped body as Benefits. Cycles, continuous views and
      // Retention are sibling surfaces and must share the same bottom
      // breathing room instead of each relying on incidental block margins.
      grid('flex h-full min-h-0 flex-col gap-4', [
        // The view strip and the cycles filter share one row — the shape every
        // list page in the module now uses.
        grid('flex shrink-0 flex-wrap items-center gap-3', [
          continuousTabChips(data.continuous),
          {
            ...widgetBlock('list-toolbar', {
              basePath: '/hrm/performance',
              currentParams: data.currentParams,
              filters: [
                {
                  paramKey: 'status',
                  label: data.segmentsLabel,
                  allLabel: data.allLabel,
                  options: data.segmentOptions,
                },
              ],
            }),
            when: f('cyclesTab'),
          },
        ]),
        {
          ...table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            empty: { title: f('empty') },
            columns: [
              column(data.columns.name, link(item('name'), item('href'))),
              column(data.columns.period, text(item('period'))),
              column(data.columns.template, text(item('template'))),
              column(data.columns.self, text(item('selfProgress')), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(data.columns.manager, text(item('managerProgress')), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(data.columns.status, badge(item('statusLabel'), { variant: item('statusVariant') })),
            ],
          }),
          when: f('cyclesTab'),
        },
        ...continuousBlocks(data.continuous),
        // Retention through the house blocks: three stat tiles and a table,
        // the same vocabulary every other HRM surface uses. It was a bespoke
        // <section> of bold headings and comma-joined sentences rendered with
        // no card around it.
        ...(data.retention
          ? [
              grid('grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-3', [
                statTile({
                  iconKey: 'trending-down',
                  accent: 'amber',
                  label: data.retention.turnoverLabel,
                  value: data.retention.turnoverValue,
                  tone: 'default',
                }),
                statTile({
                  iconKey: 'user-minus',
                  accent: 'slate',
                  label: data.retention.regrettableLabel,
                  value: data.retention.regrettableValue,
                  tone: 'default',
                }),
                statTile({
                  iconKey: 'clipboard-list',
                  accent: 'slate',
                  label: data.retention.noInterviewTitle,
                  value: String(data.retention.noInterviewCount),
                  tone: 'default',
                }),
              ]),
              table({
                variant: 'app',
                rows: f('retention.gaps'),
                rowKey: item('employmentLabel'),
                empty: {
                  title: data.retention.gapsTitle,
                  description: data.retention.gapsEmpty,
                },
                columns: [
                  column(data.retention.gapsTitle, link(item('employmentLabel'), item('employmentHref'))),
                  column(data.columns.period, text(item('terminatedFrom')), {
                    className: 'tabular-nums',
                  }),
                ],
              }),
            ]
          : []),
      ]),
      {
        ...widgetBlock('hrm-cycle-drawer', {
          detail: data.detail,
          missingDetail: data.missingDetail,
        }),
        when: f('drawerOpen'),
      },
      {
        ...widgetBlock('hrm-review-drawer', {
          review: data.review,
          missingReview: data.missingReview,
        }),
        when: f('reviewOpen'),
      },
      // HR-21: the shared evidence-draft drawer (?draft=<kind>:<id>).
      {
        ...widgetBlock('hrm-ai-draft-drawer', { draft: data.draftDrawer }),
        when: f('draftDrawerOpen'),
      },
      {
        ...widgetBlock('hrm-cycle-dialog', { create: data.create }),
        when: f('create'),
      },
      {
        ...widgetBlock('hrm-exit-drawer', {
          exit: data.exit,
          missingExit: data.missingExit,
        }),
        when: f('exitOpen'),
      },
    ],
  })
}

export async function performanceTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('performance.title')
}

export async function loadPerformancePage(sp: Record<string, string | undefined>): Promise<PerformancePageData> {
  // Structural scope: any authenticated viewer gets the tab (the read
  // service narrows every row to their privacy scope); the hrm and
  // hrmPerformance switches gate the page itself (HR-7's gating moved
  // under hrmPerformance additively). HRM management and retention stay
  // grants.
  const authz = await getAuthz()
  if (!authz) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz, '/hrm/performance')

  // The `mine` pseudo-status is the self-service segment: cycles the actor
  // participates in (subject or reviewer). Non-HR viewers see their slice
  // under every segment; the segment makes it explicit.
  const rawStatus = typeof sp.status === 'string' ? sp.status : null
  const status = rawStatus !== null && (STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : null
  const mine = rawStatus === 'mine'
  const canManage = can(authz, 'hrm.performance.manage')
  const canRetain = can(authz, 'hrm.retention.read')

  // HR-17: the continuous tabs resolve first. Retention is one of them now,
  // so the cycles list, the calibration grid, the talent grid, the feedback
  // settings and the retention figures each get the page to themselves.
  // Loaded here (not beside the retention panel) so every drawer href below
  // preserves the continuous tab through the shared helper (F3-57).
  const continuous = await loadContinuousTab(authz, sp, canManage, canRetain)
  const cyclesTab = continuous.tab === 'cycles'
  // F3-57: drawer hrefs preserve the segment and the continuous tab — a
  // drawer opened from Retention closes back onto Retention, not Cycles.
  const preservedParams = {
    ...(rawStatus ? { status: rawStatus } : {}),
    ...(cyclesTab ? {} : { tab: continuous.tab }),
  }

  const cycles = await listCycleProgress({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
  })
  let mineCycleIds: Set<string> | null = null
  if (mine) {
    const mineReviews = await listMyReviews({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    mineCycleIds = new Set([...mineReviews.asSubject, ...mineReviews.asReviewer].map((r) => r.cycleId))
  }
  const visible = cycles.filter((c) => (status === null || c.status === status) && (mineCycleIds === null || mineCycleIds.has(c.id)))
  const statusLabel = (value: string): string =>
    value === 'draft'
      ? t('performance.statusDraft')
      : value === 'open'
        ? t('performance.statusOpen')
        : value === 'calibrating'
          ? t('performance.statusCalibrating')
          : t('performance.statusClosed')
  const statusVariant = (value: string): PerformanceCycleRow['statusVariant'] =>
    value === 'open' ? 'success' : value === 'calibrating' ? 'warning' : value === 'draft' ? 'secondary' : 'default'
  const rows: PerformanceCycleRow[] = visible.map((c) => ({
    id: c.id,
    name: c.name,
    period: `${c.periodStartOn} → ${c.periodEndOn}`,
    template: c.templateName,
    selfProgress: `${c.submittedSelf}/${c.totalSelf}`,
    managerProgress: `${c.submittedManager}/${c.totalManager}`,
    status: c.status,
    statusLabel: statusLabel(c.status),
    statusVariant: statusVariant(c.status),
    href: performanceHref(preservedParams, { status: rawStatus, cycle: c.id }),
  }))

  const counts = new Map<string, number>()
  for (const c of cycles) counts.set(c.status, (counts.get(c.status) ?? 0) + 1)
  const segmentOptions: PerformanceSegmentOption[] = [
    ...STATUSES.map((s) => ({
      value: s,
      label: statusLabel(s),
      count: counts.get(s) ?? 0,
    })),
    {
      value: 'mine',
      label: t('performance.mineSegment'),
      count: mineCycleIds?.size ?? 0,
    },
  ]

  const cycleId = typeof sp.cycle === 'string' && sp.cycle.length > 0 && sp.cycle !== 'new' ? sp.cycle : null
  const creating = sp.cycle === 'new' && canManage
  const reviewId = typeof sp.review === 'string' && sp.review.length > 0 ? sp.review : null

  let detail: PerformancePageData['detail'] = null
  let missingDetail: string | null = null
  if (cycleId) {
    try {
      const full = await getCycleDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        cycleId,
      })
      detail = {
        cycleId: full.id,
        cycleName: full.name,
        cycleStatus: full.status,
        templateName: full.templateName,
        period: `${full.periodStartOn} → ${full.periodEndOn}`,
        reviews: full.reviews.map((r) => ({
          id: r.id,
          kind: r.kind,
          kindLabel:
            r.kind === 'self' ? t('performance.kindSelf') : r.kind === 'manager' ? t('performance.kindManager') : t('performance.kindPeer'),
          status: r.status,
          statusLabel: reviewStatusLabel(t, r.status),
          rating: r.calibratedRating ?? r.overallRating,
          href: performanceHref(preservedParams, { status: rawStatus, cycle: cycleId, review: r.id }),
        })),
        reviewsTitle: t('performance.reviewsTitle'),
        reviewsEmpty: t('performance.reviewsEmpty'),
        cols: {
          kind: t('performance.colKind'),
          status: t('performance.colStatus'),
          rating: t('performance.colRating'),
        },
        calibration: {
          canMove: canManage && full.status === 'open',
          canForce: canManage && full.status === 'open',
          canClose: canManage && (full.status === 'open' || full.status === 'calibrating'),
          moveLabel: t('performance.moveToCalibrating'),
          forceLabel: t('performance.forceCalibrating'),
          forceReasonLabel: t('performance.forceReason'),
          forceReasonPlaceholder: t('performance.forceReasonPlaceholder'),
          closeLabel: t('performance.closeCycle'),
          gapNote: full.managerGapCount > 0 ? t('performance.gapNote', { count: full.managerGapCount }) : null,
          failed: t('performance.actionFailed'),
        },
        closeHref: performanceHref(preservedParams, { status: rawStatus }),
      }
    } catch {
      missingDetail = t('performance.cycleNotFound')
    }
  }

  let review: PerformancePageData['review'] = null
  let missingReview: string | null = null
  let draftDrawer: AiDraftDrawerData | null = null
  if (reviewId) {
    try {
      const full = await getReviewDetail({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        reviewId,
      })
      const goals = await listGoals({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: full.review.employmentId,
      })
      review = {
        id: full.review.id,
        kindLabel:
          full.review.kind === 'self'
            ? t('performance.kindSelf')
            : full.review.kind === 'manager'
              ? t('performance.kindManager')
              : t('performance.kindPeer'),
        statusLabel: reviewStatusLabel(t, full.review.status),
        overallLabel: t('performance.overallRating'),
        overallRating: full.review.overallRating,
        calibratedLabel: t('performance.calibratedRating'),
        calibratedRating: full.review.calibratedRating,
        calibrationReason: full.review.calibrationReason,
        answers: full.answers.map((a) => ({
          id: a.id,
          sectionTitle: a.sectionTitle,
          questionPrompt: a.questionPrompt,
          answerKind: a.answerKind,
          rating: a.rating,
          text: a.text,
          required: a.required,
        })),
        goals: goals.map((g) => ({
          id: g.id,
          title: g.title,
          status: g.status,
          progress: g.progressPercent,
        })),
        goalsTitle: t('performance.goalsTitle'),
        goalsEmpty: t('performance.goalsEmpty'),
        canAnswer: full.review.status === 'pending',
        canShare: full.review.kind !== 'self' && (full.review.status === 'submitted' || full.review.status === 'calibrated'),
        canAcknowledge: full.review.status === 'shared',
        canCalibrate: canManage && (full.review.status === 'submitted' || full.review.status === 'calibrated'),
        canReopen: canManage && (full.review.status === 'submitted' || full.review.status === 'calibrated'),
        submitLabel: t('performance.submitReview'),
        shareLabel: t('performance.shareReview'),
        acknowledgeLabel: t('performance.acknowledgeReview'),
        calibrateLabel: t('performance.calibrateReview'),
        calibrateRatingLabel: t('performance.calibrateRating'),
        reasonLabel: t('performance.reason'),
        reopenLabel: t('performance.reopenReview'),
        answerRatingLabel: t('performance.answerRating'),
        answerTextLabel: t('performance.answerText'),
        requiredLabel: t('performance.answerRequired'),
        failed: t('performance.actionFailed'),
        cycleId: full.review.cycleId,
        closeHref: performanceHref(preservedParams, { status: rawStatus, cycle: cycleId }),
        draft: null,
      }
      // HR-21: "Draft from evidence" on the answer form. Manager and self
      // reviews draft from cycle goals and prior calibrated ratings; peer
      // reviews have no draft kind. Insert targets the first text field.
      const draftKind =
        full.review.status === 'pending'
          ? full.review.kind === 'manager'
            ? 'review_manager'
            : full.review.kind === 'self'
              ? 'review_self'
              : null
          : null
      const firstText = full.answers.find((a) => a.answerKind === 'text' || a.answerKind === 'rating_and_text')
      const draftLabel = draftKind && firstText ? await loadAiDraftButton(authz.user.orgId) : null
      const reviewHref = performanceHref(preservedParams, { status: rawStatus, cycle: full.review.cycleId, review: full.review.id })
      if (review && draftKind && firstText && draftLabel) {
        review.draft = {
          href: `${reviewHref}&draft=${draftKind}:${full.review.id}`,
          label: draftLabel,
        }
      }
      draftDrawer = await loadAiDraftDrawer({
        draftParam: typeof sp.draft === 'string' ? sp.draft : null,
        closeHref: reviewHref,
        fieldId: firstText ? `text-${firstText.id}` : '',
      })
    } catch {
      missingReview = t('performance.reviewNotFound')
    }
  }

  let create: PerformancePageData['create'] = null
  if (creating) {
    const templates = await listReviewTemplates({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    create = {
      title: t('performance.newCycle'),
      closeHref: performanceHref(preservedParams, { status: rawStatus }),
      templates: templates.filter((tpl) => tpl.isActive).map((tpl) => ({ value: tpl.id, label: tpl.name })),
      templateLabel: t('performance.templateLabel'),
      nameLabel: t('performance.newCycleName'),
      startLabel: t('performance.periodStart'),
      endLabel: t('performance.periodEnd'),
      submitLabel: t('performance.createCycle'),
      cancelLabel: t('performance.cancel'),
      setupHint: t('performance.templateSetupHint'),
      setupHref: '/admin/setup/hrm-review-templates',
      failed: t('performance.actionFailed'),
    }
  }

  // The exit drawer (?exit=<employmentId>): HR-only, opened from the
  // Retention gaps and the employee drawer. Readers see the record,
  // performance managers record and correct it.
  const exitEmploymentId = typeof sp.exit === 'string' && sp.exit.length > 0 ? sp.exit : null
  let exit: PerformancePageData['exit'] = null
  let missingExit: string | null = null
  if (exitEmploymentId) {
    if (isUuid(exitEmploymentId) && (canRetain || canManage)) {
      try {
        const exits = await listExitRecords({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          employmentId: exitEmploymentId,
        })
        const first = exits[0] ?? null
        exit = {
          employmentId: exitEmploymentId,
          voluntaryLabel: t('performance.exitVoluntaryYes'),
          involuntaryLabel: t('performance.exitVoluntaryNo'),
          existing: first
            ? {
                id: first.id,
                reasonKind: first.reasonKind,
                isVoluntary: first.isVoluntary,
                destination: first.destination,
                notes: first.notes,
                revision: first.revision,
              }
            : null,
          canRecord: canManage,
          title: t('performance.exitTitle'),
          closeHref: performanceHref(preservedParams, { status: rawStatus, cycle: cycleId, review: reviewId }),
        }
      } catch {
        missingExit = t('performance.exitNotFound')
      }
    } else {
      missingExit = t('performance.exitNotFound')
    }
  }

  let retention: PerformancePageData['retention'] = null
  if (canRetain && continuous.tab === 'retention') {
    const overview = await getRetentionOverview({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
    })
    const trailing = overview.trailingTwelveMonths
    retention = {
      title: t('retention.title'),
      turnoverLabel: t('retention.turnoverTwelveMonths'),
      turnoverValue:
        trailing?.turnoverRate === null || trailing?.turnoverRate === undefined ? '—' : `${(trailing.turnoverRate * 100).toFixed(1)}%`,
      regrettableLabel: t('retention.regrettableLeavers'),
      regrettableValue: String(overview.regrettableLeavers),
      gapsTitle: t('retention.missingExits'),
      gapsEmpty: t('retention.noMissingExits'),
      gaps: overview.missingExitRecords.map((g) => ({
        employmentHref: performanceHref(preservedParams, { status: rawStatus, exit: g.employmentId }),
        employmentLabel: g.workerPartyId.slice(0, 8),
        terminatedFrom: g.terminatedFrom,
      })),
      noInterviewTitle: t('retention.noInterviewTitle'),
      noInterviewCount: overview.exitRecordsWithoutInterview.length,
    }
  }

  return {
    title: t('performance.title'),
    description: t('performance.description'),
    tabs,
    canManage,
    canRetain,
    addLabel: t('performance.newCycle'),
    addHref: performanceHref(preservedParams, { status: rawStatus, cycle: 'new' }),
    basePath: '/hrm/performance',
    segmentsLabel: t('performance.segmentsLabel'),
    allLabel: t('performance.allCycles'),
    segmentOptions,
    currentParams: preservedParams,
    columns: {
      name: t('performance.colName'),
      period: t('performance.colPeriod'),
      template: t('performance.colTemplate'),
      self: t('performance.colSelf'),
      manager: t('performance.colManager'),
      status: t('performance.colStatus'),
    },
    rows,
    empty: t('performance.empty'),
    detail,
    missingDetail,
    review,
    missingReview,
    retention,
    create,
    exit,
    missingExit,
    drawerOpen: detail !== null || missingDetail !== null || creating,
    reviewOpen: review !== null || missingReview !== null,
    exitOpen: exit !== null || missingExit !== null,
    cyclesTab,
    continuous,
    draftDrawer,
    draftDrawerOpen: draftDrawer !== null,
  }
}

function reviewStatusLabel(t: (key: string) => string, status: string): string {
  return status === 'pending'
    ? t('performance.reviewPending')
    : status === 'submitted'
      ? t('performance.reviewSubmitted')
      : status === 'calibrated'
        ? t('performance.reviewCalibrated')
        : status === 'shared'
          ? t('performance.reviewShared')
          : t('performance.reviewAcknowledged')
}


