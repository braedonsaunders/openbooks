/// <reference types="node" />

/**
 * Behavioral coverage for 0334 section 1 (G1/G2/G3) and the tenant-isolation
 * catalog invariant it establishes.
 *
 * 0026 gave scheduler_outbox_terminal_audit FORCE ROW LEVEL SECURITY plus an
 * org_isolation policy but never ENABLEd RLS; 0153 did the same for
 * ai_work_item_notes; 0281 created hrm_exit_record_events with no RLS at
 * all. On a scratch install from the migration chain alone, a tenant
 * session read and wrote every organization's rows on all three. The
 * bootstrap environments.sql backstop masked this on managed installs, so
 * these tests prove the property against the live catalog and the live
 * isolation behavior, never against migration text:
 *
 * - the derived catalog test fails if ANY public table carrying org_id
 *   lacks ENABLEd + FORCEd RLS or carries no policy, unless it is on the
 *   reviewed exemption list below (platform tables, one reason each);
 * - the derived index test fails if ANY public table carrying org_id lacks
 *   a usable index led by org_id: every RLS predicate compares org_id to
 *   the current tenant, so a table without one scans on every tenant read;
 * - the org-less catalog test fails if ANY public table WITHOUT org_id is
 *   neither on the reviewed global allowlist below (one reason each) nor
 *   carrying FORCEd RLS with a policy that references a parent table's
 *   org_id (the file_versions / file_blobs / tax_group_members shape);
 * - the negative control proves that test fires, by creating an unwired
 *   org-scoped table inside a rolled-back transaction and showing the same
 *   query names it;
 * - the behavioral test plants rows for two scratch orgs (plus a NULL-org
 *   scheduler row, the platform-only crash-recovery shape) and proves a
 *   tenant session sees exactly its own rows while the NULL-org row stays
 *   invisible to every tenant and visible to bypass.
 *
 * Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

type EngineDb = typeof import("../engine/src/platform/db.ts");

/**
 * Org-scoped tables deliberately outside the ENABLE + FORCE + policy
 * requirement, with the reason each is exempt. The bar is high: an entry
 * here must name a mechanism OTHER than the org_isolation policy that keeps
 * tenant data apart. Empty today — every org_id table, including the
 * bootstrap-excluded sandboxes (bespoke sandbox_isolation policy) and
 * user_org_access (baseline org_isolation policy), carries RLS + FORCE +
 * at least one policy.
 */
const RLS_EXEMPT: Record<string, string> = {};

/**
 * Public base tables without org_id that are deliberately global: no tenant
 * rows exist, so an org_isolation policy could never match. The bar matches
 * RLS_EXEMPT — each entry names the structural fact that keeps tenant data
 * apart, never just "shared". Exact names only, so a new org-less table
 * fails closed until it is listed here with a reason or carries a
 * parent-scoped policy. Child tables that isolate through a parent (EXISTS
 * (SELECT 1 FROM parent WHERE parent.org_id = ...)) are NOT listed here;
 * the query below accepts them by reading their policy definition.
 */
const GLOBAL_ALLOWLIST: Record<string, string> = {
  _applied_migrations:
    "migration-runner ledger of filenames and hashes; no tenant data, read before any tenant scope exists",
  app_listings:
    "marketplace catalog read across orgs by design with no org filter; publisher tracked via publisher_org_id, not org_id",
  auth_login_challenges:
    "pre-authentication login state keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_login_events:
    "pre-authentication login audit keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_login_state:
    "pre-authentication login state keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_mfa_factors:
    "pre-authentication MFA state keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_oidc_identities:
    "pre-authentication identity links keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_password_resets:
    "pre-authentication reset state keyed by user_id, reached before app.current_org is set so no org policy could match",
  auth_rate_limit_buckets:
    "pre-authentication throttling counters keyed by bucket key, reached before app.current_org is set so no org policy could match",
  auth_sessions:
    "pre-authentication session state keyed by user_id, reached before app.current_org is set so no org policy could match",
  currencies:
    "shared ISO reference data identical for every org; no tenant rows",
  openbooks_document_close_modules:
    "schema registry mapping each document kind to its period-close module; written only by migrations, identical for every org, no tenant data",
  openbooks_query_catalog_relations:
    "schema registry of the relations the governed query console may expose; written only by migrations, identical for every org, no tenant data",
  openbooks_testdb_meta:
    "local test-database stamp written by scripts/testdb.sh (schema fingerprint, copy time); present only in developer test databases, never in an installation",
  orgs: "the root tenant table itself; isolated by org_root_isolation matching id/sandbox_of to the session org",
  platform_settings:
    "installation-owned singleton with bypass-only RLS, deliberately org-less so per-org backup, clone, and teardown skip it",
  sftp_daemon:
    "installation-owned daemon config (port, host key); per-tenant SFTP servers live in the org-scoped sftp_servers table",
};

/**
 * Every public base table without an org_id column, minus the global
 * allowlist above, must carry ENABLEd + FORCEd RLS with at least one policy
 * whose definition references a parent table's org_id. Anything returned is
 * a table whose rows no tenant boundary constrains.
 */
async function orgLessViolations(db: EngineDb["db"]): Promise<string[]> {
  const rows = (await db.execute<{ tbl: string }>(sql`
    with base as (
      select c.relname as tbl, c.relrowsecurity as rls,
             c.relforcerowsecurity as force
        from pg_class c
        join pg_namespace nsp on nsp.oid = c.relnamespace
       where nsp.nspname = 'public' and c.relkind = 'r'
         and not exists (
           select 1 from pg_attribute a
            where a.attrelid = c.oid
              and a.attname = 'org_id'
              and not a.attisdropped
         )
    )
    select tbl from base
     where not (
       rls and force and exists (
         select 1 from pg_policies p
          where p.schemaname = 'public'
            and p.tablename = base.tbl
            and (coalesce(p.qual, '') ilike '%org_id%'
              or coalesce(p.with_check, '') ilike '%org_id%')
       )
     )
     order by 1
  `)).rows;
  return rows.map((row) => row.tbl).filter((tbl) => !(tbl in GLOBAL_ALLOWLIST));
}

async function catalogViolations(db: EngineDb["db"]): Promise<string[]> {
  const rows = (await db.execute<{ tbl: string }>(sql`
    with t as (
      select c.relname as tbl, c.relrowsecurity as rls,
             c.relforcerowsecurity as force, count(pol.oid) as npol
        from pg_class c
        join pg_namespace nsp on nsp.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
                           and a.attname = 'org_id'
                           and not a.attisdropped
        left join pg_policy pol on pol.polrelid = c.oid
       where nsp.nspname = 'public' and c.relkind = 'r'
       group by 1, 2, 3
    )
    select tbl from t where not (rls and force and npol > 0) order by 1
  `)).rows;
  return rows.map((row) => row.tbl).filter((tbl) => !(tbl in RLS_EXEMPT));
}

/**
 * Org-scoped tables with no usable index led by org_id. An index counts
 * only when its first key column IS org_id and it is valid: a UNIQUE or
 * composite index starting with org_id serves the RLS equality probe, but
 * an INVALID one left behind by a failed CONCURRENTLY build answers no
 * query, so it must not satisfy this test.
 */
async function leadingOrgIndexViolations(db: EngineDb["db"]): Promise<string[]> {
  const rows = (await db.execute<{ tbl: string }>(sql`
    with org_tables as (
      select c.oid, c.relname as tbl,
             (select a.attnum
                from pg_attribute a
               where a.attrelid = c.oid
                 and a.attname = 'org_id'
                 and not a.attisdropped) as org_attnum
        from pg_class c
        join pg_namespace nsp on nsp.oid = c.relnamespace
       where nsp.nspname = 'public' and c.relkind = 'r'
    )
    select tbl from org_tables o
     where o.org_attnum is not null
       and not exists (
         select 1 from pg_index i
          where i.indrelid = o.oid
            and i.indisvalid
            and i.indkey[0] = o.org_attnum
       )
     order by 1
  `)).rows;
  return rows.map((row) => row.tbl);
}

test("every org_id table carries a usable index led by org_id", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const violations = await leadingOrgIndexViolations(db);
  assert.deepEqual(
    violations,
    [],
    `org-scoped tables with no usable index led by org_id (add one per table: create index concurrently if not exists <table>_org_id_idx on <table> (org_id)): ${violations.join(", ")}`,
  );
});

test("the leading-index test fires and clears with the index", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const table = `org_idx_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await db.execute(sql`create table public.${sql.raw(table)} (id uuid, org_id uuid)`);
  try {
    await db.execute(sql`create index on public.${sql.raw(table)} (id)`);
    const flagged = await leadingOrgIndexViolations(db);
    assert.ok(
      flagged.includes(table),
      `an org_id table whose only index starts elsewhere must be reported, got: ${flagged.join(", ")}`,
    );
    await db.execute(sql`create index on public.${sql.raw(table)} (org_id)`);
    const cleared = await leadingOrgIndexViolations(db);
    assert.ok(
      !cleared.includes(table),
      `an org_id table with a leading org_id index must clear, still reported: ${cleared.join(", ")}`,
    );
  } finally {
    await db.execute(sql`drop table public.${sql.raw(table)}`);
  }
});

test("every org_id table is tenant-isolated at the catalog level", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const violations = await catalogViolations(db);
  assert.deepEqual(
    violations,
    [],
    `org-scoped tables without ENABLEd + FORCEd RLS and a policy (add RLS or document the platform reason in RLS_EXEMPT): ${violations.join(", ")}`,
  );
});

test("every org-less table is globally justified or parent-isolated", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const violations = await orgLessViolations(db);
  assert.deepEqual(
    violations,
    [],
    `tables without org_id that are neither allowlisted nor parent-isolated (add ENABLEd + FORCEd RLS with a policy referencing a parent table's org_id, or document the global reason in GLOBAL_ALLOWLIST): ${violations.join(", ")}`,
  );
});

test("the org-less test fires on an unwired table without org_id", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const table = `t18_rls_orgless_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await db.execute(sql`create table public.${sql.raw(table)} (id uuid)`);
  try {
    const violations = await orgLessViolations(db);
    assert.ok(
      violations.includes(table),
      `a table without org_id and without RLS must be reported, got: ${violations.join(", ")}`,
    );
  } finally {
    await db.execute(sql`drop table public.${sql.raw(table)}`);
  }
});

test("the org-less test passes a parent-scoped child table", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const table = `t18_rls_child_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await db.execute(sql`create table public.${sql.raw(table)} (id uuid, owner_id uuid)`);
  try {
    await db.execute(sql`alter table public.${sql.raw(table)} enable row level security`);
    await db.execute(sql`alter table only public.${sql.raw(table)} force row level security`);
    const scope = sql`exists (select 1 from users u where u.id = public.${sql.raw(table)}.owner_id and (u.org_id)::text = current_setting('app.current_org'::text, true))`;
    await db.execute(sql`create policy child_isolation on public.${sql.raw(table)} using (${scope}) with check (${scope})`);
    const violations = await orgLessViolations(db);
    assert.ok(
      !violations.includes(table),
      `a child table with FORCEd RLS and a parent org_id policy must pass, got: ${violations.join(", ")}`,
    );
  } finally {
    await db.execute(sql`drop table public.${sql.raw(table)}`);
  }
});

test("the catalog test fires on an unwired org-scoped table", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const table = `t33_rls_probe_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  await db.execute(sql`create table public.${sql.raw(table)} (id uuid, org_id uuid)`);
  try {
    const violations = await catalogViolations(db);
    assert.ok(
      violations.includes(table),
      `an org_id table with no RLS must be reported, got: ${violations.join(", ")}`,
    );
  } finally {
    await db.execute(sql`drop table public.${sql.raw(table)}`);
  }
});

test("G1/G2/G3 tables hide foreign rows and NULL-org rows from tenants", { skip: !DB }, async () => {
  const [{ db, withBypass, withOrg }, { createScratchOrg, dropScratchOrg, seedFlowActors }] =
    await Promise.all([
      import("../engine/src/platform/db.ts"),
      import("../engine/src/testing/fixtures.ts"),
    ]);
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const actorsA = await seedFlowActors(orgA.orgId);
    const actorsB = await seedFlowActors(orgB.orgId);
    const auditA = randomUUID();
    const auditB = randomUUID();
    const auditNull = randomUUID();
    // Terminal scheduler evidence for each org, plus the NULL-org
    // crash-recovery shape: insertable only under bypass (the WITH CHECK
    // refuses a NULL org_id to any scoped writer).
    await withBypass(async () => {
      for (const [orgId, id] of [[orgA.orgId, auditA], [orgB.orgId, auditB]] as const) {
        await db.execute(sql`
          insert into scheduler_outbox_terminal_audit
            (id, outbox_row_id, event, org_id, kind, occurrence_key, attempt_count, marked_by, detail)
          values (${id}, ${randomUUID()}, 'terminal_failure', ${orgId}, 'flow',
                  ${`occ-${id.slice(0, 8)}`}, 1, 'test', '{}'::jsonb)`);
      }
      await db.execute(sql`
        insert into scheduler_outbox_terminal_audit
          (id, outbox_row_id, event, org_id, kind, occurrence_key, attempt_count, marked_by, detail)
        values (${auditNull}, ${randomUUID()}, 'crash_recovery_terminal_failure', null, 'flow',
                ${`occ-${auditNull.slice(0, 8)}`}, 0, 'test', '{}'::jsonb)`);
    });
    // A scoped writer cannot plant a NULL-org row behind the check. Drizzle
    // wraps the PostgreSQL refusal, so match the whole rendered chain.
    await assert.rejects(
      withOrg(orgA.orgId, () => db.execute(sql`
        insert into scheduler_outbox_terminal_audit
          (id, outbox_row_id, event, org_id, kind, occurrence_key, attempt_count, marked_by, detail)
        values (${randomUUID()}, ${randomUUID()}, 'terminal_failure', null, 'flow',
                ${`occ-x-${auditA.slice(0, 4)}`}, 1, 'test', '{}'::jsonb)`)),
      (error: unknown) => {
        const chain: string[] = [];
        for (let cur: unknown = error; cur && typeof cur === "object"; cur = (cur as { cause?: unknown }).cause) {
          chain.push(String((cur as { message?: unknown }).message ?? ""));
        }
        assert.match(
          chain.join(" "),
          /row-level security policy/,
          "a tenant session must not insert a NULL-org scheduler row",
        );
        return true;
      },
    );

    // Agent workbench notes, one per org.
    const noteA = randomUUID();
    const noteB = randomUUID();
    await withBypass(async () => {
      for (const [orgId, userId, noteId] of [
        [orgA.orgId, actorsA.adminId, noteA],
        [orgB.orgId, actorsB.adminId, noteB],
      ] as const) {
        const itemId = randomUUID();
        await db.execute(sql`
          insert into ai_work_items (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity)
          values (${itemId}, ${orgId}, 'hygiene', 'stale', 'v1', ${`fp-${noteId.slice(0, 8)}`}, 'info')`);
        await db.execute(sql`
          insert into ai_work_item_notes (id, org_id, work_item_id, user_id, body)
          values (${noteId}, ${orgId}, ${itemId}, ${userId}, 'tenant note')`);
      }
    });

    // HRM exit-record events, one per org (employment -> exit record -> event).
    const eventA = randomUUID();
    const eventB = randomUUID();
    await withBypass(async () => {
      for (const [org, userId, eventId] of [
        [orgA, actorsA.adminId, eventA],
        [orgB, actorsB.adminId, eventB],
      ] as const) {
        const employmentId = randomUUID();
        const recordId = randomUUID();
        await db.execute(sql`
          insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id)
          values (${employmentId}, ${org.orgId}, ${org.customerId}, ${org.subsidiaryId})`);
        await db.execute(sql`
          insert into hrm_exit_records (id, org_id, employment_id, reason_kind, is_voluntary)
          values (${recordId}, ${org.orgId}, ${employmentId}, 'resignation', true)`);
        await db.execute(sql`
          insert into hrm_exit_record_events (id, org_id, exit_record_id, kind, actor_user_id, after_snapshot)
          values (${eventId}, ${org.orgId}, ${recordId}, 'recorded', ${userId}, '{}'::jsonb)`);
      }
    });

    // Tenant A sees exactly its own rows on all three tables, and never the
    // NULL-org scheduler row.
    const seenAudit = await withOrg(orgA.orgId, () =>
      db.execute<{ id: string }>(sql`select id from scheduler_outbox_terminal_audit`));
    assert.deepEqual(
      seenAudit.rows.map((row) => row.id).sort(),
      [auditA].sort(),
      "tenant A must see only its own scheduler rows, never B's or the NULL-org row",
    );
    const seenNotes = await withOrg(orgA.orgId, () =>
      db.execute<{ id: string }>(sql`select id from ai_work_item_notes`));
    assert.deepEqual(seenNotes.rows.map((row) => row.id), [noteA]);
    const seenEvents = await withOrg(orgA.orgId, () =>
      db.execute<{ id: string }>(sql`select id from hrm_exit_record_events`));
    assert.deepEqual(seenEvents.rows.map((row) => row.id), [eventA]);

    // Mirror: tenant B sees exactly its own.
    const seenAuditB = await withOrg(orgB.orgId, () =>
      db.execute<{ id: string }>(sql`select id from scheduler_outbox_terminal_audit`));
    assert.deepEqual(seenAuditB.rows.map((row) => row.id), [auditB]);

    // Platform-only: bypass sees all four scheduler rows including NULL-org.
    const seenAll = await withBypass(() =>
      db.execute<{ id: string }>(sql`select id from scheduler_outbox_terminal_audit`));
    for (const id of [auditA, auditB, auditNull]) {
      assert.ok(seenAll.rows.some((row) => row.id === id), `bypass must see scheduler row ${id}`);
    }
  } finally {
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});
