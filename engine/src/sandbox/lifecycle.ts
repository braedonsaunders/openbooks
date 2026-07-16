import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { deletionOrder, loadCatalog, PARENT_FILTER, selfRefColumns } from "./catalog.ts";
import { CUSTOMIZATION_LAYER, runClone, type SandboxTier } from "./clone.ts";
import { neuterSandbox } from "./guard.ts";
import { seedDefaultMaskingPolicies } from "./masking.ts";

/**
 * Sandbox lifecycle: create, refresh (non-destructive), reset, delete. The
 * clone engine's determinism is what makes non-destructive refresh possible —
 * re-cloning production with the same seed reproduces identical ids, so a
 * sandbox's preserved customization rows keep resolving their references to the
 * freshly-copied business data.
 */

export interface CreateSandboxInput {
  productionOrgId: string;
  name: string;
  tier?: SandboxTier;
  masked?: boolean;
  asOfPeriodId?: string | null;
  createdBy?: string | null;
}

async function asOfPeriodOf(
  periodId: string | null | undefined,
): Promise<{ fiscalYear: number; periodNumber: number } | null> {
  if (!periodId) return null;
  const res = (await db.execute(sql`
    select fiscal_year, period_number from accounting_periods where id = ${periodId}`)) as any;
  const r = res.rows[0];
  return r ? { fiscalYear: r.fiscal_year, periodNumber: r.period_number } : null;
}

/** Delete a sandbox's copied rows for `tables` (org tables + org-less children).
 * Runs unscoped with the kernel-migration GUC so posted rows can be removed. */
async function wipeSandbox(sandboxOrgId: string, tableNames: Set<string>): Promise<void> {
  const cat = await loadCatalog();
  const byName = new Map(cat.tables.map((t) => [t.name, t]));
  const order = deletionOrder(cat).filter((n) => tableNames.has(n));
  await withOrg(null, async () => {
    await db.execute(sql`set constraints all deferred`);
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
    // Pre-null self-referential FK columns (e.g. folders.parent_folder_id, which
    // is ON DELETE RESTRICT) so a single delete-all can't trip its own hierarchy.
    for (const t of cat.tables) {
      if (!tableNames.has(t.name) || !t.hasOrgId) continue;
      for (const col of selfRefColumns(t)) {
        await db.execute(sql.raw(`update "${t.name}" set "${col}" = null where org_id = '${sandboxOrgId}'`));
      }
    }
    // Delete referencers before referenced (topological order).
    for (const name of order) {
      const t = byName.get(name)!;
      if (t.hasOrgId) {
        await db.execute(sql.raw(`delete from "${name}" where org_id = '${sandboxOrgId}'`));
      } else if (PARENT_FILTER[name]) {
        await db.execute(sql.raw(`delete from "${name}" where ${PARENT_FILTER[name](sandboxOrgId)}`));
      }
    }
  });
}

export async function createSandbox(input: CreateSandboxInput): Promise<{
  sandboxId: string;
  sandboxOrgId: string;
}> {
  const tier = input.tier ?? "masked";
  const masked = input.masked ?? tier === "masked";
  const sandboxOrgId = randomUUID();
  const seed = randomUUID();

  const prod = (await db.execute(sql`
    select name, legal_name, base_currency, country from orgs where id = ${input.productionOrgId}`)) as any;
  const p = prod.rows[0];
  if (!p) throw new Error(`production org not found: ${input.productionOrgId}`);

  // The sandbox org row (orgs has no org_id, so it isn't RLS-scoped).
  await db.execute(sql`
    insert into orgs (id, name, legal_name, base_currency, country, env_kind, sandbox_of, sandbox_seed, created_by)
    values (${sandboxOrgId}, ${input.name}, ${p.legal_name}, ${p.base_currency}, ${p.country},
            'sandbox', ${input.productionOrgId}, ${seed}, ${input.createdBy ?? null})`);

  const [sb] = await db
    .insert(schema.sandboxes)
    .values({
      orgId: sandboxOrgId,
      productionOrgId: input.productionOrgId,
      name: input.name,
      tier,
      masked,
      asOfPeriodId: input.asOfPeriodId ?? null,
      status: "provisioning",
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: schema.sandboxes.id });

  try {
    if (masked) await seedDefaultMaskingPolicies(input.productionOrgId);
    const result = await runClone({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
      seed,
      tier,
      masked,
      asOfPeriod: await asOfPeriodOf(input.asOfPeriodId),
    });
    await neuterSandbox(sandboxOrgId);
    await db.execute(sql`
      update sandboxes
         set status = 'ready', storage_rows = ${result.rowsCopied}, last_refresh_at = now(), last_error = null
       where id = ${sb.id}`);
  } catch (err) {
    await db.execute(sql`
      update sandboxes set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)}
       where id = ${sb.id}`);
    throw err;
  }
  return { sandboxId: sb.id, sandboxOrgId };
}

export interface RefreshOptions {
  keepCustomizations?: boolean;
}

/**
 * Refresh a sandbox from its production source. Non-destructive by default: the
 * sandbox's customization layer is preserved (only business/master data is
 * re-pulled). `keepCustomizations: false` is a full reset. The whole operation
 * is one atomic unit — readers see the old sandbox until it commits.
 */
export async function refreshSandbox(
  sandboxId: string,
  opts: RefreshOptions = {},
): Promise<void> {
  const keep = opts.keepCustomizations ?? true;
  const row = (await db.execute(sql`
    select org_id, production_org_id, tier, masked, as_of_period_id from sandboxes where id = ${sandboxId}`)) as any;
  const s = row.rows[0];
  if (!s) throw new Error(`sandbox not found: ${sandboxId}`);
  const seed = (await db.execute(sql`select sandbox_seed from orgs where id = ${s.org_id}`)) as any;
  const sandboxSeed = seed.rows[0]?.sandbox_seed as string;

  await db.execute(sql`update sandboxes set status = 'refreshing' where id = ${sandboxId}`);
  try {
    const { rebaseSet } = await loadCatalog();
    // Which tables to wipe + re-copy. Keeping customizations means leaving the
    // customization layer untouched and refreshing everything else.
    const target = new Set(
      [...rebaseSet].filter((t) => !(keep && CUSTOMIZATION_LAYER.has(t))),
    );
    await wipeSandbox(s.org_id, target);

    // Re-copy only the target tables (deterministic ids → preserved
    // customization rows keep resolving their references to the fresh data).
    await runClone({
      productionOrgId: s.production_org_id,
      sandboxOrgId: s.org_id,
      seed: sandboxSeed,
      tier: s.tier,
      masked: s.masked,
      asOfPeriod: await asOfPeriodOf(s.as_of_period_id),
      onlyTables: target,
    });

    await db.execute(sql`
      update sandboxes set status = 'ready', last_refresh_at = now(), last_error = null where id = ${sandboxId}`);
  } catch (err) {
    await db.execute(sql`
      update sandboxes set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)}
       where id = ${sandboxId}`);
    throw err;
  }
}

export async function resetSandbox(sandboxId: string): Promise<void> {
  await refreshSandbox(sandboxId, { keepCustomizations: false });
}

/** Permanently delete a sandbox: wipe all its rows, then drop the org (which
 * cascades the sandboxes row). */
export async function deleteSandbox(sandboxId: string): Promise<void> {
  const row = (await db.execute(sql`select org_id from sandboxes where id = ${sandboxId}`)) as any;
  const orgId = row.rows[0]?.org_id as string | undefined;
  if (!orgId) return;
  await db.execute(sql`update sandboxes set status = 'deleting' where id = ${sandboxId}`);
  const { rebaseSet } = await loadCatalog();
  await wipeSandbox(orgId, new Set(rebaseSet));
  await withOrg(null, async () => {
    await db.execute(sql`delete from orgs where id = ${orgId}`);
  });
}
