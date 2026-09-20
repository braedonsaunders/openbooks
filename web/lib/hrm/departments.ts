import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { getHeadcountAsOf } from '@openbooks/engine/src/hrm/employment-read.ts'
import { can, type Authz } from '../authz'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { employeeDirectoryLinkForDepartment } from './employee-directory-link'
import type { DirectoryItem } from '../../components/module-home/ui'
import type { HrmHeadcountGroup } from './home'

/**
 * Department headcount board — one read for the Departments tab: headcount
 * as-of today per department from the canonical HRM read service, with the
 * employer subsidiary breakdown, plus the working links. No direct table
 * reads: every figure comes from getHeadcountAsOf.
 *
 * Drill-through honesty: the native employees list carries no department
 * filter (its source defines no department quick filter), so the board
 * links the full list rather than faking a filtered one — the panel hint
 * says exactly that.
 */

export interface HrmDepartmentsData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof hrmGroupTabs>>
  listTitle: string
  listNote: string
  employerColumn: string
  departmentColumn: string
  headcountColumn: string
  unassigned: string
  groupsEmpty: string
  totalLabel: string
  groups: HrmHeadcountGroup[]
  total: number
  linksTitle: string
  directory: DirectoryItem[]
}

export async function loadHrmDepartments(authz: Authz): Promise<HrmDepartmentsData> {
  // The caller (the departments view) owns the page gate —
  // requirePermission plus the hrm switch with a 404. This loader never
  // re-checks either; it resolves figures for the authorized session.
  const orgId = authz.user.orgId
  const t = await getTranslations('hrm')

  const effectiveDate = await businessToday(orgId)
  const headcount = await getHeadcountAsOf({
    orgId,
    actorId: authz.user.id,
    effectiveDate,
    knownAt: new Date().toISOString(),
  })

  const canReadParties = can(authz, 'parties.read')
  const directory: DirectoryItem[] = []
  if (canReadParties) {
    directory.push({
      href: '/entities/employees',
      label: t('departments.employeesLink'),
      iconKey: 'clipboard-check',
      badge: { value: String(headcount.total), tone: 'neutral' },
    })
  }
  directory.push({
    href: '/admin/setup/departments',
    label: t('departments.setupLink'),
    iconKey: 'building',
  })

  return {
    title: t('departments.title'),
    description: t('departments.description'),
    tabs: await hrmGroupTabs(authz, '/hrm/departments'),
    listTitle: t('departments.listTitle'),
    listNote: t('departments.listNote'),
    employerColumn: t('home.groups.employer'),
    departmentColumn: t('home.groups.department'),
    headcountColumn: t('home.groups.headcount'),
    unassigned: t('home.groups.unassigned'),
    groupsEmpty: t('home.groups.empty', { date: headcount.effectiveDate }),
    totalLabel: t('home.groups.total'),
    // Each row drills through to the employee directory filtered to its
    // department (null = the unassigned roster) — only when the viewer may
    // open that list, the same parties.read gate as the directory link.
    groups: headcount.groups.map((group) => ({
      subsidiary: group.employerSubsidiaryName,
      department: group.departmentName,
      headcount: group.headcount,
      href: canReadParties ? employeeDirectoryLinkForDepartment(group.departmentId) : null,
    })),
    total: headcount.total,
    linksTitle: t('departments.linksTitle'),
    directory,
  }
}
