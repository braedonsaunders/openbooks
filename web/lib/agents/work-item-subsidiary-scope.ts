import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { uuidArray } from "@openbooks/engine/src/organization/subsidiaries.ts";

/** Account is the only work-item subject with subsidiary lineage today. */
export const WORK_ITEM_SUBJECT_JOIN = sql`left join accounts subj_acct
  on subj_acct.id = w.subject_id and w.subject_type = 'account' and subj_acct.org_id = w.org_id
  left join subsidiaries subj_sub on subj_sub.id = subj_acct.subsidiary_id and subj_sub.org_id = w.org_id`;

/**
 * Restricted readers see only account subjects whose subsidiary is in scope.
 * The left join intentionally leaves unsupported, missing, and unassigned
 * subject lineage null; equality then excludes those rows. Only an explicit
 * null scope means unrestricted; an absent scope fails closed.
 */
export function workItemSubjectScopeFilter(
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): SQL {
  if (allowedSubsidiaryIds === null) return sql``;
  if (allowedSubsidiaryIds === undefined) return sql`and false`;
  return sql`and subj_acct.subsidiary_id = any(${uuidArray([...allowedSubsidiaryIds])}::uuid[])`;
}

/** In-memory twin for detail readers; absent lineage is denied when restricted. */
export function workItemSubjectInScope(
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  subjectSubsidiaryId: string | null | undefined,
): boolean {
  if (allowedSubsidiaryIds === null) return true;
  return allowedSubsidiaryIds !== undefined && subjectSubsidiaryId != null &&
    allowedSubsidiaryIds.has(subjectSubsidiaryId);
}
