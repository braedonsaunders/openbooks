import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { DOCUMENT_KINDS, closeModuleForDocument, setPeriodLockState } from "./close.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("document_close_module matches the engine kind map", { skip: !DB }, async () => {
  // The journal fence derives the close module from the source document kind
  // in storage (0168); it must agree with DOCUMENT_CLOSE_MODULES exactly, or
  // postings land under the wrong module's lock.
  const org = await createScratchOrg();
  try {
    for (const kind of DOCUMENT_KINDS) {
      const stored = (
        await db.execute<{ module: string | null }>(
          sql`select public.document_close_module(${kind}) as module`,
        )
      ).rows[0]!.module;
      assert.equal(stored, closeModuleForDocument(kind), kind);
    }
    // Deliberate asymmetry, pinned: the engine throws on unknown kinds
    // (fail closed at the app boundary) while storage resolves them to null
    // (GL-only recheck; the deferrable source FK stays the backstop).
    const unknown = (
      await db.execute<{ module: string | null }>(
        sql`select public.document_close_module('no_such_kind') as module`,
      )
    ).rows[0]!.module;
    assert.equal(unknown, null);
    assert.throws(() => closeModuleForDocument("no_such_kind"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

async function approvedVendorBill(
  orgId: string,
  subsidiaryId: string,
  customerId: string,
  revenueAccount: string,
  date: string,
  actor: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into documents
    (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
     currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'vendor_bill', 'draft', ${id}, ${subsidiaryId},
      ${customerId}, ${date}, 'CAD', 1, 100, 0, 100, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${orgId}, ${id}, 1, ${revenueAccount}, 1, 100, 100, 0, 100)`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  return id;
}

async function draftEntryForBill(args: {
  orgId: string;
  bookId: string;
  periodId: string;
  subsidiaryId: string;
  billId: string;
  date: string;
  actor: string;
  apAccount: string;
  revenueAccount: string;
  sourceDocumentId: string | null;
}): Promise<string> {
  const entry = randomUUID();
  await db.execute(sql`insert into journal_entries
    (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
     source_document_id, memo, status, origin, created_by, updated_by)
    values (${entry}, ${args.orgId}, ${args.bookId}, ${args.subsidiaryId}, ${entry},
      ${args.date}, ${args.periodId}, ${args.sourceDocumentId}, 'Module fence probe', 'draft', 'manual',
      ${args.actor}, ${args.actor})`);
  await db.execute(sql`insert into journal_lines
    (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, party_id, is_open_item)
    values (${args.orgId}, ${entry}, 1, ${args.revenueAccount}, ${args.subsidiaryId}, 100, 'CAD', 100, 1, null, false),
           (${args.orgId}, ${entry}, 2, ${args.apAccount}, ${args.subsidiaryId}, -100, 'CAD', -100, 1, null, false)`);
  return entry;
}

test("a draft->posted flip for a module-closed source document is rejected", { skip: !DB }, async () => {
  // Posting checks the document module at the app boundary, but a concurrent
  // module-only close can commit between that check and the journal insert
  // while the trigger rechecks GL only. The fence must recheck the source
  // document's own close module on draft -> posted.
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Fence prover", "admin");
    const bill = await approvedVendorBill(
      org.orgId,
      org.subsidiaryId,
      org.customerId,
      org.accounts.revenue,
      org.date,
      actor,
    );
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "ap",
      state: "closed",
      actorId: actor,
      reason: "fence probe: AP closed, GL open",
    });
    const entry = await draftEntryForBill({
      orgId: org.orgId,
      bookId: org.bookId,
      periodId: org.periodId,
      subsidiaryId: org.subsidiaryId,
      billId: bill,
      date: org.date,
      actor,
      apAccount: org.accounts.ap,
      revenueAccount: org.accounts.revenue,
      sourceDocumentId: bill,
    });
    // The storage raise surfaces on the driver's cause chain, not on the
    // outer Drizzle message, so match the whole chain.
    await assert.rejects(
      db.execute(sql`update journal_entries set status = 'posted', posted_by = ${actor} where id = ${entry}`),
      (error: unknown) => {
        const chain = [error, (error as { cause?: unknown }).cause]
          .map((part) => String((part as Error)?.message ?? part))
          .join(" | ");
        assert.match(chain, /period is closed for AP posting/);
        return true;
      },
    );
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${entry}`)).rows[0]!.status,
      "draft",
    );
    // Control: a sourceless GL journal in the same open-GL period still posts.
    const manual = await draftEntryForBill({
      orgId: org.orgId,
      bookId: org.bookId,
      periodId: org.periodId,
      subsidiaryId: org.subsidiaryId,
      billId: bill,
      date: org.date,
      actor,
      apAccount: org.accounts.ap,
      revenueAccount: org.accounts.revenue,
      sourceDocumentId: null,
    });
    await db.execute(sql`update journal_entries set status = 'posted', posted_by = ${actor} where id = ${manual}`);
    assert.equal(
      (await db.execute<{ status: string }>(sql`select status from journal_entries where id = ${manual}`)).rows[0]!.status,
      "posted",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a module close waits for an in-flight posting window", { skip: !DB }, async () => {
  // The posting kernel holds the shared period fence from BEFORE its
  // authoritative module check through commit, so the closer below must block
  // until the window ends instead of slipping a close between check and
  // insert. The parked transaction replicates postDocument's prologue order
  // exactly (fence, then module predicate); a companion pin below asserts the
  // product file keeps that order.
  const org = await createScratchOrg();
  const poster = await pool.connect();
  try {
    const actor = await createScratchUser(org.orgId, "Fence prover", "admin");
    await poster.query("begin");
    await poster.query("select public.period_posting_fence($1, $2, $3)", [org.orgId, org.periodId, org.bookId]);
    const probe = await poster.query(
      "select public.period_module_blocks_write($1, $2, $3, $4, 'ap', false) as blocked",
      [org.orgId, org.periodId, org.bookId, org.subsidiaryId],
    );
    assert.equal(probe.rows[0].blocked, false);
    const closer = setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "ap",
      state: "closed",
      actorId: actor,
      reason: "fence probe: AP close races the posting window",
    });
    const settled = Promise.allSettled([closer]);
    let sightings = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await db.execute<{ n: number }>(sql`select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and pid <> pg_backend_pid()
         and wait_event_type = 'Lock'
         and wait_event = 'advisory'`);
      if (waiting.rows[0]!.n > 0) sightings += 1;
      if (sightings >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(sightings >= 3, "the AP close must wait on the posting window's shared fence");
    await poster.query("rollback");
    const [closeResult] = await settled;
    assert.equal(closeResult!.status, "fulfilled", JSON.stringify(closeResult));
    const closed = await db.execute<{ blocked: boolean }>(
      sql`select public.period_module_blocks_write(${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'ap', false) as blocked`,
    );
    assert.equal(closed.rows[0]!.blocked, true);
  } finally {
    poster.release();
    await dropScratchOrg(org.orgId);
  }
});

test("postDocument holds the period fence before its module check", () => {
  // Structural companion to the window test above: the one-line engine half
  // of this fix is fence-before-check inside postDocument. If the fence call
  // moves below the module validation (or disappears), the race reopens while
  // the behavioral test above keeps passing against its replica prologue.
  const source = readFileSync(new URL("./posting.ts", import.meta.url), "utf8");
  const fence = source.indexOf("period_posting_fence(${doc.orgId}, ${period.id}, ${book.id})");
  assert.ok(fence >= 0, "postDocument must acquire the shared period fence");
  const check = source.indexOf("assertPeriodModulesOpen(tx, {");
  assert.ok(check > fence, "the fence must be held before the authoritative module check");
});
