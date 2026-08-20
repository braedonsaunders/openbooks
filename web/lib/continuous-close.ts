import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { can, type Authz } from "./authz";

export type WorkItemAccess = {
  agentKey: "accounting" | "finance";
  status: "open" | "in_review" | "resolved" | "dismissed";
};

export function canReadContinuousCloseAgent(authz: Authz, agentKey: string): boolean {
  if (!can(authz, "assistant.use")) return false;
  if (agentKey === "accounting") {
    return can(authz, "banking.read") || can(authz, "gl.read") || can(authz, "close.read");
  }
  if (agentKey === "finance") return can(authz, "reports.read") || can(authz, "budgets.read");
  return false;
}

export function readableContinuousCloseAgents(authz: Authz): ("accounting" | "finance")[] {
  return (["accounting", "finance"] as const).filter((agent) => canReadContinuousCloseAgent(authz, agent));
}

export async function loadWorkItemAccess(orgId: string, itemId: string): Promise<WorkItemAccess | null> {
  const result = (await db.execute<{ agent_key: "accounting" | "finance"; status: WorkItemAccess["status"] }>(sql`
    select agent_key, status from ai_work_items where id = ${itemId} and org_id = ${orgId}
  `));
  const row = result.rows[0];
  return row ? { agentKey: row.agent_key, status: row.status } : null;
}
