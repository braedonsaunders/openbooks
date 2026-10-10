import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { DecisionFailedError, GateError, getFlowAdapter } from '@openbooks/engine/src/flows/index.ts'
import {
  FlowSubjectScopeUnresolvedError,
  lockSubjectScope,
  resolveSubjectSubsidiaries,
} from '@openbooks/engine/src/flows/subject-scope.ts'
import { getAuthz, type Authz } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { canReadFlowSubject } from '../../../lib/flow-subject-authz'
import { notFound } from "@/lib/api/responses";

/** Session + Flows feature gate for /api/flows/* (pages already 404 when off). */

export async function requireFlowsSession(): Promise<Authz | NextResponse> {
  const authz = await getAuthz();
  if (!authz)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await isFeatureEnabled(authz.user.orgId, "flows"))) {
    return notFound("record");
  }
  return authz;
}

/**
 * Session for the record-level Flow reads that other modules' drawers embed
 * (approval state, manual record buttons). Those surfaces render on every
 * document whether or not the organization uses Flows, so Flows being off is
 * not a refusal there: the caller still meets the subject's own read grant
 * and legal-entity scope, and the route answers with an empty state that
 * discloses no gates, runs or buttons.
 */
export async function requireFlowsRecordReader(): Promise<
  { authz: Authz; flowsEnabled: boolean } | NextResponse
> {
  const authz = await getAuthz();
  if (!authz)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return { authz, flowsEnabled: await isFeatureEnabled(authz.user.orgId, "flows") };
}

/** Shared helpers for the /api/flows/* gate endpoints. */

export type GateHeader = {
  id: string;
  org_id: string;
  status: string;
  assignee_user_id: string | null;
  assignee_role: string | null;
  /** Legal entity owning the approval subject (null = unavailable/rootless). */
  subsidiary_id: string | null
  subject_kind: string
  subject_id: string
};

/** Load a gate header scoped to the caller's org (null = not found for them). */
export async function loadGateHeader(
  gateId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<GateHeader | null> {
  const r = (await db.execute<Omit<GateHeader, 'subsidiary_id'>>(sql`
    select g.id, g.org_id, g.status, g.assignee_user_id, g.assignee_role,
           g.subject_kind, g.subject_id
      from flow_gates g
     where g.id = ${gateId} and g.org_id = ${orgId}
  `))
  const gate = r.rows[0]
  if (!gate) return null
  const scope = getFlowAdapter(gate.subject_kind)?.scope
  if (!scope) throw new FlowSubjectScopeUnresolvedError(gate.subject_kind, gate.subject_id)
  const owners = await resolveSubjectSubsidiaries(
    orgId,
    gate.subject_kind,
    scope,
    [gate.subject_id],
    allowedSubsidiaryIds,
  )
  const subsidiaryId = owners.get(gate.subject_id) ?? null
  // A custom scope's visibility is richer than one owner row (an allocation
  // run's whole computation): a restricted caller it hides meets the same
  // answer as a missing gate.
  if (scope.via === 'custom' && allowedSubsidiaryIds !== null && subsidiaryId === null) return null
  return { ...gate, subsidiary_id: subsidiaryId }
}

/**
 * Resolve the legal entity behind a flow subject before a direct read,
 * through the subject kind's declared scope. A missing/non-entity
 * subsidiary is deliberately returned as null so restricted callers fail
 * closed through guardSubsidiaryScope, while unrestricted callers can still
 * let the adapter decide whether the subject exists.
 */
export async function loadFlowSubjectSubsidiary(
  subjectKind: string,
  subjectId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<string | null> {
  const scope = getFlowAdapter(subjectKind)?.scope
  if (!scope) throw new FlowSubjectScopeUnresolvedError(subjectKind, subjectId)
  const owners = await resolveSubjectSubsidiaries(orgId, subjectKind, scope, [subjectId], allowedSubsidiaryIds)
  return owners.get(subjectId) ?? null
}

/** Lock the canonical scope owner for the complete record-level flow read.
 * Call inside an organization transaction and keep that transaction open
 * through status, gate, run, and history reads. */
export async function lockFlowSubjectScope(
  subjectKind: string,
  subjectId: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  const scope = getFlowAdapter(subjectKind)?.scope
  if (!scope) throw new FlowSubjectScopeUnresolvedError(subjectKind, subjectId)
  await lockSubjectScope(orgId, subjectKind, scope, subjectId, allowedSubsidiaryIds)
}

/**
 * Filter flow_runs subjects to the caller's subsidiary scope — the retry
 * route's subject-scope rule, reused for run listings (a run UUID is not a
 * grant to every legal entity). Subjects resolve batched, one query per
 * kind, through each kind's declared scope; an unregistered kind keeps no
 * entity and fails closed. Unrestricted callers (null scope) keep every
 * subject. Returns the in-scope subset, preserving order.
 */
export async function filterFlowRunSubjectsToScope<
  T extends { kind: string; id: string },
>(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  subjects: readonly T[],
  authz?: Authz,
): Promise<T[]> {
  const readableSubjects = authz
    ? subjects.filter((subject) => canReadFlowSubject(authz, subject.kind))
    : [...subjects];
  if (allowedSubsidiaryIds === null) return readableSubjects;
  if (readableSubjects.length === 0) return [];
  const idsByKind = new Map<string, string[]>();
  for (const subject of readableSubjects) {
    idsByKind.set(subject.kind, [...(idsByKind.get(subject.kind) ?? []), subject.id]);
  }
  const ownersByKind = new Map(await Promise.all([...idsByKind].map(async ([kind, ids]) => {
    const scope = getFlowAdapter(kind)?.scope
    const owners = scope
      ? await resolveSubjectSubsidiaries(orgId, kind, scope, ids, allowedSubsidiaryIds)
      : new Map<string, string | null>()
    return [kind, owners] as const
  })));
  // Fail-closed scope predicate, mirroring subsidiaryScopeAllows: an
  // unresolved or missing subsidiary is never in scope for a restricted
  // caller.
  return readableSubjects.filter((subject) => {
    const subsidiaryId = ownersByKind.get(subject.kind)?.get(subject.id);
    return (
      subsidiaryId !== null &&
      subsidiaryId !== undefined &&
      allowedSubsidiaryIds.has(subsidiaryId)
    );
  });
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
    if (e.retryable && e.causeKind === "infrastructure") {
      console.error("[flows] approval decision hit infrastructure:", e);
      return NextResponse.json(
        {
          error: "The approval service is temporarily unavailable, try again.",
        },
        { status: 503 },
      );
    }
    if (e.retryable) {
      const status = /already resolved|only a pending/.test(e.message)
        ? 409
        : 422;
      if (status === 409) console.error("[flows] approval decision raced:", e);
      return NextResponse.json({ error: e.message }, { status });
    }
    console.error("[flows] approval decision failed:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
  if (e instanceof GateError) {
    // Coded refusals map by code, never by message text.
    if (e.code === "self_approval_forbidden") {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 422 });
    }
    const msg = e.message;
    const status = /not found/.test(msg)
      ? 404
      : /already resolved|only a pending/.test(msg)
        ? 409
        : /not an approver|only the assignee/.test(msg)
          ? 403
          : 422;
    return NextResponse.json({ error: msg }, { status });
  }
  console.error("[flows] gate endpoint failed:", e);
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}
