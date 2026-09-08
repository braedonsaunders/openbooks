import { sql } from "drizzle-orm";
import type { SubsidiaryRestriction } from "@openbooks/schema";
import { db } from "../db.ts";

/** JSON identities do not participate in the catalog's scalar FK rebasing.
 * Resolve them through proven tenant-owned counterparts, never a UUID guess. */
export function remapRoleRestriction(value: unknown, ids: ReadonlyMap<string, string>, label: string): SubsidiaryRestriction | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: invalid subsidiary restriction`);
  const restriction = value as Record<string, unknown>;
  const mapped = (id: unknown): string => {
    const target = typeof id === "string" ? ids.get(id.toLowerCase()) : undefined;
    if (!target) throw new Error(`${label}: subsidiary restriction has no counterpart in the target organization`);
    return target;
  };
  if (restriction.mode === "all") return { mode: "all" };
  if (restriction.mode === "subtree") return { mode: "subtree", subsidiaryId: mapped(restriction.subsidiaryId) };
  if (restriction.mode === "list" && Array.isArray(restriction.subsidiaryIds)) {
    return { mode: "list", subsidiaryIds: restriction.subsidiaryIds.map(mapped) };
  }
  throw new Error(`${label}: invalid subsidiary restriction`);
}

export async function sandboxSubsidiaryMap(productionOrgId: string, sandboxOrgId: string, seed: string): Promise<Map<string, string>> {
  const rows = (await db.execute<{ source_id: string; target_id: string }>(sql`
    select source.id as source_id, target.id as target_id
      from subsidiaries source join subsidiaries target
        on target.id = ob_rebase(source.id, ${seed}::uuid) and target.org_id = ${sandboxOrgId}
     where source.org_id = ${productionOrgId}`)).rows;
  return new Map(rows.map(row => [row.source_id, row.target_id]));
}

/** Run inside the clone's transaction after every referenced table was copied.
 * Preserved policies keep their sandbox identities; proven legacy production
 * references are repaired and missing scope targets abort refresh atomically. */
export async function rebaseClonedJsonReferences(args: {
  productionOrgId: string; sandboxOrgId: string; seed: string; tier: string; copiedTables: ReadonlySet<string>;
}): Promise<void> {
  if (args.copiedTables.has("app_roles") || args.copiedTables.has("subsidiaries")) {
    const ids = await sandboxSubsidiaryMap(args.productionOrgId, args.sandboxOrgId, args.seed);
    if (!args.copiedTables.has("app_roles")) {
      const native = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${args.sandboxOrgId}`)).rows;
      for (const row of native) ids.set(row.id, row.id);
    }
    const roles = (await db.execute<{ id: string; subsidiary_restriction: unknown }>(sql`
      select id, subsidiary_restriction from app_roles where org_id = ${args.sandboxOrgId} order by id for update`)).rows;
    for (const role of roles) {
      const after = remapRoleRestriction(role.subsidiary_restriction, ids, `sandbox role ${role.id}`);
      if (JSON.stringify(after) === JSON.stringify(role.subsidiary_restriction)) continue;
      await db.execute(sql`update app_roles set subsidiary_restriction=${JSON.stringify(after)}::jsonb where org_id=${args.sandboxOrgId} and id=${role.id}`);
      await recordRebase(args.sandboxOrgId, "app_roles", role.id, "subsidiary_restriction", role.subsidiary_restriction, after);
    }
  }
  if (args.copiedTables.has("subsidiaries")) {
    const accounts = (await db.execute<{ source_id: string; target_id: string }>(sql`
      select source.id as source_id, target.id as target_id
        from accounts source join accounts target
          on target.id=ob_rebase(source.id,${args.seed}::uuid) and target.org_id=${args.sandboxOrgId}
       where source.org_id=${args.productionOrgId}`)).rows;
    const ids = new Map(accounts.map(row => [row.source_id, row.target_id]));
    const subsidiaries = (await db.execute<{ id: string; control_accounts: Record<string, unknown> }>(sql`
      select id,control_accounts from subsidiaries where org_id=${args.sandboxOrgId} order by id for update`)).rows;
    for (const subsidiary of subsidiaries) {
      const before = subsidiary.control_accounts;
      const after: Record<string, string> = {};
      // Development sandboxes omit the account/ledger layer, just as their org
      // control map is intentionally empty. The entity tree supports role scope.
      if (args.tier !== "dev") {
        if (!before || typeof before !== "object" || Array.isArray(before)) throw new Error(`sandbox subsidiary ${subsidiary.id}: invalid control-account map`);
        for (const [key, value] of Object.entries(before)) {
          const target = typeof value === "string" ? ids.get(value.toLowerCase()) : undefined;
          if (!target) throw new Error(`sandbox subsidiary ${subsidiary.id}: control account ${key} has no counterpart in the target organization`);
          after[key] = target;
        }
      }
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      await db.execute(sql`update subsidiaries set control_accounts=${JSON.stringify(after)}::jsonb where org_id=${args.sandboxOrgId} and id=${subsidiary.id}`);
      await recordRebase(args.sandboxOrgId, "subsidiaries", subsidiary.id, "control_accounts", before, after);
    }
  }
}

async function recordRebase(orgId: string, table: string, id: string, field: string, before: unknown, after: unknown) {
  await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},${table},${id},'update',${JSON.stringify({ mode: "sandbox_json_reference_rebase", before: { [field]: before }, after: { [field]: after } })}::jsonb,null)`);
}
