import { notFound, redirect } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { statementPageHref } from '../../../../../../lib/report-run'
import { ReportRunner } from './ReportRunner'
import { orgBranding } from '../../../../../../lib/report-pdf'

export const dynamic = 'force-dynamic'

export default async function ReportRunPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const canSchedule = authz.permissions.has('reports.schedule') || authz.permissions.has('*')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()
  // Standard statement definitions are viewed through their rich drill-through
  // pages, not the entity-query runner.
  if (definition.report_type === 'statement') redirect(statementPageHref(definition.statement))
  if (!definition.query) notFound()

  const [schedules, recentRuns, branding] = await Promise.all([
    db.execute(sql`
      select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
             timezone, recipient_emails, next_run_at, active
        from report_schedules
       where org_id = ${authz.user.orgId} and definition_id = ${id}
       order by next_run_at
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
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
    `) as unknown as Promise<{ rows: any[] }>,
    orgBranding(authz.user.orgId),
  ])

  return (
    <ReportRunner
      definition={{
        id: definition.id,
        kind: definition.kind,
        slug: definition.slug,
        name: definition.name,
        description: definition.description,
        query: definition.query,
      }}
      schedules={schedules.rows}
      recentRuns={recentRuns.rows}
      company={branding.orgName}
      canCreate={canCreate}
      canSchedule={canSchedule}
    />
  )
}
