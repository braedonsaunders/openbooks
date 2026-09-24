import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../platform/db.ts";
import {
  CloseError,
  DOCUMENT_KINDS,
  assertPeriodModulesOpen,
  closeModuleForDocument,
} from "./period-policy.ts";
import { setPeriodLockState } from "./period-locks.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { PostingError } from "../ledger/posting-contracts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

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

async function approvedCustomerInvoice(
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
    values (${id}, ${orgId}, 'customer_invoice', 'draft', ${id}, ${subsidiaryId},
      ${customerId}, ${date}, 'CAD', 1, 100, 0, 100, ${actor})`);
  await db.execute(sql`insert into document_lines
    (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${orgId}, ${id}, 1, ${revenueAccount}, 1, 100, 100, 0, 100)`);
  await db.execute(sql`update documents set status = 'approved' where id = ${id}`);
  return id;
}

function postingDeps(org: { accounts: { ar: string; ap: string; bank: string } }): {
  control: { ar: string; ap: string; bank: string };
} {
  return { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
}

test("soft-close fences posting in the engine and storage twins alike", { skip: !DB }, async () => {
  // periodLockBlocksPosting (engine) and period_module_blocks_write
  // (storage) must agree that soft_closed blocks: soft-close is a
  // first-class Setup action, and either twin going blind reopens posting
  // into a reviewing period.
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Fence prover", "admin");
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "gl",
      state: "soft_closed",
      actorId: actor,
      reason: "fence probe: soft-close the period",
    });
    await assert.rejects(
      assertPeriodModulesOpen(db, {
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        subsidiaryIds: [org.subsidiaryId],
        modules: ["gl"],
      }),
      (error: unknown) =>
        error instanceof CloseError && /GL is closed for this period/.test(error.message),
      "the engine twin refuses a soft-closed period",
    );
    const blocked = (await db.execute<{ blocked: boolean }>(sql`
      select public.period_module_blocks_write(
        ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', false
      ) as blocked
    `)).rows[0]!.blocked;
    assert.equal(blocked, true, "the storage twin blocks a soft-closed period");
    // Control: reopening clears both twins together.
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "gl",
      state: "open",
      actorId: actor,
      reason: "fence probe: reopen the period",
    });
    await assertPeriodModulesOpen(db, {
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      subsidiaryIds: [org.subsidiaryId],
      modules: ["gl"],
    });
    const unblocked = (await db.execute<{ blocked: boolean }>(sql`
      select public.period_module_blocks_write(
        ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', false
      ) as blocked
    `)).rows[0]!.blocked;
    assert.equal(unblocked, false, "an open period passes both twins");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("posting into a closed period refuses at the engine boundary with the module named", { skip: !DB }, async () => {
  // The app-boundary module check must fire before any journal exists: the
  // refusal carries the engine's module message, not the storage trigger's.
  // (If the check call disappeared, the post would still fail — but at the
  // storage guard with its message instead.)
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Fence prover", "admin");
    const invoiceId = await approvedCustomerInvoice(
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
      module: "ar",
      state: "closed",
      actorId: actor,
      reason: "fence probe: AR closed",
    });
    await assert.rejects(
      postDocument(invoiceId, postingDeps(org)),
      (error: unknown) =>
        error instanceof PostingError && /AR is closed for this period/.test(error.message),
      "the engine check refuses the closed module by name",
    );
    const entries = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId}
    `)).rows[0]!.n;
    assert.equal(entries, 0, "the refused post wrote no journal");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a module close landing mid-posting waits for the fence: the started posting wins", { skip: !DB }, async () => {
  // The real postDocument prologue holds the shared period fence across its
  // module check and journal insert (not a replica): a closer arriving
  // mid-post must block on the fence, then commit after the posting wins.
  // If the fence call disappeared from the prologue, the closer would sail
  // through while the post sleeps and the post would fail.
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Fence prover", "admin");
    const invoiceId = await approvedCustomerInvoice(
      org.orgId,
      org.subsidiaryId,
      org.customerId,
      org.accounts.revenue,
      org.date,
      actor,
    );
    await db.execute(sql.raw(`create or replace function public.probe_posting_sleep()
      returns trigger language plpgsql as $$ begin perform pg_sleep(4); return NEW; end $$`));
    await db.execute(sql.raw(`create trigger probe_posting_sleep_trigger
      before insert on journal_entries for each statement
      execute function public.probe_posting_sleep()`));
    try {
      const posting = postDocument(invoiceId, postingDeps(org));
      // Gate the closer on the posting provably sleeping inside the journal
      // trigger (fence held): a fixed delay would race a loaded database,
      // where the closer could commit before the posting even starts.
      let asleep = false;
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const sleeping = await db.execute<{ n: number }>(sql`select count(*)::int as n
          from pg_stat_activity
         where datname = current_database()
           and pid <> pg_backend_pid()
           and wait_event_type = 'Timeout'
           and wait_event = 'PgSleep'`);
        if (sleeping.rows[0]!.n > 0) {
          asleep = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(asleep, "the posting must reach its trigger sleep with the fence held");
      const closer = setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "ar",
        state: "closed",
        actorId: actor,
        reason: "fence probe: AR close races the posting",
      });
      const settled = Promise.allSettled([closer]);
      let sightings = 0;
      for (let attempt = 0; attempt < 300; attempt += 1) {
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
      assert.ok(sightings >= 3, "the AR close must wait on the posting's shared fence");
      await posting;
      const [closeResult] = await settled;
      assert.equal(closeResult!.status, "fulfilled", JSON.stringify(closeResult));
      const status = (await db.execute<{ status: string }>(sql`
        select status from documents where id = ${invoiceId}
      `)).rows[0]!.status;
      assert.equal(status, "posted", "the started posting wins the race");
      const lock = (await db.execute<{ state: string }>(sql`
        select state from period_locks
         where org_id = ${org.orgId} and period_id = ${org.periodId}
           and book_id = ${org.bookId} and module = 'ar'
      `)).rows[0]!.state;
      assert.equal(lock, "closed", "the closer commits once the posting releases the fence");
    } finally {
      await db.execute(sql.raw(`drop trigger if exists probe_posting_sleep_trigger on journal_entries`));
      await db.execute(sql.raw(`drop function if exists public.probe_posting_sleep()`));
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
