import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { listFlowSubjectProfiles } from '@openbooks/engine/src/flows/index.ts'
import type { AutomationGraph } from '@openbooks/forms-core'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import FlowBuilder from './FlowBuilder'
import type { FlowRunRow } from '../_builder/RunsPanel'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  const t = await getTranslations('admin.flows')
  return { title: t('title') }
}

export default async function FlowBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('flows.manage')
  const { id } = await params
  if (!isUuid(id)) notFound()

  const [flowRes, runsRes] = await Promise.all([
    db.execute(sql`
      select id, name, enabled, subject_kind, graph
        from flows where id = ${id} and org_id = ${authz.user.orgId}`) as any,
    db.execute(sql`
      select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
        from flow_runs where flow_id = ${id} and org_id = ${authz.user.orgId}
       order by started_at desc limit 30`) as any,
  ])
  const flow = flowRes.rows[0]
  if (!flow) notFound()

  const profile = listFlowSubjectProfiles().find((p) => p.subjectKind === flow.subject_kind)
  if (!profile) notFound()

  return (
    <div className="p-4">
      <FlowBuilder
        flow={{
          id: String(flow.id),
          name: String(flow.name),
          enabled: Boolean(flow.enabled),
          graph: flow.graph as AutomationGraph,
        }}
        runs={runsRes.rows as FlowRunRow[]}
        profile={profile}
      />
    </div>
  )
}
