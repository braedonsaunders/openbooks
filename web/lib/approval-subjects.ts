import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { pgTextArrayLiteral } from './pg-array'

/**
 * Party + decision summary for subject-kind approval rows.
 *
 * Document gates carry their party and total on the joined document; every
 * other gatable kind renders an opaque id with nowhere to click unless a
 * resolver below names its subject. Resolvers are per kind, batched, and
 * org-scoped — never inline special cases in the inbox view, and never a
 * cross-org read: an unresolvable subject keeps nulls and the row falls
 * back to the id, exactly like a restricted caller failing closed.
 */

export interface ApprovalSubjectDetail {
  /** Who the decision is about (the employee for change requests). */
  partyName: string | null
  /** What the approver decides (change kind, effective date, and
   *  compensation terms where the payload carries them). */
  summary: string | null
}

export interface ApprovalSubjectText {
  (key: string): string
  has: (key: string) => boolean
}

type SubjectResolver = (
  orgId: string,
  subjectIds: string[],
  text: ApprovalSubjectText,
) => Promise<Map<string, ApprovalSubjectDetail>>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Change kinds with requestKinds catalog labels (me.requestKinds.*). */
const KNOWN_CHANGE_KINDS = [
  'hire',
  'status_change',
  'assignment_change',
  'termination',
  'position_assignment',
  'profile_change',
] as const

function changeKindLabel(text: ApprovalSubjectText, kind: string): string {
  const key = `me.requestKinds.${kind}`
  return (KNOWN_CHANGE_KINDS as readonly string[]).includes(kind) && text.has(key)
    ? text(key)
    : kind
}

/**
 * Compensation terms from the proposal payload. No v1 payload kind (hire,
 * status_change, assignment_change, termination, position_assignment,
 * profile_change) carries compensation — terms live on the employment's
 * wage rates, never the proposal — so none render today. This stays the
 * single place a future payload version plugs its terms into, rather
 * than a second formatter beside the row.
 */
function compensationTerms(payload: Record<string, unknown>): string | null {
  const terms = payload.compensation
  if (typeof terms === 'string' && terms.trim()) return terms.trim()
  return null
}

function changeRequestSummary(
  payload: Record<string, unknown>,
  text: ApprovalSubjectText,
): string | null {
  const kind = typeof payload.kind === 'string' ? payload.kind : null
  const effective =
    typeof payload.effectiveFrom === 'string'
      ? payload.effectiveFrom
      : typeof payload.effectiveDate === 'string'
        ? payload.effectiveDate
        : null
  const parts = [
    kind ? changeKindLabel(text, kind) : null,
    effective ? `${text('queue.columns.effective')} ${effective}` : null,
    compensationTerms(payload),
  ].filter((part): part is string => part != null && part !== '')
  return parts.length > 0 ? parts.join(' · ') : null
}

async function resolveHrmChangeRequests(
  orgId: string,
  subjectIds: string[],
  text: ApprovalSubjectText,
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>()
  const ids = [...new Set(subjectIds)].filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return out
  const rows = (await db.execute<{
    id: string
    employeeName: string | null
    payload: Record<string, unknown>
  }>(sql`
    select r.id, p.display_name as "employeeName", r.payload
      from hrm_employment_change_requests r
      join worker_employments e on e.id = r.employment_id and e.org_id = r.org_id
      join parties p on p.id = e.worker_party_id and p.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = any(${pgTextArrayLiteral(ids)}::uuid[])
  `)).rows
  for (const row of rows) {
    out.set(String(row.id), {
      partyName: row.employeeName,
      summary: changeRequestSummary((row.payload ?? {}) as Record<string, unknown>, text),
    })
  }
  return out
}

const SUBJECT_RESOLVERS: Record<string, SubjectResolver> = {
  hrm_employment_change_request: resolveHrmChangeRequests,
}

/**
 * Batched subject details for approval rows, keyed `${kind}:${subjectId}`.
 * Kinds without a resolver resolve to nothing — the row keeps its id
 * fallback — and unresolvable subjects stay absent rather than throwing.
 */
export async function resolveApprovalSubjects(
  orgId: string,
  items: ReadonlyArray<{ kind: string; subjectId: string }>,
  text: ApprovalSubjectText,
): Promise<Map<string, ApprovalSubjectDetail>> {
  const out = new Map<string, ApprovalSubjectDetail>()
  const byKind = new Map<string, string[]>()
  for (const item of items) {
    if (!SUBJECT_RESOLVERS[item.kind]) continue
    const ids = byKind.get(item.kind) ?? []
    ids.push(item.subjectId)
    byKind.set(item.kind, ids)
  }
  for (const [kind, ids] of byKind) {
    const resolved = await SUBJECT_RESOLVERS[kind]!(orgId, ids, text)
    for (const [id, detail] of resolved) out.set(`${kind}:${id}`, detail)
  }
  return out
}
