import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import {
  bookReplicationGaps,
  bookReplicationReadiness,
  replicateEntryToBooks,
} from "../journal/book-replication.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  closeBookAccountMap,
  createBookAccountMap,
  createBookCurrencyVersion,
  listBookAccountMaps,
  listBookCurrencies,
} from "./settings.ts";
import { changeBookReplication } from "./replication-runs.ts";
import { MultiBookError } from "./errors.ts";
import { runExpenseAmortization } from "../amortization/run.ts";
import { reconcileDeferralAccounts } from "../amortization/reconciliation.ts";
import { AmortizationError } from "../amortization/errors.ts";
import { createManualSchedule } from "../amortization/schedules.ts";
import { installEngineSeams } from "../composition/install.ts";
import { previewAccountMerge, requestAccountMerge } from "../chart/account-merge.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

interface Fixture {
  org: ScratchOrg;
  actor: string;
  book: string;
  baseCurrency: string;
  account: (type: string) => Promise<string>;
  post: (
    lines: { accountId: string; amount: string }[],
    extra?: { postingDate?: string; reversesEntryId?: string },
  ) => Promise<string>;
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Controller", "admin"));
    await withBypass(() =>
      grantScratchPermissions(org.orgId, actor, ["gl.post_book_specific", "amortization.manage"]),
    );
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
      baseCurrency = (
        await db.execute<{ base_currency: string }>(
          sql`
        select base_currency from subsidiaries where org_id = ${org.orgId} and id = ${org.subsidiaryId}`,
          "objects",
        )
      )[0]!.base_currency;
    });
    let next = 7400;
    const account = async (type: string) => {
      const id = randomUUID();
      next += 1;
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
        insert into accounts (id, org_id, number, name, type)
        values (${id}, ${org.orgId}, ${String(next)}, ${`Book ${type} ${next}`}, ${type})`),
      );
      return id;
    };
    const post = async (
      lines: { accountId: string; amount: string }[],
      extra: { postingDate?: string; reversesEntryId?: string } = {},
    ) =>
      (
        await withOrgContext(org.orgId, () =>
          postEntry(db, {
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
          }),
        )
      ).entryId;
    await run({ org, actor, book, baseCurrency, account, post });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
}

async function activate(
  f: Fixture,
  extra: {
    replicationFrom?: string;
    openingStrategy?: "full_history" | "opening_balances";
    currencyDifferenceAccountId?: string;
  } = {},
) {
  return changeBookReplication({
    orgId: f.org.orgId,
    actorId: f.actor,
    allowedSubsidiaryIds: null,
    input: {
      bookId: f.book,
      kind: "activation",
      replicationFrom: extra.replicationFrom ?? "2026-07-01",
      openingStrategy: extra.openingStrategy ?? "opening_balances",
      ...(extra.currencyDifferenceAccountId
        ? { currencyDifferenceAccountId: extra.currencyDifferenceAccountId }
        : {}),
    },
    reason: "Report US GAAP alongside the primary book",
  });
}

async function replicaOf(f: Fixture, sourceEntryId: string) {
  return withOrgContext(f.org.orgId, async () => {
    const link = await db.execute<{ replica_entry_id: string | null; outcome: string }>(
      sql`
      select replica_entry_id, outcome from book_entry_replications
       where org_id = ${f.org.orgId} and book_id = ${f.book} and source_entry_id = ${sourceEntryId}`,
      "objects",
    );
    const replicaId = link[0]?.replica_entry_id ?? null;
    const header = replicaId
      ? (
          await db.execute<{
            book_id: string;
            status: string;
            origin: string;
            reverses_entry_id: string | null;
          }>(
            sql`
          select book_id, status, origin, reverses_entry_id from journal_entries where id = ${replicaId}`,
            "objects",
          )
        )[0]
      : undefined;
    const lines = replicaId
      ? await db.execute<{
          account_id: string;
          amount: string;
          currency: string;
          txn_amount: string;
          fx_rate: string;
          is_open_item: boolean;
        }>(
          sql`
          select account_id, amount::text as amount, currency, txn_amount::text as txn_amount,
                 fx_rate::text as fx_rate, is_open_item
            from journal_lines where entry_id = ${replicaId} order by line_number`,
          "objects",
        )
      : [];
    return { links: link.length, replicaId, header, lines };
  });
}

test(
  "a full book receives each primary posting exactly once and mirrors its reversal",
  enabled,
  () =>
    fixture(async (f) => {
      await activate(f);
      const revenue = f.org.accounts.revenue;
      const sourceId = await f.post([
        { accountId: f.org.accounts.bank, amount: "100" },
        { accountId: revenue, amount: "-100" },
      ]);

      const first = await replicaOf(f, sourceId);
      assert.equal(first.links, 1, "one replication record per book and source entry");
      assert.equal(first.header?.book_id, f.book);
      assert.equal(first.header?.status, "posted");
      assert.equal(first.header?.origin, "manual", "the copy keeps the source origin");
      assert.deepEqual(
        first.lines.map((l) => [l.account_id, l.amount]),
        [
          [f.org.accounts.bank, "100.0000"],
          [revenue, "-100.0000"],
        ],
      );

      // Replaying the replication is a no-op: no second copy.
      const replay = await withOrgTransaction(f.org.orgId, () =>
        replicateEntryToBooks(db, postEntry, {
          orgId: f.org.orgId,
          sourceEntryId: sourceId,
          actorId: f.actor,
        }),
      );
      assert.deepEqual(
        replay.map((o) => o.outcome),
        ["already"],
      );
      const copies = (
        await withOrgContext(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and book_id = ${f.book} and custom->>'bookReplicaOf' = ${sourceId}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.equal(copies, 1);

      // A governed reversal replicates as a reversal of the copy, and marking the
      // source reversed marks the copy reversed in the same transaction.
      const reversalId = await withOrgTransaction(f.org.orgId, async () => {
        const id = await f.post(
          [
            { accountId: f.org.accounts.bank, amount: "-100" },
            { accountId: revenue, amount: "100" },
          ],
          { reversesEntryId: sourceId },
        );
        await markEntryReversed(db, { orgId: f.org.orgId, entryId: sourceId, actorId: f.actor });
        return id;
      });
      const reversal = await replicaOf(f, reversalId);
      assert.equal(
        reversal.header?.reverses_entry_id,
        first.replicaId,
        "the copy reverses the original's copy",
      );
      assert.equal((await replicaOf(f, sourceId)).header?.status, "reversed");

      const gaps = await withOrgContext(f.org.orgId, () =>
        bookReplicationGaps(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }),
      );
      assert.equal(gaps.missing, 0, "a full book holds every replicable primary entry");
    }),
);

test(
  "a book in its own currency translates at the book rate and refuses a missing rate",
  enabled,
  () =>
    fixture(async (f) => {
      const bookCurrency = f.baseCurrency === "EUR" ? "USD" : "EUR";
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${f.org.orgId}, ${f.baseCurrency}, ${bookCurrency}, '2026-07-01', 'spot', '0.6800000000')`),
      );
      await createBookCurrencyVersion({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          subsidiaryId: f.org.subsidiaryId,
          currency: bookCurrency,
          rateType: "spot",
          effectiveFrom: "2026-07-01",
        },
        reason: "The group reports this entity in its own currency",
      });
      await activate(f);
      const sourceId = await f.post([
        { accountId: f.org.accounts.bank, amount: "250" },
        { accountId: f.org.accounts.revenue, amount: "-250" },
      ]);
      const copy = await replicaOf(f, sourceId);
      assert.deepEqual(
        copy.lines.map((l) => [l.amount, l.currency, l.txn_amount, l.fx_rate]),
        [
          ["170.0000", f.baseCurrency, "250.0000", "0.6800000000"],
          ["-170.0000", f.baseCurrency, "-250.0000", "0.6800000000"],
        ],
      );

      // A second full book in a currency with no rate refuses the primary
      // posting as a whole: nothing reaches the primary book either.
      const ifrs = randomUUID();
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
    values (${ifrs}, ${f.org.orgId}, 'IFRS', 'IFRS', false, true, true)`),
      );
      await createBookCurrencyVersion({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: ifrs,
          subsidiaryId: f.org.subsidiaryId,
          currency: "JPY",
          rateType: "month_average",
          effectiveFrom: "2026-07-01",
        },
        reason: "Statutory reporting in yen",
      });
      await changeBookReplication({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: ifrs,
          kind: "activation",
          replicationFrom: "2026-07-01",
          openingStrategy: "opening_balances",
        },
        reason: "Statutory reporting in yen",
      }).then(
        () => assert.fail("activation must refuse while the yen rate is missing"),
        (error: unknown) =>
          assert.ok(
            error instanceof MultiBookError && /monthly average rate/.test(error.message),
            String(error),
          ),
      );
      const ifrsMode = (
        await withOrgContext(f.org.orgId, () =>
          db.execute<{ replication_mode: string }>(
            sql`
    select replication_mode from accounting_books where id = ${ifrs}`,
            "objects",
          ),
        )
      )[0]!.replication_mode;
      assert.equal(ifrsMode, "adjustment_only", "a refused activation changes nothing");

      // Changing a version under entries the book already holds is refused.
      await createBookCurrencyVersion({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          subsidiaryId: f.org.subsidiaryId,
          currency: bookCurrency,
          rateType: "month_average",
          effectiveFrom: "2026-07-02",
        },
        reason: "Switch to the monthly average",
      }).then(
        () => assert.fail("a version may not start under existing book entries"),
        (error: unknown) => assert.ok(error instanceof MultiBookError, String(error)),
      );
    }),
);

test(
  "account mappings redirect replicated lines and refuse incompatible or retroactive mappings",
  enabled,
  () =>
    fixture(async (f) => {
      const gaapRevenue = await f.account("income");
      const asset = await f.account("asset_current_other");
      await createBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          sourceAccountId: asset,
          targetAccountId: gaapRevenue,
          effectiveFrom: "2026-07-01",
        },
        reason: "Wrong class on purpose",
      }).then(
        () => assert.fail("an asset cannot be carried as revenue"),
        (error: unknown) =>
          assert.ok(
            error instanceof MultiBookError && /statement class/.test(error.message),
            String(error),
          ),
      );
      const map = await createBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          sourceAccountId: f.org.accounts.revenue,
          targetAccountId: gaapRevenue,
          effectiveFrom: "2026-07-01",
        },
        reason: "GAAP presents this revenue separately",
      });
      await activate(f);
      const sourceId = await f.post([
        { accountId: f.org.accounts.bank, amount: "40" },
        { accountId: f.org.accounts.revenue, amount: "-40" },
      ]);
      const copy = await replicaOf(f, sourceId);
      assert.deepEqual(
        copy.lines.map((l) => l.account_id),
        [f.org.accounts.bank, gaapRevenue],
      );
      assert.ok(
        copy.lines.every((l) => !l.is_open_item),
        "book copies are ledger balances, never open items",
      );

      // Ending the mapping before the entry it governed is refused by storage.
      await closeBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        id: map.id,
        effectiveTo: "2026-07-01",
        reason: "End the mapping early",
      }).then(
        () => assert.fail("a mapping window cannot end before entries it governed"),
        (error: unknown) => assert.ok(error instanceof MultiBookError, String(error)),
      );
    }),
);

test("multi-book currency and account-map lists respect subsidiary visibility", enabled, () =>
  fixture(async (f) => {
    const targetAccount = await f.account("income");
    await createBookCurrencyVersion({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: null,
      input: {
        bookId: f.book,
        subsidiaryId: f.org.subsidiaryId,
        currency: f.baseCurrency,
        rateType: "spot",
        effectiveFrom: "2026-07-01",
      },
      reason: "Measure this entity in its book currency",
    });
    await createBookAccountMap({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: null,
      input: {
        bookId: f.book,
        subsidiaryId: f.org.subsidiaryId,
        sourceAccountId: f.org.accounts.revenue,
        targetAccountId: targetAccount,
        effectiveFrom: "2026-07-01",
      },
      reason: "Present this entity's revenue separately",
    });

    assert.equal((await listBookCurrencies(f.org.orgId)).length, 1);
    assert.equal((await listBookAccountMaps(f.org.orgId)).length, 1);
    assert.deepEqual(await listBookCurrencies(f.org.orgId, db, new Set()), []);
    assert.deepEqual(await listBookAccountMaps(f.org.orgId, db, new Set()), []);
  }),
);

test(
  "activation refuses full history over earlier entries and brings them in as opening balances",
  enabled,
  () =>
    fixture(async (f) => {
      await f.post(
        [
          { accountId: f.org.accounts.bank, amount: "75" },
          { accountId: f.org.accounts.revenue, amount: "-75" },
        ],
        { postingDate: f.org.date },
      );
      await activate(f, { replicationFrom: "2026-07-20", openingStrategy: "full_history" }).then(
        () => assert.fail("full history needs a start on or before the first entry"),
        (error: unknown) =>
          assert.ok(
            error instanceof MultiBookError && /opening balances/.test(error.message),
            String(error),
          ),
      );
      const run = await activate(f, {
        replicationFrom: "2026-07-20",
        openingStrategy: "opening_balances",
      });
      assert.equal(run.openingEntryIds.length, 1, "one opening entry per subsidiary with balances");
      const opening = await withOrgContext(f.org.orgId, () =>
        db.execute<{ account_id: string; amount: string; origin: string; book_id: string }>(
          sql`
    select l.account_id, l.amount::text as amount, e.origin, e.book_id
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where e.id = ${run.openingEntryIds[0]!} order by l.account_id`,
          "objects",
        ),
      );
      assert.ok(opening.every((row) => row.origin === "book_opening" && row.book_id === f.book));
      const byAccount = new Map(opening.map((row) => [row.account_id, row.amount]));
      assert.equal(byAccount.get(f.org.accounts.bank), "75.0000");
      assert.equal(byAccount.get(f.org.accounts.revenue), "-75.0000");

      // The start date is fixed and recorded; the book's settings changed only with the run.
      const audit = (
        await withOrgContext(f.org.orgId, () =>
          db.execute<{ n: number }>(
            sql`
    select count(*)::int as n from audit_log where org_id = ${f.org.orgId} and table_name = 'accounting_books' and row_id = ${f.book}`,
            "objects",
          ),
        )
      )[0]!.n;
      assert.ok(audit >= 1, "the activation is audited on the book");
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    update accounting_books set replication_mode = 'adjustment_only' where id = ${f.book}`),
      ).then(
        () => assert.fail("replication settings change only alongside a recorded run"),
        (error: unknown) =>
          assert.match(
            String((error as { cause?: unknown }).cause ?? error),
            /recorded replication change/,
          ),
      );
    }),
);

test(
  "opening balances preserve dimensions and carry only current-year merged P&L into the surviving account",
  enabled,
  () =>
    fixture(async (f) => {
      installEngineSeams();
      const source = await f.account("expense");
      const target = await f.account("expense");
      const currencyDifference = await f.account("income");
      const department = randomUUID();
      const oldPeriod = randomUUID();
      const currentYearPeriod = randomUUID();
      await withOrgContext(f.org.orgId, async () => {
        const calendar = (
          await db.execute<{ id: string }>(
            sql`
      select fiscal_calendar_id as id from accounting_periods where org_id = ${f.org.orgId} and id = ${f.org.periodId}`,
            "objects",
          )
        )[0]!.id;
        await db.execute(
          sql`insert into departments (id, org_id, name) values (${department}, ${f.org.orgId}, 'Operations')`,
        );
        await db.execute(sql`update accounts set required_dimensions = '["department"]'::jsonb
      where org_id = ${f.org.orgId} and id in (${source}, ${target})`);
        await db.execute(sql`insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on)
      values (${oldPeriod}, ${f.org.orgId}, ${calendar}, 2025, 12, '2025-12', '2025-12-01', '2025-12-31'),
             (${currentYearPeriod}, ${f.org.orgId}, ${calendar}, 2026, 1, '2026-01', '2026-01-01', '2026-01-31')`);
        await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"accountMerges":true}'::jsonb) where id = ${f.org.orgId}`);
        await postEntry(db, {
          orgId: f.org.orgId,
          bookId: f.org.bookId,
          subsidiaryId: f.org.subsidiaryId,
          entryNumber: `PRE-FY-${randomUUID().slice(0, 8)}`,
          postingDate: "2025-12-15",
          periodId: oldPeriod,
          origin: "manual",
          currency: f.baseCurrency,
          actorId: f.actor,
          lines: [
            { accountId: source, amount: "500", departmentId: department },
            { accountId: f.org.accounts.bank, amount: "-500" },
          ],
        });
        await postEntry(db, {
          orgId: f.org.orgId,
          bookId: f.org.bookId,
          subsidiaryId: f.org.subsidiaryId,
          entryNumber: `CURRENT-FY-${randomUUID().slice(0, 8)}`,
          postingDate: "2026-01-15",
          periodId: currentYearPeriod,
          origin: "manual",
          currency: f.baseCurrency,
          actorId: f.actor,
          lines: [
            { accountId: source, amount: "200", departmentId: department },
            { accountId: f.org.accounts.bank, amount: "-200" },
          ],
        });
      });

      const input = {
        sourceAccountId: source,
        targetAccountId: target,
        effectiveDate: "2026-07-15",
      };
      const preview = await previewAccountMerge(f.org.orgId, input, null);
      assert.deepEqual(preview.refusals, []);
      const merge = await requestAccountMerge(f.org.orgId, {
        ...input,
        expectedDigest: preview.digest,
        idempotencyKey: randomUUID(),
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        reason: "Carry the current-year balance into the surviving account",
      });
      assert.equal(merge.status, "completed");
      await activate(f, {
        replicationFrom: "2026-07-20",
        openingStrategy: "opening_balances",
        currencyDifferenceAccountId: currencyDifference,
      });

      const opening = await withOrgContext(f.org.orgId, () =>
        db.execute<{
          account_id: string;
          amount: string;
          department_id: string | null;
        }>(
          sql`
    select l.account_id, l.amount::text as amount, l.department_id
      from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
     where e.org_id = ${f.org.orgId} and e.book_id = ${f.book} and e.origin = 'book_opening'
     order by l.line_number`,
          "objects",
        ),
      );
      assert.ok(
        opening.some(
          (line) =>
            line.account_id === target &&
            line.amount === "200.0000" &&
            line.department_id === department,
        ),
      );
      assert.ok(
        !opening.some((line) => line.account_id === source),
        "merged historical P&L remains on the survivor, never the inactive source",
      );
    }),
);

test(
  "full-history backfill can replicate entries on accounts deactivated after posting",
  enabled,
  () =>
    fixture(async (f) => {
      const sourceEntryId = await f.post([
        { accountId: f.org.accounts.bank, amount: "125" },
        { accountId: f.org.accounts.revenue, amount: "-125" },
      ]);
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    update accounts set is_active = false where org_id = ${f.org.orgId} and id = ${f.org.accounts.revenue}`),
      );

      await activate(f, { replicationFrom: "2026-07-01", openingStrategy: "full_history" });
      const replica = await replicaOf(f, sourceEntryId);
      assert.equal(replica.header?.status, "posted");
      assert.ok(
        replica.lines.some(
          (line) => line.account_id === f.org.accounts.revenue && line.amount === "-125.0000",
        ),
      );
    }),
);

test("a closed period in a full book refuses the primary posting as a whole", enabled, () =>
  fixture(async (f) => {
    await activate(f);
    await setPeriodLockState({
      orgId: f.org.orgId,
      periodId: f.org.periodId,
      bookId: f.book,
      module: "gl",
      state: "soft_closed",
      actorId: f.actor,
      reason: "GAAP review in progress",
    });
    const marker = `MB-LOCK-${randomUUID().slice(0, 8)}`;
    await withOrgContext(f.org.orgId, () =>
      postEntry(db, {
        orgId: f.org.orgId,
        bookId: f.org.bookId,
        subsidiaryId: f.org.subsidiaryId,
        entryNumber: marker,
        postingDate: f.org.date,
        periodId: f.org.periodId,
        origin: "manual",
        currency: f.baseCurrency,
        actorId: f.actor,
        lines: [
          { accountId: f.org.accounts.bank, amount: "10" },
          { accountId: f.org.accounts.revenue, amount: "-10" },
        ],
      }),
    ).then(
      () => assert.fail("the book's closed period must refuse the posting"),
      (error: unknown) => assert.ok(error instanceof Error),
    );
    const primary = (
      await withOrgContext(f.org.orgId, () =>
        db.execute<{ n: number }>(
          sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and entry_number = ${marker}`,
          "objects",
        ),
      )
    )[0]!.n;
    assert.equal(primary, 0, "the primary posting rolled back with its refused copy");
  }),
);

test("a deactivated book shows its gap until a catch-up fills it", enabled, () =>
  fixture(async (f) => {
    await activate(f);
    await changeBookReplication({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: null,
      input: { bookId: f.book, kind: "deactivation" },
      reason: "Pause GAAP replication for review",
    });
    const missed = await f.post([
      { accountId: f.org.accounts.bank, amount: "12" },
      { accountId: f.org.accounts.revenue, amount: "-12" },
    ]);
    assert.equal(
      (await replicaOf(f, missed)).links,
      0,
      "an adjustment-only book receives no ordinary postings",
    );
    const run = await activate(f);
    assert.equal(run.replicatedCount, 1, "reactivation catches up from the fixed start date");
    assert.equal((await replicaOf(f, missed)).links, 1);
    const gaps = await withOrgContext(f.org.orgId, () =>
      bookReplicationGaps(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }),
    );
    assert.equal(gaps.missing, 0);
  }),
);

test(
  "close readiness reports an entry a full book is missing until a catch-up replicates it",
  enabled,
  () =>
    fixture(async (f) => {
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
        await db.execute(
          sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${f.actor} where id = ${entryId}`,
        );
      });
      const before = await withOrgContext(f.org.orgId, () =>
        bookReplicationReadiness(db, {
          orgId: f.org.orgId,
          bookId: f.org.bookId,
          through: "2026-12-31",
        }),
      );
      assert.equal(before.missing, 1, "the primary book's close sees the full book's gap");
      assert.deepEqual(
        before.books.map((book) => book.bookId),
        [f.book],
      );
      const run = await changeBookReplication({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: { bookId: f.book, kind: "catch_up" },
        reason: "Fill the gap found at close",
      });
      assert.equal(run.replicatedCount, 1);
      const after = await withOrgContext(f.org.orgId, () =>
        bookReplicationReadiness(db, { orgId: f.org.orgId, bookId: f.book, through: "2026-12-31" }),
      );
      assert.equal(after.missing, 0);
    }),
);

test("a book-specific journal posts to its book only and is never replicated", enabled, () =>
  fixture(async (f) => {
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
      return postDocument(
        documentId,
        {
          control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank },
        },
        { audit: { actorId: f.actor, source: "ui" } },
      );
    });
    const entry = (
      await withOrgContext(f.org.orgId, () =>
        db.execute<{ book_id: string }>(
          sql`
    select book_id from journal_entries where id = ${entryId}`,
          "objects",
        ),
      )
    )[0]!;
    assert.equal(entry.book_id, f.book, "the journal posts to its target book");
    const inPrimary = (
      await withOrgContext(f.org.orgId, () =>
        db.execute<{ n: number }>(
          sql`
    select count(*)::int as n from journal_entries where org_id = ${f.org.orgId} and source_document_id = ${documentId} and book_id = ${f.org.bookId}`,
          "objects",
        ),
      )
    )[0]!.n;
    assert.equal(inPrimary, 0, "nothing reaches the primary book");
    const links = (
      await withOrgContext(f.org.orgId, () =>
        db.execute<{ n: number }>(
          sql`
    select count(*)::int as n from book_entry_replications where org_id = ${f.org.orgId} and source_entry_id = ${entryId}`,
          "objects",
        ),
      )
    )[0]!.n;
    assert.equal(links, 0);
  }),
);

test("book configuration is isolated to its organization", enabled, () =>
  fixture(async (f) => {
    const other = await withBypass(() => createScratchOrg());
    try {
      await withOrgContext(other.orgId, () =>
        db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"multiBookAccounting": true}'::jsonb)
       where id = ${other.orgId}`),
      );
      await createBookCurrencyVersion({
        orgId: other.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          subsidiaryId: other.subsidiaryId,
          currency: "EUR",
          rateType: "spot",
          effectiveFrom: "2026-07-01",
        },
        reason: "Reach across organizations",
      }).then(
        () => assert.fail("another organization's book must not be configurable"),
        (error: unknown) =>
          assert.ok(error instanceof MultiBookError && error.status === 404, String(error)),
      );
    } finally {
      await withBypass(() => dropScratchOrg(other.orgId));
    }
    // The primary book takes no book configuration.
    await createBookCurrencyVersion({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: null,
      input: {
        bookId: f.org.bookId,
        subsidiaryId: f.org.subsidiaryId,
        currency: "EUR",
        rateType: "spot",
        effectiveFrom: "2026-07-01",
      },
      reason: "Translate the primary book",
    }).then(
      () => assert.fail("the primary book is the chart of record"),
      (error: unknown) =>
        assert.ok(
          error instanceof MultiBookError && /primary book/.test(error.message),
          String(error),
        ),
    );
    // A restricted caller cannot change organization-wide book configuration.
    await createBookCurrencyVersion({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: new Set([f.org.subsidiaryId]),
      input: {
        bookId: f.book,
        subsidiaryId: f.org.subsidiaryId,
        currency: "EUR",
        rateType: "spot",
        effectiveFrom: "2026-07-01",
      },
      reason: "Restricted caller",
    }).then(
      () => assert.fail("book configuration needs an unrestricted scope"),
      (error: unknown) => assert.ok(error instanceof Error),
    );
  }),
);

test(
  "a replicated reversal retains the original book accounts and quote after policy changes",
  enabled,
  () =>
    fixture(async (f) => {
      const currency = f.baseCurrency === "EUR" ? "USD" : "EUR";
      const firstRevenue = await f.account("income");
      const nextRevenue = await f.account("income");
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${f.org.orgId}, ${f.baseCurrency}, ${currency}, '2026-07-01', 'spot', '0.68')`),
      );
      await createBookCurrencyVersion({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          subsidiaryId: f.org.subsidiaryId,
          currency,
          rateType: "spot",
          effectiveFrom: "2026-07-01",
        },
        reason: "Report the book in its measurement currency",
      });
      const mapping = await createBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          sourceAccountId: f.org.accounts.revenue,
          targetAccountId: firstRevenue,
          effectiveFrom: "2026-07-01",
        },
        reason: "Present revenue in the book chart",
      });
      await activate(f);
      const source = await f.post(
        [
          { accountId: f.org.accounts.bank, amount: "100" },
          { accountId: f.org.accounts.revenue, amount: "-100" },
        ],
        { postingDate: "2026-07-15" },
      );
      const original = await replicaOf(f, source);
      assert.deepEqual(
        original.lines.map((line) => [line.account_id, line.amount]),
        [
          [f.org.accounts.bank, "68.0000"],
          [firstRevenue, "-68.0000"],
        ],
      );
      await closeBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        id: mapping.id,
        effectiveTo: "2026-07-24",
        reason: "End the previous revenue presentation",
      });
      await createBookAccountMap({
        orgId: f.org.orgId,
        actorId: f.actor,
        allowedSubsidiaryIds: null,
        input: {
          bookId: f.book,
          sourceAccountId: f.org.accounts.revenue,
          targetAccountId: nextRevenue,
          effectiveFrom: "2026-07-25",
        },
        reason: "Apply the new revenue presentation prospectively",
      });
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${f.org.orgId}, ${f.baseCurrency}, ${currency}, '2026-07-31', 'spot', '0.91')`),
      );
      const reversal = await withOrgTransaction(f.org.orgId, async () => {
        const id = await f.post(
          [
            { accountId: f.org.accounts.bank, amount: "-100" },
            { accountId: f.org.accounts.revenue, amount: "100" },
          ],
          { postingDate: "2026-07-31", reversesEntryId: source },
        );
        await markEntryReversed(db, { orgId: f.org.orgId, entryId: source, actorId: f.actor });
        return replicaOf(f, id);
      });
      assert.equal(reversal.header?.reverses_entry_id, original.replicaId);
      assert.deepEqual(
        reversal.lines.map((line) => [line.account_id, line.amount, line.txn_amount, line.fx_rate]),
        [
          [f.org.accounts.bank, "-68.0000", "-100.0000", "0.6800000000"],
          [firstRevenue, "68.0000", "100.0000", "0.6800000000"],
        ],
      );
    }),
);

async function prepaidSource(f: Fixture, currencyEffectiveFrom = "2026-07-01") {
  const prepaid = await f.account("asset_current_other");
  const bookPrepaid = await f.account("asset_current_other");
  const expense = await f.account("expense");
  const bookExpense = await f.account("expense");
  const template = randomUUID();
  const document = randomUUID();
  const line = randomUUID();
  const currency = f.baseCurrency === "EUR" ? "USD" : "EUR";
  await withOrgContext(f.org.orgId, async () => {
    await db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{features,expenseAmortization}', 'true'::jsonb) where id = ${f.org.orgId}`,
    );
    await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${f.org.orgId}, ${f.baseCurrency}, ${currency}, '2026-07-01', 'spot', '0.68')`);
    await db.execute(sql`insert into expense_amortization_templates
      (id, org_id, code, name, effective_from, method, term_source, period_count, deferral_account_id, destination_account_id, created_by, updated_by)
      values (${template}, ${f.org.orgId}, 'PREPAID', 'Prepaid expense', '2026-07-01', 'straight_line', 'template', 1, ${prepaid}, ${expense}, ${f.actor}, ${f.actor})`);
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${document}, ${f.org.orgId}, 'vendor_bill', 'draft', 'B-PREPAID', ${f.org.vendorId}, ${f.org.subsidiaryId}, ${f.org.date}, ${f.org.date}, ${f.baseCurrency}, 1, 100, 0, 100, ${f.actor})`);
    await db.execute(sql`insert into document_lines
      (id, org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, amortization_template_id, created_by)
      values (${line}, ${f.org.orgId}, ${document}, 1, ${expense}, 1, 100, 100, 0, ${template}, ${f.actor})`);
  });
  await createBookCurrencyVersion({
    orgId: f.org.orgId,
    actorId: f.actor,
    allowedSubsidiaryIds: null,
    input: {
      bookId: f.book,
      subsidiaryId: f.org.subsidiaryId,
      currency,
      rateType: "spot",
      effectiveFrom: currencyEffectiveFrom,
    },
    reason: "Measure prepaid costs in the book currency",
  });
  for (const [sourceAccountId, targetAccountId] of [
    [prepaid, bookPrepaid],
    [expense, bookExpense],
  ]) {
    await createBookAccountMap({
      orgId: f.org.orgId,
      actorId: f.actor,
      allowedSubsidiaryIds: null,
      input: {
        bookId: f.book,
        sourceAccountId: sourceAccountId!,
        targetAccountId: targetAccountId!,
        effectiveFrom: "2026-07-01",
      },
      reason: "Present prepaid costs in the book chart",
    });
  }
  const post = () =>
    withOrgTransaction(f.org.orgId, async () => {
      await submitAndReleaseIfUngated("vendor_bill", document, f.actor);
      return postDocument(
        document,
        { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } },
        { audit: { actorId: f.actor, source: "test" } },
      );
    });
  return { prepaid, bookPrepaid, expense, bookExpense, document, line, template, currency, post };
}

test(
  "a prepaid document creates and releases one reconciled schedule per book without retranslation",
  enabled,
  () =>
    fixture(async (f) => {
      const source = await prepaidSource(f);
      await activate(f);
      await source.post();
      const schedules = await withOrgContext(f.org.orgId, () =>
        db.execute<{
          book_id: string;
          currency: string;
          amount: string;
          deferral_account_id: string;
          destination_account_id: string;
        }>(
          sql`select book_id, currency, total_amount::text as amount, deferral_account_id, destination_account_id
    from expense_amortization_schedules where org_id = ${f.org.orgId} and source_line_id = ${source.line}`,
          "objects",
        ),
      );
      assert.equal(schedules.length, 2);
      assert.deepEqual(
        schedules.find((row) => row.book_id === f.org.bookId),
        {
          book_id: f.org.bookId,
          currency: f.baseCurrency,
          amount: "100.0000",
          deferral_account_id: source.prepaid,
          destination_account_id: source.expense,
        },
      );
      assert.deepEqual(
        schedules.find((row) => row.book_id === f.book),
        {
          book_id: f.book,
          currency: source.currency,
          amount: "68.0000",
          deferral_account_id: source.bookPrepaid,
          destination_account_id: source.bookExpense,
        },
      );
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
    values (${f.org.orgId}, ${f.baseCurrency}, ${source.currency}, '2026-07-31', 'spot', '0.91')`),
      );
      const run = await runExpenseAmortization({
        orgId: f.org.orgId,
        actorId: f.actor,
        periodId: f.org.periodId,
      });
      assert.equal(run.posted, 2);
      assert.deepEqual(run.problems, []);
      assert.deepEqual(run.totals, { [f.baseCurrency]: "100.0000", [source.currency]: "68.0000" });
      assert.equal(
        (
          await runExpenseAmortization({
            orgId: f.org.orgId,
            actorId: f.actor,
            periodId: f.org.periodId,
          })
        ).posted,
        0,
      );
      await withOrgContext(f.org.orgId, async () => {
        const rows = await reconcileDeferralAccounts(db, f.org.orgId, { asOf: "2026-07-31" });
        assert.ok(rows.some((row) => row.bookId === f.book && row.currency === source.currency));
        assert.ok(
          rows.every(
            (row) =>
              row.ledger === "0.0000" && row.subledger === "0.0000" && row.difference === "0.0000",
          ),
        );
        const releases = await db.execute<{ book_id: string; amount: string }>(
          sql`
      select e.book_id, l.amount::text from journal_entries e join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      where e.org_id = ${f.org.orgId} and e.origin = 'expense_amortization' and l.account_id in (${source.expense}, ${source.bookExpense})`,
          "objects",
        );
        assert.equal(releases.length, 2, "each book releases only its own measured schedule");
        assert.equal(releases.find((row) => row.book_id === f.book)?.amount, "68.0000");
      });
    }),
);

test("activation refuses already amortized history atomically", enabled, () =>
  fixture(async (f) => {
    const source = await prepaidSource(f);
    await source.post();
    await runExpenseAmortization({
      orgId: f.org.orgId,
      actorId: f.actor,
      periodId: f.org.periodId,
    });
    await assert.rejects(
      activate(f),
      (error: unknown) =>
        error instanceof AmortizationError && error.code === "amortization_book_history",
    );
    await withOrgContext(f.org.orgId, async () => {
      const book = (
        await db.execute<{ replication_mode: string }>(
          sql`select replication_mode from accounting_books where org_id = ${f.org.orgId} and id = ${f.book}`,
          "objects",
        )
      )[0]!;
      assert.equal(book.replication_mode, "adjustment_only");
      const entries = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from journal_entries where org_id = ${f.org.orgId} and book_id = ${f.book}`,
          "objects",
        )
      )[0]!;
      assert.equal(entries.count, 0, "the refused activation leaves no copies or schedules");
    });
  }),
);

test(
  "activation creates the secondary schedule from an untouched source's recorded line attribution",
  enabled,
  () =>
    fixture(async (f) => {
      const source = await prepaidSource(f);
      await source.post();
      await activate(f);
      await withOrgContext(f.org.orgId, async () => {
        const schedules = await db.execute<{ amount: string; account_id: string }>(
          sql`
      select total_amount::text as amount, deferral_account_id as account_id from expense_amortization_schedules
      where org_id = ${f.org.orgId} and source_line_id = ${source.line} and book_id = ${f.book}`,
          "objects",
        );
        assert.deepEqual(schedules, [{ amount: "68.0000", account_id: source.bookPrepaid }]);
        assert.ok(
          (await reconcileDeferralAccounts(db, f.org.orgId, { asOf: f.org.date })).every(
            (row) => row.difference === "0.0000",
          ),
        );
      });
    }),
);

test(
  "opening balances carry completed prepaid releases rather than the original deferral",
  enabled,
  () =>
    fixture(async (f) => {
      const source = await prepaidSource(f);
      await source.post();
      const amortization = await runExpenseAmortization({
        orgId: f.org.orgId,
        actorId: f.actor,
        periodId: f.org.periodId,
      });
      assert.equal(amortization.posted, 1);
      await withOrgContext(f.org.orgId, () =>
        db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${randomUUID()}, org_id, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
      from accounting_periods where org_id = ${f.org.orgId} and id = ${f.org.periodId}`),
      );
      await activate(f, { replicationFrom: "2026-08-01", openingStrategy: "opening_balances" });
      await withOrgContext(f.org.orgId, async () => {
        const amounts = await db.execute<{ account_id: string; amount: string }>(
          sql`
      select l.account_id, sum(l.amount)::text as amount from journal_entries e join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
      where e.org_id = ${f.org.orgId} and e.book_id = ${f.book} group by l.account_id`,
          "objects",
        );
        assert.equal(
          amounts.find((row) => row.account_id === source.bookExpense)?.amount,
          "68.0000",
        );
        assert.equal(
          amounts.find((row) => row.account_id === source.bookPrepaid)?.amount ?? "0.0000",
          "0.0000",
        );
      });
    }),
);

test(
  "a manual carried-in schedule uses the selected book's first release period for its measurement policy",
  enabled,
  () =>
    fixture(async (f) => {
      const source = await prepaidSource(f, "2026-07-15");
      const manual = await createManualSchedule({
        orgId: f.org.orgId,
        actorId: f.actor,
        bookId: f.book,
        subsidiaryId: f.org.subsidiaryId,
        templateId: source.template,
        totalAmount: "68",
        serviceStartOn: "2026-07-01",
        amortizeFromPeriod: "2026-08-01",
        reason: "Carry the prepaid balance into the new reporting book",
      });
      await withOrgContext(f.org.orgId, async () => {
        const schedule = (
          await db.execute<{
            currency: string;
            amount: string;
            deferral_account_id: string;
            destination_account_id: string;
          }>(
            sql`
      select currency, total_amount::text as amount, deferral_account_id, destination_account_id from expense_amortization_schedules
      where org_id = ${f.org.orgId} and id = ${manual.scheduleId}`,
            "objects",
          )
        )[0]!;
        assert.deepEqual(schedule, {
          currency: source.currency,
          amount: "68.0000",
          deferral_account_id: source.bookPrepaid,
          destination_account_id: source.bookExpense,
        });
      });
    }),
);
