import 'server-only'

import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { nextPeriodAfter } from '@openbooks/engine/src/payroll-run.ts'
import { payrollSubsidiaryScopeFilter } from '@openbooks/engine/src/payroll-scope.ts'
import { uuidArray } from '@openbooks/engine/src/subsidiaries.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { FinalPayCandidate, RunSchedule } from '../_ui/NewRunButton'

/**
 * Pay runs, split into a loader and a spec.
 *
 * The list itself is the universal RecordListView over documents kind
 * 'pay_run', placed through the `record-list-view` slot: the slot re-derives
 * org/user/permissions from the session. A spec that could name an org id is
 * a cross-tenant read. Rows open the pay-run wizard — a full page, not a
 * drawer — so this page needs no drawer widget; the per-row action is a plain
 * link, expressed as the `pay-run-row-actions` widget the slot resolves per
 * row (the same indirection the AR-invoices page uses for its document row
 * actions).
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * schedule picker rows with their engine-derived next periods, the final-pay
 * candidate picker (terminated employees only), and the module tabs. The
 * schedules, candidates, today string, tab list, and New-button presence flag
 * are data, so they travel through the loader result and the widgets render
 * them.
 */

export interface PayRunsData {
  title: string
  description: string
  currentParams: Record<string, string | string[] | undefined>
  canRun: boolean
  newRun: {
    schedules: RunSchedule[]
    finalPayCandidates: FinalPayCandidate[]
    today: string
  }
  viewTabs: { href: string; label: string; active?: boolean }[]
  openLabel: string
}

export async function loadPayRuns(
  sp: Record<string, string | string[] | undefined>,
): Promise<PayRunsData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const canRun = can(authz, 'payroll.run')
  const t = await getTranslations('payroll')

  const scheduleRows = canRun
    ? (((await db.execute<{
        id: string
        name: string
        frequency: string
        pay_date_offset_days: number
        anchor_period_end: string
        last_end: string | null
      }>(sql`
        select s.id, s.name, s.frequency, s.pay_date_offset_days,
               s.anchor_period_end::text as anchor_period_end,
               max(r.period_end)::text as last_end
          from pay_schedules s
          left join pay_runs r on r.pay_schedule_id = s.id and r.org_id = s.org_id
         where s.org_id = ${orgId} and s.is_active
           ${payrollSubsidiaryScopeFilter(sql`coalesce(s.subsidiary_id, (
             select root.id from subsidiaries root
              where root.org_id = s.org_id and root.parent_id is null and root.is_active
              order by root.created_at limit 1
           ))`, authz.allowedSubsidiaryIds)}
         group by s.id, s.name, s.frequency, s.pay_date_offset_days, s.anchor_period_end
         order by s.name`))).rows)
    : []

  // Keep the date controls on the exact same calendar as createPayRun. The
  // client receives a canonical preview, while an untouched submit still lets
  // the server derive the period again inside its transaction.
  const schedules = scheduleRows.map((schedule) => {
    const next = nextPeriodAfter(schedule, schedule.last_end)
    const payDate = new Date(`${next.periodEnd}T00:00:00Z`)
    payDate.setUTCDate(payDate.getUTCDate() + schedule.pay_date_offset_days)
    return {
      id: schedule.id,
      name: schedule.name,
      frequency: schedule.frequency,
      pay_date_offset_days: schedule.pay_date_offset_days,
      next_period_start: next.periodStart,
      next_period_end: next.periodEnd,
      next_pay_date: payDate.toISOString().slice(0, 10),
    }
  })

  // A final pay run must NAME the employees it pays (it clears every accrued
  // bank), and the engine will only calculate one for people whose employment
  // has ended — so the picker offers exactly those.
  const finalPayCandidates = canRun
    ? (((await db.execute<{ id: string; name: string; pay_schedule_id: string; terminated_on: string }>(sql`
        select distinct on (prof.employee_party_id)
               prof.employee_party_id as id, p.display_name as name,
               prof.pay_schedule_id, er.terminated_on::text as terminated_on
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
         where prof.org_id = ${orgId} and prof.is_active and er.terminated_on is not null
           ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
           and prof.pay_schedule_id = any(${uuidArray(schedules.map((schedule) => schedule.id))}::uuid[])
         order by prof.employee_party_id, er.terminated_on desc`))).rows)
    : []

  return {
    title: t('list.title'),
    description: t('list.description'),
    currentParams: sp,
    canRun,
    newRun: {
      schedules,
      finalPayCandidates,
      today: canRun ? await businessToday(orgId) : '',
    },
    viewTabs: await groupTabs('payroll', '/payroll/runs', { orgId }),
    openLabel: t('list.open'),
  }
}

const f = ref<PayRunsData>()

export function payRunsSpec(data: PayRunsData): PageSpec {
  const newRun = {
    widget: 'new-pay-run',
    props: {
      schedules: data.newRun.schedules,
      finalPayCandidates: data.newRun.finalPayCandidates,
      today: data.newRun.today,
    },
  }
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex items-center gap-3',
        actions: [
          widget(newRun.widget, newRun.props, f('canRun')),
          widget('module-home-tabs', { tabs: data.viewTabs }),
        ],
      }),
    ],
    body: [
      // The universal record list. Rows open the pay-run wizard (a full
      // page), so the per-row action is a plain link — carried as a widget
      // ref the slot resolves per row, exactly like the document row actions
      // on the AR-invoices page.
      widgetBlock('record-list-view', {
        recordType: 'pay_run',
        basePath: '/payroll/runs',
        sp: data.currentParams,
        emptyAction: data.canRun ? newRun : null,
        rowActions: { widget: 'pay-run-row-actions', props: { label: data.openLabel } },
      }),
    ],
  })
}
