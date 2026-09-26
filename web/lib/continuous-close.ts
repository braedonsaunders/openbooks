import "server-only";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  type ContinuousCloseAgentKey,
} from "@openbooks/engine/src/agents/continuous-close-config.ts";
import { can, type Authz } from "./authz";

export type WorkItemAccess = {
  agentKey: ContinuousCloseAgentKey;
  status: "open" | "in_review" | "resolved" | "dismissed";
  /**
   * The subject's subsidiary via the account join. Null for non-account
   * subjects and unattributed accounts: restricted callers fail closed on
   * null, exactly like unattributed documents elsewhere.
   */
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
  const perms: readonly string[] | undefined = AGENT_READ_PERMS[agentKey as ContinuousCloseAgentKey];
  if (!perms) return false;
  return perms.some((perm) => can(authz, perm));
}

export function readableContinuousCloseAgents(authz: Authz): ContinuousCloseAgentKey[] {
  return CONTINUOUS_CLOSE_AGENT_KEYS.filter((agent) => canReadContinuousCloseAgent(authz, agent));
}

export async function loadWorkItemAccess(orgId: string, itemId: string): Promise<WorkItemAccess | null> {
  const result = (await db.execute<{ agent_key: ContinuousCloseAgentKey; status: WorkItemAccess["status"]; subjectSubsidiaryId: string | null }>(sql`
    select w.agent_key, w.status, subj.subsidiary_id as "subjectSubsidiaryId"
      from ai_work_items w
      left join accounts subj
        on subj.id = w.subject_id and w.subject_type = 'account' and subj.org_id = w.org_id
     where w.id = ${itemId} and w.org_id = ${orgId}
  `));
  const row = result.rows[0];
  return row ? { agentKey: row.agent_key, status: row.status, subjectSubsidiaryId: row.subjectSubsidiaryId } : null;
}

/**
 * Hold the work-item row and its writable subject lineage
 * locked across a dependent write. A scope pre-check followed by a later
 * write lets a concurrent rehome move another entity's finding under the
 * write; resolving inside the same transaction (item row FOR UPDATE plus
 * the subject account FOR SHARE) keeps the check and the effects on one
 * snapshot. Locks only; every allow/deny decision stays with the caller,
 * so unrestricted and dangling-subject behavior is unchanged.
 */
export async function withLockedWorkItemAccess<T>(
  orgId: string,
  itemId: string,
  use: (tx: SqlExecutor, access: WorkItemAccess) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const item = await tx.execute<{ subject_type: string | null; subject_id: string | null }>(sql`
      select subject_type, subject_id from ai_work_items
       where id = ${itemId} and org_id = ${orgId}
       for update
    `);
    const subject = item.rows[0];
    if (!subject) return null;
    // Restricted writers can only pass the scope check on account subjects
    // (and reconciliations through their account); every other kind resolves
    // null and fails closed, so locking those two lineages leaves no
    // writable window unlocked.
    if (subject.subject_type === "account" && subject.subject_id) {
      await tx.execute(sql`select id from accounts where id = ${subject.subject_id} and org_id = ${orgId} for share`);
    } else if (subject.subject_type === "reconciliation" && subject.subject_id) {
      const reconciliation = await tx.execute<{ account_id: string }>(sql`
        select account_id from reconciliations
         where id = ${subject.subject_id} and org_id = ${orgId}
         for share
      `);
      const accountId = reconciliation.rows[0]?.account_id;
      if (accountId) {
        await tx.execute(sql`select id from accounts where id = ${accountId} and org_id = ${orgId} for share`);
      }
    }
    const result = await tx.execute<{ agent_key: ContinuousCloseAgentKey; status: WorkItemAccess["status"]; subjectSubsidiaryId: string | null }>(sql`
      select w.agent_key, w.status, subj.subsidiary_id as "subjectSubsidiaryId"
        from ai_work_items w
        left join accounts subj
          on subj.id = w.subject_id and w.subject_type = 'account' and subj.org_id = w.org_id
       where w.id = ${itemId} and w.org_id = ${orgId}
    `);
    const row = result.rows[0];
    if (!row) return null;
    return use(tx, { agentKey: row.agent_key, status: row.status, subjectSubsidiaryId: row.subjectSubsidiaryId });
  });
}
