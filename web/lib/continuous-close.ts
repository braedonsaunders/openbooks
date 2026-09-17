import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  CONTINUOUS_CLOSE_AGENT_KEYS,
  type ContinuousCloseAgentKey,
} from "@openbooks/engine/src/continuous-close-config.ts";
import { can, type Authz } from "./authz";

export type WorkItemAccess = {
  agentKey: ContinuousCloseAgentKey;
  status: "open" | "in_review" | "resolved" | "dismissed";
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
  // Fail closed at runtime: the linked engine may know packs this revision's
  // table does not (fleet shards land packs concurrently) — deny, never crash.
  const perms: readonly string[] | undefined = AGENT_READ_PERMS[agentKey as ContinuousCloseAgentKey];
  if (!perms) return false;
  return perms.some((perm) => can(authz, perm));
}

export function readableContinuousCloseAgents(authz: Authz): ContinuousCloseAgentKey[] {
  return CONTINUOUS_CLOSE_AGENT_KEYS.filter((agent) => canReadContinuousCloseAgent(authz, agent));
}

export async function loadWorkItemAccess(orgId: string, itemId: string): Promise<WorkItemAccess | null> {
  const result = (await db.execute<{ agent_key: ContinuousCloseAgentKey; status: WorkItemAccess["status"] }>(sql`
    select agent_key, status from ai_work_items where id = ${itemId} and org_id = ${orgId}
  `));
  const row = result.rows[0];
  return row ? { agentKey: row.agent_key, status: row.status } : null;
}
