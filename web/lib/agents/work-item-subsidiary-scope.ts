import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { uuidArray } from "@openbooks/engine/src/organization/subsidiaries.ts";

/**
 * Subject lineage joins for workbench readers. Account findings resolve
 * through their account; reconciliation findings through the reconciled
 * account; documents findings through the document. The subsidiary display
 * columns stay account-backed (other kinds leave them null); gating never
 * reads these joins — it uses workItemSubjectScopePredicate below.
 */
export const WORK_ITEM_SUBJECT_JOIN = sql`left join accounts subj_acct
  on subj_acct.id = w.subject_id and w.subject_type = 'account' and subj_acct.org_id = w.org_id
  left join subsidiaries subj_sub on subj_sub.id = subj_acct.subsidiary_id and subj_sub.org_id = w.org_id
  left join reconciliations subj_rec
  on subj_rec.id = w.subject_id and w.subject_type = 'reconciliation' and subj_rec.org_id = w.org_id
  left join accounts subj_rec_acct
  on subj_rec_acct.id = subj_rec.account_id and subj_rec_acct.org_id = subj_rec.org_id
  left join documents subj_doc
  on subj_doc.id = w.subject_id and w.subject_type = 'documents' and subj_doc.org_id = w.org_id`;

/**
 * A budget scenario has no header subsidiary: each line identifies its legal
 * entity, with additional account and optional project visibility constraints.
 * Admit only a scenario with at least one visible line and no line pointing
 * at an entity outside the caller's set. Same rule the module-home
 * accounting resolver applies; kept here so every workbench reader shares it.
 */
function budgetScenarioScope(orgId: string, allowed: ReadonlySet<string>, scenario: SQL): SQL {
  const ids = [...allowed];
  if (ids.length === 0) return sql` and false`;
  const idArray = sql`${uuidArray(ids)}::uuid[]`;
  const hidden = sql`(
    bl.subsidiary_id <> all(${idArray})
    or (ba.subsidiary_id is not null and ba.subsidiary_id <> all(${idArray}))
    or (bp.subsidiary_id is not null and bp.subsidiary_id <> all(${idArray}))
  )`;
  const visible = sql`(
    bl.subsidiary_id = any(${idArray})
    and (ba.subsidiary_id is null or ba.subsidiary_id = any(${idArray}))
    and (bp.subsidiary_id is null or bp.subsidiary_id = any(${idArray}))
  )`;
  return sql`
    and exists (
      select 1
        from budget_lines bl
        left join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
        left join projects bp on bp.id = bl.project_id and bp.org_id = bl.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${scenario}
         and ${visible}
    )
    and not exists (
      select 1
        from budget_lines bl
        left join accounts ba on ba.id = bl.account_id and ba.org_id = bl.org_id
        left join projects bp on bp.id = bl.project_id and bp.org_id = bl.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${scenario}
         and ${hidden}
    )`;
}

/**
 * One shared type-aware subject gate for every workbench reader (inbox list
 * and facets, detail, dashboard metrics): the same four subject kinds the
 * module-home accounting resolver admits, with identical semantics — shared
 * (null-subsidiary) accounts visible, reconciliations through their account,
 * documents strictly scoped, budget scenarios line-gated. Anything else
 * (period-level and other unresolvable lineage) fails closed for restricted
 * readers. Only an explicit null scope means unrestricted; an absent scope
 * fails closed. All callers alias work items `w`.
 */
export function workItemSubjectScopePredicate(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): SQL {
  if (allowedSubsidiaryIds === null) return sql``;
  if (allowedSubsidiaryIds === undefined) return sql`and false`;
  const idArray = sql`${uuidArray([...allowedSubsidiaryIds])}::uuid[]`;
  const accountVisible = sql`(a.subsidiary_id is null or a.subsidiary_id = any(${idArray}))`;
  const documentVisible = sql`d.subsidiary_id = any(${idArray})`;
  return sql` and (
    (w.subject_type = 'account' and exists (
      select 1 from accounts a
       where a.org_id = ${orgId} and a.id = w.subject_id and ${accountVisible}
    ))
    or (w.subject_type = 'reconciliation' and exists (
      select 1 from reconciliations reconciliation
      join accounts a on a.id = reconciliation.account_id and a.org_id = reconciliation.org_id
       where reconciliation.org_id = ${orgId} and reconciliation.id = w.subject_id
         and ${accountVisible}
    ))
    or (w.subject_type = 'documents' and exists (
      select 1 from documents d
       where d.org_id = ${orgId} and d.id = w.subject_id and ${documentVisible}
    ))
    or (w.subject_type = 'budget' ${budgetScenarioScope(orgId, allowedSubsidiaryIds, sql`w.subject_id`)})
  )`;
}

/**
 * In-memory twin for the detail boundary, over the joined per-type
 * subsidiary. Account and reconciliation subjects inherit shared-account
 * visibility (a null account is visible); documents fail closed on null.
 * Budget scenarios carry no single subsidiary — the predicate above already
 * admitted the row — and unresolvable kinds never reach the twin because
 * the predicate filters them.
 */
export function workItemSubjectInScope(
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  subjectType: string,
  subjectSubsidiaryId: string | null | undefined,
): boolean {
  if (allowedSubsidiaryIds === null) return true;
  if (allowedSubsidiaryIds === undefined) return false;
  if (subjectType === 'budget') return true;
  if (subjectType === 'account' || subjectType === 'reconciliation') {
    return subjectSubsidiaryId === null || (subjectSubsidiaryId !== undefined && allowedSubsidiaryIds.has(subjectSubsidiaryId));
  }
  return subjectSubsidiaryId != null && allowedSubsidiaryIds.has(subjectSubsidiaryId);
}
