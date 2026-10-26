import { createSchedulesForReplicatedDocument } from "../amortization/source-posting.ts";
/**
 * Governed changes to a secondary book's replication: activation of full
 * replication (with its backfill), catch-up, deactivation, and the book's
 * currency difference account. Each change records an
 * accounting_book_replication_runs row in its own transaction — the storage
 * guard admits a settings change only alongside one — with the actor and
 * reason, and audits the book's before and after state.
 *
 * Activation from a date D:
 *  - `full_history` replicates every replicable primary entry; it is refused
 *    while the primary book holds replicable entries dated before D.
 *  - `opening_balances` posts one opening entry per subsidiary on D carrying
 *    each account's balance from primary entries dated before D, including
 *    prepaid releases and account reclasses,
 *    (by transaction currency), measured at D's rate: balances in the
 *    book's currency carry their amount; foreign balances restate at the
 *    rate the book uses on D. Whatever does not balance after restatement
 *    posts to the book's currency difference account.
 * Either way the book then receives every replicable primary entry dated on
 * or after D, in posting order, in the activation transaction. A book
 * activated before resumes from its fixed start date and catches up.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { assertUnrestrictedScope } from "../organization/subsidiary-scope.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { PNL_TYPES } from "../records/account-types.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { fromUnits, mulRate, toUnits } from "../money/money.ts";
import { accountClassOf, loadMappableAccounts } from "../journal/book-account-maps.ts";
import { resolveBookBases, resolveBookRates, type BookProfile } from "../journal/book-basis.ts";
import {
  replicableEntrySql,
  replicateEntryToBooks,
  unreplicatedEntryIds,
} from "../journal/book-replication.ts";
import {
  BookTranslationError,
  rateKey,
  type BookSubsidiaryBasis,
} from "../journal/book-translation.ts";
import { postEntry, type PostEntryLineInput } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { MultiBookError, multiBookStorageRefusal } from "./errors.ts";
import {
  lockSecondaryBook,
  requireDate,
  requireMultiBookFeature,
  requireReason,
} from "./settings.ts";

export const BOOK_REPLICATION_CHANGE_KINDS = [
  "activation",
  "catch_up",
  "deactivation",
  "settings",
] as const;
export type BookReplicationChangeKind = (typeof BOOK_REPLICATION_CHANGE_KINDS)[number];

export interface BookReplicationRunRow {
  id: string;
  bookId: string;
  kind: BookReplicationChangeKind;
  modeBefore: string;
  modeAfter: string;
  replicationFrom: string | null;
  openingStrategy: string | null;
  openingEntryIds: string[];
  replicatedCount: number;
  excludedCount: number;
  reason: string;
  createdAt: string;
  createdBy: string;
}

const RUN_COLUMNS = sql`
  id, book_id as "bookId", kind, mode_before as "modeBefore", mode_after as "modeAfter",
  replication_from::text as "replicationFrom", opening_strategy as "openingStrategy",
  opening_entry_ids as "openingEntryIds", replicated_count as "replicatedCount",
  excluded_count as "excludedCount", reason, created_at::text as "createdAt", created_by as "createdBy"`;

export async function listBookReplicationRuns(
  orgId: string,
  runner: SqlExecutor = db,
): Promise<BookReplicationRunRow[]> {
  return await runner.execute<BookReplicationRunRow & Record<string, unknown>>(
    sql`
    select ${RUN_COLUMNS} from accounting_book_replication_runs
     where org_id = ${orgId} order by created_at desc, id desc`,
    "objects",
  );
}

/** The currency difference account must be a postable P&L or equity account. */
async function requireDifferenceAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: unknown,
): Promise<string | null> {
  if (accountId == null || accountId === "") return null;
  if (typeof accountId !== "string")
    throw new MultiBookError("choose the currency difference account from the chart of accounts");
  const account = (await loadMappableAccounts(runner, orgId, [accountId])).get(accountId);
  if (!account)
    throw new MultiBookError("currency difference account not found in this organization", 404);
  if (account.isSummary || !account.isActive)
    throw new MultiBookError(`${account.label} must be an active posting account`);
  const accountClass = accountClassOf(account.type);
  if (accountClass !== "income" && accountClass !== "expense" && accountClass !== "equity") {
    throw new MultiBookError(
      `${account.label} is ${accountClass ?? account.type}; book currency differences post to an income, expense or equity account`,
    );
  }
  if (account.currencyRestriction) {
    throw new MultiBookError(
      `${account.label} only accepts ${account.currencyRestriction} postings; currency differences post in each book currency`,
    );
  }
  return account.id;
}

/**
 * Record a governed replication change for one secondary book. Activation
 * and catch-up replicate in the same transaction, so the change either
 * completes with the book holding every replicable entry from its start
 * date or refuses as a whole (a closed book period, a missing rate or an
 * incompatible mapping names its remedy).
 */
export async function changeBookReplication(args: {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  input: {
    bookId: unknown;
    kind: unknown;
    replicationFrom?: unknown;
    openingStrategy?: unknown;
    currencyDifferenceAccountId?: unknown;
  };
  reason: unknown;
}): Promise<BookReplicationRunRow> {
  assertUnrestrictedScope(args.allowedSubsidiaryIds);
  const reason = requireReason(args.reason);
  const kind = args.input.kind;
  if (
    typeof kind !== "string" ||
    !(BOOK_REPLICATION_CHANGE_KINDS as readonly string[]).includes(kind)
  ) {
    throw new MultiBookError("choose activation, catch_up, deactivation or settings");
  }
  try {
    return await withOrgTransaction(args.orgId, async () => {
      await requireMultiBookFeature(db, args.orgId);
      // Exclusive against document posting for the whole change; direct
      // postings serialize on the book row locked next.
      await lockLedgerSetupFence(db, args.orgId, "exclusive");
      const book = await lockSecondaryBook(db, args.orgId, args.input.bookId);
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:book-replication:${args.orgId}:${book.id}`}, 0))`,
      );
      if (!book.isActive || !book.postsGl)
        throw new MultiBookError(`${book.code} is not an active posting book`);
      const before = {
        replicationMode: book.replicationMode,
        replicationFrom: book.replicationFrom,
        currencyDifferenceAccountId: book.currencyDifferenceAccountId,
      };
      const differenceAccountId =
        args.input.currencyDifferenceAccountId === undefined
          ? book.currencyDifferenceAccountId
          : await requireDifferenceAccount(db, args.orgId, args.input.currencyDifferenceAccountId);

      let modeAfter = book.replicationMode;
      let replicationFrom = book.replicationFrom;
      let openingStrategy: "full_history" | "opening_balances" | null = null;
      let resumed = false;
      if (kind === "activation") {
        if (book.replicationMode === "full")
          throw new MultiBookError(
            `${book.code} already replicates in full; record a catch-up to fill gaps`,
          );
        if (book.replicationFrom) {
          const requested =
            args.input.replicationFrom == null || args.input.replicationFrom === ""
              ? book.replicationFrom
              : requireDate(args.input.replicationFrom, "replicate from");
          if (requested !== book.replicationFrom) {
            throw new MultiBookError(
              `${book.code} replicates from ${book.replicationFrom}; that start date is fixed, and reactivation catches up from it`,
            );
          }
          openingStrategy = "full_history";
          resumed = true;
        } else {
          replicationFrom = requireDate(args.input.replicationFrom, "replicate from");
          const strategy = args.input.openingStrategy;
          if (strategy !== "full_history" && strategy !== "opening_balances") {
            throw new MultiBookError(
              "choose how history before the start date enters the book: full_history or opening_balances",
            );
          }
          openingStrategy = strategy;
          if (strategy === "full_history") {
            const earlier =
              (
                await db.execute<{ n: number }>(
                  sql`
              select count(*)::int as n from journal_entries e
               where e.org_id = ${args.orgId} and e.posting_date < ${replicationFrom}::date
                 and ${replicableEntrySql("e")}`,
                  "objects",
                )
              )[0]?.n ?? 0;
            if (earlier > 0) {
              throw new MultiBookError(
                `the primary book holds ${earlier} entr${earlier === 1 ? "y" : "ies"} dated before ${replicationFrom}; start on or before the first entry, or bring that history in as opening balances`,
              );
            }
          }
        }
        modeAfter = "full";
      } else if (kind === "catch_up") {
        if (book.replicationMode !== "full" || !book.replicationFrom)
          throw new MultiBookError(`${book.code} does not replicate in full; activate it first`);
      } else if (kind === "deactivation") {
        if (book.replicationMode !== "full")
          throw new MultiBookError(`${book.code} does not replicate in full`);
        modeAfter = "adjustment_only";
      } else if (args.input.currencyDifferenceAccountId === undefined) {
        throw new MultiBookError("a settings change names the book's currency difference account");
      }

      const run = (
        await db.execute<{ id: string }>(
          sql`
        insert into accounting_book_replication_runs
          (org_id, book_id, kind, mode_before, mode_after, replication_from, opening_strategy, settings, reason, created_by)
        values (${args.orgId}, ${book.id}, ${kind}, ${book.replicationMode}, ${modeAfter}, ${replicationFrom}::date,
                ${openingStrategy}, ${JSON.stringify({ currencyDifferenceAccountId: differenceAccountId, resumed })}::jsonb,
                ${reason}, ${args.actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!run) throw new Error("replication run insert returned no row");

      const updated = (
        await db.execute<{ id: string }>(
          sql`
        update accounting_books
           set replication_mode = ${modeAfter}, replication_from = ${replicationFrom}::date,
               currency_difference_account_id = ${differenceAccountId},
               updated_at = now(), updated_by = ${args.actorId}
         where org_id = ${args.orgId} and id = ${book.id}
        returning id`,
          "objects",
        )
      )[0];
      if (!updated)
        throw new MultiBookError(
          "the book changed while you were saving; reload and try again",
          409,
        );

      let openingEntryIds: string[] = [];
      let replicated = 0;
      let excluded = 0;
      if (kind === "activation" || kind === "catch_up") {
        const profile: BookProfile = {
          id: book.id,
          code: book.code,
          name: book.name,
          isPrimary: false,
          replicationMode: "full",
          replicationFrom,
          currencyDifferenceAccountId: differenceAccountId,
        };
        if (kind === "activation" && openingStrategy === "opening_balances" && !resumed) {
          openingEntryIds = await postOpeningBalances(db, {
            orgId: args.orgId,
            actorId: args.actorId,
            book: profile,
            from: replicationFrom!,
            runId: run.id,
          });
        }
        for (const entryId of await unreplicatedEntryIds(db, {
          orgId: args.orgId,
          bookId: book.id,
          from: replicationFrom!,
        })) {
          const outcomes = await replicateEntryToBooks(db, postEntry, {
            orgId: args.orgId,
            sourceEntryId: entryId,
            actorId: args.actorId,
            runId: run.id,
            onlyBookId: book.id,
            requestId: "book_replication",
          });
          for (const outcome of outcomes) {
            if (outcome.outcome === "replicated") {
              replicated += 1;
              if (outcome.replicaEntryId)
                await createSchedulesForReplicatedDocument(db, {
                  orgId: args.orgId,
                  sourceEntryId: entryId,
                  replicaEntryId: outcome.replicaEntryId,
                  actorId: args.actorId,
                });
            } else if (outcome.outcome === "excluded") excluded += 1;
          }
        }
      }
      const sealed = (
        await db.execute<BookReplicationRunRow & Record<string, unknown>>(
          sql`
        update accounting_book_replication_runs
           set replicated_count = ${replicated}, excluded_count = ${excluded},
               opening_entry_ids = ${`{${openingEntryIds.join(",")}}`}::uuid[]
         where org_id = ${args.orgId} and id = ${run.id}
        returning ${RUN_COLUMNS}`,
          "objects",
        )
      )[0];
      if (!sealed) throw new Error("replication run outcome was not recorded");
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${args.orgId}, 'accounting_books', ${book.id}, 'update',
                ${JSON.stringify({
                  before,
                  after: {
                    replicationMode: modeAfter,
                    replicationFrom,
                    currencyDifferenceAccountId: differenceAccountId,
                  },
                  reason,
                  replicationRun: {
                    id: run.id,
                    kind,
                    openingStrategy,
                    replicated,
                    excluded,
                    openingEntryIds,
                  },
                })}::jsonb, ${args.actorId})`);
      return sealed;
    });
  } catch (error) {
    if (error instanceof PostingError || error instanceof BookTranslationError)
      throw new MultiBookError(error.message);
    throw multiBookStorageRefusal(error) ?? error;
  }
}

/**
 * Post the opening entries of an activation: per subsidiary, every account's
 * balance (by transaction currency), including prepaid releases and account
 * reclasses, from primary entries dated
 * before `from`, measured in the book currency on `from`.
 */
async function postOpeningBalances(
  runner: SqlExecutor,
  args: { orgId: string; actorId: string; book: BookProfile; from: string; runId: string },
): Promise<string[]> {
  const eligibleHistory = sql`(${replicableEntrySql("e")} or (
    e.book_id in (select id from accounting_books where org_id = ${args.orgId} and is_primary)
    and e.status in ('posted', 'reversed') and e.origin in ('expense_amortization', 'account_merge')
  ))`;
  const historySubsidiaries = (
    await runner.execute<{ subsidiary_id: string }>(
      sql`
    select distinct l.subsidiary_id
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${args.orgId} and e.posting_date < ${args.from}::date
       and ${eligibleHistory}
     order by l.subsidiary_id`,
      "objects",
    )
  ).map((row) => row.subsidiary_id);
  if (historySubsidiaries.length === 0) return [];

  const periods = new Map<string, NonNullable<Awaited<ReturnType<typeof resolveCoveringPeriod>>>>();
  const fiscalYearStarts = new Map<string, string>();
  for (const subsidiaryId of historySubsidiaries) {
    const period = await resolveCoveringPeriod(runner, args.orgId, args.from, subsidiaryId);
    if (!period)
      throw new MultiBookError(
        `no entity accounting period covers the book opening date ${args.from}`,
      );
    periods.set(subsidiaryId, period);
    const fiscalYearStart = (
      await runner.execute<{ starts_on: string | null }>(
        sql`
      select min(starts_on)::text as starts_on from accounting_periods
       where org_id = ${args.orgId} and fiscal_calendar_id = ${period.fiscal_calendar_id}
         and fiscal_year = ${period.fiscal_year} and not is_adjustment`,
        "objects",
      )
    )[0]?.starts_on;
    if (!fiscalYearStart) {
      throw new MultiBookError(
        `the subsidiary's fiscal calendar has no regular periods for fiscal year ${period.fiscal_year}; generate its periods and retry`,
      );
    }
    fiscalYearStarts.set(subsidiaryId, fiscalYearStart);
  }
  const pnlYearScope = sql.join(
    [...fiscalYearStarts].map(
      ([subsidiaryId, start]) =>
        sql`(l.subsidiary_id = ${subsidiaryId} and e.posting_date >= ${start}::date)`,
    ),
    sql` or `,
  );
  const balances = await runner.execute<{
    subsidiary_id: string;
    account_id: string;
    currency: string;
    amount: string;
    txn_amount: string;
    party_id: string | null;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
    class_id: string | null;
    equipment_unit_id: string | null;
    payment_card_id: string | null;
    tax_code_id: string | null;
    extra_dims: Record<string, unknown> | null;
    eliminate: boolean;
    quantity: string | null;
    unit: string | null;
  }>(
    sql`
    select l.subsidiary_id, coalesce(a.merged_into_id, l.account_id) as account_id, l.currency,
           sum(l.amount)::text as amount, sum(l.txn_amount)::text as txn_amount,
           l.party_id, l.department_id, l.project_id, l.location_id, l.class_id,
           l.equipment_unit_id, l.payment_card_id, l.tax_code_id, l.extra_dims, l.eliminate,
           sum(l.quantity)::text as quantity, l.unit
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${args.orgId} and e.posting_date < ${args.from}::date
       and ${eligibleHistory}
       and (a.type not in (${sql.join(
         PNL_TYPES.map((type) => sql`${type}`),
         sql`, `,
       )}) or (${pnlYearScope}))
     group by l.subsidiary_id, coalesce(a.merged_into_id, l.account_id), l.currency,
              l.party_id, l.department_id, l.project_id, l.location_id, l.class_id,
              l.equipment_unit_id, l.payment_card_id, l.tax_code_id, l.extra_dims, l.eliminate, l.unit
    having sum(l.amount) <> 0 or sum(l.txn_amount) <> 0
     order by l.subsidiary_id, account_id, l.currency`,
    "objects",
  );
  if (balances.length === 0) return [];
  const subsidiaryIds = [...new Set(balances.map((row) => row.subsidiary_id))];
  const bookBases = await resolveBookBases(runner, {
    orgId: args.orgId,
    book: args.book,
    subsidiaryIds,
    postingDate: args.from,
  });
  // Foreign balances restate at the rate the book uses on the start date:
  // the book's rate type for a translated subsidiary, spot otherwise.
  const restatement = new Map<string, BookSubsidiaryBasis>();
  for (const [id, basis] of bookBases) {
    restatement.set(id, {
      ...basis,
      functionalCurrency:
        basis.functionalCurrency === basis.bookCurrency ? "" : basis.functionalCurrency,
    });
  }
  const { rates } = await resolveBookRates(runner, {
    orgId: args.orgId,
    bookCode: args.book.code,
    postingDate: args.from,
    bases: restatement,
    lines: balances
      .filter((row) => toUnits(row.txn_amount) !== 0n)
      .map((row) => ({ subsidiaryId: row.subsidiary_id, currency: row.currency })),
  });
  const entryIds: string[] = [];
  for (const subsidiaryId of subsidiaryIds) {
    const period = periods.get(subsidiaryId)!;
    const basis = bookBases.get(subsidiaryId)!;
    const lines: PostEntryLineInput[] = [];
    let total = 0n;
    for (const row of balances.filter((balance) => balance.subsidiary_id === subsidiaryId)) {
      let line: PostEntryLineInput | null = null;
      if (row.currency === basis.bookCurrency) {
        // Already in the book currency: an identity book carries the
        // functional amount, a translated book the transaction amount.
        const amount =
          basis.functionalCurrency === basis.bookCurrency ? row.amount : row.txn_amount;
        line = {
          accountId: row.account_id,
          amount,
          currency: row.currency,
          txnAmount: amount,
          fxRate: "1",
        };
      } else if (toUnits(row.txn_amount) !== 0n) {
        const rate = rates.get(rateKey(subsidiaryId, row.currency));
        if (!rate)
          throw new MultiBookError(
            `no rate resolved for ${row.currency}→${basis.bookCurrency} on ${args.from}`,
          );
        line = {
          accountId: row.account_id,
          amount: mulRate(row.txn_amount, rate),
          currency: row.currency,
          txnAmount: row.txn_amount,
          fxRate: rate,
        };
      }
      if (!line || toUnits(line.amount) === 0n) continue;
      lines.push({
        ...line,
        subsidiaryId,
        partyId: row.party_id,
        departmentId: row.department_id,
        projectId: row.project_id,
        locationId: row.location_id,
        classId: row.class_id,
        equipmentUnitId: row.equipment_unit_id,
        paymentCardId: row.payment_card_id,
        taxCodeId: row.tax_code_id,
        extraDims: row.extra_dims ?? {},
        eliminate: row.eliminate,
        quantity: row.quantity,
        unit: row.unit,
        memo: `Opening balance ${args.from}`,
      });
      total += toUnits(line.amount);
    }
    if (total !== 0n) {
      if (!args.book.currencyDifferenceAccountId) {
        throw new MultiBookError(
          `opening balances for book ${args.book.code} leave a ${basis.bookCurrency} difference of ${fromUnits(-total)} for subsidiary ${subsidiaryId} after restatement; choose the book's currency difference account and activate again`,
        );
      }
      lines.push({
        accountId: args.book.currencyDifferenceAccountId,
        subsidiaryId,
        amount: fromUnits(-total),
        currency: basis.bookCurrency,
        txnAmount: fromUnits(-total),
        fxRate: "1",
        memo: `Opening balance currency difference ${args.from}`,
      });
    }
    if (lines.length === 0) continue;
    const posted = await postEntry(runner, {
      orgId: args.orgId,
      bookId: args.book.id,
      subsidiaryId,
      entryNumber: await nextFreeEntryNumber(
        runner,
        args.orgId,
        `OPEN-${args.book.code}-${args.from}`,
      ),
      postingDate: args.from,
      periodId: period.id,
      memo: `Opening balances for book ${args.book.code} from ${args.from}`,
      origin: "book_opening",
      actorId: args.actorId,
      currency: basis.bookCurrency,
      amountBasis: "book",
      allowInactiveAccounts: true,
      idempotencyKey: `book-opening:${args.runId}:${subsidiaryId}`,
      auditAction: "insert",
      requestId: "book_replication",
      auditChanges: { replicationRunId: args.runId, openingFrom: args.from },
      lines,
    });
    entryIds.push(posted.entryId);
  }
  return entryIds;
}
