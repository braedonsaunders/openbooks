import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { userRoleKeys } from '@openbooks/engine/src/flows/targets.ts'
import { getAuthz, can } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Record-level approval state for the document flyout (NetSuite-parity
 * approval UX): who the record is pending with, whether THIS viewer can
 * decide, and a merged chronological approval history — flow_runs +
 * flow_gates (the flows engine) fused with the legacy
 * approval_requests/approval_steps fallback for the same target.
 *
 *   GET ?subjectKind=&subjectId= →
 *     {
 *       approvalState: {
 *         status,                                  // document status
 *         pendingWith: [{ name, gateId?, legacy?, since }],
 *         myActions: { gateId?, legacyStep? } | null
 *       },
 *       history: [{ id, type, actor, comment, at, title?, legacy?, delegated? }]
 *     }
 *
 * myActions mirrors the two decide endpoints' authorization exactly:
 *   • flow gate (engine gates.ts canActOnGate): the row's assignee, a holder
 *     of its assigneeRole, or an org admin;
 *   • legacy step (api/approvals/decide): the kind's approve permission, plus
 *     the step must plausibly be the viewer's (role match / party match /
 *     admin) so we don't paint approve buttons for bystanders who merely hold
 *     the permission.
 */

// Mirrors web/app/api/approvals/decide/route.ts APPROVE_PERMISSION — the
// legacy decide endpoint's kind → permission gate.
const LEGACY_APPROVE_PERMISSION: Record<string, string> = {
  vendor_bill: 'ap.approve',
  expense_report: 'ap.approve',
  customer_invoice: 'ar.approve',
}

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
  legacy?: boolean
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
  /** Gate title / step label, when there is one. */
  title?: string
  legacy?: boolean
  /** Legacy step decided by a delegate. */
  delegated?: boolean
}

export interface RecordApprovalState {
  approvalState: {
    status: string
    pendingWith: PendingWithEntry[]
    myActions: {
      gateId?: string
      legacyStep?: { requestId: string; stepNumber: number }
    } | null
  }
  history: ApprovalHistoryEntry[]
}

type Rows<T> = { rows: T[] }

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : ''

/** `[delegated YYYY-MM-DD by <userId> → <name>]` markers written by delegateGate. */
const DELEGATION_NOTE = /\[delegated (\d{4}-\d{2}-\d{2}) by \S+ → ([^\]]+)\]/g

function stripDelegationNotes(comment: string | null): string | null {
  if (!comment) return null
  const cleaned = comment.replace(DELEGATION_NOTE, '').trim()
  return cleaned || null
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

  const orgId = authz.user.orgId
  const doc = (await db.execute(sql`
    select id, kind, status from documents
     where id = ${subjectId} and org_id = ${orgId} and kind = ${subjectKind}
  `)) as unknown as Rows<{ id: string; kind: string; status: string }>
  if (!doc.rows[0]) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const status = doc.rows[0].status

  const [gates, runs, legacyRequests, roleRows, viewerRow, viewerRoles] = await Promise.all([
    db.execute(sql`
      select g.id, g.status, g.title, g.comment,
             g.assignee_user_id as "assigneeUserId", g.assignee_role as "assigneeRole",
             g.decided_by as "decidedBy", g.decided_at as "decidedAt",
             g.created_at as "createdAt", g.updated_at as "updatedAt",
             au.name as "assigneeName", du.name as "deciderName"
        from flow_gates g
        left join users au on au.id = g.assignee_user_id
        left join users du on du.id = g.decided_by
       where g.org_id = ${orgId} and g.subject_kind = ${subjectKind} and g.subject_id = ${subjectId}
       order by g.created_at
    `) as unknown as Promise<Rows<Record<string, unknown>>>,
    db.execute(sql`
      select r.id, r.started_at as "startedAt", u.name as "submitterName"
        from flow_runs r
        left join users u on u.id = r.created_by
       where r.org_id = ${orgId} and r.subject_kind = ${subjectKind}
         and r.subject_id = ${subjectId} and r.trigger = 'on_submit'
       order by r.started_at
    `) as unknown as Promise<Rows<Record<string, unknown>>>,
    db.execute(sql`
      select r.id, r.status, r.current_step as "currentStep", r.created_at as "createdAt",
             u.name as "submitterName",
             s.id as "stepId", s.step_number as "stepNumber", s.decision,
             s.assignee_role as "stepRole", s.decided_at as "decidedAt",
             s.note, s.is_delegated as "isDelegated", s.created_at as "stepCreatedAt",
             ap.display_name as "assigneePartyName", s.assignee_party_id as "assigneePartyId",
             du.name as "deciderName"
        from approval_requests r
        left join users u on u.id = r.submitted_by
        join approval_steps s on s.request_id = r.id
        left join parties ap on ap.id = s.assignee_party_id
        left join users du on du.id = s.decided_by
       where r.org_id = ${orgId} and r.target_kind = ${subjectKind} and r.target_id = ${subjectId}
       order by r.created_at, s.step_number
    `) as unknown as Promise<Rows<Record<string, unknown>>>,
    db.execute(sql`
      select key, name from app_roles where org_id = ${orgId}
    `) as unknown as Promise<Rows<{ key: string; name: string }>>,
    db.execute(sql`
      select party_id as "partyId" from users where id = ${authz.user.id}
    `) as unknown as Promise<Rows<{ partyId: string | null }>>,
    userRoleKeys(orgId, authz.user.id),
  ])

  const roleLabel = (key: string | null): string | null => {
    if (!key) return null
    return roleRows.rows.find((r) => r.key === key)?.name ?? key
  }
  const viewerPartyId = viewerRow.rows[0]?.partyId ?? null
  const isAdmin = viewerRoles.has('admin')

  // --- pendingWith + myActions ---------------------------------------------
  const pendingWith: PendingWithEntry[] = []
  const myActions: RecordApprovalState['approvalState']['myActions'] = {}

  for (const g of gates.rows) {
    if (g.status !== 'pending') continue
    const name = (g.assigneeName as string | null) ?? roleLabel(g.assigneeRole as string | null) ?? '—'
    pendingWith.push({ name, gateId: String(g.id), since: iso(g.createdAt) })
    // Engine canActOnGate semantics: direct assignee, admin, or role holder.
    const mine =
      g.assigneeUserId === authz.user.id ||
      isAdmin ||
      (!!g.assigneeRole && viewerRoles.has(String(g.assigneeRole)))
    if (mine && !myActions.gateId) myActions.gateId = String(g.id)
  }

  for (const s of legacyRequests.rows) {
    if (s.status !== 'pending' || s.decision !== 'pending') continue
    if (Number(s.stepNumber) !== Number(s.currentStep)) continue
    const name =
      (s.assigneePartyName as string | null) ?? roleLabel(s.stepRole as string | null) ?? '—'
    pendingWith.push({
      name,
      legacy: true,
      since: iso(s.stepCreatedAt ?? s.createdAt),
    })
    const perm = LEGACY_APPROVE_PERMISSION[subjectKind] ?? 'ap.approve'
    const mine =
      can(authz, perm) &&
      (isAdmin ||
        (!!s.stepRole && viewerRoles.has(String(s.stepRole))) ||
        (!!s.assigneePartyId && s.assigneePartyId === viewerPartyId))
    if (mine && !myActions.legacyStep) {
      myActions.legacyStep = { requestId: String(s.id), stepNumber: Number(s.stepNumber) }
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
    // Delegation hand-offs survive on pending rows as comment markers.
    for (const m of String(g.comment ?? '').matchAll(DELEGATION_NOTE)) {
      history.push({
        id: `gate:${g.id}:delegated:${m[1]}`,
        type: 'delegated',
        actor: m[2]!.trim(),
        comment: null,
        at: new Date(`${m[1]}T00:00:00Z`).toISOString(),
        title: String(g.title ?? ''),
      })
    }
    if (g.status === 'approved' || g.status === 'rejected') {
      history.push({
        id: `gate:${g.id}:decided`,
        type: g.status,
        actor: (g.deciderName as string | null) ?? assignee,
        comment: stripDelegationNotes(g.comment as string | null),
        at: iso(g.decidedAt ?? g.updatedAt),
        title: String(g.title ?? ''),
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

  const seenRequests = new Set<string>()
  for (const s of legacyRequests.rows) {
    if (!seenRequests.has(String(s.id))) {
      seenRequests.add(String(s.id))
      history.push({
        id: `req:${s.id}`,
        type: 'submitted',
        actor: (s.submitterName as string | null) ?? null,
        comment: null,
        at: iso(s.createdAt),
        legacy: true,
      })
    }
    if (s.decision === 'approved' || s.decision === 'rejected') {
      history.push({
        id: `step:${s.stepId}`,
        type: s.decision,
        actor:
          (s.deciderName as string | null) ??
          (s.assigneePartyName as string | null) ??
          roleLabel(s.stepRole as string | null),
        comment: (s.note as string | null) ?? null,
        at: iso(s.decidedAt),
        legacy: true,
        delegated: s.isDelegated === true,
      })
    }
  }

  history.sort((a, b) => a.at.localeCompare(b.at))

  const body: RecordApprovalState = {
    approvalState: {
      status,
      pendingWith,
      myActions: myActions.gateId || myActions.legacyStep ? myActions : null,
    },
    history,
  }
  return NextResponse.json(body)
}
