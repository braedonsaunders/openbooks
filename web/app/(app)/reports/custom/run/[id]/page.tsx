import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { requirePermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { loadReportDefinition } from '../../../../../../lib/custom-reports'
import { ReportRunner } from './ReportRunner'

export const dynamic = 'force-dynamic'

export default async function ReportRunPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('reports.read')
  const canCreate = authz.permissions.has('reports.create') || authz.permissions.has('*')
  const canSchedule = authz.permissions.has('reports.schedule') || authz.permissions.has('*')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const definition = await loadReportDefinition(authz.user.orgId, id)
  if (!definition) notFound()

  const [schedules, recentRuns] = await Promise.all([
    db.execute(sql`
      select id, definition_id, cadence, day_of_week, day_of_month, hour, minute,
             timezone, recipient_emails, next_run_at, active
        from report_schedules
       where org_id = ${authz.user.orgId} and definition_id = ${id}
       order by next_run_at
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select id, trigger, status, error, row_count, started_at, finished_at
        from report_runs
       where org_id = ${authz.user.orgId} and definition_id = ${id}
       order by created_at desc limit 10
    `) as unknown as Promise<{ rows: any[] }>,
  ])

  return (
    <ReportRunner
      definition={{
        id: definition.id,
        kind: definition.kind,
        name: definition.name,
        description: definition.description,
        query: definition.query,
      }}
      schedules={schedules.rows}
      recentRuns={recentRuns.rows}
      canCreate={canCreate}
      canSchedule={canSchedule}
    />
  )
}
