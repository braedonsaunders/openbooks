import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { checkAssignmentInternal } from '@openbooks/engine/src/hrm/qualifications/gating.ts'
import { listQualificationTypes } from '@openbooks/engine/src/hrm/qualifications/types.ts'
import { listAlerts } from '@openbooks/engine/src/hrm/qualifications/alerts.ts'
import { HrmQualificationError } from '@openbooks/engine/src/hrm/qualifications/errors.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import {
  listQualifications,
  type WorkerQualification,
} from '@openbooks/engine/src/hrm/qualifications/qualifications.ts'
import type { DerivedQualificationStatus } from '@openbooks/engine/src/hrm/qualifications/shared.ts'
import { listRequirements } from '@openbooks/engine/src/hrm/qualifications/requirements.ts'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmPeopleViewTabs } from './workspace-tabs'
import { loadQueueLabels } from './change-requests'
import { can, type Authz } from '../authz'

/**
 * Qualifications page loader (HR-14): the worker qualification ledger by
 * worker with derived status at read, the requirements coverage matrix
 * per project (rows = crew, cols = required types, cells = status
 * chips), and the fired alert register. Everything resolves through the
 * qualification services; only display names come from the shared queue
 * label helper. Renders when hrmCertifications is on and the actor holds
 * hrm.certifications.read — the page gate 404s otherwise.
 */

export type QualificationSegment = 'all' | DerivedQualificationStatus
export type QualificationSection = 'ledger' | 'requirements' | 'alerts'

export interface QualificationRow {
  id: string
  employmentId: string
  workerName: string
  workerHref: string | null
  typeCode: string
  typeName: string
  status: DerivedQualificationStatus
  statusLabel: string
  statusVariant: 'default' | 'success' | 'warn' | 'danger' | 'info'
  expiryLabel: string | null
  identifierLabel: string | null
  openHref: string
}

export interface CoverageColumn {
  code: string
  name: string
}

export interface CoverageCellData {
  label: string
  variant: 'default' | 'success' | 'warn' | 'danger' | 'info'
}

export interface CoverageRowData {
  employmentId: string
  workerName: string
  /** Six padded cells (the spec reads cells.0..cells.5). */
  cells: CoverageCellData[]
}

export interface RequirementRow {
  id: string
  subjectName: string
  typeCode: string
  severity: string
  severityVariant: 'warn' | 'danger'
  windowLabel: string
}

export interface AlertRow {
  id: string
  workerName: string
  typeLabel: string
  dueOn: string
  sentLabel: string
}

export interface QualificationsPageData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  viewTabs: Awaited<ReturnType<typeof hrmPeopleViewTabs>>
  canManage: boolean
  recordHref: string
  recordLabel: string
  settingsHref: string
  settingsLabel: string
  tiles: { iconKey: string; accent: string; label: string; value: string; tone: 'default' | 'success' | 'warn' | 'danger' | 'info' }[]
  sectionLabel: string
  sectionOptions: { value: string; label: string }[]
  section: QualificationSection
  segmentsLabel: string
  allLabel: string
  segments: { value: string; label: string; count: number }[]
  segment: QualificationSegment
  typesLabel: string
  typesAll: string
  typeOptions: { value: string; label: string }[]
  typeFilter: string
  currentParams: Record<string, string>
  listTitle: string
  columns: Record<string, string>
  openLabel: string
  emptyTitle: string
  emptyDescription: string
  rows: QualificationRow[]
  truncated: boolean
  dialogQualificationId: string | null
  dialogCloseHref: string
  dialogOpen: boolean
  recordOpen: boolean
  dialogVisible: boolean
  taxonomyTitle: string
  requirementsTitle: string
  requirementsEmpty: string
  requirements: RequirementRow[]
  coverageTitle: string
  coverageProjectLabel: string
  coverageProjectAll: string
  coverageEmpty: string
  projectOptions: { value: string; label: string }[]
  coverageProjectId: string | null
  coverageTypes: CoverageColumn[]
  coverageRows: CoverageRowData[]
  coverageTruncated: boolean
  coverageTypesTruncated: boolean
  alertsTitle: string
  alertsEmpty: string
  alerts: AlertRow[]
}

const STATUS_VARIANT: Record<DerivedQualificationStatus, QualificationRow['statusVariant']> = {
  valid: 'success',
  expiring: 'warn',
  expired: 'danger',
  revoked: 'default',
  pending_verification: 'info',
  not_yet_effective: 'info',
}

async function employmentsForParties(orgId: string, partyIds: string[]): Promise<Map<string, string>> {
  if (partyIds.length === 0) return new Map()
  const rows = (
    await db.execute<{ party: string; employment: string }>(sql`
      select worker_party_id::text as party, id::text as employment
        from worker_employments
       where org_id = ${orgId} and worker_party_id in (select jsonb_array_elements_text(${JSON.stringify(partyIds)}::jsonb)::uuid)
       order by created_at desc
    `)
  ).rows
  const map = new Map<string, string>()
  for (const row of rows) {
    if (!map.has(row.party)) map.set(row.party, row.employment)
  }
  return map
}

type HrmT = Awaited<ReturnType<typeof getTranslations>>

function statusLabel(t: HrmT, status: DerivedQualificationStatus): string {
  return t.has(`qualifications.statusNames.${status}`) ? t(`qualifications.statusNames.${status}`) : status
}

export async function loadQualificationsPage(
  authz: Authz,
  sp: Record<string, string | undefined>,
  canManage: boolean,
): Promise<QualificationsPageData> {
  const orgId = authz.user.orgId
  const actorId = authz.user.id
  const t = await getTranslations('hrm')
  const segment = (sp.segment ?? 'all') as QualificationSegment
  const typeFilter = sp.type ?? 'all'
  const section = (sp.section === 'requirements' || sp.section === 'alerts' ? sp.section : 'ledger') as QualificationSection
  const today = await businessToday(orgId)

  const [all, types, requirements, alerts] = await Promise.all([
    listQualifications(db, { orgId, actorId }),
    listQualificationTypes(db, { orgId, actorId }),
    listRequirements(db, { orgId, actorId }),
    listAlerts(db, { orgId, actorId }),
  ])

  const counts: Record<QualificationSegment, number> = {
    all: all.length,
    valid: 0,
    expiring: 0,
    expired: 0,
    revoked: 0,
    pending_verification: 0,
    not_yet_effective: 0,
  }
  for (const q of all) counts[q.status] += 1

  // Expired and still assigned: expired credentials whose employment sits
  // behind a schedule resource on a project that declares requirements.
  const gatedProjects = [...new Set(requirements.filter((r) => r.subjectKind === 'project').map((r) => r.subjectId))]
  let expiredAssigned = 0
  if (gatedProjects.length > 0) {
    const assigned = (
      await db.execute<{ employment: string }>(sql`
        select distinct e.id::text as employment
          from schedule_resources r
          join worker_employments e on e.org_id = r.org_id and e.worker_party_id = r.party_id
         where r.org_id = ${orgId} and r.project_id in (select jsonb_array_elements_text(${JSON.stringify(gatedProjects)}::jsonb)::uuid)
      `)
    ).rows.map((r) => r.employment)
    const assignedSet = new Set(assigned)
    expiredAssigned = all.filter((q) => q.status === 'expired' && assignedSet.has(q.employmentId)).length
  }

  // Projects with unmet block requirements: at least one assigned
  // employment fails a block check as of today (bounded probe).
  let projectsUnmet = 0
  const probeProjects = gatedProjects.slice(0, 20)
  for (const projectId of probeProjects) {
    const crew = (
      await db.execute<{ employment: string }>(sql`
        select distinct e.id::text as employment
          from schedule_resources r
          join worker_employments e on e.org_id = r.org_id and e.worker_party_id = r.party_id
         where r.org_id = ${orgId} and r.project_id = ${projectId}::uuid
         limit 50
      `)
    ).rows.map((r) => r.employment)
    for (const employmentId of crew) {
      const verdict = await checkAssignmentInternal(db, orgId, employmentId, 'project', projectId, today)
      if (!verdict.ok) {
        projectsUnmet += 1
        break
      }
    }
  }

  const filtered = all.filter(
    (q) => (segment === 'all' || q.status === segment) && (typeFilter === 'all' || q.type.id === typeFilter),
  )
  const truncated = filtered.length > 200
  const page = filtered.slice(0, 200)

  const labels = await loadQueueLabels(orgId, [...new Set(page.map((q) => q.employmentId))], [])

  const baseParams = (extra: Record<string, string | undefined>): Record<string, string> => {
    const out: Record<string, string> = {}
    if (sp.segment) out.segment = sp.segment
    if (sp.type) out.type = sp.type
    if (sp.section) out.section = sp.section
    if (sp.projectId) out.projectId = sp.projectId
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete out[k]
      else out[k] = v
    }
    return out
  }
  const href = (params: Record<string, string>): string => {
    const qs = new URLSearchParams(params).toString()
    return qs ? `/hrm/qualifications?${qs}` : '/hrm/qualifications'
  }

  const rows: QualificationRow[] = page.map((q: WorkerQualification) => {
    const label = labels.workerByEmployment.get(q.employmentId)
    return {
      id: q.id,
      employmentId: q.employmentId,
      workerName: label?.name ?? q.employmentId,
      workerHref: label?.partyId ? `/entities/employees?party=${encodeURIComponent(label.partyId)}` : null,
      typeCode: q.type.code,
      typeName: q.type.name,
      status: q.status,
      statusLabel: '',
      statusVariant: STATUS_VARIANT[q.status] ?? 'default',
      expiryLabel: q.expiresOn,
      identifierLabel: q.identifier,
      openHref: href({ ...baseParams({}), qualification: q.id }),
    }
  })

  // Coverage matrix for the selected project (rows = crew employments,
  // cols = required types, cells = gate chips), bounded for the page.
  const projectOptions = [...new Map(requirements.filter((r) => r.subjectKind === 'project').map((r) => [r.subjectId, r.subjectName])).entries()].map(
    ([value, label]) => ({ value, label }),
  )
  const coverageProjectId = sp.projectId && projectOptions.some((p) => p.value === sp.projectId)
    ? sp.projectId
    : (projectOptions[0]?.value ?? null)
  const allCoverageTypes = requirements
    .filter((r) => r.subjectKind === 'project' && r.subjectId === coverageProjectId)
    .map((r) => ({ code: r.typeCode, name: r.typeName, id: r.typeId }))
  // The spec reads six fixed columns (cells.0..cells.5): show the first
  // six required types, pad the rest with blanks.
  const coverageTypesTruncated = allCoverageTypes.length > 6
  const coverageTypes = allCoverageTypes.slice(0, 6)
  const coverageRows: CoverageRowData[] = []
  let coverageTruncated = false
  if (coverageProjectId) {
    const crewParties = (
      await db.execute<{ party: string }>(sql`
        select distinct r.party_id::text as party from schedule_resources r
         where r.org_id = ${orgId} and r.project_id = ${coverageProjectId}::uuid and r.party_id is not null
         limit 51
      `)
    ).rows.map((r) => r.party)
    coverageTruncated = crewParties.length > 50
    // party → employment, then display names through the shared labels.
    const employmentByParty = await employmentsForParties(orgId, crewParties.slice(0, 50))
    const crewEmployments = [...employmentByParty.values()]
    const crewLabels = await loadQueueLabels(orgId, crewEmployments, [])
    // One gate read per employment covers every column: the verdict
    // already splits blocking from warnings per type.
    for (const employment of crewEmployments) {
      const verdict = await checkAssignmentInternal(db, orgId, employment, 'project', coverageProjectId, today)
      const findings = [...(verdict.ok ? verdict.warnings : [...verdict.blocking, ...verdict.warnings])]
      const cells: CoverageCellData[] = coverageTypes.map((type) => {
        const relevant = findings.filter((f) => f.typeId === type.id)
        if (relevant.length === 0) return { label: t('qualifications.coverage.qualified'), variant: 'success' as const }
        const worst = relevant.some((f) => f.severity === 'block') ? 'danger' : ('warn' as const)
        const reason = relevant[0]!.reason
        return {
          label: t(`qualifications.coverage.${reason}`),
          variant: worst === 'danger' ? ('danger' as const) : worst,
        }
      })
      while (cells.length < 6) cells.push({ label: '—', variant: 'default' as const })
      coverageRows.push({
        employmentId: employment,
        workerName: crewLabels.workerByEmployment.get(employment)?.name ?? employment,
        cells,
      })
    }
  }

  const alertWorkerIds = [...new Set(alerts.map((a) => a.employmentId))]
  const alertLabels = await loadQueueLabels(orgId, alertWorkerIds, [])

  const paddedTypes: CoverageColumn[] = [...coverageTypes.map((t) => ({ code: t.code, name: t.name }))]
  while (paddedTypes.length < 6) paddedTypes.push({ code: '—', name: '' })

  return {
    title: t('qualifications.title'),
    description: t('qualifications.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/qualifications'),
    viewTabs: await hrmPeopleViewTabs(authz, '/hrm/qualifications'),
    canManage,
    recordHref: href({ ...baseParams({}), record: 'new' }),
    recordLabel: t('qualifications.record'),
    settingsHref: '/admin/setup?section=hrm-qualifications',
    settingsLabel: t('qualifications.settings'),
    tiles: [
      { iconKey: 'clock', accent: 'amber', label: t('qualifications.tiles.expiring'), value: String(counts.expiring), tone: 'warn' as const },
      { iconKey: 'alert', accent: 'red', label: t('qualifications.tiles.expiredAssigned'), value: String(expiredAssigned), tone: 'danger' as const },
      { iconKey: 'hourglass', accent: 'blue', label: t('qualifications.tiles.pending'), value: String(counts.pending_verification), tone: 'info' as const },
      { iconKey: 'building', accent: 'amber', label: t('qualifications.tiles.projectsUnmet'), value: String(projectsUnmet), tone: 'warn' as const },
    ],
    sectionLabel: t('qualifications.sectionLabel'),
    sectionOptions: (['ledger', 'requirements', 'alerts'] as QualificationSection[]).map((value) => ({
      value,
      label: t(`qualifications.sections.${value}`),
    })),
    section,
    segmentsLabel: t('qualifications.segmentsLabel'),
    allLabel: t('qualifications.allLabel'),
    segments: (['all', 'expiring', 'expired', 'pending_verification', 'not_yet_effective', 'valid', 'revoked'] as QualificationSegment[]).map(
      (value) => ({
        value,
        label: value === 'all' ? t('qualifications.allLabel') : statusLabel(t, value),
        count: counts[value],
      }),
    ),
    segment,
    typesLabel: t('qualifications.typesLabel'),
    typesAll: t('qualifications.typesAll'),
    typeOptions: [
      { value: 'all', label: t('qualifications.typesAll') },
      ...types.filter((x) => x.isActive).map((x) => ({ value: x.id, label: x.code })),
    ],
    typeFilter,
    currentParams: baseParams({}),
    listTitle: t('qualifications.listTitle'),
    columns: {
      worker: t('qualifications.columns.worker'),
      type: t('qualifications.columns.type'),
      status: t('qualifications.columns.status'),
      expiry: t('qualifications.columns.expiry'),
      open: t('qualifications.open'),
      subject: t('qualifications.columns.subject'),
      severity: t('qualifications.columns.severity'),
      window: t('qualifications.columns.window'),
      due: t('qualifications.columns.due'),
      sent: t('qualifications.columns.sent'),
    },
    openLabel: t('qualifications.open'),
    emptyTitle: t('qualifications.emptyTitle'),
    emptyDescription: t('qualifications.emptyDescription'),
    rows: rows.map((r) => ({ ...r, statusLabel: statusLabel(t, r.status) })),
    truncated,
    dialogQualificationId: sp.qualification && sp.qualification !== 'new' ? sp.qualification : null,
    dialogCloseHref: href(baseParams({ qualification: undefined, record: undefined })),
    dialogOpen: !!sp.qualification && sp.qualification !== 'new',
    recordOpen: sp.qualification === 'new' || sp.record === 'new',
    dialogVisible: !!sp.qualification || sp.record === 'new',
    taxonomyTitle: t('qualifications.taxonomyTitle'),
    requirementsTitle: t('qualifications.requirementsTitle'),
    requirementsEmpty: t('qualifications.requirementsEmpty'),
    requirements: requirements.map((r) => ({
      id: r.id,
      subjectName: r.subjectName,
      typeCode: r.typeCode,
      severity: r.severity,
      severityVariant: (r.severity === 'block' ? 'danger' : 'warn') as 'danger' | 'warn',
      windowLabel: r.requiredTo ? `${r.requiredFrom} – ${r.requiredTo}` : t('qualifications.windowOpen', { from: r.requiredFrom }),
    })),
    coverageTitle: t('qualifications.coverageTitle'),
    coverageProjectLabel: t('qualifications.coverageProjectLabel'),
    coverageProjectAll: t('qualifications.coverageProjectAll'),
    coverageEmpty: t('qualifications.coverageEmpty'),
    projectOptions,
    coverageProjectId,
    coverageTypes: paddedTypes,
    coverageRows,
    coverageTruncated,
    coverageTypesTruncated,
    alertsTitle: t('qualifications.alertsTitle'),
    alertsEmpty: t('qualifications.alertsEmpty'),
    alerts: alerts.map((a) => ({
      id: a.id,
      workerName: alertLabels.workerByEmployment.get(a.employmentId)?.name ?? a.employmentId,
      typeLabel: `${a.typeCode} · ${a.typeName}`,
      dueOn: a.dueOn,
      sentLabel: a.sentAt ?? t('qualifications.alertDue'),
    })),
  }
}

export interface QualificationAttention {
  expiring: number
  expired: number
}

// HR-14 begin: cockpit attention counts — how many held qualifications
// project as expiring or expired today. Null without the certifications
// read grant or while the switch is off (a refusal or an off-switch is
// an omitted item, never a zero that reads as all-clear); only
// authorization and feature refusals degrade to null, infrastructure
// failures propagate.
export async function loadQualificationAttention(authz: Authz): Promise<QualificationAttention | null> {
  if (!can(authz, 'hrm.certifications.read')) return null
  try {
    const held = await listQualifications(db, { orgId: authz.user.orgId, actorId: authz.user.id })
    return {
      expiring: held.filter((q) => q.status === 'expiring').length,
      expired: held.filter((q) => q.status === 'expired').length,
    }
  } catch (error) {
    if (error instanceof HrmQualificationError || error instanceof HrmAuthorizationError) return null
    throw error
  }
}
// HR-14 end
