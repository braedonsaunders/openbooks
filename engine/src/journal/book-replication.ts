import { neg } from "../money/money.ts";
/**
 * Replication of primary-book postings into full accounting books.
 *
 * A book in `full` mode receives every replicable primary posting dated on
 * or after its replication start, in the same transaction as the primary
 * posting: the book entry is the primary entry's lines, carried through the
 * book's account mappings and translated into the book currency by
 * postEntry, so a document never exists in the primary book without its
 * book copies. Replication is exactly-once (one book_entry_replications row
 * per book and source entry, plus the replica's idempotency key), never
 * edits posted history, and mirrors corrections: a reversal replicates as a
 * reversal of the replica, and marking a primary entry reversed marks its
 * replicas reversed. Each book's own period locks apply to its replica, so a
 * closed book period refuses the primary posting rather than skipping it.
 *
 * What replicates: primary-book entries except
 *  - origins a book measures for itself (depreciation, disposals and asset
 *    revaluation, revenue recognition, allocations, FX revaluation,
 *    consolidation translation, provisions, year-end closing and book
 *    openings): each book runs those engines on its own schedules;
 *  - entries a per-book engine marked book-specific (custom.bookSpecific);
 *  - book-specific journals (documents.accounting_book_id is set);
 *  - reversals of any entry above.
 * Realized FX settlement entries replicate for subsidiaries the book carries
 * in their functional currency; a translated subsidiary's settlement lines
 * are left out, because they remeasure the functional ledger and the book
 * measures its own currency differences.
 */
import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import {
  closeModuleForDocument,
  DOCUMENT_KINDS,
  type CloseModule,
} from "../periods/period-policy.ts";
import { resolveBookBases, type BookProfile } from "./book-basis.ts";
import { isIdentityBasis } from "./book-translation.ts";
import type { PostEntryInput, PostEntryLineInput, PostEntryResult } from "./post-entry.ts";

/** Origins every book measures for itself; never replicated. */
export const BOOK_MEASURED_ORIGINS = [
  "depreciation",
  "disposal",
  "revaluation",
  "revenue_recognition",
  "allocation",
  "fx_revaluation",
  "currency_adjustment",
  "translation",
  "provision",
  "closing",
  "opening",
  "expense_amortization",
  "account_merge",
  "book_opening",
  "net_investment_oci",
] as const;

/** Origins that remeasure the functional ledger (left out of translated subsidiaries). */
export const FUNCTIONAL_REMEASUREMENT_ORIGINS = ["fx_settlement"] as const;

/**
 * The replicable-entry predicate over a journal_entries alias, shared by the
 * posting hook, activation backfill, catch-up and the completeness check so
 * all four agree on what a full book must hold.
 */
export function replicableEntrySql(alias: string): SQL {
  const e = sql`${sql.identifier(alias)}`;
  const base = (x: SQL) => sql`(
    ${x}.origin <> all(${`{${BOOK_MEASURED_ORIGINS.join(",")}}`}::text[])
    and coalesce(${x}.custom->>'bookSpecific', 'false') <> 'true'
    and not exists (
      select 1 from documents book_doc
       where book_doc.org_id = ${x}.org_id and book_doc.id = ${x}.source_document_id
         and book_doc.accounting_book_id is not null))`;
  return sql`(
    ${e}.status in ('posted', 'reversed')
    and exists (select 1 from accounting_books source_book
                 where source_book.org_id = ${e}.org_id and source_book.id = ${e}.book_id and source_book.is_primary)
    and ${base(e)}
    and (${e}.reverses_entry_id is null or exists (
      select 1 from journal_entries reversed_source
       where reversed_source.org_id = ${e}.org_id and reversed_source.id = ${e}.reverses_entry_id
         and ${base(sql`reversed_source`)})))`;
}

type PostEntryFn = (executor: SqlExecutor, input: PostEntryInput) => Promise<PostEntryResult>;

export interface ReplicationOutcome {
  bookId: string;
  sourceEntryId: string;
  outcome: "replicated" | "excluded" | "already";
  replicaEntryId: string | null;
}

interface SourceHeader {
  id: string;
  org_id: string;
  book_id: string;
  subsidiary_id: string;
  entry_number: string;
  posting_date: string;
  period_id: string;
  memo: string | null;
  origin: string;
  reverses_entry_id: string | null;
  source_document_id: string | null;
  document_kind: string | null;
  replicable: boolean;
}

interface SourceLine {
  eliminate: boolean;
  is_currency_adjustment: boolean;
  line_number: number;
  account_id: string;
  subsidiary_id: string;
  amount: string;
  currency: string;
  txn_amount: string;
  fx_rate: string;
  memo: string | null;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  equipment_unit_id: string | null;
  payment_card_id: string | null;
  tax_code_id: string | null;
  extra_dims: Record<string, unknown> | null;
  quantity: string | null;
  unit: string | null;
  due_date: string | null;
  custom: Record<string, unknown> | null;
  contributor_kind: string | null;
  contributor_ref: string | null;
}

async function loadSource(
  executor: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<SourceHeader | null> {
  return (
    (
      await executor.execute<SourceHeader & Record<string, unknown>>(
        sql`
    select e.id, e.org_id, e.book_id, e.subsidiary_id, e.entry_number, e.posting_date::text as posting_date,
           e.period_id, e.memo, e.origin, e.reverses_entry_id, e.source_document_id,
           d.kind as document_kind, ${replicableEntrySql("e")} as replicable
      from journal_entries e
      left join documents d on d.org_id = e.org_id and d.id = e.source_document_id
     where e.org_id = ${orgId} and e.id = ${entryId}`,
        "objects",
      )
    )[0] ?? null
  );
}

/**
 * The organization's full books (the caller filters by start date). Every
 * active secondary book row is share-locked (whatever its mode) so a
 * concurrent activation either sees this posting's commit or this posting
 * sees the activation: activation updates the book row before it selects
 * the history it backfills.
 */
async function lockFullBooks(
  executor: SqlExecutor,
  orgId: string,
  onlyBookId?: string,
): Promise<(BookProfile & { replicationFrom: string })[]> {
  const rows = await executor.execute<{
    id: string;
    code: string;
    name: string;
    replication_mode: "adjustment_only" | "full";
    replication_from: string | null;
    currency_difference_account_id: string | null;
    posts_gl: boolean;
  }>(
    sql`
    select id, code, name, replication_mode, replication_from::text as replication_from,
           currency_difference_account_id, posts_gl
      from accounting_books
     where org_id = ${orgId} and not is_primary and is_active
       ${onlyBookId ? sql`and id = ${onlyBookId}` : sql``}
     order by id
     for share`,
    "objects",
  );
  return rows
    .filter(
      (row): row is typeof row & { replication_from: string } =>
        row.posts_gl && row.replication_mode === "full" && row.replication_from !== null,
    )
    .map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      isPrimary: false,
      replicationMode: row.replication_mode,
      replicationFrom: row.replication_from,
      currencyDifferenceAccountId: row.currency_difference_account_id,
    }));
}

async function loadEntryLines(
  executor: SqlExecutor,
  orgId: string,
  entryId: string,
): Promise<SourceLine[]> {
  return await executor.execute<SourceLine & Record<string, unknown>>(
    sql`
    select line_number, eliminate, is_currency_adjustment, account_id, subsidiary_id, amount::text as amount, currency,
           txn_amount::text as txn_amount, fx_rate::text as fx_rate, memo, party_id, department_id,
           project_id, location_id, class_id, equipment_unit_id, payment_card_id, tax_code_id,
           extra_dims, quantity::text as quantity, unit, due_date::text as due_date, custom,
           contributor_kind, contributor_ref
      from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId}
     order by line_number`,
    "objects",
  );
}

/**
 * Replicate one primary entry into every full book that must hold it (or
 * only `onlyBookId`). Joins the caller's transaction. Returns one outcome per
 * book considered; an entry that is not replicable returns nothing.
 */
export async function replicateEntryToBooks(
  executor: SqlExecutor,
  post: PostEntryFn,
  args: {
    orgId: string;
    sourceEntryId: string;
    actorId?: string | null;
    runId?: string | null;
    onlyBookId?: string;
    requestId?: string | null;
  },
): Promise<ReplicationOutcome[]> {
  // Books first: an organization without a full book pays one query.
  const fullBooks = await lockFullBooks(executor, args.orgId, args.onlyBookId);
  if (fullBooks.length === 0) return [];
  const source = await loadSource(executor, args.orgId, args.sourceEntryId);
  if (!source || !source.replicable) return [];
  const books = fullBooks.filter((book) => book.replicationFrom <= source.posting_date);
  if (books.length === 0) return [];
  const lines = await loadEntryLines(executor, args.orgId, source.id);
  if (lines.length === 0) {
    throw new Error(`journal entry ${source.entry_number} has no lines to replicate`);
  }
  // The book's GL lock always applies; a source document's own module lock
  // applies too, exactly as it did to the primary posting.
  const closeModules: CloseModule[] =
    source.document_kind && (DOCUMENT_KINDS as readonly string[]).includes(source.document_kind)
      ? [closeModuleForDocument(source.document_kind)]
      : [];
  const outcomes: ReplicationOutcome[] = [];
  for (const book of books) {
    const existing = (
      await executor.execute<{ replica_entry_id: string | null; outcome: string }>(
        sql`
      select replica_entry_id, outcome from book_entry_replications
       where org_id = ${args.orgId} and book_id = ${book.id} and source_entry_id = ${source.id}`,
        "objects",
      )
    )[0];
    if (existing) {
      outcomes.push({
        bookId: book.id,
        sourceEntryId: source.id,
        outcome: "already",
        replicaEntryId: existing.replica_entry_id,
      });
      continue;
    }
    const bases = await resolveBookBases(executor, {
      orgId: args.orgId,
      book,
      subsidiaryIds: lines.map((line) => line.subsidiary_id),
      postingDate: source.posting_date,
    });
    const remeasurement = (FUNCTIONAL_REMEASUREMENT_ORIGINS as readonly string[]).includes(
      source.origin,
    );
    const omitted = new Set<string>();
    const carried = lines.filter((line) => {
      const basis = bases.get(line.subsidiary_id)!;
      if (remeasurement && !isIdentityBasis(basis)) {
        omitted.add(line.subsidiary_id);
        return false;
      }
      return true;
    });
    if (carried.length === 0) {
      await recordReplication(executor, {
        orgId: args.orgId,
        bookId: book.id,
        sourceEntryId: source.id,
        replicaEntryId: null,
        outcome: "excluded",
        detail: { reason: "functional_remeasurement", omittedSubsidiaryIds: [...omitted] },
        runId: args.runId ?? null,
        actorId: args.actorId ?? null,
      });
      outcomes.push({
        bookId: book.id,
        sourceEntryId: source.id,
        outcome: "excluded",
        replicaEntryId: null,
      });
      continue;
    }
    const reversesReplica = source.reverses_entry_id
      ? ((
          await executor.execute<{ replica_entry_id: string | null }>(
            sql`
          select replica_entry_id from book_entry_replications
           where org_id = ${args.orgId} and book_id = ${book.id} and source_entry_id = ${source.reverses_entry_id}`,
            "objects",
          )
        )[0]?.replica_entry_id ?? null)
      : null;
    // A governed reversal mirrors the original book copy at its recorded
    // accounts and rates; a later mapping or quote cannot reinterpret it.
    const mirrored = reversesReplica
      ? await loadEntryLines(executor, args.orgId, reversesReplica)
      : null;
    if (mirrored?.length === 0)
      throw new Error(`The original entry in book ${book.code} has no reversal lines`);
    const bookLines: PostEntryLineInput[] = (mirrored ?? carried).map((line) => ({
      lineNumber: line.line_number,
      accountId: line.account_id,
      eliminate: line.eliminate,
      isCurrencyAdjustment: line.is_currency_adjustment,
      subsidiaryId: line.subsidiary_id,
      amount: mirrored ? neg(line.amount) : line.amount,
      currency: line.currency,
      txnAmount: mirrored ? neg(line.txn_amount) : line.txn_amount,
      fxRate: line.fx_rate,
      memo: line.memo,
      partyId: line.party_id,
      departmentId: line.department_id,
      projectId: line.project_id,
      locationId: line.location_id,
      classId: line.class_id,
      equipmentUnitId: line.equipment_unit_id,
      paymentCardId: line.payment_card_id,
      taxCodeId: line.tax_code_id,
      extraDims: line.extra_dims ?? {},
      quantity: mirrored && line.quantity !== null ? neg(line.quantity) : line.quantity,
      unit: line.unit,
      dueDate: line.due_date,
      // Open items settle in the primary book's subledger; a book copy is
      // a ledger balance, never a second open item.
      isOpenItem: false,
      custom: line.custom ?? {},
      contributorKind: line.contributor_kind,
      contributorRef: line.contributor_ref,
    }));
    const posted = await post(executor, {
      orgId: args.orgId,
      bookId: book.id,
      subsidiaryId: source.subsidiary_id,
      entryNumber: await nextFreeEntryNumber(
        executor,
        args.orgId,
        `${source.entry_number}-${book.code}`,
      ),
      postingDate: source.posting_date,
      periodId: source.period_id,
      memo: source.memo,
      origin: source.origin,
      reversesEntryId: reversesReplica,
      sourceDocumentId: source.source_document_id,
      custom: { bookReplicaOf: source.id },
      actorId: args.actorId ?? null,
      idempotencyKey: `book-replica:${book.id}:${source.id}`,
      closeModules,
      amountBasis: mirrored ? "book" : "functional",
      accountBasis: mirrored ? "book" : "source",
      allowInactiveAccounts: true,
      auditAction: "replicate",
      requestId: args.requestId ?? null,
      auditChanges: { bookReplicaOf: source.id, omittedSubsidiaryIds: [...omitted] },
      lines: bookLines,
    });
    await recordReplication(executor, {
      orgId: args.orgId,
      bookId: book.id,
      sourceEntryId: source.id,
      replicaEntryId: posted.entryId,
      outcome: "replicated",
      detail:
        omitted.size > 0
          ? { omittedSubsidiaryIds: [...omitted], reason: "functional_remeasurement" }
          : {},
      runId: args.runId ?? null,
      actorId: args.actorId ?? null,
    });
    outcomes.push({
      bookId: book.id,
      sourceEntryId: source.id,
      outcome: "replicated",
      replicaEntryId: posted.entryId,
    });
  }
  return outcomes;
}

async function recordReplication(
  executor: SqlExecutor,
  args: {
    orgId: string;
    bookId: string;
    sourceEntryId: string;
    replicaEntryId: string | null;
    outcome: "replicated" | "excluded";
    detail: Record<string, unknown>;
    runId: string | null;
    actorId: string | null;
  },
): Promise<void> {
  const inserted = (
    await executor.execute<{ id: string }>(
      sql`
    insert into book_entry_replications (org_id, book_id, source_entry_id, replica_entry_id, outcome, detail, run_id, created_by)
    values (${args.orgId}, ${args.bookId}, ${args.sourceEntryId}, ${args.replicaEntryId}, ${args.outcome},
            ${JSON.stringify(args.detail)}::jsonb, ${args.runId}, ${args.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!inserted)
    throw new Error(
      `replication of entry ${args.sourceEntryId} into book ${args.bookId} was not recorded`,
    );
}

/**
 * The live replicas of a primary entry: marking the primary entry reversed
 * marks these reversed in the same transaction.
 */
export async function liveReplicaEntryIds(
  executor: SqlExecutor,
  orgId: string,
  sourceEntryId: string,
): Promise<string[]> {
  return (
    await executor.execute<{ id: string }>(
      sql`
    select r.replica_entry_id as id
      from book_entry_replications r
      join journal_entries replica on replica.org_id = r.org_id and replica.id = r.replica_entry_id
     where r.org_id = ${orgId} and r.source_entry_id = ${sourceEntryId}
       -- Live entries only: an already reversed copy is not marked again.
       and r.replica_entry_id is not null and replica.status = 'posted'
     order by r.replica_entry_id`,
      "objects",
    )
  ).map((row) => row.id);
}

export interface BookReplicationGaps {
  /** Replicable primary entries in scope that the full book does not hold. */
  missing: number;
  /** The earliest missing entries, for the operator's remedy. */
  sample: { entryId: string; entryNumber: string; postingDate: string }[];
}

/**
 * Completeness proof for a full book: every replicable primary entry dated
 * from the replication start through `through` must have a replication
 * record for the book. Adjustment-only books have nothing to prove. Scoped
 * to entries touching `subsidiaryIds` when given (entity-scoped closes).
 */
export async function bookReplicationGaps(
  executor: SqlExecutor,
  args: { orgId: string; bookId: string; through: string; subsidiaryIds?: readonly string[] },
): Promise<BookReplicationGaps> {
  const book = (
    await executor.execute<{ replication_mode: string; replication_from: string | null }>(
      sql`
    select replication_mode, replication_from::text as replication_from
      from accounting_books where org_id = ${args.orgId} and id = ${args.bookId}`,
      "objects",
    )
  )[0];
  if (!book || book.replication_mode !== "full" || !book.replication_from)
    return { missing: 0, sample: [] };
  const scope = args.subsidiaryIds
    ? args.subsidiaryIds.length === 0
      ? sql`and false`
      : sql`and exists (select 1 from journal_lines scoped
                         where scoped.org_id = e.org_id and scoped.entry_id = e.id
                           and scoped.subsidiary_id = any(${`{${args.subsidiaryIds.join(",")}}`}::uuid[]))`
    : sql``;
  const rows = await executor.execute<{
    id: string;
    entry_number: string;
    posting_date: string;
    total: number;
  }>(
    sql`
    select e.id, e.entry_number, e.posting_date::text as posting_date, count(*) over ()::int as total
      from journal_entries e
     where e.org_id = ${args.orgId}
       and e.posting_date >= ${book.replication_from}::date and e.posting_date <= ${args.through}::date
       and ${replicableEntrySql("e")}
       and not exists (select 1 from book_entry_replications r
                        where r.org_id = e.org_id and r.book_id = ${args.bookId} and r.source_entry_id = e.id)
       ${scope}
     order by e.posting_date, e.id
     limit 20`,
    "objects",
  );
  return {
    missing: rows[0]?.total ?? 0,
    sample: rows.map((row) => ({
      entryId: row.id,
      entryNumber: row.entry_number,
      postingDate: row.posting_date,
    })),
  };
}

/**
 * Close readiness for a period's book: a full book proves its own
 * completeness; the primary book's close proves every full book's, because
 * those books are the primary postings' copies.
 */
export async function bookReplicationReadiness(
  executor: SqlExecutor,
  args: { orgId: string; bookId: string; through: string; subsidiaryIds?: readonly string[] },
): Promise<{ missing: number; books: { bookId: string; code: string; missing: number }[] }> {
  const books = await executor.execute<{ id: string; code: string }>(
    sql`
    select b.id, b.code from accounting_books b
     where b.org_id = ${args.orgId} and b.replication_mode = 'full' and b.is_active
       and (b.id = ${args.bookId} or exists (
         select 1 from accounting_books run_book
          where run_book.org_id = b.org_id and run_book.id = ${args.bookId} and run_book.is_primary))
     order by b.code, b.id`,
    "objects",
  );
  const out: { bookId: string; code: string; missing: number }[] = [];
  for (const book of books) {
    const gaps = await bookReplicationGaps(executor, {
      orgId: args.orgId,
      bookId: book.id,
      through: args.through,
      subsidiaryIds: args.subsidiaryIds,
    });
    if (gaps.missing > 0) out.push({ bookId: book.id, code: book.code, missing: gaps.missing });
  }
  return { missing: out.reduce((sum, book) => sum + book.missing, 0), books: out };
}

/**
 * Replicable primary entries dated on or after `from` that `bookId` does not
 * hold yet, in posting order (an original before its reversal).
 */
export async function unreplicatedEntryIds(
  executor: SqlExecutor,
  args: { orgId: string; bookId: string; from: string },
): Promise<string[]> {
  return (
    await executor.execute<{ id: string }>(
      sql`
    select e.id
      from journal_entries e
     where e.org_id = ${args.orgId} and e.posting_date >= ${args.from}::date
       and ${replicableEntrySql("e")}
       and not exists (select 1 from book_entry_replications r
                        where r.org_id = e.org_id and r.book_id = ${args.bookId} and r.source_entry_id = e.id)
     order by e.posting_date, e.created_at, e.id`,
      "objects",
    )
  ).map((row) => row.id);
}
