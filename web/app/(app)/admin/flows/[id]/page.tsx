import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { flowSubjectProfileForOrg } from '@openbooks/engine/src/flows/index.ts'
import type { AutomationGraph } from '@openbooks/forms-core'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { PERMISSION_CATALOGUE } from '../../../../../lib/permissions'
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

  const [flowRes, runsRes, usersRes, rolesRes] = await Promise.all([
    (db.execute(sql`
      select id, name, enabled, subject_kind, graph, ${documentRevisionSql(sql`updated_at`)} as updated_at
        from flows where id = ${id} and org_id = ${authz.user.orgId}`)),
    (db.execute(sql`
      select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
        from flow_runs where flow_id = ${id} and org_id = ${authz.user.orgId}
       order by started_at desc limit 30`)),
    (db.execute(sql`
      select id, name, email from users
       where org_id = ${authz.user.orgId} and is_active
       order by name`)),
    (db.execute(sql`
      select key, name from app_roles
       where org_id = ${authz.user.orgId}
       order by name`)),
  ])
  const flow = flowRes.rows[0]
  if (!flow) notFound()

  const profile = await flowSubjectProfileForOrg(authz.user.orgId, String(flow.subject_kind))
  if (!profile) notFound()

  return (
    <div className="p-4">
      <FlowBuilder
        flow={{
          id: String(flow.id),
          name: String(flow.name),
          enabled: Boolean(flow.enabled),
          updatedAt: String(flow.updated_at),
          graph: flow.graph as AutomationGraph,
        }}
        runs={runsRes.rows as FlowRunRow[]}
        profile={profile}
        users={usersRes.rows.map((user) => ({
          id: String(user.id),
          name: String(user.name),
          email: String(user.email),
        }))}
        roles={rolesRes.rows.map((role) => ({
          key: String(role.key),
          name: String(role.name),
        }))}
        permissions={[...PERMISSION_CATALOGUE]}
      />
    </div>
  )
}
