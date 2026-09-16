import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";

/**
 * Migration 0158 (source reconciliation evidence): mirrored journal lines
 * carry the source system's cleared stamp, reconciliations distinguish
 * statement evidence from source evidence, and per-account source state has
 * a home. The trigger carve-outs keep posted-history immutability while
 * admitting append-only evidence stamps.
 */

/** Drizzle wraps Postgres failures; the guard's text lives down the cause chain. */
function isGuardRefusal(error: unknown, pattern: RegExp): boolean {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    const message = (current as { message?: string }).message;
    if (message && pattern.test(message)) return true;
  }
  return false;
}
test("0158: source-evidence columns, checks, and append-only stamps", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const cols = (await db.execute<{ table: string; column: string }>(sql`
    select table_name as table, column_name as column
      from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'journal_lines' and column_name in ('source_cleared_date', 'source_cleared_connector'))
         or (table_name = 'reconciliations' and column_name in ('evidence_kind', 'evidence_connector'))
         or (table_name = 'source_reconciliation_state'))
  `));
  const have = new Set(cols.rows.map((r) => `${r.table}.${r.column}`));
  for (const key of [
    "journal_lines.source_cleared_date",
    "journal_lines.source_cleared_connector",
    "reconciliations.evidence_kind",
    "reconciliations.evidence_connector",
  ]) {
    assert.ok(have.has(key), `0158 adds ${key}`);
  }
  assert.ok(
    cols.rows.some((r) => r.table === "source_reconciliation_state"),
    "0158 adds source_reconciliation_state",
  );

  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Evidence reviewer", "admin");
    // New reconciliations default to statement evidence; source rows must name a connector.
    const stmt = (await db.execute<{ evidence_kind: string; evidence_connector: string | null }>(sql`
      insert into reconciliations (org_id, account_id, through_date, currency, statement_balance, status, created_by)
      values (${org.orgId}, ${org.accounts.bank}, ${org.date}, 'CAD', 0, 'in_progress', ${actor})
      returning evidence_kind, evidence_connector
    `)).rows[0]!;
    assert.equal(stmt.evidence_kind, "statement");
    assert.equal(stmt.evidence_connector, null);
    await assert.rejects(
      db.execute(sql`
        insert into reconciliations (org_id, account_id, through_date, currency, statement_balance, status, created_by, evidence_kind, evidence_connector)
        values (${org.orgId}, ${org.accounts.bank}, ${org.date}, 'CAD', 0, 'in_progress', ${actor}, 'source', null)`),
      (e: unknown) => isGuardRefusal(e, /reconciliations_source_evidence/),
    );
    await assert.rejects(
      db.execute(sql`
        insert into reconciliations (org_id, account_id, through_date, currency, statement_balance, status, created_by, evidence_kind)
        values (${org.orgId}, ${org.accounts.bank}, ${org.date}, 'CAD', 0, 'in_progress', ${actor}, 'carrier-pigeon')`),
      (e: unknown) => isGuardRefusal(e, /reconciliations_evidence_kind/),
    );

    // A posted line accepts the source stamp once and never lets it move.
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${`EV-${entryId.slice(0, 8)}`}, ${org.date}, ${org.periodId}, 'evidence stamp', 'draft', 'manual', ${actor}, ${actor})`);
    const lineId = randomUUID();
    await db.execute(sql`
      insert into journal_lines
        (id, org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${lineId}, ${org.orgId}, ${entryId}, 1, ${org.accounts.bank}, ${org.subsidiaryId}, 100, 'CAD', 100, 1),
             (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.adjustment}, ${org.subsidiaryId}, -100, 'CAD', -100, 1)`);
    await db.execute(sql`update journal_entries set status = 'posted' where id = ${entryId} and org_id = ${org.orgId}`);
    await db.execute(sql`
      update journal_lines
         set source_cleared_date = ${org.date}, source_cleared_connector = 'test-connector'
       where id = ${lineId} and org_id = ${org.orgId}`);
    const stamped = (await db.execute<{ d: string; c: string }>(sql`
      select source_cleared_date::text as d, source_cleared_connector as c
        from journal_lines where id = ${lineId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(stamped.d, org.date);
    assert.equal(stamped.c, "test-connector");
    // Clearing, retargeting, or touching money alongside the stamp is forbidden.
    await assert.rejects(
      db.execute(sql`update journal_lines set source_cleared_date = null, source_cleared_connector = null where id = ${lineId} and org_id = ${org.orgId}`),
      (e: unknown) => isGuardRefusal(e, /append-only|immutable/),
    );
    await assert.rejects(
      db.execute(sql`update journal_lines set source_cleared_connector = 'other-connector' where id = ${lineId} and org_id = ${org.orgId}`),
      (e: unknown) => isGuardRefusal(e, /append-only|immutable/),
    );
    await assert.rejects(
      db.execute(sql`update journal_lines set amount = 200, source_cleared_date = ${org.date} where id = ${lineId} and org_id = ${org.orgId}`),
      (e: unknown) => isGuardRefusal(e, /immutable/),
    );
    // Half-stamps violate the column check without reaching the trigger.
    const line2 = (await db.execute<{ id: string }>(sql`
      select id from journal_lines where entry_id = ${entryId} and org_id = ${org.orgId} and line_number = 2`)).rows[0]!.id;
    await assert.rejects(
      db.execute(sql`update journal_lines set source_cleared_date = ${org.date} where id = ${line2} and org_id = ${org.orgId}`),
      // The row trigger fires before the column check, so a half-stamp through
      // UPDATE surfaces as append-only; the check still guards direct inserts.
      (e: unknown) => isGuardRefusal(e, /append-only|journal_lines_source_cleared_evidence/),
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
