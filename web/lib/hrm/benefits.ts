import 'server-only'

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
import { loadQueueLabels } from './change-requests'
import { listScopedDepartmentOptions } from '../scoped-options'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import {
  parsePortfolioView,
  type AwardTableText,
  type BuilderOption,
  type ProgramEditSeed,
  type ProgramTableText,
  type OverviewCard,
  type PortfolioView,
  type ProgramFamily,
  type VitalsLabels,
} from './benefits-portfolio'
import {
  loadBenefitsPortfolio,
  type AttentionItem,
  type AwardDetailDrawer,
  type PortfolioAwardRow,
  type PortfolioData,
  type PortfolioProgramRow,
  type PortfolioVitals,
  type ProgramDetailDrawer,
} from './benefits-workspace'

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
  actionFailed: string
  portfolioView: PortfolioView
  overview: {
    vitals: PortfolioVitals
    vitalsLabels: VitalsLabels
    cards: OverviewCard[]
    attention: AttentionItem[]
    attentionTitle: string
    attentionEmpty: string
    reportLinks: { key: string; href: string; label: string }[]
    reportsTitle: string
    reportsEmpty: string
  }
  programColumns: { program: string; family: string; value: string; effective: string; status: string }
  programTableText: ProgramTableText
  awardTableText: AwardTableText
  programRows: PortfolioProgramRow[]
  incentiveProgramRows: PortfolioProgramRow[]
  programsTitle: string
  programsEmptyTitle: string
  programsEmptyDescription: string
  programsRefusal: { title: string; message: string } | null
  awardColumns: { program: string; recipient: string; period: string; value: string; status: string }
  awardRows: PortfolioAwardRow[]
  rewardAwardRows: PortfolioAwardRow[]
  incentiveAwardRows: PortfolioAwardRow[]
  rewardsTitle: string
  incentivesTitle: string
  payoutsTitle: string
  awardsEmptyTitle: string
  awardsEmptyDescription: string
  awardsRefusal: { title: string; message: string } | null
  newProgramButton: string
  newProgramHref: string
  newAwardButton: string
  newAwardHref: string
  programBuilderOpen: boolean
  programBuilderFamily: ProgramFamily
  programBuilderLocked: boolean
  awardBuilderOpen: boolean
  defaultAwardCurrency: string
  accountOptions: BuilderOption[]
  payComponentOptions: BuilderOption[]
  employmentOptions: BuilderOption[]
  employmentsTruncated: boolean
  programDrawer: ProgramDetailDrawer | null
  programCloseHref: string
  awardDrawer: AwardDetailDrawer | null
  awardCloseHref: string
  canQueue: boolean
  awardProgramOptions: { value: string; label: string; currency: string; fixedAmount: string | null }[]
  vitalsRefusal: { title: string; message: string } | null
  awardsTotal: number
  awardsTruncated: boolean
  truncationNotice: string
  tiles: { activePrograms: string; openWindows: string; pendingApprovals: string; queuedPayouts: string }
  deliveredRows: { currency: string; amount: string; display: string }[]
  awaitingRows: { currency: string; amount: string; display: string }[]
  moneyColumns: { currency: string; amount: string }
  deliveredTitle: string
  deliveredEmpty: string
  awaitingTitle: string
  awaitingEmpty: string
  reportsRefusal: { title: string; message: string } | null
  optionsRefusal: { title: string; message: string } | null
  scopeDepartments: BuilderOption[]
  scopeProjects: BuilderOption[]
  programEditOpen: boolean
  programEditSeed: ProgramEditSeed | null
  planSection: {
    orgId: string
    actorId: string
    canManage: boolean
    allowedSubsidiaryIds: string[] | null
  } | null
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
 * tabs on the Rewards view strip.
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
  const portfolioView = parsePortfolioView(showingEnrolments ? 'enrolments' : sp.view)
  const tabs = await hrmGroupTabs(authz, basePath)
  const keepView: Record<string, string> = showingEnrolments
    ? { view: 'enrolments' }
    : portfolioView !== 'overview'
      ? { view: portfolioView }
      : {}
  const currentParams: BenefitsData['currentParams'] = { ...keepView }
  if (sp.segment) currentParams.segment = sp.segment

  if (segment === null) {
    return {
      title: t('benefits.title'),
      description: t('portfolio.description'),
      listTitle: '',
      tabs,
      refusal: { title: t('benefits.unknownSegmentTitle'), message: t('benefits.unknownSegment', { segment: rawSegment }) },
      hasContent: false,
      segmentsLabel: t('benefits.segmentsLabel'),
      allLabel: t('benefits.allLabel'),
      segments: [],
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
      actionFailed: t('benefits.actionFailed'),
      ...emptyPortfolioFields(t, canManage, basePath),
    }
  }

  // Segment badges count every window: the selected segment filters only the
  // visible rows below, so Draft and Closed never read 0 beside a filtered list.
  const windows = await listEnrollmentWindows(db, orgId, actorId)
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

  const visibleWindows = segment === 'all' ? windows : windows.filter((w) => w.status === segment)
  // No silent prefix cap: the window drawer resolves any window by id and
  // joins its enrolments from the complete arrays, so the table presents the
  // same complete population — a sliced table beside complete counts showed
  // a nonzero status with "No enrolments".
  const windowRows: BenefitsWindowRow[] = visibleWindows.map((w) => ({
    ...w,
    kindLabel: windowKindLabel(t, w.kind),
    statusLabel: statusLabel(t, w.status),
    statusVariant: statusVariant(w.status),
    rangeLabel: `${w.opensOn} – ${w.closesOn}`,
    windowHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, { window: w.id }),
    openLabel: t('benefits.openWindow'),
  }))

  const enrollmentRows: BenefitsEnrollmentRow[] = enrolments.map((e) => {
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
      select id::text as id, name from subsidiaries
       where org_id = ${orgId}::uuid and is_active
         ${subsidiaryVisibleFilter(sql`id`, authz.allowedSubsidiaryIds)}
       order by name
    `)
  ).rows
  const departments = await listScopedDepartmentOptions(orgId, authz.allowedSubsidiaryIds)
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

  const openCount = windows.filter((w) => w.status === 'open').length
  const pendingEnrollmentCount = enrolments.filter((e) => e.status === 'pending_approval').length
  const portfolio = await loadBenefitsPortfolio(authz, sp, { openCount, pendingEnrollments: pendingEnrollmentCount }, t)
  const portfolioFields = toPortfolioFields(t, authz, canManage, basePath, sp, portfolio, segment === 'all' ? undefined : segment)

  const listTitle =
    showingEnrolments || portfolioView === 'enrolments'
      ? t('benefits.enrolmentsTitle')
      : portfolioView === 'programs'
        ? t('portfolio.programsTitle')
        : portfolioView === 'rewards'
          ? t('portfolio.rewardsTitle')
          : portfolioView === 'incentives'
            ? t('portfolio.incentivesTitle')
            : portfolioView === 'payouts'
              ? t('portfolio.payoutsTitle')
              : portfolioView === 'overview'
                ? t('portfolio.overviewTitle')
                : t('benefits.windowsTitle')

  return {
    title: t('benefits.title'),
    description: t('portfolio.description'),
    listTitle,
    tabs,
    refusal: null,
    hasContent: true,
    segmentsLabel: t('benefits.segmentsLabel'),
    allLabel: t('benefits.allLabel'),
    segments,
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
    newWindowHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, { ...keepView, window: 'new' }),
    dialogOpen,
    dialogCloseHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, keepView),
    subsidiaryOptions,
    departmentOptions,
    drawer,
    drawerCloseHref: benefitsHref(basePath, segment === 'all' ? undefined : segment, {}),
    approveLabel: t('benefits.approve'),
    actionFailed: t('benefits.actionFailed'),
    ...portfolioFields,
  }
}

/**
 * Portfolio fields for the refusal path: the unknown-segment page renders
 * the refusal instead of content, but the contract still carries a
 * well-shaped empty portfolio.
 */
function emptyPortfolioFields(
  t: BenefitsCatalog,
  canManage: boolean,
  basePath: string,
): Pick<
  BenefitsData,
  | 'portfolioView'
  | 'overview'
  | 'programColumns'
  | 'programTableText'
  | 'awardTableText'
  | 'programRows'
  | 'incentiveProgramRows'
  | 'programsTitle'
  | 'programsEmptyTitle'
  | 'programsEmptyDescription'
  | 'programsRefusal'
  | 'awardColumns'
  | 'awardRows'
  | 'rewardAwardRows'
  | 'incentiveAwardRows'
  | 'rewardsTitle'
  | 'incentivesTitle'
  | 'payoutsTitle'
  | 'awardsEmptyTitle'
  | 'awardsEmptyDescription'
  | 'awardsRefusal'
  | 'newProgramButton'
  | 'newProgramHref'
  | 'newAwardButton'
  | 'newAwardHref'
  | 'programBuilderOpen'
  | 'programBuilderFamily'
  | 'programBuilderLocked'
  | 'awardBuilderOpen'
  | 'defaultAwardCurrency'
  | 'accountOptions'
  | 'payComponentOptions'
  | 'employmentOptions'
  | 'employmentsTruncated'
  | 'programDrawer'
  | 'programCloseHref'
  | 'awardDrawer'
  | 'awardCloseHref'
  | 'canQueue'
  | 'awardProgramOptions'
  | 'vitalsRefusal'
  | 'awardsTotal'
  | 'awardsTruncated'
  | 'truncationNotice'
  | 'tiles'
  | 'deliveredRows'
  | 'awaitingRows'
  | 'moneyColumns'
  | 'deliveredTitle'
  | 'deliveredEmpty'
  | 'awaitingTitle'
  | 'awaitingEmpty'
  | 'reportsRefusal'
  | 'optionsRefusal'
  | 'scopeDepartments'
  | 'scopeProjects'
  | 'programEditOpen'
  | 'programEditSeed'
  | 'planSection'
> {
  return {
    portfolioView: 'overview',
    overview: {
      vitals: {
        activePrograms: 0,
        draftPrograms: 0,
        openWindows: 0,
        pendingEnrollments: 0,
        pendingAwards: 0,
        queuedAwards: 0,
        deliveredByCurrency: [],
        awaitingByCurrency: [],
      },
      vitalsLabels: vitalsLabels(t),
      cards: [],
      attention: [],
      attentionTitle: t('portfolio.attentionTitle'),
      attentionEmpty: t('portfolio.attentionEmpty'),
      reportLinks: [],
      reportsTitle: t('portfolio.reportsTitle'),
      reportsEmpty: t('portfolio.reportsEmpty'),
    },
    programColumns: programColumns(t),
    programTableText: programTableText(t),
    awardTableText: awardTableText(t),
    programRows: [],
    incentiveProgramRows: [],
    programsTitle: t('portfolio.programsTitle'),
    programsEmptyTitle: '',
    programsEmptyDescription: '',
    programsRefusal: null,
    awardColumns: awardColumns(t),
    awardRows: [],
    rewardAwardRows: [],
    incentiveAwardRows: [],
    rewardsTitle: t('portfolio.rewardsTitle'),
    incentivesTitle: t('portfolio.incentivesTitle'),
    payoutsTitle: t('portfolio.payoutsTitle'),
    awardsEmptyTitle: '',
    awardsEmptyDescription: '',
    awardsRefusal: null,
    newProgramButton: t('portfolio.newProgram'),
    newProgramHref: `${basePath}?program=new`,
    newAwardButton: t('portfolio.newAward'),
    newAwardHref: `${basePath}?award=new`,
    programBuilderOpen: false,
    programBuilderFamily: 'reward',
    programBuilderLocked: false,
    awardBuilderOpen: false,
    defaultAwardCurrency: '',
    accountOptions: [],
    payComponentOptions: [],
    employmentOptions: [],
    employmentsTruncated: false,
    programDrawer: null,
    programCloseHref: basePath,
    awardDrawer: null,
    awardCloseHref: basePath,
    canQueue: false,
    awardProgramOptions: [],
    vitalsRefusal: null,
    awardsTotal: 0,
    awardsTruncated: false,
    truncationNotice: t('portfolio.awardsTruncated'),
    tiles: { activePrograms: '0', openWindows: '0', pendingApprovals: '0', queuedPayouts: '0' },
    deliveredRows: [],
    awaitingRows: [],
    moneyColumns: { currency: t('portfolio.columns.currency'), amount: t('portfolio.columns.value') },
    deliveredTitle: t('portfolio.vitals.deliveredTitle'),
    deliveredEmpty: t('portfolio.vitals.deliveredEmpty'),
    awaitingTitle: t('portfolio.vitals.awaitingTitle'),
    awaitingEmpty: t('portfolio.vitals.awaitingEmpty'),
    reportsRefusal: null,
    optionsRefusal: null,
    scopeDepartments: [],
    scopeProjects: [],
    programEditOpen: false,
    programEditSeed: null,
    planSection: null,
  }
}

function vitalsLabels(t: BenefitsCatalog): VitalsLabels {
  return {
    activePrograms: t('portfolio.vitals.activePrograms'),
    openWindows: t('portfolio.vitals.openWindows'),
    pendingApprovals: t('portfolio.vitals.pendingApprovals'),
    queuedPayouts: t('portfolio.vitals.queuedPayouts'),
    deliveredTitle: t('portfolio.vitals.deliveredTitle'),
    awaitingTitle: t('portfolio.vitals.awaitingTitle'),
    deliveredEmpty: t('portfolio.vitals.deliveredEmpty'),
    awaitingEmpty: t('portfolio.vitals.awaitingEmpty'),
    reportsTitle: t('portfolio.reportsTitle'),
    reportsEmpty: t('portfolio.reportsEmpty'),
    attentionTitle: t('portfolio.attentionTitle'),
    attentionEmpty: t('portfolio.attentionEmpty'),
    cardsTitle: t('portfolio.cardsTitle'),
  }
}

function programColumns(t: BenefitsCatalog): BenefitsData['programColumns'] {
  return {
    program: t('portfolio.columns.program'),
    family: t('portfolio.columns.family'),
    value: t('portfolio.columns.value'),
    effective: t('portfolio.columns.effective'),
    status: t('portfolio.columns.status'),
  }
}

function programTableText(t: BenefitsCatalog): ProgramTableText {
  return {
    program: t('portfolio.columns.program'),
    family: t('portfolio.columns.family'),
    value: t('portfolio.columns.value'),
    effective: t('portfolio.columns.effective'),
    status: t('portfolio.columns.status'),
    emptyTitle: t('portfolio.programsEmptyTitle'),
    emptyDescription: t('portfolio.programsEmptyDescription'),
    totalLabel: t('portfolio.totalLabel'),
    truncatedLabel: t('portfolio.awardsTruncated'),
  }
}

function awardTableText(t: BenefitsCatalog): AwardTableText {
  return {
    program: t('portfolio.columns.program'),
    recipient: t('portfolio.columns.recipient'),
    period: t('portfolio.columns.period'),
    value: t('portfolio.columns.value'),
    status: t('portfolio.columns.status'),
    emptyTitle: t('portfolio.awardsEmptyTitle'),
    emptyDescription: t('portfolio.awardsEmptyDescription'),
    totalLabel: t('portfolio.totalLabel'),
    truncatedLabel: t('portfolio.awardsTruncated'),
  }
}

function awardColumns(t: BenefitsCatalog): BenefitsData['awardColumns'] {
  return {
    program: t('portfolio.columns.program'),
    recipient: t('portfolio.columns.recipient'),
    period: t('portfolio.columns.period'),
    value: t('portfolio.columns.value'),
    status: t('portfolio.columns.status'),
  }
}

/** Cards, titles, builder state, and view-filtered rows from one portfolio. */
function toPortfolioFields(
  t: BenefitsCatalog,
  authz: Authz,
  canManage: boolean,
  basePath: string,
  sp: Record<string, string | undefined>,
  portfolio: PortfolioData,
  segment: string | undefined,
): Omit<ReturnType<typeof emptyPortfolioFields>, 'portfolioView'> & { portfolioView: PortfolioView } {
  const portfolioView = parsePortfolioView(sp.view)
  const viewParam = (view: string): string => (view === 'overview' ? basePath : `${basePath}?view=${view}`)
  const familyCount = (family: string): number => portfolio.programs.filter((p) => p.family === family).length
  const countLabel = (count: number): string | null =>
    count > 0 ? t('portfolio.cards.count', { count }) : null
  const cards: OverviewCard[] = [
    {
      key: 'health',
      title: t('portfolio.cards.health.title'),
      description: t('portfolio.cards.health.description'),
      href: `${basePath}?view=programs&plan=new`,
      iconKey: 'heart-pulse',
      countLabel: null,
    },
    {
      key: 'retirement',
      title: t('portfolio.cards.retirement.title'),
      description: t('portfolio.cards.retirement.description'),
      href: `${basePath}?view=programs&plan=new`,
      iconKey: 'piggy-bank',
      countLabel: null,
    },
    {
      key: 'allowance',
      title: t('portfolio.cards.allowance.title'),
      description: t('portfolio.cards.allowance.description'),
      href: `${viewParam('programs')}${viewParam('programs') === basePath ? '?' : '&'}program=new&family=allowance`,
      iconKey: 'wallet',
      countLabel: countLabel(familyCount('allowance')),
    },
    {
      key: 'reward',
      title: t('portfolio.cards.reward.title'),
      description: t('portfolio.cards.reward.description'),
      href: `${viewParam('rewards')}&program=new&family=reward`,
      iconKey: 'gift',
      countLabel: countLabel(familyCount('reward')),
    },
    {
      key: 'incentive',
      title: t('portfolio.cards.incentive.title'),
      description: t('portfolio.cards.incentive.description'),
      href: `${viewParam('incentives')}&program=new&family=incentive`,
      iconKey: 'chart-line',
      countLabel: countLabel(familyCount('incentive')),
    },
    {
      key: 'custom',
      title: t('portfolio.cards.custom.title'),
      description: t('portfolio.cards.custom.description'),
      href: `${viewParam('programs')}${viewParam('programs') === basePath ? '?' : '&'}program=new&family=custom`,
      iconKey: 'shapes',
      countLabel: countLabel(familyCount('custom')),
    },
  ]
  const requestedFamily = sp.family === 'reward' || sp.family === 'allowance' || sp.family === 'incentive' || sp.family === 'custom'
    ? sp.family
    : null
  const currencies = new Map<string, number>()
  for (const program of portfolio.programs) currencies.set(program.currency, (currencies.get(program.currency) ?? 0) + 1)
  const defaultAwardCurrency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return {
    portfolioView,
    overview: {
      vitals: portfolio.vitals,
      vitalsLabels: vitalsLabels(t),
      cards,
      attention: portfolio.attention,
      attentionTitle: portfolio.attentionTitle,
      attentionEmpty: t('portfolio.attentionEmpty'),
      reportLinks: portfolio.reportLinks,
      reportsTitle: portfolio.reportsTitle,
      reportsEmpty: t('portfolio.reportsEmpty'),
    },
    programColumns: programColumns(t),
    programTableText: programTableText(t),
    awardTableText: awardTableText(t),
    programRows: portfolio.programs,
    incentiveProgramRows: portfolio.programs.filter((p) => p.family === 'incentive'),
    programsTitle: t('portfolio.programsTitle'),
    programsEmptyTitle: t('portfolio.programsEmptyTitle'),
    programsEmptyDescription: t('portfolio.programsEmptyDescription'),
    programsRefusal: portfolio.programsRefusal,
    awardColumns: awardColumns(t),
    awardRows: portfolio.awards,
    rewardAwardRows: portfolio.awards.filter((a) => a.programFamily === 'reward' || a.programFamily === 'allowance'),
    incentiveAwardRows: portfolio.awards.filter((a) => a.programFamily === 'incentive'),
    rewardsTitle: t('portfolio.rewardsTitle'),
    incentivesTitle: t('portfolio.incentivesTitle'),
    payoutsTitle: t('portfolio.payoutsTitle'),
    awardsEmptyTitle: t('portfolio.awardsEmptyTitle'),
    awardsEmptyDescription: t('portfolio.awardsEmptyDescription'),
    awardsRefusal: portfolio.awardsRefusal,
    newProgramButton: portfolio.newProgramButton,
    newProgramHref: portfolioHrefFor(basePath, segment, sp.view, { program: 'new' }),
    newAwardButton: t('portfolio.newAward'),
    newAwardHref: portfolioHrefFor(basePath, segment, sp.view, { award: 'new' }),
    programBuilderOpen: sp.program === 'new' && canManage && portfolio.optionsRefusal === null,
    programBuilderFamily: requestedFamily ?? 'reward',
    programBuilderLocked: requestedFamily !== null,
    awardBuilderOpen: sp.award === 'new' && canManage && portfolio.optionsRefusal === null,
    defaultAwardCurrency,
    accountOptions: portfolio.accountOptions,
    payComponentOptions: portfolio.payComponentOptions,
    employmentOptions: portfolio.employmentOptions,
    employmentsTruncated: portfolio.employmentsTruncated,
    programDrawer: portfolio.programDrawer,
    programCloseHref: portfolio.programCloseHref,
    awardDrawer: portfolio.awardDrawer,
    awardCloseHref: portfolio.awardCloseHref,
    canQueue: portfolio.canQueue,
    vitalsRefusal: portfolio.vitalsRefusal,
    awardsTotal: portfolio.awardsTotal,
    awardsTruncated: portfolio.awardsTruncated,
    truncationNotice: t('portfolio.awardsTruncated'),
    tiles: {
      activePrograms: portfolio.programsRefusal ? '—' : String(portfolio.vitals.activePrograms),
      openWindows: String(portfolio.vitals.openWindows),
      pendingApprovals: portfolio.awardsRefusal ? '—' : String(portfolio.vitals.pendingEnrollments + portfolio.vitals.pendingAwards),
      queuedPayouts: portfolio.awardsRefusal ? '—' : String(portfolio.vitals.queuedAwards),
    },
    deliveredRows: portfolio.vitals.deliveredByCurrency,
    awaitingRows: portfolio.vitals.awaitingByCurrency,
    moneyColumns: { currency: t('portfolio.columns.currency'), amount: t('portfolio.columns.value') },
    deliveredTitle: t('portfolio.vitals.deliveredTitle'),
    deliveredEmpty: t('portfolio.vitals.deliveredEmpty'),
    awaitingTitle: t('portfolio.vitals.awaitingTitle'),
    awaitingEmpty: t('portfolio.vitals.awaitingEmpty'),
    reportsRefusal: portfolio.reportsRefusal,
    optionsRefusal: portfolio.optionsRefusal,
    scopeDepartments: portfolio.departmentOptions,
    scopeProjects: portfolio.projectOptions,
    programEditOpen: sp.edit === '1' && portfolio.programs.some((program) => program.id === sp.program && program.status === 'draft') && canManage && portfolio.optionsRefusal === null,
    // The edit seed resolves from the authoritative program row the service
    // just listed — the builder edits server state, never a client echo.
    // Source accounts resolve through the detail drawer when it is open.
    programEditSeed: (() => {
      if (sp.edit !== '1' || sp.program === undefined || sp.program === 'new') return null
      const seed = portfolio.programs.find((row) => row.id === sp.program) ?? null
      if (!seed || seed.status !== 'draft' || portfolio.optionsRefusal) return null
      const drawerSources = [...portfolio.editSourceAccountIds]
      return {
        id: seed.id,
        code: seed.code,
        name: seed.name,
        family: seed.family,
        description: seed.description,
        legalEntityId: seed.legalEntityId,
        currency: seed.currency,
        effectiveFrom: seed.effectiveFrom,
        effectiveTo: seed.effectiveTo,
        payComponentId: seed.payComponentId,
        deliveryMethod: seed.deliveryMethod,
        valuation: seed.valuation,
        metric: seed.metric ?? '',
        metricScope: seed.metricScope ?? 'company',
        scopeIds: [...seed.scopeIds],
        allocation: seed.allocation,
        percentRate: seed.percentRate,
        fixedAmount: seed.fixedAmount,
        capAmount: seed.capAmount,
        budgetAmount: seed.budgetAmount,
        thresholdAmount: seed.thresholdAmount,
        frequency: seed.frequency,
        periodBasis: seed.periodBasis,
        paymentDelayDays: seed.paymentDelayDays,
        sourceAccountIds: drawerSources,
      }
    })(),
    // Manual awards record rewards, allowances, and custom grants. Incentive
    // values settle through the settlement service only — the award route
    // refuses manual incentive values, so incentive programs are not offered
    // here; they settle from their program drawer.
    awardProgramOptions: portfolio.programs
      .filter((program) => program.status === 'active' && program.family !== 'incentive')
      .map((program) => ({ value: program.id, label: `${program.code} — ${program.name}`, currency: program.currency, fixedAmount: program.valuation === 'fixed' ? program.fixedAmount : null })),
    // The insured-plan Setup section rehomes onto the programs view, where
    // the health and retirement cards land. Every other view keeps the
    // portfolio tables; the section reads its own rows, never the loader's.
    planSection:
      portfolioView === 'programs'
        ? {
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            canManage,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds ? [...authz.allowedSubsidiaryIds] : null,
          }
        : null,
  }
}

function portfolioHrefFor(
  basePath: string,
  segment: string | undefined,
  view: string | undefined,
  extra: Record<string, string>,
): string {
  const params = new URLSearchParams()
  if (segment) params.set('segment', segment)
  if (view && view !== 'overview') params.set('view', view)
  for (const [key, value] of Object.entries(extra)) params.set(key, value)
  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
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
    queueHref: '/hrm/benefits?view=enrolments',
  }
}
