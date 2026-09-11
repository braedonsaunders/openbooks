import 'server-only'

import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { documentRevisionSql } from '@openbooks/engine/src/document-revision.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { flowSubjectProfileForOrg } from '@openbooks/engine/src/flows/index.ts'
import type { AutomationGraph } from '@openbooks/forms-core'
import { frame, page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { PERMISSION_CATALOGUE } from '../../../../../lib/permissions'
import type FlowBuilder from './FlowBuilder'
import type { FlowRunRow } from '../_builder/RunsPanel'

/**
 * The approval-flow builder, split into a loader and a spec.
 *
 * One whole client island: a graph canvas with node/edge editing, a gate
 * inspector, a runs panel and every save. The spec places it over
 * loader-resolved props.
 *
 * `permissions` is `PERMISSION_CATALOGUE` — the static list of permission KEYS
 * the app defines, used to populate the gate inspector's picker. It is a
 * catalogue, not a grant: nothing about it is caller-specific, and it confers
 * nothing. The caller's own grants never leave the loader.
 *
 * Two `notFound()`s and they are not redundant. The flow may not exist in this
 * org, or its subject kind may have no profile registered — a flow whose
 * subject was removed cannot be edited, and it must be indistinguishable from
 * a flow that was never there.
 */

type BuilderProps = Parameters<typeof FlowBuilder>[0]

export interface FlowBuilderData {
  flow: BuilderProps['flow']
  runs: FlowRunRow[]
  profile: BuilderProps['profile']
  users: BuilderProps['users']
  roles: BuilderProps['roles']
  permissions: BuilderProps['permissions']
}

export async function loadFlowBuilder(id: string): Promise<FlowBuilderData> {
  const authz = await requirePermission('flows.manage')
  if (!isUuid(id)) notFound()

  const [flowRes, runsRes, usersRes, rolesRes] = await Promise.all([
    db.execute(sql`
      select id, name, enabled, subject_kind, graph, ${documentRevisionSql(sql`updated_at`)} as updated_at
        from flows where id = ${id} and org_id = ${authz.user.orgId}`),
    db.execute(sql`
      select id, subject_kind, subject_id, trigger, status, error, started_at, finished_at
        from flow_runs where flow_id = ${id} and org_id = ${authz.user.orgId}
       order by started_at desc limit 30`),
    db.execute(sql`
      select id, name, email from users
       where org_id = ${authz.user.orgId} and is_active
       order by name`),
    db.execute(sql`
      select key, name from app_roles
       where org_id = ${authz.user.orgId}
       order by name`),
  ])
  const flow = flowRes.rows[0]
  if (!flow) notFound()

  const profile = await flowSubjectProfileForOrg(authz.user.orgId, String(flow.subject_kind))
  if (!profile) notFound()

  return {
    flow: {
      id: String(flow.id),
      name: String(flow.name),
      enabled: Boolean(flow.enabled),
      updatedAt: String(flow.updated_at),
      graph: flow.graph as AutomationGraph,
    },
    runs: runsRes.rows as FlowRunRow[],
    profile,
    users: usersRes.rows.map((user) => ({
      id: String(user.id),
      name: String(user.name),
      email: String(user.email),
    })),
    roles: rolesRes.rows.map((role) => ({
      key: String(role.key),
      name: String(role.name),
    })),
    permissions: [...PERMISSION_CATALOGUE],
  }
}

export function flowBuilderSpec(data: FlowBuilderData): PageSpec {
  return page({
    route: '/admin/flows/[id]',
    // Exact native wrapper: <div className="p-4">.
    layout: 'bare',
    header: [],
    body: [
      frame('padded', [
        widgetBlock('flow-builder', {
          flow: data.flow,
          runs: data.runs,
          profile: data.profile,
          users: data.users,
          roles: data.roles,
          permissions: data.permissions,
        }),
      ]),
    ],
  })
}
