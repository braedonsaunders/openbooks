import { sql, type SQL } from "drizzle-orm";
import {
  flowGraphSubjectScopeSchema,
  flowSubjectAdmission,
  type AutomationGraph,
  type FlowSubjectAdmission,
} from "@openbooks/forms-core";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { lockSubjectScope, resolveSubjectSubsidiaries } from "./subject-scope.ts";
import type { FlowSubjectAdapter } from "./types.ts";

/**
 * Legal-entity admission for flow graphs carrying `subjectScope`.
 *
 * Admission is a property of the GRAPH and the SUBJECT, decided before a
 * flow is chosen for a subject: the subject's legal entity is resolved from
 * the adapter's declared native source (flows/subject-scope.ts — the
 * document row, an owning party/project/employment, or the subject's own
 * subsidiary column), never from request input, caller scope, evaluation
 * values, or an approval gate's assignees. Gate assignee scope governs who
 * may DECIDE; it never widens or replaces which subjects a flow applies to.
 *
 * Verdicts:
 *   admitted     — unscoped graph, or the resolved entity is listed;
 *   out-of-scope — the entity is resolved and not listed: the flow does not
 *                  apply, so no run, gate, routing or audit effect may be
 *                  created for the subject;
 *   unresolved   — scoped graph but the entity is missing, empty or
 *                  unknown: callers must fail closed, never treat the
 *                  subject as organization-wide.
 */
export type { FlowSubjectAdmission };

export interface FlowSubjectAdmissionResult {
  admission: FlowSubjectAdmission;
  /** The subject's resolved legal entity; null when it cannot be proven. */
  subsidiaryId: string | null;
}

/**
 * Resolve one subject's legal entity through its adapter's native scope
 * source and judge the graph's subject scope against it. Resolution reads
 * the actual owner (no caller visibility filter): admission is policy
 * scope, while the caller's own subsidiary ceiling is enforced separately
 * by the dispatch and gate paths exactly as for unscoped flows.
 */
export async function resolveFlowSubjectAdmission(
  orgId: string,
  adapter: FlowSubjectAdapter,
  subjectKind: string,
  subjectId: string,
  graph: Pick<AutomationGraph, "subjectScope">,
): Promise<FlowSubjectAdmissionResult> {
  if (!graph.subjectScope) return { admission: "admitted", subsidiaryId: null };
  const owners = await resolveSubjectSubsidiaries(
    orgId,
    subjectKind,
    adapter.scope,
    [subjectId],
    null,
  );
  const subsidiaryId = owners.get(subjectId) ?? null;
  return { admission: flowSubjectAdmission(graph.subjectScope, subsidiaryId), subsidiaryId };
}

/**
 * The dispatch-time admission: lock the subject's native scope owner
 * (flows/subject-scope.ts lockSubjectScope — the subject row itself for
 * document/column scopes, the referring row AND its owner for
 * party/project/employment links, the custom scope's own locked read),
 * then resolve and judge the entity under that lock. The caller's
 * transaction must stay open through planning and effects: the share
 * locks hold the legal entity (and any owner link) frozen until commit,
 * so a concurrent rehome either commits before the lock is taken (and is
 * seen by the locked resolution) or waits until the dispatch finishes.
 * A rehome can never slip between admission and effects.
 *
 * The lock is taken against the subject's ACTUAL owner (no caller
 * visibility filter): locking confers no read or decision authority, and
 * every caller's own subsidiary ceiling keeps being enforced by the
 * dispatch, gate and retry paths exactly as before. A subject whose owner
 * row cannot be locked because it does not resolve answers `unresolved`,
 * never an exception the dispatch would mistake for admittance.
 *
 * Read-only surfaces (manual-button availability, worklist and policy
 * queries) keep using the unlocked resolver above; only actual dispatch
 * (record flows, scheduled fan-out, retry) claims these locks.
 */
export async function lockFlowSubjectAdmission(
  orgId: string,
  adapter: FlowSubjectAdapter,
  subjectKind: string,
  subjectId: string,
  graph: Pick<AutomationGraph, "subjectScope">,
): Promise<FlowSubjectAdmissionResult> {
  if (!graph.subjectScope) return { admission: "admitted", subsidiaryId: null };
  try {
    await lockSubjectScope(orgId, subjectKind, adapter.scope, subjectId, null);
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return { admission: "unresolved", subsidiaryId: null };
    throw error;
  }
  const owners = await resolveSubjectSubsidiaries(
    orgId,
    subjectKind,
    adapter.scope,
    [subjectId],
    null,
  );
  const subsidiaryId = owners.get(subjectId) ?? null;
  return { admission: flowSubjectAdmission(graph.subjectScope, subsidiaryId), subsidiaryId };
}

/**
 * SQL twin of flowSubjectAdmission over a stored graph and a subject's
 * subsidiary column, for policy-existence queries that must count only
 * flows that would actually admit the subject. A subject whose entity is
 * unknown still counts a scoped flow as a policy (fail closed); a resolved
 * entity outside the list does not, so an out-of-scope template can never
 * masquerade as this subject's approval policy. Ids compare as uuids so
 * case-variant spellings stored before normalization cannot slip past.
 */
export function flowGraphAdmitsSubjectSql(graph: SQL, subsidiaryId: SQL): SQL {
  return sql`(
    ${graph} -> 'subjectScope' is null
    or ${subsidiaryId} is null
    or exists (
      select 1
        from jsonb_array_elements_text(coalesce(${graph} -> 'subjectScope' -> 'subsidiaryIds', '[]'::jsonb)) as scope_id
       where lower(scope_id) = ${subsidiaryId}::text
    )
  )`;
}

/** Canonical (trimmed, lowercase) subsidiary id set for scope comparisons. */
export function canonicalSubsidiaryIds(ids: Iterable<unknown>): Set<string> {
  return new Set(
    [...ids]
      .filter((id) => typeof id === "string")
      .map((id) => (id as string).trim().toLowerCase()),
  );
}

/**
 * Managed-write validation for a graph's subject scope: every named legal
 * entity must be a subsidiary of this organization, and every named entity
 * must sit inside the writing actor's own subsidiary ceiling (an explicit
 * null ceiling is unrestricted; an absent ceiling fails closed). Returns an
 * actionable refusal message, or null when the scope may be persisted.
 */
export async function validateFlowSubjectScopeRefs(
  orgId: string,
  graph: Pick<AutomationGraph, "subjectScope">,
  actorAllowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): Promise<string | null> {
  const scope = graph.subjectScope;
  if (!scope) return null;
  // Malformed entries refuse; they are never filtered away, which would
  // silently persist a different limit than the author submitted. The
  // shared graph schema decides validity (array shape, uuid shape, the
  // entity cap, emptiness, case-variant duplicates) and canonicalizes
  // case for every comparison below.
  const parsed = flowGraphSubjectScopeSchema.safeParse(scope);
  if (!parsed.success) {
    return "this flow's legal-entity limit is malformed — choose at least one legal entity, at most 100, without repeats, or remove the limit";
  }
  const ids = parsed.data.subsidiaryIds;
  if (actorAllowedSubsidiaryIds === undefined) {
    return "this flow's legal-entity limit cannot be checked against your access — reload and try again";
  }
  if (actorAllowedSubsidiaryIds !== null) {
    // The actor ceiling compares canonically too: a ceiling spelled in
    // uppercase uuid text grants exactly the same entities.
    const ceiling = canonicalSubsidiaryIds(actorAllowedSubsidiaryIds);
    const outside = ids.filter((id) => !ceiling.has(id));
    if (outside.length > 0) {
      return "this flow names a legal entity outside your subsidiary access — choose only legal entities you administer, or ask an administrator with unrestricted access";
    }
  }
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from subsidiaries
     where org_id = ${orgId}
       and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
  `,
    "objects",
  );
  if (rows.length !== ids.length) {
    return "this flow names a legal entity that does not belong to this organization — choose from this organization's legal entities";
  }
  return null;
}
