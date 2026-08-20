import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { db } from '@openbooks/engine/src/db.ts'
import { REPORT_ENTITY_MAP } from '@openbooks/reports'
import { DetailPageLayout } from '../../../../../../../components/page-layout'
import { can, requirePermission } from '../../../../../../../lib/authz'
import { isUuid } from '../../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../../lib/custom-reports'
import { DeliveryPanel } from './DeliveryPanel'

export const dynamic = 'force-dynamic'

/**
 * Delivery management for one saved report: e-mail schedules and the recorded
 * run history with artifacts. Kept off the report screen itself — that page is
 * pure native report chrome.
 */
export default async function ReportDeliveryPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('reports.read')
  const canSchedule = authz.permissions.has('reports.schedule') || authz.permissions.has('*')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()
  if (definition.report_type === 'statement' || !definition.query) redirect('/reports/custom')
  const entity = REPORT_ENTITY_MAP[(definition.query as { entity?: string }).entity ?? '']
  if (entity?.requiredPermission && !can(authz, entity.requiredPermission)) notFound()

  const t = await getTranslations('reports')
  const tk = await getTranslations('reports.custom')
  const displayName = definition.kind === 'built_in' && t.has(`builtIns.${definition.slug}.name`)
    ? t(`builtIns.${definition.slug}.name`)
    : definition.name

  const [schedules, recentRuns] = (await Promise.all([
    db.execute<any>(sql`
      select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
             timezone, recipient_emails, next_run_at, active
        from report_schedules
       where org_id = ${authz.user.orgId} and definition_id = ${id}
       order by next_run_at
    `),
    db.execute<any>(sql`
      select r.id, r.trigger, r.status, r.error, r.row_count, r.started_at, r.finished_at,
             exists(select 1 from report_run_artifacts a where a.run_id=r.id) as artifact_available,
             count(d.id)::int as delivery_total,
             count(d.id) filter (where d.status='sent')::int as delivery_sent,
             count(d.id) filter (where d.status='failed')::int as delivery_failed,
             count(d.id) filter (where d.status='suppressed')::int as delivery_suppressed
        from report_runs r
        left join report_delivery_outbox d on d.run_id=r.id
       where r.org_id = ${authz.user.orgId} and r.definition_id = ${id}
       group by r.id
       order by r.created_at desc limit 10
    `),
  ]))

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title={`${displayName} — ${tk('runner.scheduledDelivery')}`}
          back={{ href: `/reports/custom/run/${definition.id}`, label: displayName }}
        />
      }
    >
      <DeliveryPanel
        definitionId={definition.id}
        schedules={schedules.rows}
        recentRuns={recentRuns.rows}
        canSchedule={canSchedule}
      />
    </DetailPageLayout>
  )
}
