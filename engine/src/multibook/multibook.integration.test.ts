import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { bookReplicationGaps, bookReplicationReadiness, replicateEntryToBooks } from "../journal/book-replication.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { closeBookAccountMap, createBookAccountMap, createBookCurrencyVersion } from "./settings.ts";
import { changeBookReplication } from "./replication-runs.ts";
import { MultiBookError } from "./errors.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

interface Fixture {
  org: ScratchOrg;
  actor: string;
  book: string;
  baseCurrency: string;
  account: (type: string) => Promise<string>;
  post: (lines: { accountId: string; amount: string }[], extra?: { postingDate?: string; reversesEntryId?: string }) => Promise<string>;
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Controller", "admin"));
    const book = randomUUID();
    let baseCurrency = "";
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"multiBookAccounting": true, "multiCurrency": true}'::jsonb)
         where id = ${org.orgId}`);
      await db.execute(sql`
        insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
        values (${book}, ${org.orgId}, 'GAAP', 'US GAAP', false, true, true)`);
      baseCurrency = (await db.execute<{ base_currency: string }>(sql`
        select base_currency from subsidiaries where org_id = ${org.orgId} and id = ${org.subsidiaryId}`)).rows[0]!.base_currency;
    });
    let next = 7400;
    const account = async (type: string) => {
      const id = randomUUID();
      next += 1;
      await withOrgContext(org.orgId, () => db.execute(sql`
        insert into accounts (id, org_id, number, name, type)
        values (${id}, ${org.orgId}, ${String(next)}, ${`Book ${type} ${next}`}, ${type})`));
      return id;
    };
    const post = async (lines: { accountId: string; amount: string }[], extra: { postingDate?: string; reversesEntryId?: string } = {}) =>
      (await withOrgContext(org.orgId, () => postEntry(db, {
        orgId: org.orgId,
        bookId: org.bookId,
        subsidiaryId: org.subsidiaryId,
        entryNumber: `MB-${randomUUID().slice(0, 8)}`,
        postingDate: extra.postingDate ?? org.date,
        periodId: org.periodId,
        origin: "manual",
        reversesEntryId: extra.reversesEntryId ?? null,
        currency: baseCurrency,
        actorId: actor,
        lines,
      }))).entryId;
    await run({ org, actor, book, baseCurrency, account, post });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}

async function activate(f: Fixture, extra: { replicationFrom?: string; openingStrategy?: "full_history" | "opening_balances"; currencyDifferenceAccountId?: string } = {}) {
  return changeBookReplication({
    orgId: f.org.orgId,
    actorId: f.actor,
    allowedSubsidiaryIds: null,
    input: {
      bookId: f.book,
      kind: "activation",
      replicationFrom: extra.replicationFrom ?? "2026-07-01",
      openingStrategy: extra.openingStrategy ?? "opening_balances",
      ...(extra.currencyDifferenceAccountId ? { currencyDifferenceAccountId: extra.currencyDifferenceAccountId } : {}),
    },
    reason: "Report US GAAP alongside the primary book",
  });
}

async function replicaOf(f: Fixture, sourceEntryId: string) {
  return withOrgContext(f.org.orgId, async () => {
    const link = (await db.execute<{ replica_entry_id: string | null; outcome: string }>(sql`
      select replica_entry_id, outcome from book_entry_replications
       where org_id = ${f.org.orgId} and book_id = ${f.book} and source_entry_id = ${sourceEntryId}`)).rows;
    const replicaId = link[0]?.replica_entry_id ?? null;
    const header = replicaId
      ? (await db.execute<{ book_id: string; status: string; origin: string; reverses_entry_id: string | null }>(sql`
          select book_id, status, origin, reverses_entry_id from journal_entries where id = ${replicaId}`)).rows[0]
      : undefined;
    const lines = replicaId
      ? (await db.execute<{ account_id: string; amount: string; currency: string; txn_amount: string; fx_rate: string; is_open_item: boolean }>(sql`
          select account_id, amount::text as amount, currency, txn_amount::text as txn_amount,
                 fx_rate::text as fx_rate, is_open_item
            from journal_lines where entry_id = ${replicaId} order by line_number`)).rows
      : [];
    return { links: link.length, replicaId, header, lines };
  });
}

test("a full book receives each primary posting exactly once and mirrors its reversal", enabled, () => fixture(async (f) => {
  await activate(f);
  const revenue = f.org.accounts.revenue;
  const sourceId = await f.post([{ accountId: f.org.accounts.bank, amount: "100" }, { accountId: revenue, amount: "-100" }]);

  const first = await replicaOf(f, sourceId);
  assert.equal(first.links, 1, "one replication record per book and source entry");
  assert.equal(first.header?.book_id, f.book);
  assert.equal(first.header?.status, "posted");
  assert.equal(first.header?.origin, "manual", "the copy keeps the source origin");
  assert.deepEqual(first.lines.map((l) => [l.account_id, l.amount]), [[f.org.accounts.bank, "100.0000"], [revenue, "-100.0000"]]);

  // Replaying the replication is a no-op: no second copy.
  const replay = await withOrgTransaction(f.org.orgId, () =>
    replicateEntryToBooks(db, postEntry, { orgId: f.org.orgId, sourceEntryId: sourceId, actorId: f.actor }));
  assert.deepEqual(replay.map((o) => o.outcome), ["already"]);
  const copies = (await withOrgContext(f.org.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and book_id = ${f.book} and custom->>'bookReplicaOf' = ${sourceId}`))).rows[0]!.n;
  assert.equal(copies, 1);

  // A governed reversal replicates as a reversal of the copy, and marking the
  // source reversed marks the copy reversed in the same transaction.
  const reversalId = await withOrgTransaction(f.org.orgId, async () => {
    const id = await f.post([{ accountId: f.org.accounts.bank, amount: "-100" }, { accountId: revenue, amount: "100" }], { reversesEntryId: sourceId });
    await markEntryReversed(db, { orgId: f.org.orgId, entryId: sourceId, actorId: f.actor });
    return id;
  });
  const reversal = await replicaOf(f, reversalId);
  assert.equal(reversal.header?.reverses_entry_id, first.replicaId, "the copy reverses the original's copy");
  assert.equal((await replicaOf(f, sourceId)).header?.status, "reversed");

  const gaps = await withOrgContext(f.org.orgId, () => bookReplicationGaps(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }));
  assert.equal(gaps.missing, 0, "a full book holds every replicable primary entry");
}));

test("a book in its own currency translates at the book rate and refuses a missing rate", enabled, () => fixture(async (f) => {
  const bookCurrency = f.baseCurrency === "EUR" ? "USD" : "EUR";
  await withOrgContext(f.org.orgId, () => db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${f.org.orgId}, ${f.baseCurrency}, ${bookCurrency}, '2026-07-01', 'spot', '0.6800000000')`));
  await createBookCurrencyVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, subsidiaryId: f.org.subsidiaryId, currency: bookCurrency, rateType: "spot", effectiveFrom: "2026-07-01" },
    reason: "The group reports this entity in its own currency",
  });
  await activate(f);
  const sourceId = await f.post([{ accountId: f.org.accounts.bank, amount: "250" }, { accountId: f.org.accounts.revenue, amount: "-250" }]);
  const copy = await replicaOf(f, sourceId);
  assert.deepEqual(copy.lines.map((l) => [l.amount, l.currency, l.txn_amount, l.fx_rate]), [
    ["170.0000", f.baseCurrency, "250.0000", "0.6800000000"],
    ["-170.0000", f.baseCurrency, "-250.0000", "0.6800000000"],
  ]);

  // A second full book in a currency with no rate refuses the primary
  // posting as a whole: nothing reaches the primary book either.
  const ifrs = randomUUID();
  await withOrgContext(f.org.orgId, () => db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${ifrs}, ${f.org.orgId}, 'IFRS', 'IFRS', false, true, true)`));
  await createBookCurrencyVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: ifrs, subsidiaryId: f.org.subsidiaryId, currency: "JPY", rateType: "month_average", effectiveFrom: "2026-07-01" },
    reason: "Statutory reporting in yen",
  });
  await changeBookReplication({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: ifrs, kind: "activation", replicationFrom: "2026-07-01", openingStrategy: "opening_balances" },
    reason: "Statutory reporting in yen",
  }).then(
    () => assert.fail("activation must refuse while the yen rate is missing"),
    (error: unknown) => assert.ok(error instanceof MultiBookError && /monthly average rate/.test(error.message), String(error)),
  );
  const ifrsMode = (await withOrgContext(f.org.orgId, () => db.execute<{ replication_mode: string }>(sql`
    select replication_mode from accounting_books where id = ${ifrs}`))).rows[0]!.replication_mode;
  assert.equal(ifrsMode, "adjustment_only", "a refused activation changes nothing");

  // Changing a version under entries the book already holds is refused.
  await createBookCurrencyVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, subsidiaryId: f.org.subsidiaryId, currency: bookCurrency, rateType: "month_average", effectiveFrom: "2026-07-02" },
    reason: "Switch to the monthly average",
  }).then(
    () => assert.fail("a version may not start under existing book entries"),
    (error: unknown) => assert.ok(error instanceof MultiBookError, String(error)),
  );
}));

test("account mappings redirect replicated lines and refuse incompatible or retroactive mappings", enabled, () => fixture(async (f) => {
  const gaapRevenue = await f.account("income");
  const asset = await f.account("asset_current_other");
  await createBookAccountMap({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, sourceAccountId: asset, targetAccountId: gaapRevenue, effectiveFrom: "2026-07-01" },
    reason: "Wrong class on purpose",
  }).then(
    () => assert.fail("an asset cannot be carried as revenue"),
    (error: unknown) => assert.ok(error instanceof MultiBookError && /statement class/.test(error.message), String(error)),
  );
  const map = await createBookAccountMap({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, sourceAccountId: f.org.accounts.revenue, targetAccountId: gaapRevenue, effectiveFrom: "2026-07-01" },
    reason: "GAAP presents this revenue separately",
  });
  await activate(f);
  const sourceId = await f.post([{ accountId: f.org.accounts.bank, amount: "40" }, { accountId: f.org.accounts.revenue, amount: "-40" }]);
  const copy = await replicaOf(f, sourceId);
  assert.deepEqual(copy.lines.map((l) => l.account_id), [f.org.accounts.bank, gaapRevenue]);
  assert.ok(copy.lines.every((l) => !l.is_open_item), "book copies are ledger balances, never open items");

  // Ending the mapping before the entry it governed is refused by storage.
  await closeBookAccountMap({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    id: map.id, effectiveTo: "2026-07-01", reason: "End the mapping early",
  }).then(
    () => assert.fail("a mapping window cannot end before entries it governed"),
    (error: unknown) => assert.ok(error instanceof MultiBookError, String(error)),
  );
}));

test("activation refuses full history over earlier entries and brings them in as opening balances", enabled, () => fixture(async (f) => {
  await f.post([{ accountId: f.org.accounts.bank, amount: "75" }, { accountId: f.org.accounts.revenue, amount: "-75" }], { postingDate: f.org.date });
  await activate(f, { replicationFrom: "2026-07-20", openingStrategy: "full_history" }).then(
    () => assert.fail("full history needs a start on or before the first entry"),
    (error: unknown) => assert.ok(error instanceof MultiBookError && /opening balances/.test(error.message), String(error)),
  );
  const run = await activate(f, { replicationFrom: "2026-07-20", openingStrategy: "opening_balances" });
  assert.equal(run.openingEntryIds.length, 1, "one opening entry per subsidiary with balances");
  const opening = (await withOrgContext(f.org.orgId, () => db.execute<{ account_id: string; amount: string; origin: string; book_id: string }>(sql`
    select l.account_id, l.amount::text as amount, e.origin, e.book_id
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where e.id = ${run.openingEntryIds[0]!} order by l.account_id`))).rows;
  assert.ok(opening.every((row) => row.origin === "book_opening" && row.book_id === f.book));
  const byAccount = new Map(opening.map((row) => [row.account_id, row.amount]));
  assert.equal(byAccount.get(f.org.accounts.bank), "75.0000");
  assert.equal(byAccount.get(f.org.accounts.revenue), "-75.0000");

  // The start date is fixed and recorded; the book's settings changed only with the run.
  const audit = (await withOrgContext(f.org.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log where org_id = ${f.org.orgId} and table_name = 'accounting_books' and row_id = ${f.book}`))).rows[0]!.n;
  assert.ok(audit >= 1, "the activation is audited on the book");
  await withOrgContext(f.org.orgId, () => db.execute(sql`
    update accounting_books set replication_mode = 'adjustment_only' where id = ${f.book}`)).then(
    () => assert.fail("replication settings change only alongside a recorded run"),
    (error: unknown) => assert.match(String((error as { cause?: unknown }).cause ?? error), /recorded replication change/),
  );
}));

test("a closed period in a full book refuses the primary posting as a whole", enabled, () => fixture(async (f) => {
  await activate(f);
  await setPeriodLockState({
    orgId: f.org.orgId, periodId: f.org.periodId, bookId: f.book, module: "gl", state: "soft_closed",
    actorId: f.actor, reason: "GAAP review in progress",
  });
  const marker = `MB-LOCK-${randomUUID().slice(0, 8)}`;
  await withOrgContext(f.org.orgId, () => postEntry(db, {
    orgId: f.org.orgId, bookId: f.org.bookId, subsidiaryId: f.org.subsidiaryId, entryNumber: marker,
    postingDate: f.org.date, periodId: f.org.periodId, origin: "manual", currency: f.baseCurrency, actorId: f.actor,
    lines: [{ accountId: f.org.accounts.bank, amount: "10" }, { accountId: f.org.accounts.revenue, amount: "-10" }],
  })).then(
    () => assert.fail("the book's closed period must refuse the posting"),
    (error: unknown) => assert.ok(error instanceof Error),
  );
  const primary = (await withOrgContext(f.org.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and entry_number = ${marker}`))).rows[0]!.n;
  assert.equal(primary, 0, "the primary posting rolled back with its refused copy");
}));

test("a deactivated book shows its gap until a catch-up fills it", enabled, () => fixture(async (f) => {
  await activate(f);
  await changeBookReplication({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, kind: "deactivation" }, reason: "Pause GAAP replication for review",
  });
  const missed = await f.post([{ accountId: f.org.accounts.bank, amount: "12" }, { accountId: f.org.accounts.revenue, amount: "-12" }]);
  assert.equal((await replicaOf(f, missed)).links, 0, "an adjustment-only book receives no ordinary postings");
  const run = await activate(f);
  assert.equal(run.replicatedCount, 1, "reactivation catches up from the fixed start date");
  assert.equal((await replicaOf(f, missed)).links, 1);
  const gaps = await withOrgContext(f.org.orgId, () => bookReplicationGaps(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }));
  assert.equal(gaps.missing, 0);
}));

test("close readiness reports an entry a full book is missing until a catch-up replicates it", enabled, () => fixture(async (f) => {
  await activate(f);
  // A primary entry written outside the posting API never reached the book.
  const entryId = randomUUID();
  await withOrgContext(f.org.orgId, async () => {
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin, created_by, updated_by)
      values (${entryId}, ${f.org.orgId}, ${f.org.bookId}, ${f.org.subsidiaryId}, ${`MB-RAW-${entryId.slice(0, 8)}`}, ${f.org.date},
              ${f.org.periodId}, 'draft', 'manual', ${f.actor}, ${f.actor})`);
    await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${f.org.orgId}, ${entryId}, 1, ${f.org.accounts.bank}, ${f.org.subsidiaryId}, 9, ${f.baseCurrency}, 9, 1),
             (${f.org.orgId}, ${entryId}, 2, ${f.org.accounts.revenue}, ${f.org.subsidiaryId}, -9, ${f.baseCurrency}, -9, 1)`);
    await db.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${f.actor} where id = ${entryId}`);
  });
  const before = await withOrgContext(f.org.orgId, () =>
    bookReplicationReadiness(db, { orgId: f.org.orgId, bookId: f.org.bookId, through: "2026-12-31" }));
  assert.equal(before.missing, 1, "the primary book's close sees the full book's gap");
  assert.deepEqual(before.books.map((book) => book.bookId), [f.book]);
  const run = await changeBookReplication({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.book, kind: "catch_up" }, reason: "Fill the gap found at close",
  });
  assert.equal(run.replicatedCount, 1);
  const after = await withOrgContext(f.org.orgId, () =>
    bookReplicationReadiness(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }));
  assert.equal(after.missing, 0);
}));

test("a book-specific journal posts to its book only and is never replicated", enabled, () => fixture(async (f) => {
  await activate(f);
  const documentId = randomUUID();
  await withOrgContext(f.org.orgId, async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, accounting_book_id,
         document_date, currency, subtotal, tax_total, total, created_by)
      values (${documentId}, ${f.org.orgId}, 'journal', 'draft', 'JE-GAAP-1', ${f.org.subsidiaryId}, ${f.book},
              ${f.org.date}, ${f.baseCurrency}, '30', '0', '30', ${f.actor})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, subsidiary_id, amount, quantity, unit_price, tax_amount, tax_input_amount)
      values
        (${f.org.orgId}, ${documentId}, 1, ${f.org.accounts.bank}, ${f.org.subsidiaryId}, '30', '1', '30', '0', '30'),
        (${f.org.orgId}, ${documentId}, 2, ${f.org.accounts.revenue}, ${f.org.subsidiaryId}, '-30', '1', '-30', '0', '-30')`);
  });
  const entryId = await withOrgTransaction(f.org.orgId, async () => {
    await submitAndReleaseIfUngated("journal", documentId, f.actor);
    return postDocument(documentId, {
      control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank },
    }, { audit: { actorId: f.actor, source: "ui" } });
  });
  const entry = (await withOrgContext(f.org.orgId, () => db.execute<{ book_id: string }>(sql`
    select book_id from journal_entries where id = ${entryId}`))).rows[0]!;
  assert.equal(entry.book_id, f.book, "the journal posts to its target book");
  const inPrimary = (await withOrgContext(f.org.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and source_document_id = ${documentId} and book_id = ${f.org.bookId}`))).rows[0]!.n;
  assert.equal(inPrimary, 0, "nothing reaches the primary book");
  const links = (await withOrgContext(f.org.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from book_entry_replications where org_id = ${f.org.orgId} and source_entry_id = ${entryId}`))).rows[0]!.n;
  assert.equal(links, 0);
}));

test("book configuration is isolated to its organization", enabled, () => fixture(async (f) => {
  const other = await withBypass(() => createScratchOrg());
  try {
    await withOrgContext(other.orgId, () => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"multiBookAccounting": true}'::jsonb)
       where id = ${other.orgId}`));
    await createBookCurrencyVersion({
      orgId: other.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
      input: { bookId: f.book, subsidiaryId: other.subsidiaryId, currency: "EUR", rateType: "spot", effectiveFrom: "2026-07-01" },
      reason: "Reach across organizations",
    }).then(
      () => assert.fail("another organization's book must not be configurable"),
      (error: unknown) => assert.ok(error instanceof MultiBookError && error.status === 404, String(error)),
    );
  } finally {
    await withBypass(() => dropScratchOrg(other.orgId));
  }
  // The primary book takes no book configuration.
  await createBookCurrencyVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { bookId: f.org.bookId, subsidiaryId: f.org.subsidiaryId, currency: "EUR", rateType: "spot", effectiveFrom: "2026-07-01" },
    reason: "Translate the primary book",
  }).then(
    () => assert.fail("the primary book is the chart of record"),
    (error: unknown) => assert.ok(error instanceof MultiBookError && /primary book/.test(error.message), String(error)),
  );
  // A restricted caller cannot change organization-wide book configuration.
  await createBookCurrencyVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: new Set([f.org.subsidiaryId]),
    input: { bookId: f.book, subsidiaryId: f.org.subsidiaryId, currency: "EUR", rateType: "spot", effectiveFrom: "2026-07-01" },
    reason: "Restricted caller",
  }).then(
    () => assert.fail("book configuration needs an unrestricted scope"),
    (error: unknown) => assert.ok(error instanceof Error),
  );
}));
