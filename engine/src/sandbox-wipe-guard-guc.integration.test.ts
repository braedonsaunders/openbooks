import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  orgRowCounts,
} from "./test-fixtures.ts";
import { createSandbox, deleteSandbox } from "./sandbox/lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

const migration = readFileSync(
  new URL(
    "../../schema/migrations/generated/0043_sandbox_wip_prebill_wipe_guard.sql",
    import.meta.url,
  ),
  "utf8",
);
const authorizationMigration = readFileSync(
  new URL(
    "../../schema/migrations/generated/0078_sandbox_wipe_guard_authorization.sql",
    import.meta.url,
  ),
  "utf8",
);

const deployedWipGuard = `
CREATE OR REPLACE FUNCTION public.wip_prebill_event_append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('openbooks.sandbox_wipe',true)='on' THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  RAISE EXCEPTION 'WIP prebill events are append-only';
END $$;
`;

test("0043 scopes the deployed WIP guard and replays safely", { skip: !DB }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(deployedWipGuard);
    const before = await client.query<{ definition: string }>(
      "select pg_get_functiondef('public.wip_prebill_event_append_only_guard()'::regprocedure) as definition",
    );
    assert.match(before.rows[0]!.definition, /current_setting\('openbooks\.sandbox_wipe'/);

    await client.query(migration);
    await client.query(migration);
    const after = await client.query<{ definition: string }>(
      "select pg_get_functiondef('public.wip_prebill_event_append_only_guard()'::regprocedure) as definition",
    );
    assert.match(after.rows[0]!.definition, /openbooks_sandbox_wipe_allowed\(old\.org_id\)/i);
    assert.doesNotMatch(after.rows[0]!.definition, /current_setting\(/);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
});

test("0078 replays and removes every raw sandbox-wipe short circuit", { skip: !DB }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(authorizationMigration);
    await client.query(authorizationMigration);
    const names = [
      "depreciation_evidence_attachment_guard",
      "inventory_provisional_immutable",
      "openbooks_guard_depreciation_evidence",
      "je_guard",
      "openbooks_gl_activity_entry",
      "openbooks_gl_activity_line",
      "openbooks_party_payment_stats",
      "posted_document_financial_guard",
      "protect_country_tax_pack_installation",
      "subscription_amendment_immutable_guard",
      "subscription_period_invoice_immutable_guard",
      "subscription_plan_version_immutable_guard",
      "subscription_version_component_immutable_guard",
      "recurring_occurrence_document_immutable_guard",
      "enforce_payment_instruction_posting_claim",
      "document_lines_total_line_refresh",
      "document_lines_total_line_tieout",
    ];
    for (const name of names) {
      const result = await client.query<{ definition: string }>(
        `select pg_get_functiondef(('public.${name}()')::regprocedure) as definition`,
      );
      assert.doesNotMatch(result.rows[0]!.definition, /current_setting\([^)]*sandbox_wipe/i);
      assert.match(result.rows[0]!.definition, /openbooks_sandbox_wipe_allowed/i);
    }
    const cascade = await client.query<{ definition: string }>(
      "select pg_get_functiondef('public.openbooks_je_cascade_posting_date()'::regprocedure) as definition",
    );
    assert.doesNotMatch(cascade.rows[0]!.definition, /sandbox_wipe|current_setting\(/i);
    for (const name of ["assert_document_totals_match_lines", "refresh_document_totals_from_lines"]) {
      const result = await client.query<{ definition: string }>(
        `select pg_get_functiondef(('public.${name}(uuid, uuid)')::regprocedure) as definition`,
      );
      assert.doesNotMatch(result.rows[0]!.definition, /sandbox_wipe|current_setting\(/i);
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
});

test("a raw wipe GUC cannot rewrite posted ledger state, while an authorized sandbox delete can", { skip: !DB }, async () => {
  const installer = await pool.connect();
  try {
    await installer.query("begin");
    await installer.query(authorizationMigration);
    await installer.query("commit");
  } finally {
    await installer.query("rollback").catch(() => undefined);
    installer.release();
  }
  const org = await createScratchOrg();
  const entryId = randomUUID();
  const lineDebitId = randomUUID();
  const lineCreditId = randomUUID();
  try {
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, entry_number, posting_date, period_id, status, subsidiary_id)
      values
        (${entryId}, ${org.orgId}, ${org.bookId}, ${`WIPE-${entryId.slice(0, 8)}`}, ${org.date},
         ${org.periodId}, 'draft', ${org.subsidiaryId})`);
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, fx_rate, subsidiary_id)
      values
        (${lineDebitId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.ar}, 10, 'CAD', 10, 1, ${org.subsidiaryId}),
        (${lineCreditId}, ${org.orgId}, ${entryId}, 2, ${org.accounts.revenue}, -10, 'CAD', -10, 1, ${org.subsidiaryId})`);
    await db.execute(sql`
      update journal_entries set status = 'posted', posted_at = now()
       where id = ${entryId} and org_id = ${org.orgId}`);

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
        await tx.execute(sql`
          update journal_entries set memo = 'raw-guc-must-not-bypass'
           where id = ${entryId} and org_id = ${org.orgId}`);
      }),
      (error: unknown) => pgMessage(error).includes("posted and immutable"),
    );

    const before = await db.execute<{ month: string; debit_total: string; credit_total: string }>(sql`
      select month::text, debit_total::text, credit_total::text
        from gl_month_activity
       where org_id = ${org.orgId} and account_id = ${org.accounts.ar}
       order by month`);
    assert.deepEqual(before.rows.map((row) => row.month), ["2026-07-01"]);

    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
      await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`);
      await tx.execute(sql`
        update journal_entries set posting_date = '2026-08-01'
         where id = ${entryId} and org_id = ${org.orgId}`);
    });
    const cascaded = await db.execute<{ posting_date: string }>(sql`
      select posting_date::text from journal_lines where id = ${lineDebitId}`);
    assert.equal(cascaded.rows[0]!.posting_date, "2026-08-01");
    const after = await db.execute<{ month: string; debit_total: string; line_count: string }>(sql`
      select month::text, debit_total::text, line_count::text
        from gl_month_activity
       where org_id = ${org.orgId} and account_id = ${org.accounts.ar}
       order by month`);
    assert.deepEqual(after.rows.map((row) => row.month), ["2026-07-01", "2026-08-01"]);
    assert.equal(Number(after.rows[0]!.debit_total), 0);
    assert.equal(Number(after.rows[0]!.line_count), 0);
    assert.equal(after.rows[1]!.debit_total, before.rows[0]!.debit_total);

    await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${org.orgId}`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
      await tx.execute(sql`delete from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId}`);
      await tx.execute(sql`delete from journal_entries where org_id = ${org.orgId} and id = ${entryId}`);
    });
    const deleted = await db.execute<{ entries: number; lines: number }>(sql`
      select
        (select count(*)::int from journal_entries where org_id = ${org.orgId} and id = ${entryId}) as entries,
        (select count(*)::int from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId}) as lines`);
    assert.equal(Number(deleted.rows[0]!.entries), 0);
    assert.equal(Number(deleted.rows[0]!.lines), 0);
  } finally {
    await db.execute(sql`update orgs set env_kind = 'production' where id = ${org.orgId}`).catch(() => undefined);
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a fresh-schema sandbox wipe fully clears WIP pre-bill events", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const sandboxName = `WIP wipe ${randomUUID()}`;
  let sandboxId: string | null = null;
  let sandboxOrgId: string | null = null;
  try {
    const projectId = randomUUID();
    const prebillId = randomUUID();
    const eventId = randomUUID();
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values
        (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'WIP-WIPE',
         'WIP wipe regression', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into wip_prebills
        (id, org_id, project_id, worksheet_number, period_end)
      values
        (${prebillId}, ${org.orgId}, ${projectId}, 'WIP-WIPE-1', ${org.date})`);
    await db.execute(sql`
      insert into wip_prebill_events
        (id, org_id, prebill_id, event_type, actor_id)
      values
        (${eventId}, ${org.orgId}, ${prebillId}, 'created', ${randomUUID()})`);

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.sandbox_wipe', 'on', true)`);
        await tx.execute(sql`
          delete from wip_prebill_events
           where org_id = ${org.orgId} and id = ${eventId}`);
      }),
      (error: unknown) => pgMessage(error).includes("WIP prebill events are append-only"),
    );
    const preserved = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from wip_prebill_events
       where org_id = ${org.orgId} and id = ${eventId}`);
    assert.equal(Number(preserved.rows[0]!.count), 1);

    const sandbox = await createSandbox({
      productionOrgId: org.orgId,
      name: sandboxName,
      tier: "full",
      masked: false,
    });
    sandboxId = sandbox.sandboxId;
    sandboxOrgId = sandbox.sandboxOrgId;
    const planted = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from wip_prebill_events
       where org_id = ${sandboxOrgId}`);
    assert.equal(Number(planted.rows[0]!.count), 1);

    await deleteSandbox(sandboxId);
    sandboxId = null;
    assert.deepEqual(await orgRowCounts(sandboxOrgId), {});
  } finally {
    if (sandboxId) {
      await deleteSandbox(sandboxId).catch(() => undefined);
    } else {
      const failed = await db.execute<{ id: string }>(sql`
        select id
          from sandboxes
         where production_org_id = ${org.orgId} and name = ${sandboxName}`);
      for (const row of failed.rows) await deleteSandbox(row.id).catch(() => undefined);
    }
    await dropScratchOrgReporting(org.orgId);
  }
});
