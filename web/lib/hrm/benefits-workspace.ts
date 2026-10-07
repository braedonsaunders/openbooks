import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { getMoneyFormatter } from '../money-server'

import {
  benefitCurrencyOptions,
  type BenefitCurrencyOption,
  listBenefitApprovalPolicies,
  listBenefitAwards,
  listBenefitPrograms,
  listProgramMemberships,
  listProgramSources,
  previewIncentiveSettlement,
  type BenefitAward,
  type BenefitAwardStatus,
  type BenefitProgram,
  type BenefitProgramFamily,
  type BenefitProgramStatus,
} from '@openbooks/engine/hrm/benefits'
import { can, type Authz } from '../authz'
import {
  buildAttentionQueue,
  portfolioHref,
  totalsByCurrency,
  type BenefitPayComponentOption,
  type AttentionItem,
  type CurrencyTotal,
} from './benefits-portfolio'

export type { AttentionItem, CurrencyTotal }
import { listScopedAccountOptions, listScopedDepartmentOptions, listScopedProjectOptions } from '../scoped-options'
import { subsidiaryVisibleFilter } from '../subsidiaries'
import { loadQueueLabels } from './change-requests'
import { loadBenefitsReportLinks, type BenefitsReportLink } from './benefits-reports'
import { isFeatureEnabled } from '../features'

/**
 * Employer-defined program rules, participants, activity and payroll delivery. Programs and awards load through the
 * domain services (loader-resolved, newest first, actor scope inside),
 * never a direct benefits-table read from the web app. A service refusal
 * travels as data beside the sections it blocks: the cockpit renders the
 * refusal with its remedy, never a success around missing rows.
 *
 * Money crosses as canonical decimal strings and is summed only within one
 * currency. Amounts in different currencies render as separate lines; the
 * loader never totals them into one figure.
 */

export interface PortfolioProgramRow extends BenefitProgram {
  familyLabel: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  valueLabel: string
  programHref: string
  openLabel: string
}

export interface PortfolioAwardRow extends BenefitAward {
  programCode: string
  programName: string
  programFamily: BenefitProgramFamily | null
  programDeliveryMethod: BenefitProgram['deliveryMethod'] | null
  recipientLabel: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  valueLabel: string
  awardHref: string
  openLabel: string
}



export interface PortfolioVitals {
  activePrograms: number
  draftPrograms: number
  openWindows: number
  pendingEnrollments: number
  pendingAwards: number
  queuedAwards: number
  /** Delivered awards summed within each currency — never across them. */
  deliveredByCurrency: CurrencyTotal[]
  /** Approved and queued awards summed within each currency. */
  awaitingByCurrency: CurrencyTotal[]
}

export interface ProgramSimulationRecipient {
  employmentId: string
  employeeLabel: string
  share: string
  grossValue: string
  netValue: string
  capped: boolean
  explanation: string
}

export interface ProgramSimulation {
  periodFrom: string
  periodTo: string
  currency: string
  payableAfter: string
  isEstimate: boolean
  summaryLines: string[]
  measuredLines: { label: string; value: string }[]
  recipients: ProgramSimulationRecipient[]
  excluded: string[]
  totalAwarded: string
  undistributed: string
  thresholdMet: boolean
}

export interface ProgramDetailDrawer {
  canConfigureApprovalPolicies: boolean
  approvalPolicies: Awaited<ReturnType<typeof listBenefitApprovalPolicies>> | null
  approvalPoliciesRefusal: { title: string; message: string } | null
  editHref: string
  policyLines: { label: string; value: string }[]
  simulateHref: string
  /** A refused member/source/simulation read renders inside the drawer with
   *  its message — the drawer never shows partial policy as complete. */
  drawerRefusal: { title: string; message: string } | null
  simulation: ProgramSimulation | null
  simulationRefusal: { title: string; message: string } | null
  program: PortfolioProgramRow
  activity: PortfolioAwardRow[]
  activityRefusal: { title: string; message: string } | null
  activityTruncated: boolean
  members: {
    id: string
    employmentId: string
    employeeLabel: string
    employeeHref: string | null
    rangeLabel: string
    weight: string | null
    role: string | null
  }[]
  membersEmpty: string
  sources: { id: string; accountId: string; accountLabel: string; weightBps: number | null }[]
  sourcesEmpty: string
}

export interface AwardDetailDrawer {
  award: PortfolioAwardRow
  timelineEmpty: string
}

export interface BuilderOption {
  value: string
  label: string
}

export interface PortfolioCatalog {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

export interface PortfolioData {
  /** Measured-account ids for the program under edit, resolved even though
   *  edit mode suppresses the detail drawer. When the read fails the edit
   *  is blocked with the refusal below: an empty picker would imply cleared
   *  sources and silently narrow the program on save. */
  editSourceAccountIds: string[]
  editSourcesRefusal: { title: string; message: string } | null
  vitals: PortfolioVitals
  /** A refused award read blocks the portfolio totals with its remedy. */
  vitalsRefusal: { title: string; message: string } | null
  /** Complete authorized award population, paged by the shared list. */
  awardsTotal: number
  awardsTruncated: boolean
  attention: AttentionItem[]
  attentionTitle: string
  attentionEmpty: string
  programs: PortfolioProgramRow[]
  programsRefusal: { title: string; message: string } | null
  awards: PortfolioAwardRow[]
  awardsRefusal: { title: string; message: string } | null
  reportLinks: { key: BenefitsReportLink['key']; href: string; label: string }[]
  reportsTitle: string
  /** A refused report-link resolution renders beside the reports section —
   *  never a silent empty list pretending no reports exist. */
  reportsRefusal: { title: string; message: string } | null
  /** A refused selector lookup (accounts, components, employments)
   *  renders beside the builders — an empty picker never pretends the
   *  catalog is empty. Project options stay deliberately empty while the
   *  Projects feature is off, with no refusal. */
  optionsRefusal: { title: string; message: string } | null
  canManage: boolean
  canQueue: boolean
  newProgramButton: string
  newProgramHref: string
  programDrawer: ProgramDetailDrawer | null
  programCloseHref: string
  awardDrawer: AwardDetailDrawer | null
  awardCloseHref: string
  currencyOptions: BenefitCurrencyOption[]
  accountOptions: BuilderOption[]
  payComponentOptions: BenefitPayComponentOption[]
  departmentOptions: BuilderOption[]
  projectOptions: BuilderOption[]
  employmentOptions: BuilderOption[]
  employmentsTruncated: boolean
  subsidiaryOptions: BuilderOption[]
}

type Catalog = {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

function statusVariant(status: string): PortfolioProgramRow['statusVariant'] {
  if (status === 'active' || status === 'approved' || status === 'delivered' || status === 'open') return 'success'
  if (status === 'draft' || status === 'pending' || status === 'queued') return 'warning'
  if (status === 'rejected') return 'destructive'
  if (status === 'closed' || status === 'voided' || status === 'cancelled') return 'outline'
  return 'default'
}

function labelOf(t: Catalog, prefix: string, value: string): string {
  return t.has(`${prefix}.${value}`) ? t(`${prefix}.${value}`) : value
}

function programValueLabel(program: BenefitProgram, amount: (value: string, currency: string) => string): string {
  if (program.valuation === 'fixed' && program.fixedAmount !== null) {
    return amount(program.fixedAmount, program.currency)
  }
  if (program.valuation === 'percent' && program.percentRate !== null) return `${program.percentRate}%`
  if (program.valuation === 'pool' && program.budgetAmount !== null) {
    return amount(program.budgetAmount, program.currency)
  }
  return program.valuation
}







async function serviceRefusal(
  t: Catalog,
  work: () => Promise<void>,
): Promise<{ title: string; message: string } | null> {
  try {
    await work()
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : t('portfolio.loadFailed')
    return { title: t('portfolio.loadFailedTitle'), message }
  }
}


export async function loadBenefitsPortfolio(
  authz: Authz,
  sp: Record<string, string | undefined>,
  windows: { openCount: number; pendingEnrollments: number },
  catalog: PortfolioCatalog,
): Promise<PortfolioData> {
  const t = catalog as unknown as Catalog
  const basePath = '/hrm/benefits'
  const orgId = authz.user.orgId
  const actorId = authz.user.id
  const canManage = can(authz, 'hrm.benefits.manage')
  // Queue and delivery release payout: finance under payroll.manage. HR
  // authors awards (canManage) but must never see a finance action.
  const canQueue = can(authz, 'payroll.manage')

  let programs: BenefitProgram[] = []
  let awards: BenefitAward[] = []
  const [programsRefusal, awardsRefusal, { money }] = await Promise.all([
    serviceRefusal(t, async () => {
      programs = (await listBenefitPrograms({ orgId, actorId })).programs
    }),
    serviceRefusal(t, async () => {
      awards = (await listBenefitAwards({ orgId, actorId })).awards
    }),
    getMoneyFormatter(orgId),
  ])
  const amountLabel = (value: string, currency: string): string => money(value, { currency })

  const programById = new Map(programs.map((program) => [program.id, program]))
  const { workerByEmployment } = await loadQueueLabels(
    orgId,
    [...new Set([...awards.map((a) => a.employmentId)])],
    [],
  )

  const programRows: PortfolioProgramRow[] = programs.map((program) => ({
    ...program,
    familyLabel: labelOf(t, 'portfolio.families', program.family as string),
    statusLabel: labelOf(t, 'portfolio.programStatus', program.status as string),
    statusVariant: statusVariant(program.status),
    valueLabel: programValueLabel(program, amountLabel),
    programHref: portfolioHref(basePath, 'programs', { program: program.id }),
    openLabel: t('portfolio.openProgram'),
  }))
  const awardRows: PortfolioAwardRow[] = awards.map((award) => {
    const program = programById.get(award.programId)
    const worker = workerByEmployment.get(award.employmentId)
    return {
      ...award,
      programCode: program?.code ?? award.programId,
      programName: program?.name ?? award.programId,
      programFamily: program?.family ?? null,
      programDeliveryMethod: program?.deliveryMethod ?? null,
      recipientLabel: worker?.name ?? award.employmentId,
      statusLabel: award.status === 'queued' && program?.deliveryMethod === 'external' && award.payrollProcessed ? t('portfolio.externalPayrollProcessed') : award.status === 'delivered' && program?.deliveryMethod === 'payroll' ? t('portfolio.payrollDelivery') : labelOf(t, 'portfolio.awardStatus', award.status as string),
      statusVariant: statusVariant(award.status),
      valueLabel: amountLabel(award.value, award.currency),
      awardHref: portfolioHref(basePath, sp.view, { award: award.id }),
      openLabel: t('portfolio.openAward'),
    }
  })

  // An empty allowed set sees nothing: the predicate fails closed instead
  // of emitting IN (), which Postgres rejects. Null keeps org-wide reads.
  const scopeList = (column: ReturnType<typeof sql>): ReturnType<typeof sql> => {
    if (authz.allowedSubsidiaryIds === null) return sql``
    const ids = [...authz.allowedSubsidiaryIds]
    if (ids.length === 0) return sql`and false`
    return sql`and ${column} in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`
  }

  // Services return the complete authorized population when no limit is
  // requested. Lists, totals and attention counts share that same read.
  const vitalsRefusal = awardsRefusal
  const countStatus = (status: string): number => awards.filter((award) => award.status === status).length
  const totalStatus = (statuses: string[]): CurrencyTotal[] =>
    totalsByCurrency(awards.filter((award) => statuses.includes(award.status)), amountLabel)

  const activePrograms = programs.filter((p) => p.status === 'active').length
  const draftPrograms = programs.filter((p) => p.status === 'draft').length
  const pendingAwards = countStatus('pending')
  const queuedAwards = countStatus('queued')
  const awardsTotal = awards.length
  const awardsTruncated = false

  const vitals: PortfolioVitals = {
    activePrograms,
    draftPrograms,
    openWindows: windows.openCount,
    pendingEnrollments: windows.pendingEnrollments,
    pendingAwards,
    queuedAwards,
    deliveredByCurrency: totalStatus(['delivered']),
    awaitingByCurrency: totalStatus(['approved', 'queued']),
  }

  const programsMissingComponent = programs
    .filter((p) => p.deliveryMethod === 'payroll' && p.payComponentId === null && p.status !== 'closed')
    .map((p) => ({ id: p.id, code: p.code }))

  const attention = buildAttentionQueue({
    pendingEnrollments: windows.pendingEnrollments,
    pendingAwards,
    queuedAwards,
    draftPrograms,
    programsMissingComponent,
    format: (key, params) => t(key, params),
    basePath,
  })

  // Report links resolve actual tenant report definitions. A refusal renders
  // beside the reports section with its message — an empty list never
  // pretends no reports exist.
  let reportLinks: PortfolioData['reportLinks'] = []
  let reportsRefusal: PortfolioData['reportsRefusal'] = null
  try {
    reportLinks = (await loadBenefitsReportLinks(authz)).map((link) => ({
      ...link,
      label: t.has(`portfolio.reports.${link.key}`) ? t(`portfolio.reports.${link.key}`) : link.key,
    }))
  } catch (error) {
    reportsRefusal = {
      title: t('portfolio.reportsFailedTitle'),
      message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
    }
  }

  // Builder source selectors resolve through the same scoped reads as every
  // other drawer: measured accounts, departments, and projects fence to the
  // actor's subsidiary scope, and pay components list active earning
  // components the program links for payroll delivery. Measured accounts
  // serve incentive money metrics only — rewards and allowances map value
  // through the pay component, never an extra funding list. The domain
  // service re-validates every id on write.
  // Selector lookups fail loudly with a named refusal beside the builders —
  // an empty picker never pretends its catalog is empty. Project options
  // stay deliberately empty while the Projects feature is off (no refusal:
  // there is nothing to pick, and the service refuses project scope the
  // same way on write).
  const lookup = async <T>(work: () => Promise<T[]>): Promise<{ rows: T[]; failure: string | null }> => {
    try {
      return { rows: await work(), failure: null }
    } catch (error) {
      return {
        rows: [],
        failure: error instanceof Error ? error.message : t('portfolio.loadFailed'),
      }
    }
  }
  let projectsEnabled = false
  let featureRefusal: PortfolioData['optionsRefusal'] = null
  try {
    projectsEnabled = await isFeatureEnabled(orgId, 'projects')
  } catch (error) {
    featureRefusal = {
      title: t('portfolio.optionsFailedTitle'),
      message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
    }
  }
  const [accounts, departments, projects, payComponents, employments, subsidiaries, currencies] = await Promise.all([
    lookup(() => listScopedAccountOptions(orgId, authz.allowedSubsidiaryIds, { activeOnly: true, postingOnly: true })),
    lookup(() => listScopedDepartmentOptions(orgId, authz.allowedSubsidiaryIds)),
    projectsEnabled
      ? lookup(() => listScopedProjectOptions(orgId, authz.allowedSubsidiaryIds))
      : Promise.resolve({ rows: [], failure: null }),
    lookup(() =>
      db
        .execute<{ id: string; code: string | null; name: string; paymentKind: 'cash' | 'non_cash' }>(sql`
          select id::text as id, code, name, payment_kind as "paymentKind" from pay_components
           where org_id = ${orgId} and is_active and kind = 'earning'
           order by sequence, code
        `)
        .then((result) => result.rows),
    ),
    lookup(() =>
      db
        .execute<{ id: string; name: string | null }>(sql`
          select w.id::text as id, p.display_name as name
            from worker_employments w
            join parties p on p.org_id = w.org_id and p.id = w.worker_party_id
           where w.org_id = ${orgId}::uuid
             ${scopeList(sql`w.employer_subsidiary_id`)}
           order by p.display_name
        `)
        .then((result) => result.rows),
    ),
    lookup(() =>
      db
        .execute<{ id: string; name: string }>(sql`
          select id::text as id, name from subsidiaries
           where org_id = ${orgId}::uuid and is_active
             ${subsidiaryVisibleFilter(sql`id`, authz.allowedSubsidiaryIds)}
           order by name
        `)
        .then((result) => result.rows),
    ),
    lookup(() => benefitCurrencyOptions(db, orgId, actorId)),
  ])
  const lookupFailures = [
    accounts.failure,
    departments.failure,
    projects.failure,
    payComponents.failure,
    employments.failure,
    subsidiaries.failure,
    currencies.failure,
  ].filter((failure): failure is string => failure !== null)
  const optionsRefusal: PortfolioData['optionsRefusal'] =
    lookupFailures.length > 0
      ? { title: t('portfolio.optionsFailedTitle'), message: lookupFailures[0] ?? t('portfolio.loadFailed') }
      : featureRefusal

  // Edit mode renders the builder alone, but the seed still needs the
  // authoritative measured accounts: resolved here even though the detail
  // drawer stays suppressed, so an edit never implies cleared sources.
  let editSourceAccountIds: string[] = []
  let editSourcesRefusal: PortfolioData['optionsRefusal'] = null
  if (sp.edit === '1' && sp.program && sp.program !== 'new') {
    try {
      editSourceAccountIds = (await listProgramSources(db, orgId, actorId, sp.program)).map((s) => s.accountId)
    } catch (error) {
      editSourcesRefusal = {
        title: t('portfolio.optionsFailedTitle'),
        message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
      }
    }
  }
  let programDrawer: ProgramDetailDrawer | null = null
  // Edit mode renders the builder alone: the seed above carries the
  // authoritative row, so the detail drawer does not stack beneath it.
  if (sp.program && !sp.award && sp.edit !== '1') {
    const found = programRows.find((row) => row.id === sp.program) ?? null
    if (found) {
      let members: Awaited<ReturnType<typeof listProgramMemberships>> = []
      let sources: Awaited<ReturnType<typeof listProgramSources>> = []
      let drawerRefusal: ProgramDetailDrawer['drawerRefusal'] = null
      try {
        ;[members, sources] = await Promise.all([
          listProgramMemberships({ orgId, actorId, programId: found.id }),
          listProgramSources(db, orgId, actorId, found.id),
        ])
      } catch (error) {
        drawerRefusal = {
          title: t('portfolio.drawerFailedTitle'),
          message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
        }
      }
      const memberLabels = await loadQueueLabels(
        orgId,
        [...new Set(members.map((m) => m.employmentId))],
        [],
      )
      const accountById = new Map(accounts.rows.map((a) => [a.id, a]))
      // Settlement simulation runs the engine preview over an explicit
      // period: the same measure and the same math settlement runs, over
      // posted and approved sources only. It writes nothing; settling stays
      // with the settlement service through the program route.
      let simulation: ProgramSimulation | null = null
      let simulationRefusal: ProgramDetailDrawer['simulationRefusal'] = null
      const simulatePeriodFrom = typeof sp.periodFrom === 'string' ? sp.periodFrom : ''
      const simulatePeriodTo = typeof sp.periodTo === 'string' ? sp.periodTo : ''
      if (found.family === 'incentive' && sp.simulate === '1' && simulatePeriodFrom !== '' && simulatePeriodTo !== '') {
        try {
          const preview = await previewIncentiveSettlement({
            orgId,
            actorId,
            programId: found.id,
            periodFrom: simulatePeriodFrom,
            periodTo: simulatePeriodTo,
          })
          const recipientLabels = await loadQueueLabels(
            orgId,
            [...new Set(preview.visibleRecipients.map((r) => r.employmentId))],
            [],
          )
          const measured = preview.measured
          const measuredLines =
            measured.metric === 'approved_hours'
              ? [
                  { label: t('portfolio.simulate.totalHours'), value: measured.totalHours },
                  { label: t('portfolio.simulate.entries'), value: String(measured.entryCount) },
                ]
              : measured.metric === 'transactions' ? [
                  { label: t('portfolio.simulate.measured'), value: found.valuation === 'per_unit' ? measured.value : amountLabel(measured.value, measured.currency) },
                  { label: t('portfolio.simulate.entries'), value: String(measured.entryCount) },
                ] : [
                  { label: t('portfolio.simulate.revenue'), value: amountLabel(measured.revenueTotal, measured.currency) },
                  { label: t('portfolio.simulate.expenses'), value: amountLabel(measured.expenseTotal, measured.currency) },
                  { label: t('portfolio.simulate.measured'), value: amountLabel(measured.value, measured.currency) },
                  { label: t('portfolio.simulate.entries'), value: String(measured.entryCount) },
                ]
          simulation = {
            periodFrom: preview.periodFrom,
            periodTo: preview.periodTo,
            currency: preview.currency,
            payableAfter: preview.payableAfter,
            isEstimate: preview.isEstimate,
            summaryLines: [...preview.computation.summaryLines],
            measuredLines,
            recipients: preview.visibleRecipients.map((recipient) => ({
              employmentId: recipient.employmentId,
              employeeLabel:
                recipientLabels.workerByEmployment.get(recipient.employmentId)?.name ?? recipient.employmentId,
              share: recipient.share,
              grossValue: amountLabel(recipient.grossValue, preview.currency),
              netValue: amountLabel(recipient.value, preview.currency),
              capped: recipient.capped,
              explanation: recipient.explanation,
            })),
            excluded: [...preview.excluded],
            totalAwarded: amountLabel(preview.computation.totalAwarded, preview.currency),
            undistributed: amountLabel(preview.computation.undistributed, preview.currency),
            thresholdMet: preview.computation.thresholdMet,
          }
        } catch (error) {
          simulationRefusal = {
            title: t('portfolio.simulateFailedTitle'),
            message: error instanceof Error ? error.message : t('portfolio.loadFailed'),
          }
        }
      }
      const policyLines: ProgramDetailDrawer['policyLines'] = []
      const policy = (key: string, value: string | null) => {
        if (value !== null && value !== '') policyLines.push({ label: t(`portfolio.builder.fields.${key}`), value })
      }
      policy('legalEntity', subsidiaries.rows.find((entity) => entity.id === found.legalEntityId)?.name ?? null)
      policy('valuation', t(`portfolio.valuations.${found.valuation}`))
      for (const field of ['capAmount', 'budgetAmount', 'thresholdAmount'] as const) {
        if (found[field] !== null) policy(field, amountLabel(found[field], found.currency))
      }
      if (found.family === 'incentive') {
        if (found.metric) policy('metric', t(`portfolio.metrics.${found.metric}`))
        if (found.metricScope) policy('metricScope', t(`portfolio.scopes.${found.metricScope}`))
        const scopeOptions = found.metricScope === 'department' ? departments.rows : projects.rows
        for (const option of scopeOptions.filter((option) => found.scopeIds.includes(option.id))) policy('metricScope', option.name)
        policy('allocation', t(`portfolio.allocations.${found.allocation}`))
      }
      policy('frequency', t(`portfolio.frequencies.${found.frequency}`))
      if (found.periodBasis) policy('periodBasis', t(`portfolio.periodBasis.${found.periodBasis}`))
      policy('paymentDelayDays', String(found.paymentDelayDays))
      policy('deliveryMethod', t(`portfolio.delivery.${found.deliveryMethod}`))
      const component = payComponents.rows.find((component) => component.id === found.payComponentId)
      policy('payComponent', component ? `${component.code ?? ''} — ${component.name}` : null)
      let approvalPolicies: ProgramDetailDrawer['approvalPolicies'] = null
      let approvalPoliciesRefusal: ProgramDetailDrawer['approvalPoliciesRefusal'] = null
      try { if (found.approvalMode === 'flows') approvalPolicies = await listBenefitApprovalPolicies({ orgId, actorId, programId: found.id }) }
      catch (error) { approvalPoliciesRefusal = { title: t('portfolio.readFailedTitle'), message: error instanceof Error ? error.message : t('portfolio.loadFailed') } }
      programDrawer = {
        canConfigureApprovalPolicies: can(authz, 'flows.manage'),
        approvalPolicies, approvalPoliciesRefusal,
        policyLines,
        editHref: portfolioHref(basePath, sp.view, { program: found.id, edit: '1' }),
        simulateHref: portfolioHref(basePath, sp.view, { program: found.id }),
        drawerRefusal,
        simulation,
        simulationRefusal,
        program: found,
        activity: awardRows.filter(award => award.programId === found.id),
        activityRefusal: awardsRefusal,
        activityTruncated: awardsTruncated,
        members: members.map((member) => ({
          id: member.id,
          employmentId: member.employmentId,
          employeeLabel: memberLabels.workerByEmployment.get(member.employmentId)?.name ?? member.employmentId,
          employeeHref: memberLabels.workerByEmployment.get(member.employmentId)?.partyId ? `/entities/employees?party=${memberLabels.workerByEmployment.get(member.employmentId)!.partyId}&partyTab=benefits` : null,
          rangeLabel:
            member.effectiveTo !== null ? `${member.effectiveFrom} – ${member.effectiveTo}` : `${member.effectiveFrom} – …`,
          weight: member.weight,
          role: member.role,
        })),
        membersEmpty: t('portfolio.membersEmpty'),
        sources: sources.map((source) => {
          const account = accountById.get(source.accountId)
          return {
            id: source.id,
            accountId: source.accountId,
            accountLabel: account ? `${account.number ?? ''} ${account.name}`.trim() : source.accountId,
            weightBps: source.weightBps,
          }
        }),
        sourcesEmpty: t('portfolio.sourcesEmpty'),
      }
    }
  }

  let awardDrawer: AwardDetailDrawer | null = null
  if (sp.award) {
    const found = awardRows.find((row) => row.id === sp.award) ?? null
    if (found) {
      awardDrawer = { award: found, timelineEmpty: t('portfolio.awardTimelineEmpty') }
    }
  }

  return {
    editSourceAccountIds,
    editSourcesRefusal,
    vitals,
    vitalsRefusal,
    awardsTotal,
    awardsTruncated,
    attention,
    attentionTitle: t('portfolio.attentionTitle'),
    attentionEmpty: t('portfolio.attentionEmpty'),
    programs: programRows,
    programsRefusal,
    awards: awardRows,
    awardsRefusal,
    reportLinks,
    reportsTitle: t('portfolio.reportsTitle'),
    reportsRefusal,
    optionsRefusal: optionsRefusal ?? editSourcesRefusal,
    canManage,
    canQueue,
    newProgramButton: t('portfolio.newProgram'),
    newProgramHref: portfolioHref(basePath, sp.view, { program: 'new' }),
    programDrawer,
    programCloseHref: portfolioHref(basePath, sp.view, {}),
    awardDrawer,
    awardCloseHref: portfolioHref(basePath, sp.view, {}),
    currencyOptions: currencies.rows,
    accountOptions: accounts.rows.map((a) => ({
      value: a.id,
      label: `${a.number ?? ''} ${a.name}`.trim(),
    })),
    payComponentOptions: payComponents.rows.map((c) => ({
      value: c.id,
      label: `${c.code ?? ''} — ${c.name}`.trim(),
      paymentKind: c.paymentKind,
    })),
    departmentOptions: departments.rows.map((d) => ({ value: d.id, label: d.name })),
    projectOptions: projects.rows.map((p) => ({ value: p.id, label: p.name })),
    employmentOptions: employments.rows.map((e) => ({
      value: e.id,
      label: e.name ?? e.id,
    })),
    employmentsTruncated: false,
    subsidiaryOptions: subsidiaries.rows.map((row) => ({ value: row.id, label: row.name })),
  }
}

export type { BenefitAwardStatus, BenefitProgramFamily, BenefitProgramStatus }
