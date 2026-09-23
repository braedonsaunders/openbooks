import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, longPool, orgContext, schema, withMaintenanceTransaction, withOrg, type MaintenanceTransactionOptions } from "../platform/db.ts";
import {
  assertUuid,
  deferredDeletionTables,
  deletionOrder,
  loadCatalog,
  PARENT_FILTER,
  SANDBOX_CYCLE_BREAKERS,
  selfRefColumns,
} from "./catalog.ts";
import { copyClonedFileObjects, CUSTOMIZATION_LAYER, listSandboxS3VersionIds, runClone, type SandboxTier } from "./clone.ts";
import { deleteS3Blobs } from "../platform/file-storage.ts";
import { neuterSandbox } from "../organization/sandbox-guard.ts";
import { seedDefaultMaskingPolicies } from "./masking.ts";
import { verifyCloneRls } from "./verify-rls.ts";

/** A zero-row sandbox lookup is a failure: the caller asked to act on a named id. */
export function requireFoundSandbox<T>(
  sandboxId: string,
  row: T | null | undefined,
): T {
  if (row == null || (typeof row === "string" && row.length === 0)) {
    throw new Error(`sandbox not found: ${sandboxId}`);
  }
  return row;
}

/** Stamped onto `sandboxes.last_error` while status is `refreshing`. Not a user error. */
export const REFRESH_CLONE_PROOF_PREFIX = "clone-rls-proof:";

export function newRefreshCloneProofToken(): string {
  return `${REFRESH_CLONE_PROOF_PREFIX}${randomUUID()}`;
}

export function sandboxRefreshLockKey(sandboxId: string): string {
  return `openbooks:sandbox-refresh:${sandboxId}`;
}

/**
 * Ready is allowed only for the clone this request just proved. Another
 * refresh of the same sandbox (same seed, identical row counts) is a
 * different clone and must not inherit this request's ready write.
 */
export function refreshReadyMatchesProvenClone(
  row: { status: string; lastError: string | null },
  proven: { proofToken: string },
): boolean {
  return (
    proven.proofToken.startsWith(REFRESH_CLONE_PROOF_PREFIX) &&
    proven.proofToken.length > REFRESH_CLONE_PROOF_PREFIX.length &&
    row.status === "refreshing" &&
    row.lastError === proven.proofToken
  );
}

export function refuseUnprovenRefreshReady(
  row: { status: string; lastError: string | null } | undefined,
  proven: { sandboxId: string; proofToken: string },
): void {
  if (!row) throw new Error(`sandbox not found: ${proven.sandboxId}`);
  if (!refreshReadyMatchesProvenClone(row, proven)) {
    throw new Error(
      `cannot mark sandbox ${proven.sandboxId} ready; this request proved clone ${proven.proofToken} but the row holds ${row.lastError ?? "(none)"}. Re-run the refresh.`,
    );
  }
}

/**
 * Hold the same-sandbox session lock across clone + RLS proof + ready. The
 * maintenance helper releases its lock when the clone transaction returns,
 * which would let a second refresh commit a new clone before this request
 * marks ready.
 */
/**
 * Same-sandbox advisory lock, shared with promotion capture: refresh holds
 * it across wipe + re-copy + verify + ready, and buildChangeSet holds it
 * across capture, so a refresh can neither commit a new clone under a
 * capture nor wipe rows the capture is diffing. Exported for promote.ts;
 * all other callers go through refreshSandbox/deleteSandbox.
 */
export async function withSandboxRefreshLock<T>(sandboxId: string, work: () => Promise<T>): Promise<T> {
  const client = await longPool.connect();
  let poisoned: Error | undefined;
  const onError = (error: Error) => {
    poisoned = error;
  };
  client.on("error", onError);
  const key = sandboxRefreshLockKey(sandboxId);
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await work();
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      } catch {
        // A broken connection is discarded on release, lock and all.
      }
    }
  } finally {
    client.off("error", onError);
    client.release(poisoned);
  }
}

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
  /**
   * Production settings captured inside the clone snapshot (runClone returns
   * them). When provided, the rebase derives from the same snapshot the
   * sandbox settings came from instead of re-reading production after the
   * clone committed. Refresh omits this and keeps its long-standing
   * current-production read.
   */
  productionSettings?: Record<string, unknown> | null;
}): Promise<Record<string, string>> {
  // With an in-snapshot settings capture, the production half comes from the
  // caller and only the sandbox half is read; otherwise both halves are read
  // live (the refresh path).
  let productionControls: Record<string, unknown> | null | undefined;
  if (args.productionSettings != null) {
    productionControls = args.productionSettings["controlAccounts"] as
      | Record<string, unknown>
      | null
      | undefined;
  } else {
    const prodRow = (
      await db.execute(sql`
      select production.settings -> 'controlAccounts' as production_controls
        from orgs production
       where production.id = ${args.productionOrgId}
    `)
    ).rows[0]?.production_controls as Record<string, unknown> | null | undefined;
    if (prodRow === undefined) throw new Error("sandbox control-account rebase target not found");
    productionControls = prodRow;
  }
  const sandboxRow = (
    await db.execute(sql`
    select settings -> 'controlAccounts' as sandbox_controls
      from orgs
     where id = ${args.sandboxOrgId}
  `)
  ).rows[0] as { sandbox_controls: Record<string, unknown> | null } | undefined;
  if (!sandboxRow) throw new Error("sandbox control-account rebase target not found");

  const sourceControls = productionControls ?? {};
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
  const before = sandboxRow.sandbox_controls ?? {};
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

/** Delete a sandbox's copied rows for `tables` (org tables + org-less children).
 * Runs unscoped with the kernel-migration GUC so posted rows can be removed. */
async function wipeSandbox(sandboxOrgId: string, tableNames: Set<string>): Promise<void> {
  // This path deletes a whole tenant. The org id is bound as a parameter in
  // every statement below EXCEPT the PARENT_FILTER branch, which reuses a
  // shared string builder (clone.ts uses it too) whose only interpolation is
  // this id. Assert it is a canonical UUID at this boundary so that one
  // remaining interpolation is provably a value that cannot carry a quote or a
  // statement — a reader can verify that from this line plus PARENT_FILTER's
  // three constant templates.
  assertUuid(sandboxOrgId);
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
    // Park the sandbox's users inactive BEFORE their role assignments go:
    // role_assignments_active_user_guard (immediate here) forbids leaving an
    // ACTIVE user roleless, which every reset/delete of a sandbox that holds
    // cloned users would otherwise trip.
    if (byName.has("users") && byName.has("role_assignments")) {
      await db.execute(sql`update users set is_active = false where org_id = ${sandboxOrgId}`);
    }
    for (const [table, columns] of Object.entries(SANDBOX_CYCLE_BREAKERS)) {
      if (!byName.has(table)) continue;
      // Tables in the deferred tail are removed after SET CONSTRAINTS ALL
      // DEFERRED with commit-time validation, so pre-nulling their cycle
      // links buys nothing — and on posted rows it is actively harmful: a
      // posted document's links are covered by CHECK constraints (e.g.
      // documents_posted_period_required) that fire immediately on UPDATE,
      // failing every delete of a sandbox that holds posted documents and
      // stranding its org behind orgs_sandbox_of_fkey. Keep the pre-null only
      // for tables deleted under immediate constraints.
      if (deferred.has(table)) continue;
      await db.execute(sql`
        update ${sql.identifier(table)}
           set ${sql.join(columns.map((column) => sql`${sql.identifier(column)} = null`), sql`, `)}
         where org_id = ${sandboxOrgId}
      `);
    }
    // Pre-null self-referential FK columns (e.g. folders.parent_folder_id, which
    // is ON DELETE RESTRICT) so a single delete-all can't trip its own hierarchy.
    for (const t of targetTables) {
      if (!t.hasOrgId) continue;
      for (const col of selfRefColumns(t)) {
        await db.execute(sql`
          update ${sql.identifier(t.name)}
             set ${sql.identifier(col)} = null
           where org_id = ${sandboxOrgId}
        `);
      }
    }
    const remove = async (name: string) => {
      const t = byName.get(name)!;
      if (t.hasOrgId) {
        await db.execute(sql`delete from ${sql.identifier(name)} where org_id = ${sandboxOrgId}`);
      } else if (PARENT_FILTER[name]) {
        // Shared string builder; sandboxOrgId is assertUuid-checked at the top.
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

  if (tier === "as_of" && !input.asOfPeriodId) throw new Error("as-of sandbox requires a cutoff period");
  // Only the cutoff period ID crosses into the clone: runClone resolves its
  // calendar and end date inside the copy snapshot, so no outer lookup can go
  // stale between here and the copy (SBOX1 addendum).
  const prod = (await db.execute(sql`
    select name, legal_name, base_currency, country, tax_ids, settings
      from orgs where id = ${input.productionOrgId}`));
  const p = prod.rows[0];
  if (!p) throw new Error(`production org not found: ${input.productionOrgId}`);

  // The sandbox org row (orgs has no org_id, so it isn't RLS-scoped). The org
  // row is not cloned, so masking policies never see it: a masked sandbox
  // starts without the organization's tax registrations. These values are
  // PROVISIONAL scaffolding so the row exists for the clone to overwrite:
  // the authoritative capture happens inside runClone's snapshot
  // (initializeOrg), and a ready sandbox always carries the snapshot's
  // configuration, never this read.
  await db.execute(sql`
    insert into orgs (
      id, name, legal_name, base_currency, country, tax_ids, settings,
      env_kind, sandbox_of, sandbox_seed, created_by
    )
    values (
      ${sandboxOrgId}, ${input.name}, ${p.legal_name}, ${p.base_currency}, ${p.country},
      ${JSON.stringify(masked ? {} : (p.tax_ids ?? {}))}::jsonb, ${JSON.stringify(p.settings ?? {})}::jsonb,
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
      asOfPeriodId: input.asOfPeriodId ?? null,
      initializeOrg: true,
    });
    // S3-backed attachments live outside the row-copy transaction: copy the
    // objects onto the rebased keys now that the rows exist. A copy failure
    // marks the sandbox failed (catch below), never a ready sandbox whose
    // cabinet 404s. Masked clones are a no-op here by construction — their
    // rows carry the tombstone kind, never 's3'.
    await copyClonedFileObjects({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
      seed,
    });
    await rebaseSandboxControlAccounts({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
      seed,
      actorId: input.createdBy ?? null,
      // The clone captured these inside its snapshot: the rebase derives
      // from the same configuration the sandbox settings came from.
      productionSettings: result.sourceSettings,
    });
    await neuterSandbox(sandboxOrgId);
    // Prove tenant isolation on the clone before it is marked ready.
    // withOrg opens its own bypass-off transactions even when the caller
    // holds withBypassContext (ALS bypass, no pinned connection).
    await verifyCloneRls({
      productionOrgId: input.productionOrgId,
      sandboxOrgId,
    });
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
async function inRefreshTransaction<T>(
  work: () => Promise<T>,
  opts: MaintenanceTransactionOptions = {},
): Promise<T> {
  // Repeatable read like the standalone clone: the re-copy inside must see
  // the same production snapshot for every table even while production posts
  // around it. Nested clone/wipe calls reuse this transaction (and its
  // isolation) instead of opening their own.
  return withMaintenanceTransaction(null, async () => {
    const active = orgContext.getStore();
    if (!active?.txDb) throw new Error("refresh transaction was not pinned");
    return await orgContext.run({ ...active, bypass: false }, async () => await work());
  }, opts);
}

/**
 * Refresh a sandbox from its production source. Non-destructive by default: the
 * sandbox's customization layer is preserved (only business/master data is
 * re-pulled). `keepCustomizations: false` is a full reset. The same-sandbox
 * advisory lock is held across clone + `verifyCloneRls` + ready so a second
 * refresh cannot commit a new clone under this request's ready write. Clone
 * work commits while status stays `refreshing` and `last_error` holds this
 * request's proof token; ready is written only if that token still matches.
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
  const s = requireFoundSandbox(sandboxId, row.rows[0]);
  const seed = (await db.execute(sql`select sandbox_seed from orgs where id = ${s.org_id}`));
  const sandboxSeed = seed.rows[0]?.sandbox_seed as string;
  const proofToken = newRefreshCloneProofToken();

  await withSandboxRefreshLock(sandboxId, async () => {
    try {
      // Commit refreshing + this request's proof token BEFORE the clone
      // unit. A mark inside that transaction rolls back with a failed
      // INSERT, the catch's `last_error = proofToken` then matches zero
      // rows, and the sandbox stays ready after a failed refresh.
      const marked = (await db.execute<{ id: string }>(sql`
        update sandboxes
           set status = 'refreshing', last_error = ${proofToken}, updated_at = now()
         where id = ${sandboxId} and org_id = ${s.org_id} and status <> 'deleting'
         returning id`));
      if (!marked.rows[0]) {
        requireFoundSandbox(
          sandboxId,
          (await db.execute<{ status: string }>(sql`
          select status from sandboxes where id = ${sandboxId} and org_id = ${s.org_id}`)).rows[0],
        );
        throw new Error(`cannot refresh sandbox ${sandboxId} while it is being deleted`);
      }

      // The sandbox's current S3 object keys, snapshotted BEFORE the wipe:
      // objects live outside the row transaction, so keys whose versions
      // disappear upstream are deleted after the re-copy commits.
      const staleS3VersionIds = await listSandboxS3VersionIds(s.org_id);
      // Which tables to wipe + re-copy. Keeping customizations means leaving the
      // customization layer untouched and refreshing everything else. Computed
      // outside the clone unit: the post-commit S3 sync below needs the same set.
      const { rebaseSet } = await loadCatalog();
      const target = new Set(
        [...rebaseSet].filter((t) => !(keep && CUSTOMIZATION_LAYER.has(t))),
      );
      // New default policies reach existing tenants here, not just on create:
      // a masked sandbox created before a default existed would otherwise
      // refresh without it. Idempotent — an org's deliberate deactivation is
      // left untouched.
      if (s.masked) await seedDefaultMaskingPolicies(s.production_org_id);

      await inRefreshTransaction(async () => {
        if (s.tier === "as_of" && !s.as_of_period_id) throw new Error("as-of sandbox requires a cutoff period");
        // Only the cutoff period ID crosses into the clone: runClone resolves
        // its calendar and end date inside the shared snapshot transaction,
        // so the refresh resolves exactly what it copies. The sandbox org
        // row is deliberately NOT re-initialized here — refresh preserves the
        // sandbox's own org configuration and only re-pulls tenant rows.
        await wipeSandbox(s.org_id, target);

        // Re-copy only the target tables (deterministic ids → preserved
        // customization rows keep resolving their references to the fresh data).
        await runClone({
          productionOrgId: s.production_org_id,
          sandboxOrgId: s.org_id,
          seed: sandboxSeed,
          tier: s.tier,
          masked: s.masked,
          asOfPeriodId: s.as_of_period_id,
          onlyTables: target,
        });
        await rebaseSandboxControlAccounts({
          productionOrgId: s.production_org_id,
          sandboxOrgId: s.org_id,
          seed: sandboxSeed,
        });
        // The re-copy just rehydrated every integration/credential row from
        // production; make the sandbox inert again inside the same unit so a
        // reader can never observe a refreshed sandbox that could reach the
        // outside world (worker-scheduled refreshes run unattended).
        await neuterSandbox(s.org_id);
        if (s.masked) await scrubSandboxOrgIdentity(s.org_id);
        // Status stays 'refreshing' through commit. The proof cannot run inside
        // this unit: the pinned connection keeps app.bypass_rls=on, so a
        // ready write here would publish the clone before isolation is proven.
      }, {
        isolationLevel: "REPEATABLE READ",
        // The same-sandbox lock is already held by withSandboxRefreshLock
        // across clone + verify + ready. Re-acquiring the same key on this
        // transaction's connection would deadlock the request against itself.
      });
      // After the clone unit commits, still under the same-sandbox lock:
      // bring the sandbox's S3 objects to the re-copied rows (masked clones
      // are a no-op — tombstoned rows never match 's3'), then drop keys whose
      // versions disappeared upstream. A sync failure marks the refresh
      // failed (catch below), never a ready sandbox with a stale cabinet.
      await copyClonedFileObjects({
        productionOrgId: s.production_org_id,
        sandboxOrgId: s.org_id,
        seed: sandboxSeed,
        onlyTables: target,
      });
      const currentS3VersionIds = new Set(await listSandboxS3VersionIds(s.org_id));
      await deleteS3Blobs(staleS3VersionIds.filter((id) => !currentS3VersionIds.has(id)));
      // After the clone unit commits, still under the same-sandbox lock.
      // verifyCloneRls opens its own withOrg transactions (bypass off).
      await verifyCloneRls({
        productionOrgId: s.production_org_id,
        sandboxOrgId: s.org_id,
      });
      const markedReady = await db.execute<{ id: string }>(sql`
        update sandboxes
           set status = 'ready', last_refresh_at = now(), last_error = null, updated_at = now()
         where id = ${sandboxId} and org_id = ${s.org_id}
           and status = 'refreshing' and last_error = ${proofToken}
         returning id`);
      if (!markedReady.rows[0]) {
        const current = (await db.execute<{ status: string; last_error: string | null }>(sql`
          select status, last_error from sandboxes where id = ${sandboxId} and org_id = ${s.org_id}`)).rows[0];
        refuseUnprovenRefreshReady(
          current ? { status: current.status, lastError: current.last_error } : undefined,
          { sandboxId, proofToken },
        );
        throw new Error(
          `cannot mark sandbox ${sandboxId} ready; the proven clone was not updated. Re-run the refresh.`,
        );
      }
    } catch (err) {
      // Never clobber a deleter's mark or a newer refresh's proof token.
      // Zero rows is expected and benign only in that race — our own mark
      // is committed before the clone unit, so a clone failure matches.
      const failed = await db.execute<{ id: string }>(sql`
        update sandboxes
           set status = 'failed', last_error = ${String(err instanceof Error ? err.message : err)},
               updated_at = now()
         where id = ${sandboxId} and org_id = ${s.org_id}
           and status <> 'deleting' and last_error = ${proofToken}
         returning id`);
      if (!failed.rows[0] && err instanceof Error) {
        err.message = `${err.message}; failed-status write matched 0 rows for sandbox ${sandboxId}`;
      }
      throw err;
    }
  });
}

/** A masked sandbox's org row never carries the organization's tax
 * registrations (the row is not cloned, so column masking cannot reach it). */
async function scrubSandboxOrgIdentity(sandboxOrgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set tax_ids = '{}'::jsonb, updated_at = now()
     where id = ${sandboxOrgId} and env_kind = 'sandbox' and tax_ids <> '{}'::jsonb`);
}

export async function resetSandbox(sandboxId: string): Promise<void> {
  await refreshSandbox(sandboxId, { keepCustomizations: false });
}

/** Permanently delete a sandbox: wipe all its rows, then drop the org (which
 * cascades the sandboxes row). */
export async function deleteSandbox(sandboxId: string): Promise<void> {
  const row = (await db.execute(sql`select org_id from sandboxes where id = ${sandboxId}`));
  const orgId = requireFoundSandbox(sandboxId, row.rows[0]?.org_id as string | undefined);
  // A refresh that already marked 'refreshing' owns this sandbox: wiping
  // under its clone unit corrupts the refresh and strands the status. The
  // conditional mark makes the race atomic — the loser refuses loudly.
  const marked = (await db.execute<{ id: string }>(sql`
    update sandboxes
       set status = 'deleting', last_error = null, updated_at = now()
     where id = ${sandboxId} and org_id = ${orgId} and status <> 'refreshing'
     returning id`));
  if (!marked.rows[0]) {
    requireFoundSandbox(
      sandboxId,
      (await db.execute<{ status: string }>(sql`
      select status from sandboxes where id = ${sandboxId} and org_id = ${orgId}`)).rows[0],
    );
    throw new Error(`cannot delete sandbox ${sandboxId} while it is refreshing — retry once the refresh completes`);
  }
  try {
    const { tenantTables } = await loadCatalog();
    // S3 objects live outside the row wipe: snapshot the keys first so the
    // sandbox's objects die with its rows instead of orphaning in the bucket.
    const s3VersionIds = await listSandboxS3VersionIds(orgId);
    await wipeSandbox(orgId, new Set(tenantTables.map((t) => t.name)));
    await deleteS3Blobs(s3VersionIds);
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
