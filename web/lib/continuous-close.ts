import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  type ContinuousCloseAgentKey,
} from "@openbooks/engine/agents/continuous-close-config";
import { can, type Authz } from "./authz";
import {
  WORK_ITEM_SUBJECT_JOIN,
  workItemSubjectInScope,
  workItemSubjectScopePredicate,
} from "./agents/work-item-subsidiary-scope";

export type WorkItemAccess = {
  agentKey: ContinuousCloseAgentKey;
  status: "open" | "in_review" | "resolved" | "dismissed";
  subjectType: string | null;
  subjectSubsidiaryId: string | null;
};

/**
 * Minimum read grants that make one agent pack's findings visible. Each pack
 * mirrors the screen its detectors read: collections watches receivables,
 * payables watches the AP cockpit, reconciliation watches bank data, data
 * hygiene watches ledger and master-data quality for accounting stewards, and
 * forensics watches the spend-document screens (bills, credits, expenses,
 * journals) its sentinel-diff items come from.
 */
export const AGENT_READ_PERMS: Record<ContinuousCloseAgentKey, readonly string[]> = {
  accounting: ["banking.read", "gl.read", "close.read"],
  finance: ["reports.read", "budgets.read"],
  collections: ["ar.read"],
  payables: ["ap.read"],
  reconciliation: ["banking.read", "banking.reconcile"],
  hygiene: ["gl.read", "close.read"],
  forensics: ["gl.read", "ap.read", "ar.read", "expenses.read"],
  tax: ["gl.read", "close.read", "ap.read", "ar.read", "expenses.read"],
  payroll: ["payroll.read", "close.read"],
  projects: ["gl.read", "projects.read", "close.read"],
  cash: ["banking.read", "gl.read", "close.read"],
};

export function canReadContinuousCloseAgent(authz: Authz, agentKey: string): boolean {
  if (!can(authz, "assistant.use")) return false;
  if (!(CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(agentKey)) return false;
  // Fail closed at runtime: the linked engine can ship packs this revision's
  // table does not know yet — deny, never crash.
  const perms: readonly string[] | undefined =
    AGENT_READ_PERMS[agentKey as ContinuousCloseAgentKey];
  if (!perms) return false;
  return perms.some((perm) => can(authz, perm));
}

export function readableContinuousCloseAgents(authz: Authz): ContinuousCloseAgentKey[] {
  return CONTINUOUS_CLOSE_AGENT_KEYS.filter((agent) => canReadContinuousCloseAgent(authz, agent));
}

export async function loadWorkItemAccess(
  orgId: string,
  itemId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<WorkItemAccess | null> {
  const result = await db.execute<{
    agent_key: ContinuousCloseAgentKey;
    status: WorkItemAccess["status"];
    subjectType: string | null;
    subjectSubsidiaryId: string | null;
  }>(
    sql`
    select w.agent_key, w.status, w.subject_type as "subjectType",
           coalesce(subj_acct.subsidiary_id, subj_rec_acct.subsidiary_id, subj_doc.subsidiary_id) as "subjectSubsidiaryId"
      from ai_work_items w
      ${WORK_ITEM_SUBJECT_JOIN}
     where w.id = ${itemId} and w.org_id = ${orgId}
       ${workItemSubjectScopePredicate(orgId, allowedSubsidiaryIds)}
  `,
    "objects",
  );
  const row = result[0];
  if (
    !row ||
    !workItemSubjectInScope(allowedSubsidiaryIds, row.subjectType ?? "", row.subjectSubsidiaryId)
  )
    return null;
  return {
    agentKey: row.agent_key,
    status: row.status,
    subjectType: row.subjectType,
    subjectSubsidiaryId: row.subjectSubsidiaryId,
  };
}

/**
 * Hold the work-item row and its writable subject lineage locked across a
 * dependent write. Scope is resolved again inside this transaction so a
 * concurrent rehome cannot move an out-of-scope finding under the write.
 */
export async function withLockedWorkItemAccess<T>(
  orgId: string,
  itemId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  use: (tx: SqlExecutor, access: WorkItemAccess) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const item = await tx.execute<{ subject_type: string | null; subject_id: string | null }>(
      sql`
      select subject_type, subject_id from ai_work_items
       where id = ${itemId} and org_id = ${orgId}
       for update
    `,
      "objects",
    );
    const subject = item[0];
    if (!subject) return null;
    // Lock the source row whose subsidiary determines visibility. Budget
    // edits lock their scenario before changing its subsidiary lines.
    if (subject.subject_type === "account" && subject.subject_id) {
      await tx.execute(
        sql`select id from accounts where id = ${subject.subject_id} and org_id = ${orgId} for share`,
      );
    } else if (subject.subject_type === "reconciliation" && subject.subject_id) {
      const reconciliation = await tx.execute<{ account_id: string }>(
        sql`
        select account_id from reconciliations
         where id = ${subject.subject_id} and org_id = ${orgId}
         for share
      `,
        "objects",
      );
      const accountId = reconciliation[0]?.account_id;
      if (accountId) {
        await tx.execute(
          sql`select id from accounts where id = ${accountId} and org_id = ${orgId} for share`,
        );
      }
    } else if (subject.subject_type === "documents" && subject.subject_id) {
      await tx.execute(
        sql`select id from documents where id = ${subject.subject_id} and org_id = ${orgId} for share`,
      );
    } else if (subject.subject_type === "budget" && subject.subject_id) {
      // Budget edits lock their scenario before changing its subsidiary lines.
      await tx.execute(
        sql`select id from budget_scenarios where id = ${subject.subject_id} and org_id = ${orgId} for share`,
      );
    }
    const result = await tx.execute<{
      agent_key: ContinuousCloseAgentKey;
      status: WorkItemAccess["status"];
      subjectType: string | null;
      subjectSubsidiaryId: string | null;
    }>(
      sql`
      select w.agent_key, w.status, w.subject_type as "subjectType",
             coalesce(subj_acct.subsidiary_id, subj_rec_acct.subsidiary_id, subj_doc.subsidiary_id) as "subjectSubsidiaryId"
        from ai_work_items w
        ${WORK_ITEM_SUBJECT_JOIN}
       where w.id = ${itemId} and w.org_id = ${orgId}
         ${workItemSubjectScopePredicate(orgId, allowedSubsidiaryIds)}
    `,
      "objects",
    );
    const row = result[0];
    if (
      !row ||
      !workItemSubjectInScope(allowedSubsidiaryIds, row.subjectType ?? "", row.subjectSubsidiaryId)
    )
      return null;
    return use(tx, {
      agentKey: row.agent_key,
      status: row.status,
      subjectType: row.subjectType,
      subjectSubsidiaryId: row.subjectSubsidiaryId,
    });
  });
}
