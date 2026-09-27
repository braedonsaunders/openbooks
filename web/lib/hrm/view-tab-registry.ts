/**
 * THE registry of HRM sibling views. Pure data, so the recruiting page and
 * the tests can read it without the server-only resolver in
 * ./workspace-tabs, which filters it by grant and feature for a viewer.
 */

import type { ViewTabGroup } from '../../components/module-home/view-tab-match'

/** The recruiting depth views: part of Recruiting, so each rides its switch. */
const RECRUITING_DEPTH_VIEWS = ['interviews', 'offers', 'postings', 'pools'] as const

export type ViewTabDef = {
  href: string
  ns: 'hrm' | 'nav'
  key: string
  /** The grant the destination enforces; the tab hides without it. */
  permission?: string
  /** The optional-feature switch the destination sits behind. */
  feature?: string
  prefix?: boolean
  carry?: string[]
}

const RECRUITING_DEPTH_TABS: ViewTabDef[] = RECRUITING_DEPTH_VIEWS.map((tab) => ({
  href: `/hrm/recruiting?tab=${tab}`,
  ns: 'hrm',
  key: `recruiting.tabs.${tab}`,
  permission: 'hrm.recruiting.read',
  feature: 'hrmRecruiting',
  carry: ['status'],
}))

/**
 * THE registry of HRM sibling views: one entry per group-strip job that
 * has more than one view. It is the only place a view tab is declared.
 * The HRM and employee-list route layouts resolve it once and the page
 * layout renders the matching strip under every page header, so a page
 * cannot omit its job's strip or put it somewhere else. Each tab carries
 * the grant and feature its destination enforces, so a viewer is never
 * offered a tab that access-denies or 404s.
 */
export const HRM_VIEW_TABS: Record<'people' | 'hiring' | 'timeOff' | 'talent' | 'rewards', ViewTabDef[]> = {
  // Employees: the native roster plus the people-shaped ledgers.
  people: [
    { href: '/entities/employees', ns: 'nav', key: 'modules.employees', permission: 'parties.read' },
    { href: '/hrm/org-chart', ns: 'hrm', key: 'home.tabs.orgChart', feature: 'hrm' },
    { href: '/hrm/processes', ns: 'hrm', key: 'home.tabs.processes', permission: 'hrm.process.read', prefix: true },
    {
      href: '/hrm/documents',
      ns: 'hrm',
      key: 'home.tabs.documents',
      permission: 'hrm.documents.read',
      feature: 'hrmDocuments',
    },
    {
      href: '/hrm/qualifications',
      ns: 'hrm',
      key: 'home.tabs.qualifications',
      permission: 'hrm.certifications.read',
      feature: 'hrmCertifications',
    },
  ],
  // Hiring: Positions is a route; the recruiting views ride `?tab=` and
  // keep the openings status filter between them.
  hiring: [
    { href: '/hrm/positions', ns: 'hrm', key: 'home.tabs.positions', permission: 'hrm.position.read' },
    {
      href: '/hrm/recruiting',
      ns: 'hrm',
      key: 'recruiting.tabs.openings',
      permission: 'hrm.recruiting.read',
      feature: 'hrmRecruiting',
      carry: ['status'],
    },
    ...RECRUITING_DEPTH_TABS,
  ],
  // Time off: the request queue and the calendar share the segment filter.
  timeOff: [
    { href: '/hrm/leave', ns: 'hrm', key: 'leave.listTitle', permission: 'hrm.leave.read', carry: ['segment'] },
    {
      href: '/hrm/leave?view=calendar',
      ns: 'hrm',
      key: 'leave.calendarTitle',
      permission: 'hrm.leave.read',
      carry: ['segment'],
    },
  ],
  // Talent: Cycles has no grant — a manager with reports and no grant
  // still reaches it, and the read service narrows every row.
  talent: [
    { href: '/hrm/performance', ns: 'hrm', key: 'performance.continuous.tabs.cycles', feature: 'hrmPerformance' },
    {
      href: '/hrm/performance?tab=calibration',
      ns: 'hrm',
      key: 'performance.continuous.tabs.calibration',
      permission: 'hrm.performance.manage',
      feature: 'hrmPerformance',
    },
    {
      href: '/hrm/performance?tab=talent',
      ns: 'hrm',
      key: 'performance.continuous.tabs.talent',
      permission: 'hrm.performance.manage',
      feature: 'hrmPerformance',
    },
    {
      href: '/hrm/performance?tab=retention',
      ns: 'hrm',
      key: 'retention.title',
      permission: 'hrm.retention.read',
      feature: 'hrmPerformance',
    },
    {
      href: '/hrm/performance?tab=settings',
      ns: 'hrm',
      key: 'performance.continuous.tabs.settings',
      permission: 'hrm.performance.manage',
      feature: 'hrmPerformance',
    },
    { href: '/hrm/surveys', ns: 'hrm', key: 'home.tabs.surveys', permission: 'hrm.surveys.manage', feature: 'hrmSurveys' },
  ],
  // Rewards: compensation (with its cycles and plans), benefit windows and
  // enrolments, and pay equity.
  rewards: [
    {
      href: '/hrm/compensation',
      ns: 'hrm',
      key: 'home.tabs.compensation',
      permission: 'hrm.compensation.read',
      feature: 'hrmCompensation',
      prefix: true,
    },
    { href: '/hrm/benefits', ns: 'hrm', key: 'benefits.windowsTitle', permission: 'hrm.benefits.read' },
    {
      href: '/hrm/benefits?view=enrolments',
      ns: 'hrm',
      key: 'benefits.enrolmentsTitle',
      permission: 'hrm.benefits.read',
    },
    {
      href: '/hrm/compensation/equity',
      ns: 'hrm',
      key: 'equity.title',
      permission: 'hrm.compensation.read',
      feature: 'hrmCompensation',
    },
  ],
}

/**
 * The registry as view strips: `allowed` drops the tabs a viewer may not
 * open, `label` names the rest. Order is the registry's.
 */
export function hrmViewTabGroupsFor(
  allowed: (def: ViewTabDef) => boolean,
  label: (def: ViewTabDef) => string,
): ViewTabGroup[] {
  return Object.values(HRM_VIEW_TABS).map((defs) =>
    defs.filter(allowed).map((def) => ({
      href: def.href,
      label: label(def),
      ...(def.prefix ? { prefix: true } : {}),
      ...(def.carry ? { carry: def.carry } : {}),
    })),
  )
}
