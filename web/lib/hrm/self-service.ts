import 'server-only'

import { getTranslations } from 'next-intl/server'
import { actorHasTeam, findTeamEmploymentIdsForParty } from '@openbooks/engine/src/hrm/self-service/team-read.ts'
import { getMyProfile,
  getMyRequests,
  getMySteps,
  type MyRequest,
  type MyStep,
} from '@openbooks/engine/src/hrm/self-service/self-read.ts'
import {
  getMyBenefitsWorkspace,
  getMyReviewWorkspace,
  loadManagerOwedReviews,
  selfWorkspaceCapabilities,
} from '@openbooks/engine/src/hrm/self-service/my-work.ts'
import { getTeamView, type TeamView } from '@openbooks/engine/src/hrm/self-service/team-read.ts'
import { HrmAuthorizationError } from '@openbooks/engine/src/hrm/authorization.ts'
import { SelfServiceError } from '@openbooks/engine/src/hrm/self-service/actor.ts'
import { can, type Authz } from '../authz'
import type { DirectoryItem } from '../../components/module-home/ui'
import type { ModuleHomeTab } from '../../components/module-home/ui'
import { loadMyLeave, type MyLeaveBalance } from './leave'

/**
 * Me workspace loaders — the person's own view of their employment and the
 * manager's team. Rows come from the self-service engine reads (party
 * behind the login, structural team), never a direct table read from the
 * web app. Computed refusals travel as data: pages render them beside the
 * panels, never an empty workspace pretending the person has no record.
 *
 * EXTENSION POINT (HR-7 reviews, HR-8 benefits): SELF_SERVICE_EXTENSIONS
 * below is the rail the /me overview fills from. A shard that lands a new
 * person-scoped section appends one entry here (href, hrm-namespace label
 * key, icon key) and the loader resolves it into a DirectoryItem — never a
 * placeholder panel promising a section that does not exist yet.
 */

export interface SelfServiceExtension {
  href: string
  /** hrm-namespace message key for the label. */
  labelKey: string
  iconKey: string
  /** Tab capability gating the rail entry: hidden is a fact, never a refusal. */
  capability?: 'reviews' | 'benefits'
}

export const SELF_SERVICE_EXTENSIONS: SelfServiceExtension[] = [
  { href: '/me/reviews', labelKey: 'me.tabs.reviews', iconKey: 'star', capability: 'reviews' },
  { href: '/me/benefits', labelKey: 'me.tabs.benefits', iconKey: 'heart', capability: 'benefits' },
]

export type StatusVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'

function statusVariant(status: string): StatusVariant {
  if (status === 'active' || status === 'approved' || status === 'done') return 'success'
  if (status === 'draft' || status === 'offered') return 'secondary'
  if (status === 'submitted' || status === 'pending_approval' || status === 'on_leave') return 'warning'
  if (status === 'rejected' || status === 'terminated') return 'destructive'
  if (status === 'withdrawn' || status === 'cancelled' || status === 'applied' || status === 'suspended') return 'outline'
  return 'default'
}

type Catalog = {
  (key: string, params?: Record<string, string | number>): string
  has: (key: string) => boolean
}

function statusLabel(t: Catalog, prefix: string, status: string): string {
  return t.has(`${prefix}.${status}`) ? t(`${prefix}.${status}`) : status
}

/** The Me strip: Overview, Profile, Leave (the /hrm/my-leave inbox as its
 * route), Checklists, Reviews and Benefits only when the org holds review
 * cycles / benefit plans at all, and Team only when the actor holds direct
 * reports. Hidden tabs are facts, never refusals. */
export async function meTabs(authz: Authz, activeHref: string): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('hrm')
  const [hasTeam, caps] = await Promise.all([
    actorHasTeam({ orgId: authz.user.orgId, actorId: authz.user.id }).catch(() => false),
    selfWorkspaceCapabilities(authz.user.orgId).catch(() => ({ hasReviewCycles: false, hasBenefitPlans: false })),
  ])
  const tabs: ModuleHomeTab[] = [
    { href: '/me', label: t('me.tabs.overview'), active: activeHref === '/me' },
    { href: '/me/profile', label: t('me.tabs.profile'), active: activeHref === '/me/profile' },
    { href: '/hrm/my-leave', label: t('me.tabs.leave'), active: activeHref === '/hrm/my-leave' },
    { href: '/me/checklists', label: t('me.tabs.checklists'), active: activeHref === '/me/checklists' },
  ]
  if (caps.hasReviewCycles || activeHref === '/me/reviews') {
    tabs.push({ href: '/me/reviews', label: t('me.tabs.reviews'), active: activeHref === '/me/reviews' })
  }
  if (caps.hasBenefitPlans || activeHref === '/me/benefits') {
    tabs.push({ href: '/me/benefits', label: t('me.tabs.benefits'), active: activeHref === '/me/benefits' })
  }
  if (hasTeam || activeHref === '/me/team') {
    tabs.push({ href: '/me/team', label: t('me.tabs.team'), active: activeHref === '/me/team' })
  }
  return tabs
}

export interface MeRefusal {
  title: string
  message: string
}

function toRefusal(t: Catalog, error: unknown): MeRefusal | null {
  if (error instanceof SelfServiceError || error instanceof HrmAuthorizationError) {
    return { title: t('me.refusedTitle'), message: error.message }
  }
  return null
}

export interface MeFact {
  label: string
  value: string
}

export interface MeStepRow extends MyStep {
  statusLabel: string
  statusVariant: StatusVariant
  requiredLabel: string
  completeLabel: string
  overdueLabel: string | null
}

export interface MeRequestRow extends MyRequest {
  kindLabel: string
  statusLabel: string
  statusVariant: StatusVariant
  submittedLabel: string | null
}

export interface MeEmploymentRow {
  employmentId: string
  employer: string
  title: string
  department: string
  statusLabel: string
  statusVariant: StatusVariant
  manager: string
  serviceStart: string
}

export interface MeOverviewData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  hasTeam: boolean
  displayName: string | null
  employments: MeEmploymentRow[]
  employmentsTitle: string
  employmentsColumns: { employer: string; title: string; department: string; status: string; manager: string; serviceStart: string }
  employmentsEmpty: string
  employmentsEmptyDescription: string
  stepsTitle: string
  steps: MeStepRow[]
  stepsEmpty: string
  stepsEmptyDescription: string
  stepsColumns: { title: string; process: string; due: string; status: string }
  checklistsHref: string
  viewChecklists: string
  requestsTitle: string
  requests: MeRequestRow[]
  requestsEmpty: string
  requestsEmptyDescription: string
  requestsColumns: { kind: string; status: string; submitted: string }
  balancesTitle: string
  balances: MyLeaveBalance[]
  balancesEmpty: string
  timeKindLabel: string
  valueKindLabel: string
  unlimitedLabel: string
  leaveHref: string
  viewLeave: string
  extensionsTitle: string
  extensions: DirectoryItem[]
  hasExtensions: boolean
  profileHref: string
  editProfile: string
}

function stepRows(t: Catalog, steps: MyStep[]): MeStepRow[] {
  return steps.map((step) => ({
    ...step,
    // The read selects pending steps on open processes only: status is a
    // display constant, never a second source of truth.
    statusLabel: statusLabel(t, 'me.stepStatus', 'pending'),
    statusVariant: statusVariant('pending'),
    requiredLabel: step.required ? t('me.checklists.required') : t('me.checklists.optional'),
    completeLabel: t('me.checklists.complete'),
    overdueLabel: step.overdue ? t('me.checklists.overdue') : null,
  }))
}

function requestRows(t: Catalog, requests: MyRequest[]): MeRequestRow[] {
  return requests.map((request) => ({
    ...request,
    kindLabel: statusLabel(t, 'me.requestKinds', request.kind),
    statusLabel: statusLabel(t, 'me.requestStatus', request.status),
    statusVariant: statusVariant(request.status),
    submittedLabel: request.submittedAt,
  }))
}

/** The Me overview: employment summary, open steps, pending requests,
 * balances, and the extension rail. Leave details ride the shared
 * self-service inbox loader so the numbers always agree. */
export async function loadMeOverview(authz: Authz): Promise<MeOverviewData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const tabs = await meTabs(authz, '/me')
  const base = {
    title: t('me.overview.title'),
    description: t('me.overview.description'),
    tabs,
    stepsTitle: t('me.overview.stepsTitle'),
    stepsEmpty: t('me.overview.stepsEmpty'),
    stepsEmptyDescription: t('me.overview.stepsEmptyDescription'),
    stepsColumns: {
      title: t('me.checklists.columns.title'),
      process: t('me.checklists.columns.process'),
      due: t('me.checklists.columns.due'),
      status: t('me.checklists.columns.status'),
    },
    checklistsHref: '/me/checklists',
    viewChecklists: t('me.overview.viewChecklists'),
    requestsTitle: t('me.overview.requestsTitle'),
    requestsEmpty: t('me.overview.requestsEmpty'),
    requestsEmptyDescription: t('me.overview.requestsEmptyDescription'),
    requestsColumns: {
      kind: t('me.requests.columns.kind'),
      status: t('me.requests.columns.status'),
      submitted: t('me.requests.columns.submitted'),
    },
    balancesTitle: t('me.overview.balancesTitle'),
    balancesEmpty: t('me.overview.balancesEmpty'),
    timeKindLabel: t('myLeave.timeKind'),
    valueKindLabel: t('myLeave.valueKind'),
    unlimitedLabel: t('myLeave.unlimited'),
    leaveHref: '/hrm/my-leave',
    viewLeave: t('me.overview.viewLeave'),
    extensionsTitle: t('me.overview.extensionsTitle'),
    profileHref: '/me/profile?edit=1',
    editProfile: t('me.profile.edit'),
    employmentsTitle: t('me.overview.employmentsTitle'),
    employmentsColumns: {
      employer: t('me.overview.employer'),
      title: t('me.overview.jobTitle'),
      department: t('me.overview.department'),
      status: t('me.overview.status'),
      manager: t('me.overview.manager'),
      serviceStart: t('me.overview.serviceStart'),
    },
    employmentsEmpty: t('me.overview.employmentsEmpty'),
    employmentsEmptyDescription: t('me.overview.employmentsEmptyDescription'),
  }
  try {
    const [profile, steps, requests, inbox, hasTeam, caps] = await Promise.all([
      getMyProfile({ orgId, actorId: authz.user.id }),
      getMySteps({ orgId, actorId: authz.user.id }),
      getMyRequests({ orgId, actorId: authz.user.id }),
      loadMyLeave(authz, {}).catch(() => null),
      actorHasTeam({ orgId, actorId: authz.user.id }).catch(() => false),
      selfWorkspaceCapabilities(orgId).catch(() => ({ hasReviewCycles: false, hasBenefitPlans: false })),
    ])
    const visible = SELF_SERVICE_EXTENSIONS.filter(
      (extension) =>
        extension.capability === undefined ||
        (extension.capability === 'reviews' ? caps.hasReviewCycles : caps.hasBenefitPlans),
    )
    const extensions: DirectoryItem[] = visible.map((extension) => ({
      href: extension.href,
      label: t.has(extension.labelKey) ? t(extension.labelKey) : extension.labelKey,
      iconKey: extension.iconKey,
    }))
    return {
      ...base,
      refusal: null,
      hasContent: true,
      hasTeam,
      displayName: profile.displayName,
      employments: profile.employments.map((summary) => ({
        employmentId: summary.employmentId,
        employer: summary.employerName,
        title: summary.jobTitle ?? t('me.overview.notAvailable'),
        department: summary.departmentName ?? t('me.overview.notAvailable'),
        statusLabel: statusLabel(t, 'me.employmentStatus', summary.status),
        statusVariant: statusVariant(summary.status),
        manager: summary.managerNames.length > 0 ? summary.managerNames.join(', ') : t('me.overview.notAvailable'),
        serviceStart: summary.serviceStart,
      })),
      steps: stepRows(t, steps.slice(0, 5)),
      requests: requestRows(t, requests.filter((row) => row.status === 'draft' || row.status === 'pending_approval').slice(0, 5)),
      balances: inbox?.balances ?? [],
      extensions,
      hasExtensions: extensions.length > 0,
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return {
      ...base,
      refusal,
      hasContent: refusal === null,
      hasTeam: false,
      displayName: null,
      employments: [],
      steps: [],
      requests: [],
      balances: [],
      extensions: [],
      hasExtensions: false,
    }
  }
}

export interface MeProfileData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  displayName: string
  contactTitle: string
  contactFacts: MeFact[]
  addressTitle: string
  addressFacts: MeFact[]
  noAddress: string
  emergencyTitle: string
  emergencyFacts: MeFact[]
  noEmergency: string
  editButton: string
  editHref: string
  dialogOpen: boolean
  dialogCloseHref: string
  dialog: {
    title: string
    description: string
    employments: { value: string; label: string }[]
    employmentLabel: string
    phoneLabel: string
    emailLabel: string
    addressLabel: string
    line1Label: string
    line2Label: string
    cityLabel: string
    regionLabel: string
    postalCodeLabel: string
    countryLabel: string
    emergencyLabel: string
    emergencyNameLabel: string
    emergencyRelationshipLabel: string
    emergencyPhoneLabel: string
    reasonLabel: string
    reasonPlaceholder: string
    clearHint: string
    submitLabel: string
    cancelLabel: string
    submitFailed: string
  } | null
  pendingTitle: string | null
  pendingMessage: string | null
  hasPending: boolean
}

function addressLine(t: Catalog, value: string | null): string {
  return value ?? t('me.overview.notAvailable')
}

/** The person's party fields in a read view; Edit opens a URL-drawer form
 * whose submit files the profile_change request. Nothing else on the party
 * is editable here. */
export async function loadMeProfile(
  authz: Authz,
  sp: Record<string, string | undefined> = {},
): Promise<MeProfileData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const tabs = await meTabs(authz, '/me/profile')
  const base = {
    title: t('me.profile.title'),
    description: t('me.profile.description'),
    tabs,
    contactTitle: t('me.profile.contactTitle'),
    addressTitle: t('me.profile.addressTitle'),
    noAddress: t('me.profile.noAddress'),
    emergencyTitle: t('me.profile.emergencyTitle'),
    noEmergency: t('me.profile.noEmergency'),
    editButton: t('me.profile.edit'),
    editHref: '/me/profile?edit=1',
    dialogCloseHref: '/me/profile',
    pendingTitle: null as string | null,
    pendingMessage: null as string | null,
    hasPending: false,
  }
  try {
    const [profile, requests] = await Promise.all([
      getMyProfile({ orgId, actorId: authz.user.id }),
      getMyRequests({ orgId, actorId: authz.user.id }),
    ])
    const pending = requests.find((row) => row.kind === 'profile_change' && (row.status === 'draft' || row.status === 'pending_approval'))
    const address = profile.address
    return {
      ...base,
      refusal: null,
      hasContent: true,
      displayName: profile.displayName,
      contactFacts: [
        { label: t('me.profile.phone'), value: profile.phone ?? t('me.overview.notAvailable') },
        { label: t('me.profile.email'), value: profile.email ?? t('me.overview.notAvailable') },
      ],
      addressFacts: address
        ? [
            ...(address.label ? [{ label: t('me.profile.addressLabel'), value: address.label }] : []),
            { label: t('me.profile.line1'), value: addressLine(t, address.line1) },
            { label: t('me.profile.line2'), value: addressLine(t, address.line2) },
            { label: t('me.profile.city'), value: addressLine(t, address.city) },
            { label: t('me.profile.region'), value: addressLine(t, address.region) },
            { label: t('me.profile.postalCode'), value: addressLine(t, address.postalCode) },
            { label: t('me.profile.country'), value: addressLine(t, address.country) },
          ]
        : [],
      emergencyFacts: profile.emergencyContact
        ? [
            { label: t('me.profile.emergencyName'), value: profile.emergencyContact.name ?? t('me.overview.notAvailable') },
            {
              label: t('me.profile.emergencyRelationship'),
              value: profile.emergencyContact.relationship ?? t('me.overview.notAvailable'),
            },
            { label: t('me.profile.emergencyPhone'), value: profile.emergencyContact.phone ?? t('me.overview.notAvailable') },
          ]
        : [],
      dialogOpen: sp.edit !== undefined,
      dialog: sp.edit !== undefined
        ? {
            title: t('me.profile.dialogTitle'),
            description: t('me.profile.dialogDescription'),
            employments: profile.employments.map((summary) => ({
              value: summary.employmentId,
              label: `${summary.employerName} — ${statusLabel(t, 'me.employmentStatus', summary.status)}`,
            })),
            employmentLabel: t('me.profile.employment'),
            phoneLabel: t('me.profile.phone'),
            emailLabel: t('me.profile.email'),
            addressLabel: t('me.profile.addressTitle'),
            line1Label: t('me.profile.line1'),
            line2Label: t('me.profile.line2'),
            cityLabel: t('me.profile.city'),
            regionLabel: t('me.profile.region'),
            postalCodeLabel: t('me.profile.postalCode'),
            countryLabel: t('me.profile.country'),
            emergencyLabel: t('me.profile.emergencyTitle'),
            emergencyNameLabel: t('me.profile.emergencyName'),
            emergencyRelationshipLabel: t('me.profile.emergencyRelationship'),
            emergencyPhoneLabel: t('me.profile.emergencyPhone'),
            reasonLabel: t('me.profile.reason'),
            reasonPlaceholder: t('me.profile.reasonPlaceholder'),
            clearHint: t('me.profile.clearHint'),
            submitLabel: t('me.profile.submit'),
            cancelLabel: t('me.profile.cancel'),
            submitFailed: t('me.profile.submitFailed'),
          }
        : null,
      pendingTitle: pending ? t('me.profile.pendingTitle') : null,
      pendingMessage: pending
        ? t('me.profile.pendingMessage', { status: statusLabel(t, 'me.requestStatus', pending.status) })
        : null,
      hasPending: pending !== undefined,
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return {
      ...base,
      refusal,
      hasContent: refusal === null,
      displayName: '',
      contactFacts: [],
      addressFacts: [],
      emergencyFacts: [],
      dialogOpen: false,
      dialog: null,
    }
  }
}

export interface MeChecklistsData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  listTitle: string
  columns: { title: string; process: string; due: string; required: string; evidence: string; status: string }
  rows: (MeStepRow & { evidenceLabel: string })[]
  emptyTitle: string
  emptyDescription: string
  completeFailed: string
}

/** My process steps with the complete action (the existing step endpoint;
 * the evidence rules are unchanged). */
export async function loadMeChecklists(authz: Authz): Promise<MeChecklistsData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const base = {
    title: t('me.checklists.title'),
    description: t('me.checklists.description'),
    tabs: await meTabs(authz, '/me/checklists'),
    listTitle: t('me.checklists.listTitle'),
    columns: {
      title: t('me.checklists.columns.title'),
      process: t('me.checklists.columns.process'),
      due: t('me.checklists.columns.due'),
      required: t('me.checklists.columns.required'),
      evidence: t('me.checklists.columns.evidence'),
      status: t('me.checklists.columns.status'),
    },
    emptyTitle: t('me.checklists.emptyTitle'),
    emptyDescription: t('me.checklists.emptyDescription'),
    completeFailed: t('me.checklists.completeFailed'),
  }
  try {
    const steps = await getMySteps({ orgId, actorId: authz.user.id })
    return {
      ...base,
      refusal: null,
      hasContent: true,
      rows: stepRows(t, steps).map((row) => ({
        ...row,
        evidenceLabel: statusLabel(t, 'me.evidenceKinds', row.evidenceKind),
      })),
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return { ...base, refusal, hasContent: refusal === null, rows: [] }
  }
}

export interface MeTeamReportRow {
  employmentId: string
  workerName: string
  workerHref: string | null
  title: string
  department: string
  employer: string
  statusLabel: string
  statusVariant: StatusVariant
  serviceStart: string
}

export interface MeTeamLeaveRow {
  id: string
  workerName: string
  leaveTypeCode: string
  rangeLabel: string
  hours: string
  decideLabel: string
  decideHref: string
}

export interface MeTeamChangeRow {
  id: string
  workerName: string
  kindLabel: string
  statusLabel: string
  statusVariant: StatusVariant
  decideLabel: string
  decideHref: string
}

export interface MeTeamData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  asOf: string
  rosterTitle: string
  rosterColumns: { name: string; title: string; department: string; status: string; serviceStart: string }
  roster: MeTeamReportRow[]
  rosterEmpty: string
  stepsTitle: string
  stepsColumns: { employee: string; title: string; due: string }
  teamSteps: (TeamView['openSteps'][number] & { overdueLabel: string | null })[]
  stepsEmpty: string
  leaveTitle: string
  leaveColumns: { employee: string; type: string; range: string; hours: string }
  pendingLeave: MeTeamLeaveRow[]
  leaveEmpty: string
  approvalsHref: string
  decideInApprovals: string
  changesTitle: string
  changesColumns: { employee: string; kind: string; status: string }
  pendingChanges: MeTeamChangeRow[]
  changesEmpty: string
  owedTitle: string
  owedColumns: { employee: string; cycle: string; status: string; due: string }
  owedReviews: MeTeamOwedRow[]
  owedEmpty: string
  openReview: string
}

/** The manager's team: roster, steps assigned to the manager, pending
 * leave, and pending change requests. Approve/decline rides native
 * Approvals — rows deep-link there and build no second decision path. */
export async function loadMeTeam(authz: Authz): Promise<MeTeamData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const tabs = await meTabs(authz, '/me/team')
  const base = {
    title: t('me.team.title'),
    description: t('me.team.description'),
    tabs,
    rosterTitle: t('me.team.rosterTitle'),
    rosterColumns: {
      name: t('me.team.columns.name'),
      title: t('me.team.columns.title'),
      department: t('me.team.columns.department'),
      status: t('me.team.columns.status'),
      serviceStart: t('me.team.columns.serviceStart'),
    },
    rosterEmpty: t('me.team.rosterEmpty'),
    stepsTitle: t('me.team.stepsTitle'),
    stepsColumns: {
      employee: t('me.team.columns.name'),
      title: t('me.checklists.columns.title'),
      due: t('me.checklists.columns.due'),
    },
    stepsEmpty: t('me.team.stepsEmpty'),
    leaveTitle: t('me.team.leaveTitle'),
    leaveColumns: {
      employee: t('me.team.columns.name'),
      type: t('leave.columns.type'),
      range: t('leave.columns.range'),
      hours: t('leave.columns.hours'),
    },
    leaveEmpty: t('me.team.leaveEmpty'),
    approvalsHref: '/approvals',
    decideInApprovals: t('me.team.decideInApprovals'),
    changesTitle: t('me.team.changesTitle'),
    changesColumns: {
      employee: t('me.team.columns.name'),
      kind: t('me.requests.columns.kind'),
      status: t('me.requests.columns.status'),
    },
    changesEmpty: t('me.team.changesEmpty'),
    owedTitle: t('me.team.owedTitle'),
    owedColumns: {
      employee: t('me.team.columns.name'),
      cycle: t('me.team.columns.cycle'),
      status: t('me.team.columns.status'),
      due: t('me.checklists.columns.due'),
    },
    owedEmpty: t('me.team.owedEmpty'),
    openReview: t('me.team.openReview'),
  }
  try {
    const [team, owed] = await Promise.all([
      getTeamView({ orgId, actorId: authz.user.id }),
      // A report-less manager refuses inside getTeamView; the owed read
      // answers empty on its own, so the refusal below still names NO_TEAM.
      loadManagerOwedReviews({ orgId, actorId: authz.user.id }).catch(() => []),
    ])
    const canOpenDrawer = can(authz, 'parties.read')
    return {
      ...base,
      refusal: null,
      hasContent: true,
      asOf: team.asOf,
      roster: team.reports.map((report) => ({
        employmentId: report.employmentId,
        workerName: report.workerName,
        // The employee drawer opens on the Employment tab only; a viewer
        // who cannot open the drawer (no parties.read) gets plain names.
        workerHref: canOpenDrawer
          ? `/entities/employees?party=${encodeURIComponent(report.workerPartyId)}&partyTab=employment`
          : null,
        title: report.jobTitle ?? t('me.overview.notAvailable'),
        department: report.departmentName ?? t('me.overview.notAvailable'),
        employer: report.employerName,
        statusLabel: statusLabel(t, 'me.employmentStatus', report.status),
        statusVariant: statusVariant(report.status),
        serviceStart: report.serviceStart,
      })),
      teamSteps: team.openSteps.map((step) => ({
        ...step,
        overdueLabel: step.dueOn < team.asOf ? t('me.checklists.overdue') : null,
      })),
      pendingLeave: team.pendingLeave.map((request) => ({
        id: request.id,
        workerName: request.workerName,
        leaveTypeCode: request.leaveTypeCode,
        rangeLabel: `${request.startsOn} → ${request.endsOn}`,
        hours: request.hours,
        decideLabel: t('me.team.decideInApprovals'),
        decideHref: '/approvals',
      })),
      pendingChanges: team.pendingChanges.map((request) => ({
        id: request.id,
        workerName: request.workerName,
        kindLabel: statusLabel(t, 'me.requestKinds', request.kind),
        statusLabel: statusLabel(t, 'me.requestStatus', request.status),
        statusVariant: statusVariant(request.status),
        decideLabel: t('me.team.decideInApprovals'),
        decideHref: '/approvals',
      })),
      owedReviews: owed.map((row) => ({
        reviewId: row.reviewId,
        workerName: row.workerName,
        cycleName: row.cycleName,
        statusLabel: statusLabel(t, 'me.reviewStatus', row.status),
        statusVariant: statusVariant(row.status),
        dueOn: row.managerDueOn,
        openLabel: t('me.team.openReview'),
        openHref: row.drawerHref,
      })),
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return {
      ...base,
      refusal,
      hasContent: refusal === null,
      asOf: '',
      roster: [],
      teamSteps: [],
      pendingLeave: [],
      pendingChanges: [],
      owedReviews: [],
    }
  }
}

export interface MeTeamOwedRow {
  reviewId: string
  workerName: string
  cycleName: string
  statusLabel: string
  statusVariant: StatusVariant
  dueOn: string | null
  openLabel: string
  openHref: string
}

export interface MeReviewSelfRow {
  reviewId: string
  cycleName: string
  periodLabel: string
  dueOn: string | null
  statusLabel: string
  statusVariant: StatusVariant
  openLabel: string
  openHref: string
}

export interface MeReviewSharedRow {
  reviewId: string
  cycleName: string
  statusLabel: string
  statusVariant: StatusVariant
  ratingLabel: string
  sharedOn: string | null
  canAcknowledge: boolean
  acknowledgeLabel: string
}

export interface MeGoalRowData {
  id: string
  title: string
  dueOn: string | null
  statusLabel: string
  statusVariant: StatusVariant
  progressPercent: number
  progressLabel: string
  updateLabel: string
  updateHref: string
}

export interface MeReviewsData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  selfTitle: string
  selfColumns: { cycle: string; period: string; due: string; status: string }
  selfRows: MeReviewSelfRow[]
  selfEmpty: string
  selfEmptyDescription: string
  answerInDrawer: string
  sharedTitle: string
  sharedColumns: { cycle: string; status: string; rating: string; shared: string }
  sharedRows: MeReviewSharedRow[]
  sharedEmpty: string
  sharedEmptyDescription: string
  acknowledgeFailed: string
  goalsTitle: string
  goalsColumns: { title: string; due: string; status: string; progress: string }
  goalRows: MeGoalRowData[]
  goalsEmpty: string
  goalsEmptyDescription: string
  goalDialogOpen: boolean
  goalDialogCloseHref: string
  goalDialog: {
    goalId: string
    title: string
    description: string
    percentLabel: string
    noteLabel: string
    notePlaceholder: string
    submitLabel: string
    cancelLabel: string
    submitFailed: string
  } | null
}

/** The person's own review cycles: owed self-assessments, shared manager
 * reviews with the acknowledge action, and their own goals with progress.
 * Answering rides the existing performance drawer (rows deep-link there);
 * acknowledge and goal progress post to the Me API routes, which refuse
 * with the service message intact. */
export async function loadMeReviews(
  authz: Authz,
  sp: Record<string, string | undefined> = {},
): Promise<MeReviewsData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const base = {
    title: t('me.reviews.title'),
    description: t('me.reviews.description'),
    tabs: await meTabs(authz, '/me/reviews'),
    selfTitle: t('me.reviews.selfTitle'),
    selfColumns: {
      cycle: t('me.reviews.columns.cycle'),
      period: t('me.reviews.columns.period'),
      due: t('me.checklists.columns.due'),
      status: t('me.reviews.columns.status'),
    },
    selfEmpty: t('me.reviews.selfEmpty'),
    selfEmptyDescription: t('me.reviews.selfEmptyDescription'),
    answerInDrawer: t('me.reviews.answerInDrawer'),
    sharedTitle: t('me.reviews.sharedTitle'),
    sharedColumns: {
      cycle: t('me.reviews.columns.cycle'),
      status: t('me.reviews.columns.status'),
      rating: t('me.reviews.columns.rating'),
      shared: t('me.reviews.columns.shared'),
    },
    sharedEmpty: t('me.reviews.sharedEmpty'),
    sharedEmptyDescription: t('me.reviews.sharedEmptyDescription'),
    acknowledgeFailed: t('me.reviews.acknowledgeFailed'),
    goalsTitle: t('me.reviews.goalsTitle'),
    goalsColumns: {
      title: t('me.reviews.columns.goal'),
      due: t('me.checklists.columns.due'),
      status: t('me.reviews.columns.status'),
      progress: t('me.reviews.columns.progress'),
    },
    goalsEmpty: t('me.reviews.goalsEmpty'),
    goalsEmptyDescription: t('me.reviews.goalsEmptyDescription'),
    goalDialogCloseHref: '/me/reviews',
  }
  try {
    const workspace = await getMyReviewWorkspace({ orgId, actorId: authz.user.id })
    const selfRows: MeReviewSelfRow[] = []
    const sharedRows: MeReviewSharedRow[] = []
    for (const group of workspace.cycles) {
      if (group.mySelf) {
        selfRows.push({
          reviewId: group.mySelf.id,
          cycleName: group.name,
          periodLabel: `${group.periodStartOn} → ${group.periodEndOn}`,
          dueOn: group.mySelf.selfDueOn,
          statusLabel: statusLabel(t, 'me.reviewStatus', group.mySelf.status),
          statusVariant: statusVariant(group.mySelf.status),
          openLabel: t('me.reviews.answerInDrawer'),
          openHref: group.mySelf.drawerHref,
        })
      }
      for (const shared of group.sharedWithMe) {
        sharedRows.push({
          reviewId: shared.id,
          cycleName: group.name,
          statusLabel: statusLabel(t, 'me.reviewStatus', shared.status),
          statusVariant: statusVariant(shared.status),
          ratingLabel: shared.overallRating ?? t('me.overview.notAvailable'),
          sharedOn: shared.sharedAt,
          canAcknowledge: shared.status === 'shared',
          acknowledgeLabel: t('me.reviews.acknowledge'),
        })
      }
    }
    const goalId = typeof sp.goal === 'string' && sp.goal.length > 0 ? sp.goal : null
    const goalDialog =
      goalId && workspace.goals.some((goal) => goal.id === goalId)
        ? {
            goalId,
            title: t('me.reviews.goalDialogTitle'),
            description: t('me.reviews.goalDialogDescription'),
            percentLabel: t('me.reviews.columns.progress'),
            noteLabel: t('me.reviews.goalNoteLabel'),
            notePlaceholder: t('me.reviews.goalNotePlaceholder'),
            submitLabel: t('me.reviews.goalSubmit'),
            cancelLabel: t('me.profile.cancel'),
            submitFailed: t('me.reviews.goalFailed'),
          }
        : null
    return {
      ...base,
      refusal: null,
      hasContent: true,
      selfRows,
      sharedRows,
      goalRows: workspace.goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        dueOn: goal.dueOn,
        statusLabel: statusLabel(t, 'me.goalStatus', goal.status),
        statusVariant: statusVariant(goal.status),
        progressPercent: goal.progressPercent,
        progressLabel: `${goal.progressPercent}%`,
        updateLabel: t('me.reviews.goalUpdate'),
        updateHref: `/me/reviews?goal=${encodeURIComponent(goal.id)}`,
      })),
      goalDialogOpen: goalDialog !== null,
      goalDialog,
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return {
      ...base,
      refusal,
      hasContent: refusal === null,
      selfRows: [],
      sharedRows: [],
      goalRows: [],
      goalDialogOpen: false,
      goalDialog: null,
    }
  }
}

export interface MeElectionRow {
  id: string
  planCode: string
  planName: string
  coverageLabel: string | null
  statusLabel: string
  statusVariant: StatusVariant
  effectiveLabel: string
  employeeAmount: string | null
  changeHref: string | null
  changeLabel: string
}

export interface MeWindowRow {
  id: string
  name: string
  kindLabel: string
  rangeLabel: string
}

export interface MeDependentRow {
  displayName: string
  relationship: string
}

export interface MeBenefitPlanOption {
  value: string
  label: string
  levels: { value: string; label: string }[]
}

export interface MeBenefitsData {
  title: string
  description: string
  tabs: ModuleHomeTab[]
  refusal: MeRefusal | null
  hasContent: boolean
  electionsTitle: string
  electionsColumns: { plan: string; coverage: string; status: string; effective: string; monthly: string }
  elections: MeElectionRow[]
  electionsEmpty: string
  electionsEmptyDescription: string
  monthlyHint: string
  windowsTitle: string
  windowsColumns: { name: string; kind: string; range: string }
  windows: MeWindowRow[]
  windowsEmpty: string
  windowsEmptyDescription: string
  dependentsTitle: string
  dependentsColumns: { name: string; relationship: string }
  dependents: MeDependentRow[]
  dependentsEmpty: string
  electLabel: string
  electHref: string
  dialogOpen: boolean
  dialogCloseHref: string
  dialog: {
    title: string
    description: string
    employmentLabel: string
    employments: { value: string; label: string }[]
    planLabel: string
    plans: MeBenefitPlanOption[]
    levelLabel: string
    windowLabel: string
    windows: { value: string; label: string }[]
    fromLabel: string
    lifeEventLabel: string
    lifeEventPlaceholder: string
    submitLabel: string
    cancelLabel: string
    submitFailed: string
  } | null
  changeDialogOpen: boolean
  changeDialog: {
    enrollmentId: string
    planName: string
    title: string
    description: string
    levelLabel: string
    levels: { value: string; label: string }[]
    dateLabel: string
    reasonLabel: string
    reasonPlaceholder: string
    submitLabel: string
    cancelLabel: string
    submitFailed: string
  } | null
}

/** The person's benefits: current elections with the stored payroll
 * amounts, the open windows covering their employer, dependents on file,
 * and the elect/change dialogs. Amounts render the stored per-period
 * figures — never a recomputed number. */
export async function loadMeBenefits(
  authz: Authz,
  sp: Record<string, string | undefined> = {},
): Promise<MeBenefitsData> {
  const orgId = authz.user.orgId
  const t = (await getTranslations('hrm')) as unknown as Catalog
  const base = {
    title: t('me.benefits.title'),
    description: t('me.benefits.description'),
    tabs: await meTabs(authz, '/me/benefits'),
    electionsTitle: t('me.benefits.electionsTitle'),
    electionsColumns: {
      plan: t('me.benefits.columns.plan'),
      coverage: t('me.benefits.columns.coverage'),
      status: t('me.benefits.columns.status'),
      effective: t('me.benefits.columns.effective'),
      monthly: t('me.benefits.columns.monthly'),
    },
    monthlyHint: t('me.benefits.monthlyHint'),
    electionsEmpty: t('me.benefits.electionsEmpty'),
    electionsEmptyDescription: t('me.benefits.electionsEmptyDescription'),
    windowsTitle: t('me.benefits.windowsTitle'),
    windowsColumns: {
      name: t('me.benefits.columns.window'),
      kind: t('me.benefits.columns.kind'),
      range: t('me.benefits.columns.range'),
    },
    windowsEmpty: t('me.benefits.windowsEmpty'),
    windowsEmptyDescription: t('me.benefits.windowsEmptyDescription'),
    dependentsTitle: t('me.benefits.dependentsTitle'),
    dependentsColumns: {
      name: t('me.benefits.columns.dependent'),
      relationship: t('me.benefits.columns.relationship'),
    },
    dependentsEmpty: t('me.benefits.dependentsEmpty'),
    electLabel: t('me.benefits.elect'),
    electHref: '/me/benefits?elect=1',
    dialogCloseHref: '/me/benefits',
  }
  try {
    const [workspace, profile] = await Promise.all([
      getMyBenefitsWorkspace({ orgId, actorId: authz.user.id }),
      getMyProfile({ orgId, actorId: authz.user.id }),
    ])
    const employments = profile.employments.map((summary) => ({
      value: summary.employmentId,
      label: `${summary.employerName} — ${summary.jobTitle ?? t('me.overview.notAvailable')}`,
    }))
    const electOpen = sp.elect === '1'
    const changeId = typeof sp.change === 'string' && sp.change.length > 0 ? sp.change : null
    const changeTarget = changeId ? workspace.elections.find((row) => row.id === changeId) : undefined
    return {
      ...base,
      refusal: null,
      hasContent: true,
      elections: workspace.elections.map((row) => ({
        id: row.id,
        planCode: row.planCode,
        planName: `${row.planCode} — ${row.planName}`,
        coverageLabel: row.coverageLabel,
        statusLabel: statusLabel(t, 'me.enrollmentStatus', row.status),
        statusVariant: statusVariant(row.status),
        effectiveLabel: row.effectiveTo ? `${row.effectiveFrom} → ${row.effectiveTo}` : `${row.effectiveFrom} → …`,
        employeeAmount:
          row.employeeAmountPerPeriod != null ? `${row.employeeAmountPerPeriod} ${row.currency}` : null,
        changeHref: row.status === 'active' ? `/me/benefits?change=${encodeURIComponent(row.id)}` : null,
        changeLabel: t('me.benefits.change'),
      })),
      windows: workspace.openWindows.map((window) => ({
        id: window.id,
        name: window.name,
        kindLabel: statusLabel(t, 'me.windowKinds', window.kind),
        rangeLabel: `${window.opensOn} → ${window.closesOn}`,
      })),
      dependents: workspace.dependents.map((row) => ({
        displayName: row.displayName,
        relationship: row.relationship,
      })),
      dialogOpen: electOpen,
      dialog: electOpen
        ? {
            title: t('me.benefits.electTitle'),
            description: t('me.benefits.electDescription'),
            employmentLabel: t('me.profile.employment'),
            employments,
            planLabel: t('me.benefits.columns.plan'),
            plans: workspace.plans.map((plan) => ({
              value: plan.id,
              label: `${plan.code} — ${plan.name}`,
              levels: plan.levels.map((level) => ({ value: level.levelKey, label: level.label })),
            })),
            levelLabel: t('me.benefits.columns.coverage'),
            windowLabel: t('me.benefits.columns.window'),
            windows: workspace.openWindows.map((window) => ({
              value: window.id,
              label: `${window.name} (${window.opensOn} → ${window.closesOn})`,
            })),
            fromLabel: t('me.benefits.fromLabel'),
            lifeEventLabel: t('me.benefits.lifeEventLabel'),
            lifeEventPlaceholder: t('me.benefits.lifeEventPlaceholder'),
            submitLabel: t('me.benefits.electSubmit'),
            cancelLabel: t('me.profile.cancel'),
            submitFailed: t('me.benefits.electFailed'),
          }
        : null,
      changeDialogOpen: changeTarget !== undefined,
      changeDialog:
        changeTarget !== undefined
          ? {
              enrollmentId: changeTarget.id,
              planName: `${changeTarget.planCode} — ${changeTarget.planName}`,
              title: t('me.benefits.changeTitle'),
              description: t('me.benefits.changeDescription'),
              levelLabel: t('me.benefits.columns.coverage'),
              levels: (
                workspace.plans.find((plan) => plan.code === changeTarget.planCode)?.levels ?? []
              ).map((level) => ({ value: level.levelKey, label: level.label })),
              dateLabel: t('me.benefits.fromLabel'),
              reasonLabel: t('me.profile.reason'),
              reasonPlaceholder: t('me.benefits.changeReasonPlaceholder'),
              submitLabel: t('me.benefits.changeSubmit'),
              cancelLabel: t('me.profile.cancel'),
              submitFailed: t('me.benefits.changeFailed'),
            }
          : null,
    }
  } catch (error) {
    const refusal = toRefusal(t, error)
    return {
      ...base,
      refusal,
      hasContent: refusal === null,
      elections: [],
      windows: [],
      dependents: [],
      dialogOpen: false,
      dialog: null,
      changeDialogOpen: false,
      changeDialog: null,
    }
  }
}

/** The drawer's Employment tab payload for a manager who holds the party
 * on their team but lacks hrm.employment.read. Null when the party holds
 * none of the actor's reports, so the tab hides. canManageHrm stays
 * false: authoring rides the manage grant the manager does not hold. */
export async function loadTeamEmploymentPayload(
  orgId: string,
  actorId: string,
  workerPartyId: string,
): Promise<{ employmentIds: string[]; canManageHrm: false } | null> {
  const employmentIds = await findTeamEmploymentIdsForParty({ orgId, actorId, workerPartyId })
  if (employmentIds.length === 0) return null
  return { employmentIds, canManageHrm: false }
}
