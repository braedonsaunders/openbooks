import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { subsidiaryVisibleFilter } from "../../organization/subsidiary-scope.ts";
import { RecruitingError } from "./errors.ts";

/**
 * Candidate ownership (Audit-H): a candidate has no subsidiary of their own,
 * so visibility and actionability resolve through their applications'
 * requisitions. A candidate is owned in the actor's scope when they hold at
 * least one application on a requisition whose employer subsidiary sits in
 * the actor's allowed set (null = unrestricted: every application counts).
 *
 * Row-level scoping rule (coordinator constraint): this ANY-application
 * check is correct ONLY for genuinely candidate-wide rows — the candidate
 * row itself (anonymize/delete), consents, tags, pool memberships — which
 * carry no narrower link. Where the row links its OWN requisition (an
 * application, an offer, an interview, a scorecard), the gate checks THAT
 * requisition's employer, never the candidate's other applications:
 * otherwise a candidate attached to both an A and a B requisition would
 * leak the B slice to an A-scoped actor through the A link.
 *
 * Talent-pool membership never confers ownership here: pools are a shared
 * reading surface, not scope. Pool-context reads (member lists, rediscovery
 * matches) carry names only and no contact PII by shape; every mutation of
 * a candidate — pool add/remove/tag, consent, attach, retention action —
 * requires ownership through an in-scope requisition, and denials are
 * uniform with not-found so existence cannot be probed across entities.
 *
 * Predicates and denial shapes build on the canonical
 * engine/src/organization/subsidiary-scope.ts (visibility filter,
 * unrestricted assertion); only the recruiting-specific ownership join —
 * candidate → application → requisition employer — lives here, because the
 * organization module must not import HRM tables.
 */

/** Requisition ids of the candidate's applications inside the actor's scope (canonical visibility filter). */
export async function candidateInScopeRequisitionIds(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
  allowed: Set<string> | null,
): Promise<string[]> {
  const rows = (await exec.execute<{ requisitionId: string }>(sql`
    select distinct a.requisition_id as "requisitionId"
      from hrm_applications a
      join hrm_requisitions r on r.org_id = a.org_id and r.id = a.requisition_id
     where a.org_id = ${orgId} and a.candidate_id = ${candidateId}
       ${subsidiaryVisibleFilter(sql`r.employer_subsidiary_id`, allowed)}
  `)).rows;
  return rows.map((row) => row.requisitionId);
}

/**
 * Require ownership of a candidate for a mutating path. Returns the
 * in-scope requisition ids. Throws the uniform not-visible refusal when the
 * candidate is unknown or owned entirely outside the actor's scope — the
 * two cases are deliberately indistinguishable. Unrestricted actors own
 * every candidate (existence is still verified); scoped actors need an
 * application on an in-scope requisition.
 */
export async function requireCandidateOwnedInScope(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
  allowed: Set<string> | null,
): Promise<string[]> {
  if (allowed === null) {
    const exists = (await exec.execute<{ one: number }>(sql`
      select 1 as one from hrm_candidates where org_id = ${orgId} and id = ${candidateId}
    `)).rows[0];
    if (!exists) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
    }
    return candidateInScopeRequisitionIds(exec, orgId, candidateId, null);
  }
  const ids = await candidateInScopeRequisitionIds(exec, orgId, candidateId, allowed);
  if (ids.length === 0) {
    throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization");
  }
  return ids;
}

/** Whether the candidate sits in any talent pool (read-sharing only — never ownership). */
export async function candidateSharedViaPool(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
): Promise<boolean> {
  const row = (await exec.execute<{ one: number }>(sql`
    select 1 as one from hrm_talent_pool_members
     where org_id = ${orgId} and candidate_id = ${candidateId}
     limit 1
  `)).rows[0];
  return !!row;
}

/** Total applications on the candidate (fresh prospects have none — first attach wins). */
export async function candidateApplicationCount(
  exec: SqlExecutor,
  orgId: string,
  candidateId: string,
): Promise<number> {
  const row = (await exec.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_applications
     where org_id = ${orgId} and candidate_id = ${candidateId}
  `)).rows[0];
  return Number(row?.count ?? 0);
}
