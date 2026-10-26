import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting, orgRowCounts } from "./fixtures.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps driver errors (DrizzleQueryError), hiding the PostgreSQL
 * message in `cause`; match the whole rendered chain so a trigger rejection
 * stays assertable. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  return `${String(error)}\n${cause === undefined ? "" : String(cause)}`;
}

async function functionDefinition(signature: string): Promise<string> {
  const [row] = await db.execute<{ definition: string }>(
    sql`select pg_get_functiondef(${signature}::regprocedure) as definition`,
    "objects",
  );
  assert.ok(row, `${signature} is installed`);
  return row.definition;
}

test(
  "immutability guards admit a sandbox wipe only through the authorized org check",
  { skip: !DB },
  async () => {
    // A raw session GUC is settable by any connection; only the
    // org-scoped authorization function may open the wipe path.
    const names = [
      "prebill_event_append_only_guard",
      "depreciation_evidence_attachment_guard",
      "inventory_provisional_immutable",
      "openbooks_guard_depreciation_evidence",
      "je_guard",
      "openbooks_gl_activity_entry",
      "openbooks_gl_activity_line",
      "openbooks_party_payment_stats",
      "openbooks_open_item_balances_application",
      "openbooks_open_item_balances_line",
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
      const definition = await functionDefinition(`public.${name}()`);
      assert.doesNotMatch(definition, /current_setting\([^)]*sandbox_wipe/i, name);
      assert.match(definition, /openbooks_sandbox_wipe_allowed/i, name);
    }
    // Derivation and totals functions carry no wipe path at all.
    for (const signature of [
      "public.openbooks_je_cascade_posting_date()",
      "public.assert_document_totals_match_lines(uuid, uuid)",
      "public.refresh_document_totals_from_lines(uuid, uuid)",
    ]) {
      assert.doesNotMatch(
        await functionDefinition(signature),
        /sandbox_wipe|current_setting\(/i,
        signature,
      );
    }
  },
);

test(
  "a raw wipe GUC cannot rewrite posted ledger state, while an authorized sandbox delete can",
  { skip: !DB },
  async () => {
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

      // No amend escape exists: even the wipe+amend combination cannot move
      // a posted entry's date. Corrections
      // reverse and repost; history is never edited in place.
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
          await tx.execute(sql`select set_config('openbooks.amend', 'on', true)`);
          await tx.execute(sql`
          update journal_entries set posting_date = '2026-08-01'
           where id = ${entryId} and org_id = ${org.orgId}`);
        }),
        (error: unknown) => pgMessage(error).includes("posted and immutable"),
      );

      await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${org.orgId}`);
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('openbooks.sandbox_wipe', 'on', true)`);
        await tx.execute(
          sql`delete from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId}`,
        );
        await tx.execute(
          sql`delete from journal_entries where org_id = ${org.orgId} and id = ${entryId}`,
        );
      });
      const deleted = await db.execute<{ entries: number; lines: number }>(sql`
      select
        (select count(*)::int from journal_entries where org_id = ${org.orgId} and id = ${entryId}) as entries,
        (select count(*)::int from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId}) as lines`);
      assert.equal(Number(deleted.rows[0]!.entries), 0);
      assert.equal(Number(deleted.rows[0]!.lines), 0);
    } finally {
      await db
        .execute(sql`update orgs set env_kind = 'production' where id = ${org.orgId}`)
        .catch(() => undefined);
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

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
      insert into prebills
        (id, org_id, project_id, worksheet_number, period_end)
      values
        (${prebillId}, ${org.orgId}, ${projectId}, 'WIP-WIPE-1', ${org.date})`);
    await db.execute(sql`
      insert into prebill_events
        (id, org_id, prebill_id, event_type, actor_id)
      values
        (${eventId}, ${org.orgId}, ${prebillId}, 'created', ${randomUUID()})`);

    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.sandbox_wipe', 'on', true)`);
        await tx.execute(sql`
          delete from prebill_events
           where org_id = ${org.orgId} and id = ${eventId}`);
      }),
      (error: unknown) => /pre.?bill events are append-only/i.test(pgMessage(error)),
    );
    const preserved = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from prebill_events
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
        from prebill_events
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
