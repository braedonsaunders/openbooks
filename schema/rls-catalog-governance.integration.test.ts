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

test("every org_id table is tenant-isolated at the catalog level", { skip: !DB }, async () => {
  const [{ db }] = await Promise.all([import("../engine/src/platform/db.ts")]);
  const violations = await catalogViolations(db);
  assert.deepEqual(
    violations,
    [],
    `org-scoped tables without ENABLEd + FORCEd RLS and a policy (add RLS or document the platform reason in RLS_EXEMPT): ${violations.join(", ")}`,
  );
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
