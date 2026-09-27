import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import type { resDemandLines } from '@openbooks/schema/src/resourcing.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { weekStartOf, weeksBetween } from '@openbooks/engine/src/resourcing/weeks.ts'
import { can, requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { isUuid, mergeHref, pickString } from '@/lib/list-params'
import { subsidiaryVisibleFilter } from '@/lib/subsidiaries'
import { crmOpportunityScope } from '@/lib/crm-scope'
import { loadDemandWeeks, type DemandWeek } from '@/lib/resourcing/demand'
import { loadFieldDefs } from '@/lib/custom-fields'
import { widget, widgetBlock, page, pageHeader, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import type { DemandDrawer } from './DemandDrawer'

type DemandLineRecord = typeof resDemandLines.$inferSelect
type DemandLineReadRow = {
  id: DemandLineRecord['id']
  departmentId: DemandLineRecord['departmentId']
  departmentName: string
  departmentActive: boolean
  jobTitle: DemandLineRecord['jobTitle']
  firstWeek: string
  lastWeek: string
  hoursPerWeek: string
  note: DemandLineRecord['note']
  opportunityId: DemandLineRecord['opportunityId']
  custom: DemandLineRecord['custom']
} & Record<string, unknown>
type DepartmentOptionRow = { id: string; name: string; is_active: boolean } & Record<string, unknown>
type OpportunityOptionRow = { id: string; name: string } & Record<string, unknown>
type DemandDrawerProps = Parameters<typeof DemandDrawer>[0]

function customRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export type DemandPageData = {
  currentParams: Record<string, string | string[] | undefined>
  canManage: boolean
  title: string
  description: string
  newLabel: string
  drawer: DemandDrawerProps['drawer'] | null
}

function firstSundayOfCurrentWeek(): string {
  const today = new Date().toISOString().slice(0, 10)
  return weekStartOf(today)
}

async function weightingForLine(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  row: DemandLineReadRow,
): Promise<DemandWeek[]> {
  const weeks = weeksBetween(row.firstWeek, row.lastWeek)
  const all: DemandWeek[] = []
  for (let start = 0; start < weeks.length; start += 53) {
    const range = weeks.slice(start, start + 53)
    const rows = await loadDemandWeeks(orgId, allowedSubsidiaryIds, {
      firstSunday: range[0]!,
      lastSunday: range[range.length - 1]!,
      departmentId: row.departmentId,
      jobTitle: row.jobTitle,
    })
    all.push(...rows.filter((demand) => demand.lineId === row.id))
  }
  return all
}

export async function loadDemandPage(
  sp: Record<string, string | string[] | undefined>,
): Promise<DemandPageData> {
  const authz = await requirePermission('resourcing.read')
  await requireFeatureEnabled(authz.user.orgId, 'resourcing')
  const t = await getTranslations('resourcing')
  const canManage = can(authz, 'resourcing.manage')
  const demandId = typeof sp.demand === 'string' ? sp.demand : undefined
  const creating = demandId === 'new' && canManage
  let row: DemandLineReadRow | null = null

  if (demandId && isUuid(demandId)) {
    row = (await db.execute<DemandLineReadRow>(sql`
      select dl.id::text as id, dl.department_id::text as "departmentId",
             d.name as "departmentName", d.is_active as "departmentActive",
             dl.job_title as "jobTitle", dl.first_week::text as "firstWeek",
             dl.last_week::text as "lastWeek", dl.hours_per_week::text as "hoursPerWeek",
             dl.note, dl.opportunity_id::text as "opportunityId", dl.custom
        from res_demand_lines dl
        join departments d on d.id = dl.department_id and d.org_id = dl.org_id
       where dl.org_id = ${authz.user.orgId} and dl.id = ${demandId}
         ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
       limit 1
    `)).rows[0] ?? null
  }

  const wantsDrawer = creating || row !== null
  let drawer: DemandPageData['drawer'] = null
  if (wantsDrawer) {
    const [departments, opportunities, fieldDefs] = await Promise.all([
      db.execute<DepartmentOptionRow>(sql`
        select id::text as id, name, is_active from departments d
         where org_id = ${authz.user.orgId} and is_active
           ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by name
      `),
      db.execute<OpportunityOptionRow>(sql`
        select o.id::text as id, o.name from crm_opportunities o
         where o.org_id = ${authz.user.orgId} ${crmOpportunityScope(authz.allowedSubsidiaryIds)}
         order by o.name limit 500
      `),
      loadFieldDefs('res_demand_lines'),
    ])
    const firstSunday = firstSundayOfCurrentWeek()
    const formRow = row ?? {
      id: '',
      departmentId: departments.rows[0]?.id ?? '',
      departmentName: departments.rows[0]?.name ?? '',
      departmentActive: true,
      jobTitle: '',
      firstWeek: firstSunday,
      lastWeek: firstSunday,
      hoursPerWeek: '',
      note: null,
      opportunityId: null,
      custom: {},
    }
    const options = departments.rows.map((department) => ({ value: department.id, label: department.name }))
    if (row && !options.some((option) => option.value === row!.departmentId)) {
      options.push({ value: row.departmentId, label: `${row.departmentName} (${t('demandLines.departmentInactive')})` })
    }
    const opportunityOptions = opportunities.rows.map((opportunity) => ({ value: opportunity.id, label: opportunity.name }))
    const weights = row
      ? await weightingForLine(authz.user.orgId, authz.allowedSubsidiaryIds, row)
      : []
    const requestedReturn = pickString(sp.drawerReturn)
    const closeHref = requestedReturn?.startsWith('/resourcing/demand')
      ? requestedReturn
      : mergeHref('/resourcing/demand', sp, { demand: undefined, drawerReturn: undefined })
    drawer = {
      remountKey: row?.id ?? 'new-demand-line',
      row: {
        id: formRow.id,
        departmentId: formRow.departmentId,
        departmentName: formRow.departmentName,
        departmentActive: formRow.departmentActive,
        jobTitle: formRow.jobTitle,
        firstWeek: formRow.firstWeek,
        lastWeek: formRow.lastWeek,
        hoursPerWeek: formRow.hoursPerWeek,
        note: formRow.note ?? '',
        opportunityId: formRow.opportunityId ?? '',
        custom: customRecord(formRow.custom),
      },
      departments: options,
      opportunities: opportunityOptions,
      fieldDefs: fieldDefs as DemandDrawerProps['drawer']['fieldDefs'],
      weights,
      canManage,
      closeHref,
      createMode: creating,
      opportunityOutsideScopeLabel: t('demand.exclusion.out_of_scope'),
    }
  }

  return {
    currentParams: sp,
    canManage,
    title: t('demandLines.title'),
    description: t('demandLines.description'),
    newLabel: t('demandLines.actions.new'),
    drawer,
  }
}

export function demandSpec(data: DemandPageData): PageSpec {
  const newDemand = widget('link-button', {
    href: mergeHref('/resourcing/demand', data.currentParams, { demand: 'new' }),
    label: data.newLabel,
    variant: 'default',
  })
  return page({
    layout: 'list',
    header: [pageHeader({
      title: data.title,
      description: data.description,
      actionsClassName: 'flex flex-wrap items-center justify-end gap-2',
      actions: data.canManage ? [newDemand] : [],
    })],
    body: [widgetBlock('entity-list-view', {
      recordType: 'resourcing_demand',
      sp: data.currentParams,
      drawer: data.drawer ? { widget: 'resourcing-demand-drawer', props: { drawer: data.drawer } } : null,
    })],
  })
}
