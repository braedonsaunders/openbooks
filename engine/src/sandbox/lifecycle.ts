import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, orgContext, schema, withMaintenanceTransaction, withOrg } from "../db.ts";
import {
  deferredDeletionTables,
  deletionOrder,
  loadCatalog,
  PARENT_FILTER,
  SANDBOX_CYCLE_BREAKERS,
  selfRefColumns,
} from "./catalog.ts";
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

const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rebase account identities embedded in the org-level settings document.
 * Relational sandbox rows are rebased by the clone engine, but JSON values do
 * not participate in FK introspection. Leaving production account UUIDs in a
 * sandbox would be a silent cross-tenant configuration reference.
 *
 * Only identities proven to be production-owned accounts and to have an exact
 * cloned counterpart survive. A customization-only sandbox has no cloned
 * accounts, so its control map is intentionally empty instead of dangling.
 */
export async function rebaseSandboxControlAccounts(args: {
  productionOrgId: string;
  sandboxOrgId: string;
  seed: string;
  actorId?: string | null;
}): Promise<Record<string, string>> {
  const state = await db.execute(sql`
    select production.settings -> 'controlAccounts' as production_controls,
           sandbox.settings -> 'controlAccounts' as sandbox_controls
      from orgs production
      join orgs sandbox on sandbox.id = ${args.sandboxOrgId}
     where production.id = ${args.productionOrgId}
  `);
  const row = state.rows[0] as
    | {
        production_controls: Record<string, unknown> | null;
        sandbox_controls: Record<string, unknown> | null;
      }
    | undefined;
  if (!row) throw new Error("sandbox control-account rebase target not found");

  const sourceControls = row.production_controls ?? {};
  const sourceIds = [
    ...new Set(
      Object.values(sourceControls).filter(
        (value): value is string =>
          typeof value === "string" && UUID_VALUE.test(value),
      ),
    ),
  ];
  const mapped = new Map<string, string>();
  if (sourceIds.length > 0) {
    const result = await db.execute(sql`
      select source.id::text as source_id,
             target.id::text as sandbox_id
        from accounts source
        join accounts target
          on target.id = ob_rebase(source.id, ${args.seed}::uuid)
         and target.org_id = ${args.sandboxOrgId}
       where source.org_id = ${args.productionOrgId}
         and source.id = any(${`{${sourceIds.join(",")}}`}::uuid[])
    `);
    for (const account of result.rows as Array<{
      source_id: string;
      sandbox_id: string;
    }>) {
      mapped.set(account.source_id, account.sandbox_id);
    }
  }

  const rebased = Object.fromEntries(
    Object.entries(sourceControls).flatMap(([key, value]) => {
      if (typeof value !== "string" || !UUID_VALUE.test(value)) return [];
      const sandboxId = mapped.get(value);
      return sandboxId ? [[key, sandboxId]] : [];
    }),
  );
  const before = row.sandbox_controls ?? {};
  if (JSON.stringify(before) === JSON.stringify(rebased)) return rebased;

  const requestId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(
               coalesce(settings, '{}'::jsonb),
               '{controlAccounts}',
               ${JSON.stringify(rebased)}::jsonb,
               true
             ),
             updated_at = now(),
             updated_by = ${args.actorId ?? null}
       where id = ${args.sandboxOrgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${args.sandboxOrgId}, 'orgs', ${args.sandboxOrgId}, 'update',
        ${JSON.stringify({
          mode: "sandbox_control_account_rebase",
          productionOrgId: args.productionOrgId,
          before,
          after: rebased,
        })}::jsonb,
        ${args.actorId ?? null}, ${requestId}
      )
    `);
  });
  return rebased;
}

async function asOfPeriodOf(
  periodId: string | null | undefined,
  orgId: string,
): Promise<{ fiscalYear: number; periodNumber: number } | null> {
  if (!periodId) return null;
  const res = await db.execute<{ fiscal_year: number; period_number: number }>(sql`
    select fiscal_year, period_number from accounting_periods
     where id = ${periodId} and org_id = ${orgId}`);
  const r = res.rows[0];
  return r ? { fiscalYear: r.fiscal_year, periodNumber: r.period_number } : null;
}

/** Delete a sandbox's copied rows for `tables` (org tables + org-less children).
 * Runs unscoped with the kernel-migration GUC so posted rows can be removed. */
async function wipeSandbox(sandboxOrgId: string, tableNames: Set<string>): Promise<void> {
  const cat = await loadCatalog();
  const targetTables = cat.tenantTables.filter(
    (t) => tableNames.has(t.name) && t.name !== "sandboxes",
  );
  const byName = new Map(targetTables.map((t) => [t.name, t]));
  const targetCatalog = { ...cat, tables: targetTables };
  const order = deletionOrder(targetCatalog);
  const deferred = deferredDeletionTables(targetCatalog);
  await withOrg(null, async () => {
    await db.execute(sql`set constraints all immediate`);
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.amend', 'on', true)`);
    await db.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
    for (const [table, columns] of Object.entries(SANDBOX_CYCLE_BREAKERS)) {
      if (!byName.has(table)) continue;
      await db.execute(sql.raw(
        `update "${table}" set ${columns.map((column) => `"${column}" = null`).join(", ")} `
          + `where org_id = '${sandboxOrgId}'`,
      ));
    }
    // Pre-null self-referential FK columns (e.g. folders.parent_folder_id, which
    // is ON DELETE RESTRICT) so a single delete-all can't trip its own hierarchy.
    for (const t of targetTables) {
      if (!t.hasOrgId) continue;
      for (const col of selfRefColumns(t)) {
        await db.execute(sql.raw(`update "${t.name}" set "${col}" = null where org_id = '${sandboxOrgId}'`));
      }
    }
    const remove = async (name: string) => {
      const t = byName.get(name)!;
      if (t.hasOrgId) {
        await db.execute(sql.raw(`delete from "${name}" where org_id = '${sandboxOrgId}'`));
      } else if (PARENT_FILTER[name]) {
        await db.execute(sql.raw(`delete from "${name}" where ${PARENT_FILTER[name](sandboxOrgId)}`));
      }
    };
    // Delete the acyclic portion with immediate FK checks. Only the graph tail
    // containing real cycles is deferred, keeping commit validation bounded.
    for (const name of order) {
      if (!deferred.has(name)) await remove(name);
    }
    if (deferred.size) await db.execute(sql`set constraints all deferred`);
    for (const name of order) {
      if (deferred.has(name)) await remove(name);
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
    select name, legal_name, base_currency, country, tax_ids, settings
      from orgs where id = ${input.productionOrgId}`));
  const p = prod.rows[0];
  if (!p) throw new Error(`production org not found: ${input.productionOrgId}`);

  // The sandbox org row (orgs has no org_id, so it isn't RLS-scoped).
  await db.execute(sql`
    insert into orgs (
      id, name, legal_name, base_currency, country, tax_ids, settings,
      env_kind, sandbox_of, sandbox_seed, created_by
    )
    values (
      ${sandboxOrgId}, ${input.name}, ${p.legal_name}, ${p.base_currency}, ${p.country},
      ${JSON.stringify(p.tax_ids ?? {})}::jsonb, ${JSON.stringify(p.settings ?? {})}::jsonb,
      'sandbox', ${input.productionOrgId}, ${seed}, ${input.createdBy ?? null}
    )`);

  const sb = (await db
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
    .returning({ id: schema.sandboxes.id }))[0]!;

  try {
    if (masked) await seedDefaultMaskingPolicies(input.productionOrgId);
    const result = await runClone({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
      seed,
      tier,
      masked,
      asOfPeriod: await asOfPeriodOf(input.asOfPeriodId, input.productionOrgId),
    });
    await rebaseSandboxControlAccounts({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
      seed,
      actorId: input.createdBy ?? null,
    });
    await neuterSandbox(sandboxOrgId);
    await db.execute(sql`
      update sandboxes
         set status = 'ready', storage_rows = ${result.rowsCopied}, last_refresh_at = now(),
             last_error = null, updated_at = now()
       where id = ${sb.id} and org_id = ${sandboxOrgId}`);
  } catch (err) {
    await db.execute(sql`
      update sandboxes
         set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)},
             updated_at = now()
       where id = ${sb.id} and org_id = ${sandboxOrgId}`);
    throw err;
  }
  return { sandboxId: sb.id, sandboxOrgId };
}

export interface RefreshOptions {
  keepCustomizations?: boolean;
}

/**
 * Run refresh work in one timeout-free transaction while keeping the existing
 * clone/wipe helpers on their normal `withOrg(null)` entry points. Those
 * helpers reuse an active transaction only when its context is non-bypass;
 * the maintenance transaction itself is (correctly) marked bypass. Reusing
 * its pinned executor under a non-bypass context is safe here because the
 * connection's transaction-local GUC remains `app.bypass_rls = on`; it simply
 * makes nested `withOrg(null)` calls participate instead of opening a second
 * transaction that could commit a partial wipe.
 */
async function inRefreshTransaction<T>(work: () => Promise<T>): Promise<T> {
  return withMaintenanceTransaction(null, async () => {
    const active = orgContext.getStore();
    if (!active?.txDb) throw new Error("refresh transaction was not pinned");
    return await orgContext.run({ ...active, bypass: false }, async () => await work());
  });
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
  const row = await db.execute<{
    org_id: string; production_org_id: string; tier: SandboxTier; masked: boolean; as_of_period_id: string | null;
  }>(sql`
    select org_id, production_org_id, tier, masked, as_of_period_id from sandboxes where id = ${sandboxId}`);
  const s = row.rows[0];
  if (!s) throw new Error(`sandbox not found: ${sandboxId}`);
  const seed = (await db.execute(sql`select sandbox_seed from orgs where id = ${s.org_id}`));
  const sandboxSeed = seed.rows[0]?.sandbox_seed as string;

  try {
    await inRefreshTransaction(async () => {
      await db.execute(sql`
        update sandboxes
           set status = 'refreshing', last_error = null, updated_at = now()
         where id = ${sandboxId} and org_id = ${s.org_id}`);

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
        asOfPeriod: await asOfPeriodOf(s.as_of_period_id, s.production_org_id),
        onlyTables: target,
      });
      await rebaseSandboxControlAccounts({
        productionOrgId: s.production_org_id,
        sandboxOrgId: s.org_id,
        seed: sandboxSeed,
      });

      await db.execute(sql`
        update sandboxes
           set status = 'ready', last_refresh_at = now(), last_error = null, updated_at = now()
         where id = ${sandboxId} and org_id = ${s.org_id}`);
    });
  } catch (err) {
    await db.execute(sql`
      update sandboxes
         set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)},
             updated_at = now()
       where id = ${sandboxId} and org_id = ${s.org_id}`);
    throw err;
  }
}

export async function resetSandbox(sandboxId: string): Promise<void> {
  await refreshSandbox(sandboxId, { keepCustomizations: false });
}

/** Permanently delete a sandbox: wipe all its rows, then drop the org (which
 * cascades the sandboxes row). */
export async function deleteSandbox(sandboxId: string): Promise<void> {
  const row = (await db.execute(sql`select org_id from sandboxes where id = ${sandboxId}`));
  const orgId = row.rows[0]?.org_id as string | undefined;
  if (!orgId) return;
  await db.execute(sql`
    update sandboxes
       set status = 'deleting', last_error = null, updated_at = now()
     where id = ${sandboxId} and org_id = ${orgId}`);
  try {
    const { tenantTables } = await loadCatalog();
    await wipeSandbox(orgId, new Set(tenantTables.map((t) => t.name)));
    await withOrg(null, async () => {
      await db.execute(sql`delete from orgs where id = ${orgId}`);
    });
  } catch (err) {
    await db.execute(sql`
      update sandboxes
         set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)},
             updated_at = now()
       where id = ${sandboxId} and org_id = ${orgId}`);
    throw err;
  }
}
