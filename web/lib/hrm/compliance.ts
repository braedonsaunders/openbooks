import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { addCalendarDays, businessToday, utcDateFromParts } from '@openbooks/engine/src/platform/business-date.ts'
import { listFindings } from '@openbooks/engine/src/hrm/construction/findings.ts'
import { listSchedules } from '@openbooks/engine/src/hrm/construction/rates.ts'
import { listRuns, listFormats } from '@openbooks/engine/src/hrm/construction/certified.ts'
import { listCompClasses, listCompRules } from '@openbooks/engine/src/hrm/construction/comp-classes.ts'
import { listEntries, listPolicies } from '@openbooks/engine/src/hrm/construction/per-diem.ts'
import { can, type Authz } from '../authz'
import { setupSectionParams } from '../list-params'
import { complianceHref } from './workspace-href'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'

/**
 * Compliance workspace loader (HR-13) — findings, rate schedules,
 * certified runs, comp classes and per-diem behind the Compliance tab.
 * Rows come from the construction services (loader-resolved), never a
 * direct table read from the web app. Computed refusals travel as data.
 */

export type ComplianceSection = 'findings' | 'rates' | 'certified' | 'classes' | 'perdiem'

export interface ComplianceFindingRow {
  id: string
  kind: string
  kindLabel: string
  projectLabel: string | null
  workedOn: string | null
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  recordedLabel: string
}

export interface ComplianceScheduleRow {
  id: string
  name: string
  kindLabel: string
  scopeLabel: string
  reciprocityLabel: string
  windowLabel: string
  statusLabel: string
}

export interface ComplianceRunRow {
  id: string
  projectLabel: string
  weekLabel: string
  formatKey: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
}

export interface ComplianceClassRow {
  id: string
  code: string
  name: string
  rateLabel: string
  rulesLabel: string
}

export interface ComplianceEntryRow {
  id: string
  dayLabel: string
  amountLabel: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  entryKind: 'per_diem' | 'travel'
}

export interface ComplianceData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  canManage: boolean
  refusal: { title: string; message: string } | null
  hasContent: boolean
  section: ComplianceSection
  sections: Array<{ value: string; label: string }>
  kindFilter: string | null
  kinds: Array<{ value: string; label: string; count: number }>
  stats: Array<{ label: string; value: string; sub: string }>
  findings: ComplianceFindingRow[]
  schedules: ComplianceScheduleRow[]
  runs: ComplianceRunRow[]
  classes: ComplianceClassRow[]
  entries: ComplianceEntryRow[]
  policiesCount: number
  formatsEmpty: boolean
  packName: string | null
  generateHref: string
  generateCloseHref: string
  generateLabel: string
  actions: {
    acknowledge: string
    resolve: string
    approve: string
    void: string
    submit: string
  }
  generateDialog: {
    title: string
    projectLabel: string
    weekLabel: string
    formatLabel: string
    generateLabel: string
    cancelLabel: string
    projects: Array<{ value: string; label: string }>
    formats: Array<{ value: string; label: string }>
  }
  currentParams: Record<string, string | string[] | undefined>
  labels: {
    findingsTitle: string
    ratesTitle: string
    certifiedTitle: string
    classesTitle: string
    perdiemTitle: string
    empty: string
    emptyAction: string
    columns: Record<string, string>
  }
}

const SECTIONS: ComplianceSection[] = ['findings', 'rates', 'certified', 'classes', 'perdiem']

function statusVariant(status: string): ComplianceFindingRow['statusVariant'] {
  if (status === 'open' || status === 'computed') return 'warning'
  if (status === 'voided') return 'destructive'
  if (status === 'approved' || status === 'submitted' || status === 'generated' || status === 'resolved') return 'success'
  return 'secondary'
}

function weekEndingSunday(today: string): string {
  // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would remap
  // onto 1900-1999; addCalendarDays renders the result.
  const [y, m, d] = today.split('-').map(Number)
  const date = utcDateFromParts(y!, m! - 1, d!)
  const add = (7 - date.getUTCDay()) % 7
  return addCalendarDays(today, add)
}

export async function loadCompliancePage(
  authz: Authz,
  sp: Record<string, string | undefined>,
  basePath: string = '/hrm/compliance',
): Promise<ComplianceData> {
  const t = await getTranslations('hrm')
  const tabs = await hrmGroupTabs(authz, basePath)
  const canManage = can(authz, 'hrm.construction.manage')
  const section = SECTIONS.includes(sp.section as ComplianceSection) ? (sp.section as ComplianceSection) : 'findings'
  const kindFilter = typeof sp.kind === 'string' && sp.kind.length > 0 ? sp.kind : null
  // OM-18/CK-09: the rehomed construction sections read their New/edit
  // drawers from namespaced keys — one URL opens exactly one drawer.
  // The workspace's own params ride beside the section's list params,
  // never instead of them.
  const currentParams: ComplianceData['currentParams'] = { section, ...(kindFilter ? { kind: kindFilter } : {}), ...setupSectionParams(sp, ['classification', 'schedule', 'compClass', 'ratioRule', 'perDiem']) }
  const empty: ComplianceData = {
    title: t('compliance.title'),
    description: t('compliance.description'),
    tabs,
    canManage,
    refusal: null,
    hasContent: false,
    section,
    sections: SECTIONS.map((value) => ({ value, label: t(`compliance.sections.${value}`) })),
    kindFilter,
    kinds: [],
    stats: [],
    findings: [],
    schedules: [],
    runs: [],
    classes: [],
    entries: [],
    policiesCount: 0,
    formatsEmpty: false,
    packName: null,
    // F3-55: the dialog open/close hrefs preserve the section, the kind
    // filter, and the setup-section params through the shared helper.
    generateHref: complianceHref(currentParams, { generate: '1' }),
    generateCloseHref: complianceHref(currentParams),
    generateLabel: t('compliance.generate'),
    actions: {
      acknowledge: t('compliance.actions.acknowledge'),
      resolve: t('compliance.actions.resolve'),
      approve: t('compliance.actions.approve'),
      void: t('compliance.actions.void'),
      submit: t('compliance.actions.submit'),
    },
    generateDialog: {
      title: t('compliance.generateDialog.title'),
      projectLabel: t('compliance.generateDialog.project'),
      weekLabel: t('compliance.generateDialog.week'),
      formatLabel: t('compliance.generateDialog.format'),
      generateLabel: t('compliance.generateDialog.generate'),
      cancelLabel: t('compliance.generateDialog.cancel'),
      projects: [],
      formats: [],
    },
    currentParams,
    labels: {
      findingsTitle: t('compliance.findingsTitle'),
      ratesTitle: t('compliance.ratesTitle'),
      certifiedTitle: t('compliance.certifiedTitle'),
      classesTitle: t('compliance.classesTitle'),
      perdiemTitle: t('compliance.perdiemTitle'),
      empty: t('compliance.empty'),
      emptyAction: t('compliance.emptyAction'),
      columns: {
        kind: t('compliance.columns.kind'),
        project: t('compliance.columns.project'),
        day: t('compliance.columns.day'),
        status: t('compliance.columns.status'),
        recorded: t('compliance.columns.recorded'),
        schedule: t('compliance.columns.schedule'),
        scope: t('compliance.columns.scope'),
        reciprocity: t('compliance.columns.reciprocity'),
        window: t('compliance.columns.window'),
        run: t('compliance.columns.run'),
        week: t('compliance.columns.week'),
        format: t('compliance.columns.format'),
        code: t('compliance.columns.code'),
        name: t('compliance.columns.name'),
        rate: t('compliance.columns.rate'),
        rules: t('compliance.columns.rules'),
        amount: t('compliance.columns.amount'),
        actions: t('compliance.columns.actions'),
      },
    },
  }
  if (!can(authz, 'hrm.construction.read')) return { ...empty, refusal: { title: t('compliance.refused'), message: t('compliance.needRead') } }
  const orgId = authz.user.orgId
  const actorId = authz.user.id
  try {
    const projects = (
      await db.execute<{ id: string; name: string }>(sql`
        select id::text as id, name from projects where org_id = ${orgId} order by name
      `)
    ).rows
    const projectName = new Map(projects.map((project) => [project.id, project.name]))
    const findings = await listFindings(db, orgId, actorId, null)
    const kinds = ['ratio_breach', 'missing_rate', 'class_unresolved', 'registration_missing', 'fringe_mismatch'].map(
      (value) => ({
        value,
        label: t(`compliance.kinds.${value}`),
        count: findings.filter((finding) => finding.kind === value && finding.status === 'open').length,
      }),
    )
    const visible = kindFilter ? findings.filter((finding) => finding.kind === kindFilter) : findings
    const findingRows: ComplianceFindingRow[] = visible.slice(0, 200).map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      kindLabel: t(`compliance.kinds.${finding.kind}`),
      projectLabel: finding.projectId ? (projectName.get(finding.projectId) ?? finding.projectId) : null,
      workedOn: finding.workedOn,
      status: finding.status,
      statusLabel: t(`compliance.findingStatus.${finding.status}`),
      statusVariant: statusVariant(finding.status),
      recordedLabel: finding.recordedAt.slice(0, 10),
    }))
    const schedules = await listSchedules(db, orgId, actorId)
    const scheduleRows: ComplianceScheduleRow[] = schedules.map((schedule) => {
      const scope = schedule.appliesTo
      const parts: string[] = []
      if (scope.project_ids?.length) parts.push(`${scope.project_ids.length}× ${t('compliance.scope.project')}`)
      if (scope.location_ids?.length) parts.push(`${scope.location_ids.length}× ${t('compliance.scope.location')}`)
      if (scope.employer_subsidiary_id) parts.push(t('compliance.scope.subsidiary'))
      return {
        id: schedule.id,
        name: schedule.name,
        kindLabel: t(`compliance.scheduleKind.${schedule.kind}`),
        scopeLabel: parts.length > 0 ? parts.join(', ') : t('compliance.scope.org'),
        reciprocityLabel: t(`compliance.reciprocity.${schedule.reciprocity}`),
        windowLabel: schedule.effectiveTo ? `${schedule.effectiveFrom} – ${schedule.effectiveTo}` : `${schedule.effectiveFrom} – …`,
        statusLabel: schedule.isActive ? t('compliance.active') : t('compliance.retired'),
      }
    })
    const runs = await listRuns(db, orgId, actorId, null)
    const runRows: ComplianceRunRow[] = runs.slice(0, 200).map((run) => ({
      id: run.id,
      projectLabel: run.projectId ? (projectName.get(run.projectId) ?? run.projectId) : '—',
      weekLabel: run.weekEnding,
      formatKey: run.formatKey,
      status: run.status,
      statusLabel: t(`compliance.runStatus.${run.status}`),
      statusVariant: statusVariant(run.status),
    }))
    const classes = await listCompClasses(db, orgId, actorId)
    const rules = await listCompRules(db, orgId, actorId)
    const classRows: ComplianceClassRow[] = classes.map((compClass) => ({
      id: compClass.id,
      code: compClass.code,
      name: compClass.name,
      rateLabel: compClass.ratePer100 ?? '—',
      rulesLabel: String(rules.filter((rule) => rule.compClassId === compClass.id).length),
    }))
    const entries = await listEntries(db, orgId, actorId, null)
    const entryRows: ComplianceEntryRow[] = entries.slice(0, 200).map((entry) => ({
      id: entry.id,
      dayLabel: entry.workedOn,
      amountLabel: `${entry.amount} ${entry.currency}`,
      status: entry.status,
      statusLabel: t(`compliance.entryStatus.${entry.status}`),
      statusVariant: statusVariant(entry.status),
      entryKind: 'per_diem',
    }))
    const policies = await listPolicies(db, orgId, actorId)
    let packName: string | null = null
    let formatsEmpty = false
    let formatOptions: Array<{ value: string; label: string }> = []
    try {
      const declared = await listFormats(db, orgId, actorId)
      packName = declared.packName
      formatsEmpty = declared.formats.length === 0
      formatOptions = declared.formats.map((format) => ({ value: format.key, label: format.label }))
    } catch {
      packName = null
    }
    // Certified due: scoped projects whose current week has no generated run.
    // "Current" is the org's business day, never the UTC day.
    const today = await businessToday(orgId)
    const due = weekEndingSunday(today)
    const generatedWeeks = new Set(runs.filter((run) => run.status !== 'draft').map((run) => `${run.projectId}|${run.weekEnding}`))
    const scopedProjects = new Set<string>()
    for (const schedule of schedules) {
      for (const projectId of schedule.appliesTo.project_ids ?? []) scopedProjects.add(projectId)
    }
    const dueCount = [...scopedProjects].filter((projectId) => !generatedWeeks.has(`${projectId}|${due}`)).length
    const openCount = findings.filter((finding) => finding.status === 'open').length
    return {
      ...empty,
      hasContent: true,
      kinds,
      findings: findingRows,
      schedules: scheduleRows,
      runs: runRows,
      classes: classRows,
      entries: entryRows,
      policiesCount: policies.length,
      formatsEmpty,
      packName,
      generateDialog: {
        ...empty.generateDialog,
        projects: projects.map((project) => ({ value: project.id, label: project.name })),
        formats: formatOptions,
      },
      stats: [
        { label: t('compliance.stats.openFindings'), value: String(openCount), sub: t('compliance.stats.openFindingsSub') },
        { label: t('compliance.stats.dueReports'), value: String(dueCount), sub: t('compliance.stats.dueReportsSub', { week: due }) },
        {
          label: t('compliance.stats.unresolvedClasses'),
          value: String(findings.filter((finding) => finding.kind === 'class_unresolved' && finding.status === 'open').length),
          sub: t('compliance.stats.unresolvedClassesSub'),
        },
        {
          label: t('compliance.stats.perdiemWaiting'),
          value: String(entries.filter((entry) => entry.status === 'computed').length),
          sub: t('compliance.stats.perdiemWaitingSub'),
        },
      ],
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...empty, refusal: { title: t('compliance.refused'), message } }
  }
}
