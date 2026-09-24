import { sql } from "drizzle-orm";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  ScopeNotFoundError,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";

/**
 * H-AUTORUNS: subsidiary scope for automation run history.
 *
 * A run's own row carries no subsidiary, so visibility derives from its
 * subject: the project, party, document, or schedule the run acted on.
 * Subjects that resolve to no subsidiary (agent-managed or schedule runs)
 * are org-wide and visible only to unrestricted callers — a restricted
 * actor must never enumerate agent runs by id.
 */

/** Run subject with its resolved subsidiary; null subsidiary = org-wide. */
export interface RunSubjectScope {
  subjectKind: string | null;
  subjectSubsidiaryId: string | null;
}

/**
 * Scope predicate over a run's subject. Delegates to the canonical
 * `subsidiaryScopeAllows` so direct reads and list filters agree: null
 * subsidiary fails closed for restricted callers (runs are not parties —
 * no orgWideNull), unrestricted callers pass.
 */
export function runSubjectVisible(
  allowed: ReadonlySet<string> | null,
  subject: RunSubjectScope,
): boolean {
  return subsidiaryScopeAllows(allowed, subject.subjectSubsidiaryId);
}

/**
 * Direct-record read of one run: throw the uniform not-found when the
 * run's subject sits outside the caller's scope, so an out-of-scope run
 * is indistinguishable from a missing one.
 */
export function assertRunSubjectScope(
  allowed: ReadonlySet<string> | null,
  subject: RunSubjectScope,
): void {
  if (!runSubjectVisible(allowed, subject)) throw new ScopeNotFoundError();
}

/**
 * Scope for run-history reads. Web routes pass the request's resolved lens;
 * direct engine callers omit it and the actor's current grants are resolved
 * here — never a saved permission set.
 */
export async function resolveRunScope(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
): Promise<ReadonlySet<string> | null> {
  if (allowedSubsidiaryIds !== undefined) return allowedSubsidiaryIds;
  return actorAllowedSubsidiaryIds(db, orgId, actorId);
}

/** Minimal run identity for subject resolution. */
export interface RunSubject {
  subjectKind: string | null;
  subjectId: string | null;
}

const scopeKey = (kind: string, id: string): string => `${kind}${id}`;

/**
 * Batch-resolve run subjects to their subsidiary, one query per subject
 * family. Direct-subsidiary subjects (documents including expense reports,
 * projects, parties) and employment-linked subjects (employments,
 * leave requests via the primary assignment) resolve to the row's
 * subsidiary. Anything else — schedule and agent-managed runs, HRM rows
 * without a subsidiary, unknown kinds, and deleted subjects (no row) — is
 * absent from the map, and callers treat absence as org-wide: visible only
 * to unrestricted callers, never enumerable by a restricted actor by id.
 *
 * Deliberately stricter than execution time (which keeps existing behavior
 * for entities without subsidiary lineage): history enumeration must never
 * disclose another entity's run payloads, errors, or steps by id.
 */
export async function resolveRunSubjectSubsidiaries(
  orgId: string,
  runs: readonly RunSubject[],
): Promise<Map<string, string | null>> {
  const resolved = new Map<string, string | null>();
  const bucket = (kinds: readonly string[]): string[] => {
    const ids: string[] = [];
    for (const run of runs) {
      if (run.subjectKind && run.subjectId && (kinds as readonly string[]).includes(run.subjectKind)) {
        ids.push(run.subjectId);
      }
    }
    return [...new Set(ids)];
  };
  const store = (kind: string, id: string, subsidiaryId: string | null): void => {
    resolved.set(scopeKey(kind, id), subsidiaryId);
  };
  const documents = bucket(["document", "expense_report"]);
  if (documents.length > 0) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from documents
       where org_id = ${orgId} and id = any(${`{${documents.join(",")}}`}::uuid[])
    `)).rows;
    for (const row of rows) store("document", row.id, row.subsidiary_id);
    // Expense reports live in documents; keep the run's own kind on the key.
    for (const row of rows) store("expense_report", row.id, row.subsidiary_id);
  }
  const projects = bucket(["project"]);
  if (projects.length > 0) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from projects
       where org_id = ${orgId} and id = any(${`{${projects.join(",")}}`}::uuid[])
    `)).rows;
    for (const row of rows) store("project", row.id, row.subsidiary_id);
  }
  const parties = bucket(["party"]);
  if (parties.length > 0) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, subsidiary_id from parties
       where org_id = ${orgId} and id = any(${`{${parties.join(",")}}`}::uuid[])
    `)).rows;
    for (const row of rows) store("party", row.id, row.subsidiary_id);
  }
  const employments = bucket(["employment"]);
  if (employments.length > 0) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id, employer_subsidiary_id as subsidiary_id from worker_employments
       where org_id = ${orgId} and id = any(${`{${employments.join(",")}}`}::uuid[])
    `)).rows;
    for (const row of rows) store("employment", row.id, row.subsidiary_id);
  }
  const leaves = bucket(["leave_request"]);
  if (leaves.length > 0) {
    const rows = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select r.id, e.employer_subsidiary_id as subsidiary_id
        from hrm_leave_requests r
        left join employment_assignment_versions e
          on e.org_id = r.org_id and e.employment_id = r.employment_id
         and e.recorded_until is null and e.is_primary
         and e.effective_from <= current_date
         and (e.effective_to is null or e.effective_to > current_date)
       where r.org_id = ${orgId} and r.id = any(${`{${leaves.join(",")}}`}::uuid[])
    `)).rows;
    for (const row of rows) store("leave_request", row.id, row.subsidiary_id);
  }
  return resolved;
}

/**
 * Scope view of one run for the visibility predicate: missing keys
 * (unresolvable or org-wide subjects) resolve to a null subsidiary, which
 * the canonical rule fails closed for restricted callers.
 */
export function runScopeFor(
  resolved: ReadonlyMap<string, string | null>,
  subjectKind: string | null,
  subjectId: string | null,
): RunSubjectScope {
  return {
    subjectKind,
    subjectSubsidiaryId:
      subjectKind && subjectId ? (resolved.get(scopeKey(subjectKind, subjectId)) ?? null) : null,
  };
}
