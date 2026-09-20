import { sql } from "drizzle-orm";
import type { SubsidiaryRestriction } from "@openbooks/schema";
import { db } from "../platform/db.ts";

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
  return sandboxCounterpartMap("subsidiaries", productionOrgId, sandboxOrgId, seed);
}

/** production id → sandbox id for every row of `table` whose deterministic
 * rebase actually exists in the sandbox organization. A production id with no
 * proven counterpart is deliberately absent, so callers refuse rather than
 * guess. */
async function sandboxCounterpartMap(table: "subsidiaries" | "departments", productionOrgId: string, sandboxOrgId: string, seed: string): Promise<Map<string, string>> {
  const rows = (await db.execute<{ source_id: string; target_id: string }>(sql`
    select source.id as source_id, target.id as target_id
      from ${sql.identifier(table)} source join ${sql.identifier(table)} target
        on target.id = ob_rebase(source.id, ${seed}::uuid) and target.org_id = ${sandboxOrgId}
     where source.org_id = ${productionOrgId}`)).rows;
  return new Map(rows.map(row => [row.source_id, row.target_id]));
}

/** HRM scope filters: `applies_to` on process templates, leave policies
 * and review cycles is `{ employer_subsidiary_id?: uuid|null,
 * department_id?: uuid|null }` (the shape CHECK on each table is the
 * authority). Both keys are tenant identities that the scalar FK rebase
 * never sees, so a verbatim copy would pin a sandbox rule to a PRODUCTION
 * entity or department. The sibling rule columns (accrual_rule,
 * carryover_rule, rating_scale) carry kinds, decimal strings, day counts
 * and label strings — no identities — and copy verbatim on purpose. */
export const SCOPE_FILTER_TABLES = ["hrm_process_templates", "hrm_leave_policies", "hrm_review_cycles"] as const;
export type ScopeFilterTable = (typeof SCOPE_FILTER_TABLES)[number];

export function remapScopeFilter(
  value: unknown,
  ids: { subsidiaries: ReadonlyMap<string, string>; departments: ReadonlyMap<string, string> },
  label: string,
): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: invalid scope filter`);
  const filter = value as Record<string, unknown>;
  const after: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(filter)) {
    const counterparts = key === "employer_subsidiary_id" ? ids.subsidiaries : key === "department_id" ? ids.departments : null;
    if (!counterparts) throw new Error(`${label}: scope filter carries an unknown key ${key}`);
    if (raw === null) { after[key] = null; continue; }
    const target = typeof raw === "string" ? counterparts.get(raw.toLowerCase()) : undefined;
    if (!target) throw new Error(`${label}: scope filter ${key} has no counterpart in the target organization`);
    after[key] = target;
  }
  return after;
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
  const scoped = SCOPE_FILTER_TABLES.filter((table) => args.copiedTables.has(table));
  if (scoped.length) {
    // A refresh that re-copies the HRM rules always re-copies the entity tree
    // and departments with them (neither is a preserved customization), so the
    // counterparts are the freshly rebased rows, never a stale sandbox guess.
    const ids = {
      subsidiaries: await sandboxCounterpartMap("subsidiaries", args.productionOrgId, args.sandboxOrgId, args.seed),
      departments: await sandboxCounterpartMap("departments", args.productionOrgId, args.sandboxOrgId, args.seed),
    };
    for (const table of scoped) {
      const rows = (await db.execute<{ id: string; applies_to: unknown }>(sql`
        select id, applies_to from ${sql.identifier(table)} where org_id = ${args.sandboxOrgId} order by id for update`)).rows;
      for (const row of rows) {
        const after = remapScopeFilter(row.applies_to, ids, `sandbox ${table} ${row.id}`);
        if (JSON.stringify(after) === JSON.stringify(row.applies_to)) continue;
        await db.execute(sql`update ${sql.identifier(table)} set applies_to=${JSON.stringify(after)}::jsonb where org_id=${args.sandboxOrgId} and id=${row.id}`);
        await recordRebase(args.sandboxOrgId, table, row.id, "applies_to", row.applies_to, after);
      }
    }
  }
}

async function recordRebase(orgId: string, table: string, id: string, field: string, before: unknown, after: unknown) {
  await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},${table},${id},'update',${JSON.stringify({ mode: "sandbox_json_reference_rebase", before: { [field]: before }, after: { [field]: after } })}::jsonb,null)`);
}
