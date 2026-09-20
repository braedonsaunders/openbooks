import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { retryFlowRun, FlowRetryError } from '@openbooks/engine/src/flows/index.ts'
import { loadFlowSubjectSubsidiary } from '../../../_lib'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Re-drive a FAILED flow run after its failure cause is fixed (F-t04-004: a
 * gate that resolved to zero assignees strands its subject with no path
 * forward). Retrying re-plans the stored trigger against the current graph
 * and current subject values on the same run row. Refusals are request
 * state (FlowRetryError → 4xx), never 500s.
 *
 * A run UUID is not a grant to every legal entity. The route resolves the
 * subject's subsidiary and applies the same direct-record gate as
 * record-state / decide / manual before the engine may re-drive the run.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('flows.manage', 'flows')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const orgId = gate.user.orgId
  const run = (await db.execute<{ subjectKind: string; subjectId: string }>(sql`
    select subject_kind as "subjectKind", subject_id as "subjectId"
      from flow_runs
     where id = ${id} and org_id = ${orgId}
  `)).rows[0]
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const subsidiaryDenied = guardSubsidiaryScope(
    gate,
    await loadFlowSubjectSubsidiary(run.subjectKind, run.subjectId, orgId),
  )
  if (subsidiaryDenied) return subsidiaryDenied

  try {
    const result = await retryFlowRun(id, { orgId, userId: gate.user.id })
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof FlowRetryError) {
      const status = /not found/.test(e.message) ? 404 : 422
      return NextResponse.json({ error: e.message }, { status })
    }
    throw e
  }
}
