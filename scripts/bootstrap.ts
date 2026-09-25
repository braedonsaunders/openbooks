import { runtimeDatabaseConfig, bypassDatabaseConfig } from "./bootstrap-paths"
import { assertConstrainedSchemaOwnerMigrationRole, requireRuntimeLoginRole, requireBypassLoginRole, ensureRuntimeRoleExists, ensureBypassRoleExists, ensureBypassObjectGrants, ensureBypassDatabaseRole, ensureRuntimeDatabaseRole, verifyRuntimeDatabaseRole, transferTestOwnershipToRuntimeRole, ensureReadRole } from "./bootstrap/database-roles"
import { runUpgradeCheckMain, migrate } from "./bootstrap/migrate"
import { ensureOrg, seedCurrencies, ensureRootSubsidiary, seedRoles, seedAdmin, ensureFirstPlatformAdmin } from "./bootstrap/seed"
import { sql } from "drizzle-orm"
import { precreatedRolesEnabled, verifyPrecreatedRoles, verifyPrecreatedObjectAccess, verifyRuntimeOwnership } from "./bootstrap-roles.ts"
import { db, env, longPool, pool, withBypassContext } from "../engine/src/platform/db.ts"
import { provisionOrganizationDefaults } from "../engine/src/provisioning/organization-provisioning.ts"

async function main(): Promise<void> {
  if (process.argv.includes("--check")) {
    // Strictly read-only: this path takes no advisory lock (it must not
    // block a live app), creates nothing, and performs no role, seed, or
    // RLS work. It lists the pending migrations and runs the evaluable
    // preflights, exiting 1 on any refuse finding and 0 otherwise.
    const json = process.argv.includes("--json");
    let code = 1;
    try {
      code = await runUpgradeCheckMain(json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      // A caller asked for machine output, so it gets machine output, error
      // included. A bare crash leaves it nothing to parse.
      if (json) console.log(JSON.stringify({ error: message }));
      code = 1;
    } finally {
      await pool.end().catch(() => {});
      await longPool.end().catch(() => {});
    }
    // Drain stdout before exiting: process.exit() right after a large write to
    // a pipe cut the JSON report at 146,176 bytes in the perf-1m rehearsal
    // (one row per offending pay stub), and the caller could not parse it.
    await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
    process.exit(code);
  }
  const precreated = precreatedRolesEnabled(env);
  const runtimeConfig = runtimeDatabaseConfig();
  const bypassConfig = bypassDatabaseConfig();
  const constrainedSchemaOwnerMigration =
    env.OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION === "1";
  const restoreTarget = env.OPENBOOKS_RESTORE_TARGET === "1";
  if (restoreTarget && constrainedSchemaOwnerMigration) {
    throw new Error(
      "OPENBOOKS_RESTORE_TARGET and constrained schema-owner migration modes cannot be combined",
    );
  }
  if (env.NODE_ENV === "production" && !runtimeConfig) {
    throw new Error(
      "OPENBOOKS_RUNTIME_DB_URL is required for production bootstrap; migrations and application traffic must use separate database roles",
    );
  }
  const lockClient = await pool.connect();
  let locked = false;
  try {
    // Rolling deployments can start more than one container against the same
    // database. Serialize the entire migrate+seed unit so one
    // bootstrap cannot seed a relation while another is changing its policy
    // or constraint definition.
    await lockClient.query("set statement_timeout = 0");
    await lockClient.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      "openbooks:deployment-bootstrap",
    ]);
    locked = true;
    console.log("[bootstrap] starting");
    // Bootstrap is the one intentional installation-wide maintenance boundary.
    // Set it explicitly: an absent tenant remains fail-closed everywhere else,
    // while migration validation must see every row before it changes a global
    // constraint. Context-only scope keeps each tracked migration's own
    // transaction authoritative instead of pinning an outer transaction.
    await withBypassContext(async () => {
      if (constrainedSchemaOwnerMigration) {
        if (!runtimeConfig) {
          throw new Error(
            "constrained schema-owner migration requires OPENBOOKS_RUNTIME_DB_URL",
          );
        }
        await assertConstrainedSchemaOwnerMigrationRole(runtimeConfig);
        // The runtime login must already exist (this login cannot create
        // roles); grants for tables this run creates are applied after the
        // migration chain, then the runtime login is verified non-owner and
        // RLS-proved before anything serves it. The cross-tenant login is
        // verified the same way when the release wires it: this gates the
        // digest swap on a bypass role the new web/worker can actually boot
        // with (they refuse at import without one).
        await requireRuntimeLoginRole(runtimeConfig);
        if (bypassConfig) await requireBypassLoginRole(bypassConfig);
        await migrate();
        await ensureRuntimeDatabaseRole(runtimeConfig, true);
        // The constrained login owns the schema, so it can converge the
        // host-created bypass login's object grants for tables this run
        // created — same treatment as the runtime login above.
        if (bypassConfig) {
          await ensureBypassObjectGrants(bypassConfig, runtimeConfig.roleName);
        }
        await verifyRuntimeOwnership(pool, runtimeConfig.roleName);
        const firstOrg = await pool.query<{ id: string }>(
          "select id from orgs order by created_at limit 1",
        );
        if (firstOrg.rows[0]) {
          await verifyRuntimeDatabaseRole(runtimeConfig, firstOrg.rows[0].id);
        } else {
          console.log(
            "[bootstrap] no organizations yet; runtime RLS proofs are deferred to the first deploy with an organization",
          );
        }
        return;
      }
      // Some migrations grant privileges to openbooks_read, so a fresh database
      // must establish the role before applying them. Run the same idempotent
      // routine again afterward to grant access to the newly created tables.
      if (precreated) {
        await verifyPrecreatedRoles(pool, runtimeConfig!);
        // The host owns the cross-tenant login too: verify it exists with
        // BYPASSRLS rather than creating it. Absent stays skipped — the
        // installer never serves tenant traffic, so it needs no bypass
        // credential of its own.
        if (bypassConfig) await requireBypassLoginRole(bypassConfig);
        console.log("[bootstrap] pre-created roles verified; host owns role provisioning");
      } else {
        await ensureReadRole();
      }
      // Runtime roles the migrations may reference (e.g. RLS policies targeted
      // `TO openbooks_app`) must also exist before the migration chain runs;
      // the post-migrate ensureRuntimeDatabaseRole still grants the now-created
      // relations their privileges. The cross-tenant login is ensured on the
      // same schedule so the stock Compose stack boots its first web/worker
      // with a provisioned bypass role.
      if (runtimeConfig && !precreated) await ensureRuntimeRoleExists(runtimeConfig);
      if (bypassConfig && !precreated) {
        await ensureBypassRoleExists(bypassConfig, runtimeConfig?.roleName ?? null);
      }
      await migrate();
      if (runtimeConfig) await ensureRuntimeDatabaseRole(runtimeConfig, precreated);
      if (bypassConfig && !precreated) {
        await ensureBypassDatabaseRole(bypassConfig, runtimeConfig?.roleName ?? null);
      }
      if (bypassConfig && precreated) {
        await ensureBypassObjectGrants(bypassConfig, runtimeConfig?.roleName ?? null);
      }
      if (precreated) {
        await verifyPrecreatedObjectAccess(pool, runtimeConfig!);
      } else {
        await ensureReadRole(runtimeConfig?.roleName);
      }
      await seedCurrencies();
      if (restoreTarget) {
        const organizations = (await db.execute<{ count: number }>(
          sql`select count(*)::int as count from orgs`,
        ));
        if (organizations.rows[0]?.count !== 0) {
          throw new Error(
            "OPENBOOKS_RESTORE_TARGET requires a new database with zero organizations",
          );
        }
        console.log(
          "[bootstrap] schema-only restore target ready; no organization or administrator was seeded",
        );
        return;
      }
      const primaryOrgId = await ensureOrg();
      const organizations = (await db.execute<{ id: string }>(
        sql`select id from orgs order by created_at`,
      ));
      for (const { id: orgId } of organizations.rows) {
        await ensureRootSubsidiary(orgId);
        await seedRoles(orgId);
        await provisionOrganizationDefaults(orgId);
      }
      await seedAdmin(primaryOrgId);
      await ensureFirstPlatformAdmin();
      if (env.OPENBOOKS_TEST_OWNERSHIP_TRANSFER === "1" && !runtimeConfig) {
        throw new Error(
          "[bootstrap] OPENBOOKS_TEST_OWNERSHIP_TRANSFER requires OPENBOOKS_RUNTIME_DB_URL",
        );
      }
      if (runtimeConfig) await transferTestOwnershipToRuntimeRole(runtimeConfig);
      if (runtimeConfig)
        await verifyRuntimeDatabaseRole(runtimeConfig, primaryOrgId);
    });
    console.log("[bootstrap] done");
  } finally {
    if (locked) {
      await lockClient
        .query("select pg_advisory_unlock(hashtextextended($1, 0))", [
          "openbooks:deployment-bootstrap",
        ])
        .catch(() => {});
    }
    lockClient.release();
    await pool.end();
    // Migration and RLS DDL now check out longPool sessions, which (unlike the
    // governed read pool) keep the process alive while idle. Without this the
    // bootstrap process hangs after "[bootstrap] done".
    await longPool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
