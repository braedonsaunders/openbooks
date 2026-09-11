import 'server-only'

import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../../../../lib/authz'
import { canRunReportEntity } from '../../../../../../../lib/report-authz'
import { isUuid } from '../../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../../lib/custom-reports'
import type { DeliveryPanel } from './DeliveryPanel'

/**
 * Delivery management for one saved report, split into a loader and a spec.
 *
 * Kept off the report screen itself — that page is pure native report chrome —
 * this one owns the e-mail schedules and the recorded run history with
 * artifacts. One whole client island: schedule forms, cadence pickers,
 * recipient editing and the run list's retry actions.
 *
 * The gate is the part worth reading. `canRunReportEntity(authz, query)` is
 * an entity-level permission check on the report's OWN query — a reader who
 * may not run the report may not manage its delivery either, because a
 * schedule is a standing instruction to send that data to someone. It fails
 * with `notFound()`, not a message, so a report a caller cannot run is
 * indistinguishable from one that does not exist. All of this stays in the
 * loader; the spec sees only finished rows.
 *
 * The title interpolates the display name with a translated suffix, which is
 * string building — so the loader builds it.
 */

type PanelProps = Parameters<typeof DeliveryPanel>[0]

export interface ReportDeliveryData {
  title: string
  backHref: string
  backLabel: string
  definitionId: string
  schedules: PanelProps['schedules']
  recentRuns: PanelProps['recentRuns']
  canSchedule: boolean
}

export async function loadReportDelivery(id: string): Promise<ReportDeliveryData> {
  const authz = await requirePermission('reports.read')
  const canSchedule = authz.permissions.has('reports.schedule') || authz.permissions.has('*')
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()
  if (definition.report_type === 'statement' || !definition.query) redirect('/reports/custom')
  if (!(await canRunReportEntity(authz, definition.query))) notFound()

  const t = await getTranslations('reports')
  const tk = await getTranslations('reports.custom')
  const displayName = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.name`)
    ? t(`builtIns.${definition.slug}.name`)
    : definition.name

  const [schedules, recentRuns] = await Promise.all([
    db.execute<any>(sql`
      select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
             timezone, recipient_emails, next_run_at, active
        from report_schedules
       where org_id = ${authz.user.orgId} and definition_id = ${id}
       order by next_run_at
    `),
    db.execute<any>(sql`
      select r.id, r.trigger, r.status, r.error, r.row_count, r.started_at, r.finished_at,
             exists(select 1 from report_run_artifacts a where a.run_id=r.id and a.org_id=r.org_id) as artifact_available,
             count(d.id)::int as delivery_total,
             count(d.id) filter (where d.status='sent')::int as delivery_sent,
             count(d.id) filter (where d.status='failed')::int as delivery_failed,
             count(d.id) filter (where d.status='suppressed')::int as delivery_suppressed
        from report_runs r
        left join report_delivery_outbox d on d.run_id=r.id and d.org_id=r.org_id
       where r.org_id = ${authz.user.orgId} and r.definition_id = ${id}
       group by r.id
       order by r.created_at desc limit 10
    `),
  ])

  return {
    title: `${displayName} — ${tk('runner.scheduledDelivery')}`,
    backHref: `/reports/custom/run/${definition.id}`,
    backLabel: displayName,
    definitionId: definition.id,
    schedules: schedules.rows,
    recentRuns: recentRuns.rows,
    canSchedule,
  }
}

const f = ref<ReportDeliveryData>()

export function reportDeliverySpec(data: ReportDeliveryData): PageSpec {
  return page({
    route: '/reports/custom/run/[id]/delivery',
    // `detail`, not `list`: the native page uses DetailPageLayout.
    layout: 'detail',
    header: [
      pageHeader({
        title: f('title'),
        back: { href: f('backHref'), label: f('backLabel') },
      }),
    ],
    body: [
      widgetBlock('delivery-panel', {
        definitionId: data.definitionId,
        schedules: data.schedules,
        recentRuns: data.recentRuns,
        canSchedule: data.canSchedule,
      }),
    ],
  })
}
