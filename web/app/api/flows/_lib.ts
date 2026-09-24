import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { DecisionFailedError, GateError } from '@openbooks/engine/src/flows/index.ts'
import { getAuthz, type Authz } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'

/** Session + Flows feature gate for /api/flows/* (pages already 404 when off). */
export async function requireFlowsSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!(await isFeatureEnabled(authz.user.orgId, 'flows'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return authz
}

/** Shared helpers for the /api/flows/* gate endpoints. */

export type GateHeader = {
  id: string
  org_id: string
  status: string
  assignee_user_id: string | null
  assignee_role: string | null
  /** Legal entity owning the approval subject (null = unavailable/rootless). */
  subsidiary_id: string | null
};

/** Load a gate header scoped to the caller's org (null = not found for them). */
export async function loadGateHeader(gateId: string, orgId: string): Promise<GateHeader | null> {
  const r = (await db.execute<GateHeader>(sql`
    select g.id, g.org_id, g.status, g.assignee_user_id, g.assignee_role,
           case
             when g.subject_kind = 'party_bank_account' then (
               select p.subsidiary_id
                 from party_bank_accounts ba
                 join parties p on p.id = ba.party_id and p.org_id = ba.org_id
                where ba.id = g.subject_id and ba.org_id = g.org_id
             )
             when g.subject_kind = 'timesheet_week' then (
               select p.subsidiary_id
                 from timesheet_weeks tw
                 join parties p on p.id = tw.employee_party_id and p.org_id = tw.org_id
                where tw.id = g.subject_id and tw.org_id = g.org_id
             )
             else d.subsidiary_id
           end as subsidiary_id
      from flow_gates g
      left join documents d
        on d.id = g.subject_id and d.org_id = g.org_id and d.kind = g.subject_kind
     where g.id = ${gateId} and g.org_id = ${orgId}
  `))
  return r.rows[0] ?? null
}

/**
 * Resolve the legal entity behind a flow subject before a direct read. Flow
 * subjects are polymorphic: documents (including field tickets and pay runs)
 * carry their own subsidiary, while bank-account and timesheet subjects
 * inherit it from their party. A missing/non-entity subsidiary is deliberately
 * returned as null so restricted callers fail closed through
 * guardSubsidiaryScope, while unrestricted callers can still let the adapter
 * decide whether the subject exists.
 */
export async function loadFlowSubjectSubsidiary(
  subjectKind: string,
  subjectId: string,
  orgId: string,
): Promise<string | null> {
  const r = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select case
             when ${subjectKind} = 'party_bank_account' then (
               select p.subsidiary_id
                 from party_bank_accounts ba
                 join parties p on p.id = ba.party_id and p.org_id = ba.org_id
                where ba.id = ${subjectId} and ba.org_id = ${orgId}
             )
             when ${subjectKind} = 'timesheet_week' then (
               select p.subsidiary_id
                 from timesheet_weeks tw
                 join parties p on p.id = tw.employee_party_id and p.org_id = tw.org_id
                where tw.id = ${subjectId} and tw.org_id = ${orgId}
             )
             when ${subjectKind} in ('budget_scenario', 'close_run') then null
             else (
               select d.subsidiary_id
                 from documents d
                where d.id = ${subjectId}
                  and d.org_id = ${orgId}
                  and d.kind = ${subjectKind}
             )
           end as "subsidiaryId"
  `))
  return r.rows[0]?.subsidiaryId ?? null
}

/**
 * Filter flow_runs subjects to the caller's subsidiary scope — the retry
 * route's subject-scope rule, reused for run listings (a run UUID is not a
 * grant to every legal entity). Document subjects resolve batched one
 * query per kind; bank-account and timesheet subjects resolve through
 * loadFlowSubjectSubsidiary; every other kind resolves through the same
 * loader, which fails closed (null) for restricted callers. Unrestricted
 * callers (null scope) keep every subject. Duplicate subjects resolve
 * once. Returns the in-scope subset, preserving order.
 */
export async function filterFlowRunSubjectsToScope<T extends { kind: string; id: string }>(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  subjects: readonly T[],
): Promise<T[]> {
  if (allowedSubsidiaryIds === null) return [...subjects]
  if (subjects.length === 0) return []
  const subsidiaryBySubject = new Map<string, string | null>()
  const keyOf = (kind: string, id: string) => `${kind}\0${id}`
  // Document subjects (every kind the loader resolves through the
  // documents table) batch one query per kind.
  const documentKinds = new Map<string, { ids: string[] }>()
  const individual: { key: string; kind: string; id: string }[] = []
  for (const subject of subjects) {
    const key = keyOf(subject.kind, subject.id)
    if (subsidiaryBySubject.has(key)) continue
    subsidiaryBySubject.set(key, null)
    if (
      subject.kind === 'party_bank_account' ||
      subject.kind === 'timesheet_week' ||
      subject.kind === 'budget_scenario' ||
      subject.kind === 'close_run'
    ) {
      individual.push({ key, kind: subject.kind, id: subject.id })
    } else {
      const group = documentKinds.get(subject.kind) ?? { ids: [] }
      group.ids.push(subject.id)
      documentKinds.set(subject.kind, group)
    }
  }
  await Promise.all([
    ...[...documentKinds].map(async ([kind, group]) => {
      const uniqueIds = [...new Set(group.ids)]
      const r = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
        select id, subsidiary_id as "subsidiaryId" from documents
         where org_id = ${orgId} and kind = ${kind} and id = any(${`{${uniqueIds.join(',')}}`}::uuid[])
      `))
      for (const row of r.rows) subsidiaryBySubject.set(keyOf(kind, row.id), row.subsidiaryId)
    }),
    ...individual.map(async (item) => {
      subsidiaryBySubject.set(
        item.key,
        await loadFlowSubjectSubsidiary(item.kind, item.id, orgId),
      )
    }),
  ])
  // Fail-closed scope predicate, mirroring subsidiaryScopeAllows (kept
  // inline so this module's import surface — and the neighbouring unit
  // mock — stays exactly as it was): an unresolved or missing subsidiary
  // is never in scope for a restricted caller.
  return subjects.filter((subject) => {
    const subsidiaryId = subsidiaryBySubject.get(keyOf(subject.kind, subject.id))
    return subsidiaryId !== null && subsidiaryId !== undefined && allowedSubsidiaryIds.has(subsidiaryId)
  })
}

/**
 * Map an engine GateError onto an HTTP status. The engine throws one error
 * class with human-readable messages; the route pre-checks catch the common
 * cases (404 missing, 409 already decided) so this mapping only has to cover
 * races, authorization, and atomic decision failures.
 */
export function gateErrorResponse(e: unknown): NextResponse {
  // An atomic decision failure (any post-flip stage, including release)
  // records NOTHING — the gate stays pending — so it is never a success
  // and never a bare 'internal error'. The failure carries its cause's
  // class, set where it was constructed from the cause itself: a retryable
  // DOMAIN failure is a data condition (a typed refusal from the release
  // adapter, e.g. the approver's missing person link) — 422 with the
  // message intact, 409 when the cause names stale state, reusing the
  // markers below. A retryable INFRASTRUCTURE failure (a dropped
  // connection, a timeout, a serialization failure) is a 503 with a
  // retry-again message that carries no storage internals. Only a
  // non-retryable failure is a defect in the decide path, and only that
  // stays a 500. Every non-422 path logs.
  if (e instanceof DecisionFailedError) {
    if (e.retryable && e.causeKind === 'infrastructure') {
      console.error('[flows] approval decision hit infrastructure:', e)
      return NextResponse.json(
        { error: 'The approval service is temporarily unavailable, try again.' },
        { status: 503 },
      )
    }
    if (e.retryable) {
      const status = /already resolved|only a pending/.test(e.message) ? 409 : 422
      if (status === 409) console.error('[flows] approval decision raced:', e)
      return NextResponse.json({ error: e.message }, { status })
    }
    console.error('[flows] approval decision failed:', e)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
  if (e instanceof GateError) {
    const msg = e.message
    const status = /not found/.test(msg)
      ? 404
      : /already resolved|only a pending/.test(msg)
        ? 409
        : /not an approver|only the assignee/.test(msg)
          ? 403
          : 422
    return NextResponse.json({ error: msg }, { status })
  }
  console.error('[flows] gate endpoint failed:', e)
  return NextResponse.json({ error: 'internal error' }, { status: 500 })
}
