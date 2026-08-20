import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/src/db.ts'
import { gateDecisionCapability, getFlowAdapter } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Record-level approval state for the document flyout (source platform-parity
 * approval UX): who the record is pending with, whether THIS viewer can
 * decide, and a chronological approval history — all from the Flows engine
 * (flow_runs + flow_gates).
 *
 *   GET ?subjectKind=&subjectId= →
 *     {
 *       approvalState: {
 *         status,                                  // document status
 *         pendingWith: [{ name, gateId, since }],
 *         myActions: { gateId } | null
 *       },
 *       history: [{ id, type, actor, comment, at, title?, delegated? }]
 *     }
 *
 * myActions mirrors the decide endpoint's authorization exactly (engine
 * gates.ts canActOnGate): the row's assignee, a holder of its assigneeRole,
 * or an org admin.
 */

export type ApprovalEventType =
  | 'submitted'
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'escalated'
  | 'delegated'

export interface PendingWithEntry {
  name: string
  gateId?: string
  /** ISO timestamp the assignment has been waiting since. */
  since: string
}

export interface ApprovalHistoryEntry {
  id: string
  type: ApprovalEventType
  /** Display name of who acted (or who the request went to, for 'requested'). */
  actor: string | null
  comment: string | null
  /** ISO timestamp. */
  at: string
  /** Gate title, when there is one. */
  title?: string
  /** Gate decided by a delegate. */
  delegated?: boolean
}

export interface RecordApprovalState {
  approvalState: {
    status: string
    pendingWith: PendingWithEntry[]
    myActions: {
      gateId?: string
      signatureRequired?: boolean
    } | null
  }
  history: ApprovalHistoryEntry[]
}

type Rows<T> = { rows: T[] }

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : ''

/** `[delegated YYYY-MM-DD by <userId> → <name>]` markers written by delegateGate. */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const subjectKind = url.searchParams.get('subjectKind') ?? ''
  const subjectId = url.searchParams.get('subjectId') ?? ''
  if (!subjectKind || !isUuid(subjectId)) {
    return NextResponse.json({ error: 'subjectKind and subjectId required' }, { status: 400 })
  }

  const orgId = authz.user.orgId
  const adapter = getFlowAdapter(subjectKind)
  if (!adapter) return NextResponse.json({ error: 'unknown subject kind' }, { status: 400 })
  const status = await withOrgContext(orgId, () => adapter.getStatus(subjectId))
  if (status === null) return NextResponse.json({ error: 'record not found' }, { status: 404 })

  const [gates, runs, roleRows] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select g.id, g.status, g.title, g.comment,
             g.assignee_user_id as "assigneeUserId", g.assignee_role as "assigneeRole",
             g.decided_by as "decidedBy", g.decided_at as "decidedAt",
             g.created_at as "createdAt", g.updated_at as "updatedAt",
             g.delegated_from_user_id as "delegatedFromUserId",
             g.on_behalf_of_user_id as "onBehalfOfUserId",
             au.name as "assigneeName", du.name as "deciderName",
             fu.name as "delegatedFromName", ou.name as "onBehalfOfName"
        from flow_gates g
        left join users au on au.id = g.assignee_user_id
        left join users du on du.id = g.decided_by
        left join users fu on fu.id = g.delegated_from_user_id
        left join users ou on ou.id = g.on_behalf_of_user_id
       where g.org_id = ${orgId} and g.subject_kind = ${subjectKind} and g.subject_id = ${subjectId}
       order by g.created_at
    `),
    db.execute<Record<string, unknown>>(sql`
      select r.id, r.started_at as "startedAt", u.name as "submitterName"
        from flow_runs r
        left join users u on u.id = r.created_by
       where r.org_id = ${orgId} and r.subject_kind = ${subjectKind}
         and r.subject_id = ${subjectId}
       order by r.started_at
    `),
    db.execute<{ key: string; name: string }>(sql`
      select key, name from app_roles where org_id = ${orgId}
    `),
  ])

  const roleLabel = (key: string | null): string | null => {
    if (!key) return null
    return roleRows.rows.find((r) => r.key === key)?.name ?? key
  }
  // --- pendingWith + myActions ---------------------------------------------
  const pendingWith: PendingWithEntry[] = []
  const myActions: RecordApprovalState['approvalState']['myActions'] = {}

  for (const g of gates.rows) {
    if (g.status !== 'pending') continue
    const name = (g.assigneeName as string | null) ?? roleLabel(g.assigneeRole as string | null) ?? '—'
    pendingWith.push({ name, gateId: String(g.id), since: iso(g.createdAt) })
    const capability = await withOrgContext(orgId, () =>
      gateDecisionCapability(String(g.id), authz.user.id),
    )
    if (capability.canAct && !myActions.gateId) {
      myActions.gateId = String(g.id)
      myActions.signatureRequired = capability.signatureRequired
    }
  }

  // --- history --------------------------------------------------------------
  const history: ApprovalHistoryEntry[] = []

  for (const r of runs.rows) {
    history.push({
      id: `run:${r.id}`,
      type: 'submitted',
      actor: (r.submitterName as string | null) ?? null,
      comment: null,
      at: iso(r.startedAt),
    })
  }

  for (const g of gates.rows) {
    const assignee =
      (g.assigneeName as string | null) ?? roleLabel(g.assigneeRole as string | null)
    if (g.status !== 'cancelled') {
      // Sibling rows cancelled by a satisfied 'any' quorum are routing noise;
      // their creation still shows who the approval was requested from.
      history.push({
        id: `gate:${g.id}:requested`,
        type: 'requested',
        actor: assignee,
        comment: null,
        at: iso(g.createdAt),
        title: String(g.title ?? ''),
      })
    }
    // Delegation hand-off — structured provenance (delegated_from_user_id),
    // recorded when the gate was reassigned; the current assignee holds it now.
    if (g.delegatedFromUserId) {
      history.push({
        id: `gate:${g.id}:delegated`,
        type: 'delegated',
        actor: (g.assigneeName as string | null) ?? assignee,
        comment: null,
        at: iso(g.updatedAt),
        title: String(g.title ?? ''),
      })
    }
    if (g.status === 'approved' || g.status === 'rejected') {
      history.push({
        id: `gate:${g.id}:decided`,
        type: g.status,
        actor: (g.deciderName as string | null) ?? assignee,
        comment: g.comment as string | null,
        at: iso(g.decidedAt ?? g.updatedAt),
        title: String(g.title ?? ''),
        // A delegate decided on behalf of the original assignee.
        delegated: !!g.onBehalfOfUserId,
      })
    } else if (g.status === 'escalated') {
      history.push({
        id: `gate:${g.id}:escalated`,
        type: 'escalated',
        actor: assignee,
        comment: null,
        at: iso(g.updatedAt),
        title: String(g.title ?? ''),
      })
    }
  }

  history.sort((a, b) => a.at.localeCompare(b.at))

  const body: RecordApprovalState = {
    approvalState: {
      status,
      pendingWith,
      myActions: myActions.gateId ? myActions : null,
    },
    history,
  }
  return NextResponse.json(body)
}
