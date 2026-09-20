import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { getHeadcountAsOf } from '@openbooks/engine/src/hrm/employment-read.ts'
import { can, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import type { DirectoryItem } from '../../components/module-home/ui'

/**
 * Human Resources module home — one read for the workspace landing cockpit:
 * headcount as-of today by employer subsidiary and department from the
 * canonical HRM read service, plus the live directory. No direct table
 * reads: every figure comes from getHeadcountAsOf, which resolves each
 * employment through the temporal primitives under the hrm gate and the
 * actor's subsidiary scope.
 */

export interface HrmHeadcountGroup {
  subsidiary: string
  department: string | null
  headcount: number
}

export interface HrmHomeData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  headcountLabel: string
  headcountValue: string
  headcountSub: string
  employersLabel: string
  employersValue: string
  employersSub: string
  departmentsLabel: string
  departmentsValue: string
  departmentsSub: string
  groupsTitle: string
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  groupsEmpty: string
  totalLabel: string
  groups: HrmHeadcountGroup[]
  total: number
  directoryTitle: string
  directory: DirectoryItem[]
}

export async function loadHrmHome(authz: Authz): Promise<HrmHomeData> {
  // The caller (the /hrm view) owns the page gate — requirePermission plus
  // the hrm switch with a 404. This loader never re-checks either; it
  // resolves figures for the authorized session it is given.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')
  const tNav = await getTranslations('nav')

  const effectiveDate = await businessToday(orgId)
  const headcount = await getHeadcountAsOf({
    orgId,
    actorId: authz.user.id,
    effectiveDate,
    knownAt: new Date().toISOString(),
  })

  const employers = new Set(headcount.groups.map((group) => group.employerSubsidiaryId)).size
  const departments = new Set(
    headcount.groups.map((group) => group.departmentId).filter((id): id is string => id !== null),
  ).size

  // The home reflects the org's own surface: the directory names the native
  // employee list (the module's record home) exactly when the viewer may
  // open it, annotated with the live headcount figure.
  const directory: DirectoryItem[] = []
  if (can(authz, 'parties.read')) {
    directory.push({
      href: '/entities/employees',
      label: tNav('modules.employees'),
      iconKey: 'clipboard-check',
      badge: { value: String(headcount.total), tone: 'neutral' },
    })
  }

  return {
    title: t('home.title'),
    description: t('home.description'),
    tabs: await hrmGroupTabs(authz, '/hrm'),
    headcountLabel: t('home.vitals.headcount'),
    headcountValue: String(headcount.total),
    headcountSub: t('home.vitals.headcountSub', { date: headcount.effectiveDate }),
    employersLabel: t('home.vitals.employers'),
    employersValue: String(employers),
    employersSub: t('home.vitals.employersSub', { count: employers }),
    departmentsLabel: t('home.vitals.departments'),
    departmentsValue: String(departments),
    departmentsSub: t('home.vitals.departmentsSub', { count: departments }),
    groupsTitle: t('home.groups.title'),
    employerColumn: t('home.groups.employer'),
    departmentColumn: t('home.groups.department'),
    headcountColumn: t('home.groups.headcount'),
    unassigned: t('home.groups.unassigned'),
    groupsEmpty: t('home.groups.empty', { date: headcount.effectiveDate }),
    totalLabel: t('home.groups.total'),
    groups: headcount.groups.map((group) => ({
      subsidiary: group.employerSubsidiaryName,
      department: group.departmentName,
      headcount: group.headcount,
    })),
    total: headcount.total,
    directoryTitle: t('home.directory.title'),
    directory,
  }
}
