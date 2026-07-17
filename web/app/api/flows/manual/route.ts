import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { evaluateLogicRule, type EvalContext } from '@openbooks/forms-core'
import { db, schema } from '@openbooks/engine/src/db.ts'
import {
  getFlowAdapter,
  parseFlowGraph,
  runRecordFlows,
} from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, can, type Authz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Manual flow triggers — the "record buttons" authored as `manual` trigger
 * nodes on a flow graph.
 *
 *   GET  ?subjectKind=&subjectId=  → the buttons the CALLER may click on that
 *        record right now: enabled flows for the kind whose graphs carry
 *        manual triggers, with `requirePermission` checked against the
 *        caller's authz and `showIf` evaluated server-side against the
 *        record's live values.
 *   POST { subjectKind, subjectId, buttonId } → re-resolves availability the
 *        same way (never trust the client's button list), then dispatches
 *        runRecordFlows({ kind: 'manual', buttonId }).
 */

interface ManualButton {
  buttonId: string
  label: string
  confirm?: string
}

/** Resolve the manual buttons the caller may use on a record right now. */
async function availableButtons(
  authz: Authz,
  subjectKind: string,
  subjectId: string,
): Promise<ManualButton[] | NextResponse> {
  const adapter = getFlowAdapter(subjectKind)
  if (!adapter) return NextResponse.json({ error: 'unknown subject kind' }, { status: 400 })

  const subject = await adapter.loadContext(subjectId)
  if (!subject) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  // Viewer-aware showIf (NetSuite button conditions like "Next Approver =
  // Current User" / "Requestor = Current User"): inject who is LOOKING before
  // evaluating each button's rule.
  const [pendingGate] = await db
    .select({ id: schema.flowGates.id })
    .from(schema.flowGates)
    .where(
      and(
        eq(schema.flowGates.orgId, authz.user.orgId),
        eq(schema.flowGates.subjectId, subjectId),
        eq(schema.flowGates.status, 'pending'),
        eq(schema.flowGates.assigneeUserId, authz.user.id),
      ),
    )
    .limit(1)
  const evalCtx: EvalContext = {
    values: {
      ...subject.values,
      current_user_id: authz.user.id,
      is_submitter: subject.submitterUserId === authz.user.id,
      is_pending_approver: !!pendingGate,
    },
    rows: subject.rows ?? {},
  }

  const flows = await db
    .select({ id: schema.flows.id, graph: schema.flows.graph })
    .from(schema.flows)
    .where(
      and(
        eq(schema.flows.orgId, authz.user.orgId),
        eq(schema.flows.subjectKind, subjectKind),
        eq(schema.flows.enabled, true),
      ),
    )

  const buttons: ManualButton[] = []
  const seen = new Set<string>()
  for (const flow of flows) {
    const graph = parseFlowGraph(flow.id, flow.graph)
    if (!graph) continue
    for (const node of graph.nodes) {
      if (node.data.kind !== 'trigger' || node.data.trigger.trigger !== 'manual') continue
      const td = node.data.trigger
      if (seen.has(td.buttonId)) continue
      if (td.requirePermission && !can(authz, td.requirePermission)) continue
      if (td.showIf && !evaluateLogicRule(td.showIf, evalCtx)) continue
      seen.add(td.buttonId)
      buttons.push({ buttonId: td.buttonId, label: td.label, confirm: td.confirm })
    }
  }
  return buttons
}

export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const subjectKind = url.searchParams.get('subjectKind') ?? ''
  const subjectId = url.searchParams.get('subjectId') ?? ''
  if (!subjectKind || !isUuid(subjectId)) {
    return NextResponse.json({ error: 'subjectKind and subjectId required' }, { status: 400 })
  }

  const buttons = await availableButtons(authz, subjectKind, subjectId)
  if (buttons instanceof NextResponse) return buttons
  return NextResponse.json({ buttons })
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as {
    subjectKind?: string
    subjectId?: string
    buttonId?: string
  }
  if (!body.subjectKind || !isUuid(body.subjectId ?? '') || !body.buttonId) {
    return NextResponse.json({ error: 'subjectKind, subjectId, buttonId required' }, { status: 400 })
  }

  const buttons = await availableButtons(authz, body.subjectKind, body.subjectId!)
  if (buttons instanceof NextResponse) return buttons
  if (!buttons.some((b) => b.buttonId === body.buttonId)) {
    return NextResponse.json({ error: 'this action is not available' }, { status: 404 })
  }

  const result = await runRecordFlows(
    { kind: 'manual', buttonId: body.buttonId },
    body.subjectKind,
    body.subjectId!,
    { orgId: authz.user.orgId, userId: authz.user.id },
  )
  const failed = result.runs.some((r) => r.status === 'failed')
  return NextResponse.json({
    ok: !failed,
    runs: result.runs,
    gatesCreated: result.gatesCreated,
  })
}
