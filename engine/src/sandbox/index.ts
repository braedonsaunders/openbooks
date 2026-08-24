import { sql } from "drizzle-orm";
import { db } from "../db.ts";

export { createSandbox, refreshSandbox, resetSandbox, deleteSandbox } from "./lifecycle.ts";
export { buildChangeSet, applyChangeSet } from "./promote.ts";
export { isSandboxOrg, assertNotSandbox, getEnvKind, neuterSandbox } from "./guard.ts";
export { runClone } from "./clone.ts";
export type { SandboxTier } from "./clone.ts";

export interface SandboxSummary {
  id: string;
  orgId: string;
  productionOrgId: string;
  name: string;
  tier: string;
  masked: boolean;
  status: string;
  lastError: string | null;
  lastRefreshAt: string | null;
  refreshSchedule: string | null;
  storageRows: number;
  createdAt: string;
}

/** List sandboxes owned by a production org (call from the production context). */
export async function listSandboxes(productionOrgId: string): Promise<SandboxSummary[]> {
  const res = await db.execute<SandboxSummary & Record<string, unknown>>(sql`
    select id, org_id as "orgId", production_org_id as "productionOrgId", name, tier, masked,
           status, last_error as "lastError", last_refresh_at as "lastRefreshAt",
           refresh_schedule as "refreshSchedule", storage_rows as "storageRows", created_at as "createdAt"
      from sandboxes
     where production_org_id = ${productionOrgId}
     order by created_at desc`);
  return res.rows;
}

/** Resolve the sandbox row for an org that IS a sandbox (used by org-switch). */
export async function sandboxForOrg(orgId: string): Promise<SandboxSummary | null> {
  const res = await db.execute<SandboxSummary & Record<string, unknown>>(sql`
    select id, org_id as "orgId", production_org_id as "productionOrgId", name, tier, masked,
           status, last_error as "lastError", last_refresh_at as "lastRefreshAt",
           refresh_schedule as "refreshSchedule", storage_rows as "storageRows", created_at as "createdAt"
      from sandboxes where org_id = ${orgId}`);
  return res.rows[0] ?? null;
}
