import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import {
  verifyPrecreatedRoles,
  verifyPrecreatedObjectAccess,
  verifyReadRoleAssumption,
} from "./bootstrap-roles.ts";

const exec = promisify(execFile);
const adminUrl = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
// A canonical DB partition must refuse a missing administrator endpoint rather
// than silently skip this provisioning proof. Standalone runs can supply only
// the administrator URL because every database used here is created afresh.
const DB = Boolean(process.env.OPENBOOKS_DB_URL || adminUrl);
const root = new URL("..", import.meta.url).pathname;
const password = "precreated-role-integration-password";
const HEADER = [
  "SET statement_timeout = 0;",
  "SET idle_in_transaction_session_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SET client_min_messages = warning;",
].join("\n");

/** The probe migration filename `offset` ordinals past the newest published
 * forward migration, so an upgrade probe never collides with a real one. */
async function nextForwardMigration(offset: number, name: string): Promise<string> {
  const ordinals = (await readdir(join(root, "schema", "migrations", "generated")))
    .map((file) => /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file)?.[1])
    .filter((ordinal): ordinal is string => ordinal !== undefined)
    .map(Number);
  return `${String(Math.max(0, ...ordinals) + offset).padStart(4, "0")}_${name}.sql`;
}

/** A copy of this checkout's runner and release schema with forward
 * migrations above the baseline, so an upgrade can be exercised without
 * touching the source tree. Engine code resolves to this checkout. */
async function forwardMigrationTree(migrations: Record<string, string>): Promise<string> {
  const tree = await mkdtemp(join(tmpdir(), "openbooks-forward-migrations-"));
  for (const path of ["scripts", "package.json", "tsconfig.base.json"])
    await cp(join(root, path), join(tree, path), { recursive: true });
  await cp(join(root, "schema", "migrations"), join(tree, "schema", "migrations"), {
    recursive: true,
    filter: (source) => !/\.test\.[a-z]+$/.test(source),
  });
  await symlink(join(root, "node_modules"), join(tree, "node_modules"));
  for (const [file, body] of Object.entries(migrations)) {
    await writeFile(
      join(tree, "schema", "migrations", "generated", file),
      `${HEADER}\n\n${body}\n`,
    );
    await writeFile(
      join(tree, "schema", "migrations", "preflight", file.replace(/\.sql$/, ".none")),
      "Creates a new function only; no existing rows are read or changed.\n",
    );
  }
  return tree;
}

test(
  "host-managed PostgreSQL installs, upgrades, and refuses broken permissions without role administration",
  { skip: !DB, timeout: 240_000 },
  async (t) => {
    assert.ok(
      adminUrl,
      "host-managed provisioning tests require OPENBOOKS_TEST_ADMIN_DB_URL; use the test cluster administrator endpoint",
    );
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const suffix = randomBytes(6).toString("hex");
    const owner = `ob_pc_owner_${suffix}`;
    const runtime = `ob_pc_app_${suffix}`;
    const other = `ob_pc_other_${suffix}`;
    const database = `ob_pc_${suffix}`;
    const otherDatabase = `ob_pc_other_${suffix}`;
    const managedDatabase = `ob_pc_managed_${suffix}`;
    const managedRole = `ob_pc_managed_${suffix}`;
    const url = (role: string, db = database) => {
      const parsed = new URL(adminUrl!);
      parsed.username = role;
      parsed.password = password;
      parsed.pathname = `/${db}`;
      return parsed.toString();
    };
    const config = { connectionString: url(runtime), roleName: runtime, password };
    const ownerPool = new pg.Pool({ connectionString: url(owner), max: 1 });
    const runtimePool = new pg.Pool({ connectionString: url(runtime), max: 1 });
    const trees: string[] = [];
    const bootstrap = async (overrides: Record<string, string> = {}, cwd = root) => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("OPENBOOKS_") &&
            !key.startsWith("ADMIN_") &&
            !key.startsWith("ORG_") &&
            !key.startsWith("PLATFORM_"),
        ),
      );
      return exec(
        process.execPath,
        [
          "--no-concurrent-sparkplug",
          "--no-concurrent-recompilation",
          "--import",
          "tsx",
          "scripts/bootstrap.ts",
        ],
        {
          cwd,
          maxBuffer: 4 * 1024 * 1024,
          timeout: 150_000,
          env: {
            ...env,
            NODE_ENV: "production",
            OPENBOOKS_BOOTSTRAP: "1",
            OPENBOOKS_PRECREATED_ROLES: "1",
            OPENBOOKS_MIGRATION_DB_URL: url(owner),
            OPENBOOKS_DB_URL: url(runtime),
            OPENBOOKS_RUNTIME_DB_URL: url(runtime),
            OPENBOOKS_DATA_KEY: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
            ORG_NAME: "Hosted PostgreSQL integration",
            ORG_CURRENCY: "USD",
            ORG_COUNTRY: "US",
            ADMIN_EMAIL: "hosted@example.test",
            ADMIN_PASSWORD: "hosted-admin-integration-password",
            ...overrides,
          },
        },
      );
    };
    try {
      // Reuse the shared test cluster's read role without altering its posture or
      // other memberships. Every login/database this test changes is uniquely owned.
      await admin.query(
        "do $$ begin if not exists (select 1 from pg_roles where rolname='openbooks_read') then create role openbooks_read nologin; end if; end $$",
      );
      for (const role of [owner, runtime, other]) {
        await admin.query(
          `create role ${role} login nosuperuser nobypassrls nocreatedb nocreaterole noreplication password '${password}'`,
        );
      }
      await admin.query(`grant ${runtime} to ${owner} with inherit true, set true`);
      await admin.query(
        `grant openbooks_read to ${runtime}, ${other} with inherit false, set true`,
      );
      await admin.query(`create database ${database} owner ${owner}`);
      await admin.query(`create database ${otherDatabase} owner ${other}`);
      await admin.query(`revoke all on database ${database}, ${otherDatabase} from public`);
      await admin.query(`grant connect, temporary on database ${database} to ${runtime}`);
      // Use the actual administrator credential, not the per-test login password.
      const provisionerUrl = new URL(adminUrl!);
      provisionerUrl.pathname = `/${database}`;
      const extensionAdmin = new pg.Client({ connectionString: provisionerUrl.toString() });
      await extensionAdmin.connect();
      try {
        await extensionAdmin.query("create extension btree_gist with schema public");
        await t.test("missing required extension refuses before schema creation", async () => {
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, config),
            /required extensions must be installed in public: pgcrypto/,
          );
          assert.equal(
            (await ownerPool.query("select to_regclass('public.orgs') as relation")).rows[0]
              .relation,
            null,
          );
        });
        await extensionAdmin.query("create extension pgcrypto with schema public");
      } finally {
        await extensionAdmin.end();
      }

      await t.test(
        "maintenance migrations refuse a constrained login before schema creation",
        async () => {
          await assert.rejects(bootstrap(), (error: unknown) =>
            /pending migrations require the database host's PostgreSQL maintenance administrator/.test(
              (error as { stderr: string }).stderr,
            ),
          );
          assert.equal(
            (await ownerPool.query("select to_regclass('public.orgs') as relation")).rows[0]
              .relation,
            null,
          );
          assert.equal(
            (await ownerPool.query("select to_regclass('public._applied_migrations') as relation"))
              .rows[0].relation,
            null,
          );
        },
      );
      await t.test(
        "host-admin installation preserves constrained business and runtime ownership",
        async () => {
          const result = await bootstrap({
            PLATFORM_ADMIN_EMAIL: "hosted@example.test",
            OPENBOOKS_MIGRATION_DB_URL: provisionerUrl.toString(),
          });
          assert.match(result.stdout, /pre-created roles verified/);
          assert.match(result.stdout, /\[bootstrap\] done/);
          await ownerPool.query("select set_config('app.bypass_rls','on',false)");
          const seeded = await ownerPool.query(
            "select (select count(*)::int from orgs) as orgs, (select count(*)::int from users where email='hosted@example.test') as admins, (select count(*)::int from _applied_migrations) as migrations",
          );
          assert.equal(seeded.rows[0].orgs, 1);
          assert.equal(seeded.rows[0].admins, 1);
          const manifest = JSON.parse(
            await readFile(join(root, "schema", "migrations", "baseline.json"), "utf8"),
          );
          assert.deepEqual(
            (
              await ownerPool.query("select sha256 from _applied_migrations where filename=$1", [
                manifest.filename,
              ])
            ).rows,
            [{ sha256: manifest.baselineSha256 }],
          );
          assert.ok(seeded.rows[0].migrations >= 1);
          // A fresh install has no other path to /platform: the seeded
          // administrator named by PLATFORM_ADMIN_EMAIL is its first platform
          // operator, and exactly that user holds the flag.
          assert.match(
            result.stdout,
            /hosted@example\.test granted platform super-admin via PLATFORM_ADMIN_EMAIL/,
          );
          assert.deepEqual(
            (await ownerPool.query("select email from users where is_super_admin and is_active"))
              .rows,
            [{ email: "hosted@example.test" }],
          );
          const grantAudit = await ownerPool.query(
            "select action, actor_id, row_id, changes from audit_log where table_name='users'",
          );
          assert.equal(grantAudit.rows.length, 1);
          assert.equal(grantAudit.rows[0].action, "update");
          assert.match(String(grantAudit.rows[0].changes.reason), /PLATFORM_ADMIN_EMAIL/);
          assert.equal(grantAudit.rows[0].changes.before.is_super_admin, false);
          assert.equal(grantAudit.rows[0].changes.after.is_super_admin, true);
          const ownerOnly = await ownerPool.query(
            "select pg_get_userbyid(relowner) as owner from pg_class where oid='public.orgs'::regclass",
          );
          assert.equal(ownerOnly.rows[0].owner, owner);
          assert.deepEqual((await runtimePool.query("select id from orgs")).rows, []);
          await assert.rejects(
            runtimePool.query("alter table public.orgs disable row level security"),
            { code: "42501" },
          );
          await assert.rejects(runtimePool.query(`set role ${owner}`), { code: "42501" });
        },
      );
      await t.test("bootstrap retry preserves migration digests and seed identities", async () => {
        const before = await ownerPool.query(
          "select filename, sha256, applied_at from _applied_migrations order by filename",
        );
        const orgs = await ownerPool.query("select id from orgs order by id");
        // A different address on a retry is NOT promoted: an operator already
        // exists, so the console governs grants from here.
        const retry = await bootstrap({
          ADMIN_EMAIL: "second@example.test",
          PLATFORM_ADMIN_EMAIL: "second@example.test",
        });
        assert.doesNotMatch(retry.stdout, /granted platform super-admin/);
        assert.deepEqual(
          (
            await ownerPool.query(
              "select email from users where is_super_admin and is_active order by email",
            )
          ).rows,
          [{ email: "hosted@example.test" }],
        );
        assert.deepEqual(
          (
            await ownerPool.query(
              "select email, is_super_admin from users where email='second@example.test'",
            )
          ).rows,
          [{ email: "second@example.test", is_super_admin: false }],
        );
        assert.deepEqual(
          (
            await ownerPool.query(
              "select filename, sha256, applied_at from _applied_migrations order by filename",
            )
          ).rows,
          before.rows,
        );
        assert.deepEqual(
          (await ownerPool.query("select id from orgs order by id")).rows,
          orgs.rows,
        );
      });
      const firstForward = await nextForwardMigration(1, "forward_owner_probe");
      const firstBody =
        "CREATE FUNCTION public.forward_owner_probe() RETURNS integer LANGUAGE sql STABLE AS 'select 1';";
      await t.test(
        "an existing installation applies a pending forward migration with the constrained owner",
        async () => {
          const before = await ownerPool.query(
            "select filename, sha256, applied_at from _applied_migrations order by filename",
          );
          const tree = await forwardMigrationTree({ [firstForward]: firstBody });
          trees.push(tree);
          await bootstrap({}, tree);
          const probe = await ownerPool.query(
            "select proowner::regrole::text as owner from pg_proc where oid='public.forward_owner_probe()'::regprocedure",
          );
          assert.equal(probe.rows[0].owner, owner);
          const recorded = await ownerPool.query(
            "select sha256 from _applied_migrations where filename=$1",
            [`generated/${firstForward}`],
          );
          assert.equal(recorded.rowCount, 1);
          assert.deepEqual(
            (
              await ownerPool.query(
                "select filename, sha256, applied_at from _applied_migrations where filename <> $1 order by filename",
                [`generated/${firstForward}`],
              )
            ).rows,
            before.rows,
          );
        },
      );
      await t.test(
        "maintenance upgrades retain the established restricted business owner",
        async () => {
          const secondForward = await nextForwardMigration(2, "forward_maintenance_probe");
          const before = await ownerPool.query(
            "select filename,sha256,applied_at from _applied_migrations order by filename",
          );
          const tree = await forwardMigrationTree({
            [firstForward]: firstBody,
            [secondForward]:
              "CREATE FUNCTION public.forward_maintenance_probe() RETURNS integer LANGUAGE sql STABLE AS 'select 2';",
          });
          trees.push(tree);
          await bootstrap(
            {
              OPENBOOKS_PRECREATED_ROLES: "0",
              OPENBOOKS_MIGRATION_DB_URL: provisionerUrl.toString(),
            },
            tree,
          );
          const authority = await ownerPool.query(
            "select proowner::regrole::text as owner from pg_proc where oid='public.forward_maintenance_probe()'::regprocedure",
          );
          assert.equal(authority.rows[0].owner, owner);
          assert.equal(
            (
              await ownerPool.query(
                "select count(*)::int as n from _applied_migrations where filename=$1",
                [`generated/${secondForward}`],
              )
            ).rows[0].n,
            1,
          );
          assert.deepEqual(
            (
              await ownerPool.query(
                "select filename,sha256,applied_at from _applied_migrations where filename<>$1 order by filename",
                [`generated/${secondForward}`],
              )
            ).rows,
            before.rows,
          );
        },
      );
      await t.test(
        "effective PUBLIC leaks and missing governed-view grants are refused",
        async () => {
          await ownerPool.query("grant select on public.orgs to public");
          try {
            await assert.rejects(
              verifyPrecreatedObjectAccess(ownerPool, config),
              /outside the governed read-only surface: public.orgs/,
            );
          } finally {
            await ownerPool.query("revoke select on public.orgs from public");
          }
          await ownerPool.query(
            "revoke select on openbooks_query.accounting_books from openbooks_read",
          );
          try {
            await assert.rejects(
              verifyPrecreatedObjectAccess(ownerPool, config),
              /object grants are incomplete: openbooks_query.accounting_books/,
            );
          } finally {
            await ownerPool.query(
              "grant select on openbooks_query.accounting_books to openbooks_read",
            );
          }
        },
      );
      await t.test(
        "sharing the query role does not grant access to another installation's database",
        async () => {
          for (const [role, target] of [
            [runtime, otherDatabase],
            [other, database],
          ] as const) {
            const client = new pg.Client({ connectionString: url(role, target) });
            try {
              await assert.rejects(client.connect(), { code: "42501" });
            } finally {
              await client.end();
            }
          }
        },
      );
      await t.test("PUBLIC database access and runtime schema CREATE are refused", async () => {
        await admin.query(`grant connect on database ${database} to public`);
        try {
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, config),
            /revoke database CONNECT\/CREATE from PUBLIC/,
          );
        } finally {
          await admin.query(`revoke connect on database ${database} from public`);
        }
        await ownerPool.query(`grant create on schema public to ${runtime}`);
        try {
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, config),
            /must not own application objects.*CREATE privileges/,
          );
        } finally {
          await ownerPool.query(`revoke create on schema public from ${runtime}`);
        }
      });
      await t.test(
        "missing and SET FALSE read memberships refuse bootstrap, and failed probes leave a reusable connection",
        async () => {
          await admin.query(`grant openbooks_read to ${runtime} with inherit true, set false`);
          await assert.rejects(
            verifyReadRoleAssumption(runtimePool, runtime),
            /cannot SET ROLE openbooks_read.*membership must permit SET ROLE/,
          );
          assert.equal(
            (await runtimePool.query("select current_user as name")).rows[0].name,
            runtime,
          );
          await assert.rejects(bootstrap(), (error: unknown) =>
            /cannot SET ROLE openbooks_read/.test((error as { stderr: string }).stderr),
          );
          await admin.query(`revoke openbooks_read from ${runtime}`);
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, config),
            /cannot SET ROLE openbooks_read/,
          );
          await admin.query(`grant openbooks_read to ${runtime} with inherit false, set true`);
        },
      );
      await t.test(
        "unsafe runtime attributes, missing login, and missing owner inheritance refuse by name",
        async () => {
          await admin.query(`alter role ${runtime} bypassrls`);
          await assert.rejects(verifyPrecreatedRoles(ownerPool, config), /unsafe role privileges/);
          await admin.query(`alter role ${runtime} nobypassrls`);
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, { ...config, roleName: `missing_${suffix}` }),
            /must exist with LOGIN/,
          );
          await admin.query(`grant ${runtime} to ${owner} with inherit false, set true`);
          await assert.rejects(
            verifyPrecreatedRoles(ownerPool, config),
            /must inherit runtime role/,
          );
          await admin.query(`grant ${runtime} to ${owner} with inherit true, set true`);
        },
      );
      await t.test("same-login configuration fails before migration work", async () => {
        await assert.rejects(
          bootstrap({ OPENBOOKS_RUNTIME_DB_URL: url(owner) }),
          (error: unknown) =>
            /separate migration-owner and runtime logins/.test(
              (error as { stderr: string }).stderr,
            ),
        );
      });
      await t.test(
        "automatic provisioning still installs a fresh database with the flag disabled",
        async () => {
          await admin.query(`create database ${managedDatabase}`);
          const migration = new URL(adminUrl!);
          migration.pathname = `/${managedDatabase}`;
          const result = await bootstrap({
            OPENBOOKS_PRECREATED_ROLES: "0",
            OPENBOOKS_MIGRATION_DB_URL: migration.toString(),
            OPENBOOKS_RUNTIME_DB_URL: url(managedRole, managedDatabase),
          });
          assert.match(result.stdout, /\[bootstrap\] done/);
          // Without PLATFORM_ADMIN_EMAIL a fresh install grants no one: today's
          // behaviour is preserved and the console remains unreachable until an
          // operator is granted through it.
          assert.doesNotMatch(result.stdout, /granted platform super-admin/);
          const managedPool = new pg.Pool({ connectionString: migration.toString(), max: 1 });
          try {
            await managedPool.query("select set_config('app.bypass_rls','on',false)");
            assert.deepEqual(
              (
                await managedPool.query(
                  "select email from users where is_super_admin and is_active",
                )
              ).rows,
              [],
            );
            // Naming a user that does not exist refuses by name with the remedy
            // instead of granting no one, and the refused run grants nothing.
            await assert.rejects(
              bootstrap({
                OPENBOOKS_PRECREATED_ROLES: "0",
                OPENBOOKS_MIGRATION_DB_URL: migration.toString(),
                OPENBOOKS_RUNTIME_DB_URL: url(managedRole, managedDatabase),
                PLATFORM_ADMIN_EMAIL: "ghost@example.test",
              }),
              (error: unknown) =>
                /PLATFORM_ADMIN_EMAIL names ghost@example\.test.*does not exist.*ADMIN_EMAIL/.test(
                  (error as { stderr: string }).stderr,
                ),
            );
            assert.deepEqual(
              (
                await managedPool.query(
                  "select email from users where is_super_admin and is_active",
                )
              ).rows,
              [],
            );
          } finally {
            await managedPool.end();
          }
          const login = await admin.query(
            "select rolcanlogin, rolsuper, rolcreaterole, rolbypassrls from pg_roles where rolname=$1",
            [managedRole],
          );
          assert.deepEqual(login.rows, [
            { rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolbypassrls: false },
          ]);
        },
      );
    } finally {
      for (const tree of trees) await rm(tree, { recursive: true, force: true });
      await ownerPool.end();
      await runtimePool.end();
      // Only uniquely named resources created above are removed, even on refusal.
      await admin.query(`drop database if exists ${database} with (force)`);
      await admin.query(`drop database if exists ${otherDatabase} with (force)`);
      await admin.query(`drop database if exists ${managedDatabase} with (force)`);
      for (const role of [owner, runtime, other, managedRole])
        await admin.query(`drop role if exists ${role}`);
      await admin.end();
    }
  },
);
