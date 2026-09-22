import 'server-only'

import { getTranslations } from 'next-intl/server'
import { can, type Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import type { ModuleHomeTab } from '../../components/module-home/tab-types'

/**
 * HRM workspace strips. The group strip names six jobs (plus Compliance
 * when construction is on). Everything that used to be a fourteenth peer
 * — documents, surveys, qualifications, benefits, positions, org chart,
 * processes — is a viewTab under its job, so it stays findable without
 * crowding the header.
 */

function pathOf(href: string): string {
  return href.split('?')[0] ?? href
}

function queryOf(href: string): URLSearchParams {
  const query = href.split('?')[1]
  return new URLSearchParams(query ?? '')
}

/**
 * Map a page href to the group-strip tab that should light up. Child
 * routes (documents, surveys, positions, …) highlight their parent job,
 * never a missing fourteenth peer.
 */
export function hrmStripParentHref(pageHref: string): string {
  const path = pathOf(pageHref)
  const rules: { prefix: string; parent: string }[] = [
    { prefix: '/hrm/compensation', parent: '/hrm/compensation' },
    { prefix: '/hrm/benefits', parent: '/hrm/compensation' },
    { prefix: '/hrm/positions', parent: '/hrm/recruiting' },
    { prefix: '/hrm/recruiting', parent: '/hrm/recruiting' },
    { prefix: '/hrm/org-chart', parent: '/entities/employees' },
    { prefix: '/hrm/processes', parent: '/entities/employees' },
    { prefix: '/hrm/documents', parent: '/entities/employees' },
    { prefix: '/hrm/qualifications', parent: '/entities/employees' },
    { prefix: '/hrm/surveys', parent: '/hrm/performance' },
    { prefix: '/hrm/performance', parent: '/hrm/performance' },
    { prefix: '/hrm/leave', parent: '/hrm/leave' },
    { prefix: '/hrm/compliance', parent: '/hrm/compliance' },
    { prefix: '/hrm/change-requests', parent: '/hrm' },
    { prefix: '/entities/employees', parent: '/entities/employees' },
    { prefix: '/hrm', parent: '/hrm' },
  ]
  for (const { prefix, parent } of rules) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return parent
  }
  return path
}

async function tab(
  href: string,
  label: string,
  activeHref: string,
  extraActive?: boolean,
): Promise<ModuleHomeTab> {
  return {
    href,
    label,
    active: extraActive === true || pathOf(activeHref) === pathOf(href),
  }
}

/**
 * Employees job: the native roster plus the people-shaped ledgers that
 * used to sit on the group strip.
 */
export async function hrmPeopleViewTabs(authz: Authz, activeHref: string): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('hrm')
  const tNav = await getTranslations('nav')
  const orgId = authz.user.orgId
  const path = pathOf(activeHref)
  const tabs: ModuleHomeTab[] = []
  if (can(authz, 'parties.read')) {
    tabs.push({
      href: '/entities/employees',
      label: tNav('modules.employees'),
      active: path === '/entities/employees',
    })
  }
  if (await isFeatureEnabled(orgId, 'hrmOrgChart')) {
    tabs.push({
      href: '/hrm/org-chart',
      label: t('home.tabs.orgChart'),
      active: path === '/hrm/org-chart',
    })
  }
  if (can(authz, 'hrm.process.read')) {
    tabs.push({
      href: '/hrm/processes',
      label: t('home.tabs.processes'),
      active: path === '/hrm/processes' || path.startsWith('/hrm/processes/'),
    })
  }
  if (can(authz, 'hrm.documents.read') && (await isFeatureEnabled(orgId, 'hrmDocuments'))) {
    tabs.push(await tab('/hrm/documents', t('home.tabs.documents'), activeHref))
  }
  if (can(authz, 'hrm.certifications.read') && (await isFeatureEnabled(orgId, 'hrmCertifications'))) {
    tabs.push(await tab('/hrm/qualifications', t('home.tabs.qualifications'), activeHref))
  }
  return tabs
}

/**
 * Hiring job: Positions is a route; the recruiting depth tabs stay
 * `?tab=` on /hrm/recruiting. The caller supplies those depth tabs so
 * this helper never imports the recruiting page.
 */
export async function hrmHiringViewTabs(
  authz: Authz,
  activeHref: string,
  depthTabs: ModuleHomeTab[],
): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('hrm')
  const onPositions = pathOf(activeHref) === '/hrm/positions'
  const tabs: ModuleHomeTab[] = []
  if (can(authz, 'hrm.position.read')) {
    tabs.push({
      href: '/hrm/positions',
      label: t('home.tabs.positions'),
      active: onPositions,
    })
  }
  for (const depth of depthTabs) {
    tabs.push({
      ...depth,
      active: onPositions ? false : depth.active === true,
    })
  }
  return tabs
}

/**
 * Talent job: review-cycle surfaces plus Surveys. Feature checks match
 * the performance page so a tab never lands on a 404.
 */
export async function hrmTalentViewTabs(authz: Authz, activeHref: string): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const path = pathOf(activeHref)
  const tabParam = queryOf(activeHref).get('tab')
  const canManage = can(authz, 'hrm.performance.manage')
  const canRetain = can(authz, 'hrm.retention.read')
  const [calibrationOn, successionOn, feedbackOn, surveysOn] = await Promise.all([
    isFeatureEnabled(orgId, 'hrmCalibration'),
    isFeatureEnabled(orgId, 'hrmSuccession'),
    isFeatureEnabled(orgId, 'hrmFeedback'),
    isFeatureEnabled(orgId, 'hrmSurveys'),
  ])
  const onPerformance = path === '/hrm/performance'
  const onSurveys = path === '/hrm/surveys'
  const performanceTab =
    onPerformance && tabParam && ['calibration', 'talent', 'settings', 'retention'].includes(tabParam)
      ? tabParam
      : onPerformance
        ? 'cycles'
        : null

  const tabs: ModuleHomeTab[] = [
    {
      href: '/hrm/performance',
      label: t('performance.continuous.tabs.cycles'),
      active: performanceTab === 'cycles',
    },
  ]
  if (canManage && calibrationOn) {
    tabs.push({
      href: '/hrm/performance?tab=calibration',
      label: t('performance.continuous.tabs.calibration'),
      active: performanceTab === 'calibration',
    })
  }
  if (canManage && successionOn) {
    tabs.push({
      href: '/hrm/performance?tab=talent',
      label: t('performance.continuous.tabs.talent'),
      active: performanceTab === 'talent',
    })
  }
  if (canRetain) {
    tabs.push({
      href: '/hrm/performance?tab=retention',
      label: t('retention.title'),
      active: performanceTab === 'retention',
    })
  }
  if (canManage && feedbackOn) {
    tabs.push({
      href: '/hrm/performance?tab=settings',
      label: t('performance.continuous.tabs.settings'),
      active: performanceTab === 'settings',
    })
  }
  if (can(authz, 'hrm.surveys.manage') && surveysOn) {
    tabs.push({
      href: '/hrm/surveys',
      label: t('home.tabs.surveys'),
      active: onSurveys,
    })
  }
  return tabs
}

/**
 * Rewards job: compensation, benefit windows, enrolments, and equity.
 * Windows / Enrolments stay tabs (they are views, not status segments).
 */
export async function hrmRewardsViewTabs(authz: Authz, activeHref: string): Promise<ModuleHomeTab[]> {
  const t = await getTranslations('hrm')
  const orgId = authz.user.orgId
  const path = pathOf(activeHref)
  const view = queryOf(activeHref).get('view')
  const onBenefits = path === '/hrm/benefits'
  const onEnrolments = onBenefits && view === 'enrolments'
  const onEquity = path === '/hrm/compensation/equity'
  const onCompensation = path.startsWith('/hrm/compensation') && !onEquity
  const tabs: ModuleHomeTab[] = []
  if (can(authz, 'hrm.compensation.read') && (await isFeatureEnabled(orgId, 'hrmCompensation'))) {
    tabs.push({
      href: '/hrm/compensation',
      label: t('home.tabs.compensation'),
      active: onCompensation,
    })
  }
  if (can(authz, 'hrm.benefits.read')) {
    tabs.push({
      href: '/hrm/benefits',
      label: t('benefits.windowsTitle'),
      active: onBenefits && !onEnrolments,
    })
    tabs.push({
      href: '/hrm/benefits?view=enrolments',
      label: t('benefits.enrolmentsTitle'),
      active: onEnrolments,
    })
  }
  if (can(authz, 'hrm.compensation.read') && (await isFeatureEnabled(orgId, 'hrmPayTransparency'))) {
    tabs.push({
      href: '/hrm/compensation/equity',
      label: t('equity.title'),
      active: onEquity,
    })
  }
  return tabs
}
