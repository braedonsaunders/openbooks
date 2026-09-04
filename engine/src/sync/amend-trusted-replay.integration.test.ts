/**
 * Rebuilding an approved document's lines needs BOTH trusted-replay settings,
 * held in ONE transaction.
 *
 * document_line_immutability (0034) blocks editing the lines of a document that
 * is not draft, with one carve-out: a caller holding `openbooks.migration` AND
 * `openbooks.amend` together. Either alone is deliberately not an edit bypass.
 *
 * The importer's rebuild path set only `amend`, and set it with a bare pool
 * statement rather than inside a transaction — where `set local` lasts just for
 * its own implicit transaction and is gone before the next statement runs. Both
 * mistakes are invisible in isolation and identical in effect: the delete hits
 * the guard and the document is lost for that run.
 *
 * These cases pin the guard's actual contract, so a future rebuild path cannot
 * quietly reintroduce either half.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, type ScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

let org: ScratchOrg | null = null;
async function ctx(): Promise<ScratchOrg> {
  if (!org) org = await createScratchOrg();
  return org;
}

/** An APPROVED document with one line — the state the rebuild path repairs. */
async function approvedWithLine(o: ScratchOrg): Promise<string> {
  const id = randomUUID();
  const actor = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, party_id,
                             document_date, currency, subtotal, tax_total, total, created_by)
      values (${id}, ${o.orgId}, 'vendor_bill', 'draft', ${`AM-${id.slice(0, 8)}`},
              ${o.vendorId}, ${o.date}, 'CAD', '10.0000', '0', '10.0000', ${actor})`);
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
                                  quantity, unit_price, amount, created_by)
      values (${o.orgId}, ${id}, 1, ${o.accounts.cogs}, 'amend', '1', '10.0000', '10.0000', ${actor})`);
  });
  await db.execute(sql`
    update documents set status = 'approved' where id = ${id} and org_id = ${o.orgId}`);
  return id;
}

/** Drizzle wraps driver errors, hiding the PostgreSQL message in `cause`;
 *  render the whole chain so a trigger rejection stays assertable. */
function pgMessage(error: unknown): string {
  let out = "";
  let current: unknown = error;
  while (current) {
    out += `${String(current)}\n`;
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

function deleteLines(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }, o: ScratchOrg, id: string) {
  return tx.execute(sql`
    delete from document_lines where document_id = ${id} and org_id = ${o.orgId}`);
}

test(
  "both trusted-replay settings, in one transaction, admit the rebuild",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const id = await approvedWithLine(o);

    await db.transaction(async (tx) => {
      await tx.execute(sql`set local openbooks.amend = on`);
      await tx.execute(sql`set local openbooks.migration = on`);
      await deleteLines(tx, o, id);
    });

    const left = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from document_lines
       where document_id = ${id} and org_id = ${o.orgId}`);
    assert.equal(left.rows[0]!.n, 0, "the paired authority must admit the rebuild");
  },
);

test(
  "either setting alone is refused, and so is a bare pool statement",
  { skip: !DB, timeout: 120_000 },
  async () => {
    const o = await ctx();
    const guard = /lines are immutable outside draft status/;

    const amendOnly = await approvedWithLine(o);
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await deleteLines(tx, o, amendOnly);
        }),
      (error: unknown) => guard.test(pgMessage(error)),
      "holding only openbooks.amend must not become an edit bypass",
    );

    const migrationOnly = await approvedWithLine(o);
    await assert.rejects(
      () =>
        db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.migration = on`);
          await deleteLines(tx, o, migrationOnly);
        }),
      (error: unknown) => guard.test(pgMessage(error)),
      "holding only openbooks.migration must not become an edit bypass",
    );

    // The original defect: `set local` on the pool is scoped to its own
    // implicit transaction, so by the delete it is no longer set at all.
    const id = await approvedWithLine(o);
    await db.execute(sql`set local openbooks.amend = on`);
    await db.execute(sql`set local openbooks.migration = on`);
    await assert.rejects(
      () => deleteLines(db, o, id),
      (error: unknown) => guard.test(pgMessage(error)),
      "settings issued as separate pool statements do not survive to the delete",
    );
  },
);
