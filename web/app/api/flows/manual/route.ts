import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { evaluateLogicRule, planAutomation, type EvalContext } from '@openbooks/forms-core'
import { db, schema, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import {
  dispatchFailureReason,
  getFlowAdapter,
  parseFlowGraph,
  runRecordFlows,
} from '@openbooks/engine/src/flows/index.ts'
import { can, guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { canReadFlowSubject, manualButtonPermission } from '../../../../lib/flow-subject-authz'
import { loadFlowSubjectSubsidiary, requireFlowsSession } from '../_lib'
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

  // Domain read before anything about the record is disclosed: without the
  // subject kind's read grant the record answers exactly as if missing.
  if (!canReadFlowSubject(authz, subjectKind)) {
    return NextResponse.json({ error: 'record not found' }, { status: 404 })
  }
  // Manual flows can mutate their subject. Resolve its legal entity before
  // loading any values or evaluating buttons so a restricted caller cannot
  // use a forged id to run an action on a hidden subsidiary's record.
  const denied = guardSubsidiaryScope(
    authz,
    await loadFlowSubjectSubsidiary(subjectKind, subjectId, authz.user.orgId),
  )
  if (denied) return denied

  const subject = await adapter.loadContext(subjectId)
  if (!subject) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  // Viewer-aware showIf (source platform button conditions like "Next Approver =
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
      // Subject action authority, independent of the trigger's optional
      // requirePermission: the button's own planned effects decide the
      // grant — edit for field sets, post/approve for status transitions
      // and posts. A button the caller may not run stays hidden, exactly
      // like a failed requirePermission, so POST meets the same
      // unavailability refusal for it.
      const required = manualButtonPermission(
        subjectKind,
        planAutomation(graph, { kind: 'manual', buttonId: td.buttonId }, evalCtx),
      )
      if (!required || !can(authz, required)) continue
      seen.add(td.buttonId)
      buttons.push({ buttonId: td.buttonId, label: td.label, confirm: td.confirm })
    }
  }
  return buttons
}

export async function GET(req: Request) {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz

  const url = new URL(req.url)
  const subjectKind = url.searchParams.get('subjectKind') ?? ''
  const subjectId = url.searchParams.get('subjectId') ?? ''
  if (!subjectKind || !isUuid(subjectId)) {
    return NextResponse.json({ error: 'subjectKind and subjectId required' }, { status: 400 })
  }

  const buttons = await withOrgContext(authz.user.orgId, () =>
    availableButtons(authz, subjectKind, subjectId),
  )
  if (buttons instanceof NextResponse) return buttons
  return NextResponse.json({ buttons })
}

export async function POST(req: Request) {
  const authz = await requireFlowsSession()
  if (authz instanceof NextResponse) return authz

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    subjectKind?: string
    subjectId?: string
    buttonId?: string
  }
  if (!body.subjectKind || !isUuid(body.subjectId ?? '') || !body.buttonId) {
    return NextResponse.json({ error: 'subjectKind, subjectId, buttonId required' }, { status: 400 })
  }

  const buttons = await withOrgContext(authz.user.orgId, () =>
    availableButtons(authz, body.subjectKind!, body.subjectId!),
  )
  if (buttons instanceof NextResponse) return buttons
  if (!buttons.some((b) => b.buttonId === body.buttonId)) {
    return NextResponse.json({ error: 'this action is not available' }, { status: 404 })
  }

  const result = await withOrgContext(authz.user.orgId, () =>
    runRecordFlows(
      { kind: 'manual', buttonId: body.buttonId! },
      body.subjectKind!,
      body.subjectId!,
      { orgId: authz.user.orgId, userId: authz.user.id },
    ),
  )
  // A dispatch-level failure leaves NO runs behind (the dispatch threw before
  // any flow ran). Reporting 200 ok:true for that would toast success for
  // work that never ran — refuse loudly with the dispatch reason instead.
  if (result.failed && result.runs.length === 0) {
    return NextResponse.json(
      { error: result.error ?? 'flow dispatch failed' },
      { status: 500 },
    )
  }
  const failed = result.failed || result.runs.some((r) => r.status === 'failed')
  const reason = failed ? dispatchFailureReason(result) : null
  return NextResponse.json({
    ok: !failed,
    runs: result.runs,
    gatesCreated: result.gatesCreated,
    ...(reason ? { error: reason } : {}),
  })
}
