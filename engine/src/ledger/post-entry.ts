import { sql } from "drizzle-orm";
import { assertPeriodModulesOpen, CloseError, type CloseModule } from "../close/period-policy.ts";
import { sum } from "../money/money.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { PostingError } from "./posting-contracts.ts";
import { assertFinalKernelBalance } from "./posting-invariants.ts";

/**
 * The ONE journal-write API for direct (non-document) postings. Every
 * journal_entries / journal_lines row the application creates flows through
 * postEntry (new postings) or markEntryReversed (the posted -> reversed
 * lifecycle marker), except the document-posting kernel
 * (commitDocumentPosting in posting-commit.ts), which is the ledger's own
 * sibling implementation for the document path: it keeps its
 * document-specific exactly-once machinery (entry-number allocation with a
 * savepoint-isolated unique-violation diagnosis, the approved -> posted
 * document flip, allocation lineage, secondary-book entries, and effects
 * outbox) while sharing every guard below. No module outside engine/src/ledger
 * writes these tables directly (scripts/check-ledger-journal-writes.mjs
 * enforces that boundary).
 *
 * One call owns the whole posting: the organization posting lock, balance
 * validation (whole entry and per subsidiary), the book / period / entity /
 * account guards, the open-period check behind the shared close/posting
 * fence, exactly-once numbering, the draft -> posted flip, and the audit
 * record. All lines of the entry go in ONE multi-row INSERT statement, which
 * is the invariant the statement-level balance triggers (migration 0381)
 * rely on: each touched entry is validated once per statement.
 *
 * Amounts are canonical ledger strings (no floats, ever). Errors are
 * LedgerPostError (a PostingError), naming the refused value and the remedy.
 */
export class LedgerPostError extends PostingError {
  readonly name = "LedgerPostError";
}

export interface PostEntryLineInput {
  accountId: string;
  /** Signed base amount: positive = debit, negative = credit. */
  amount: string;
  /** Legal entity of the leg; defaults to the entry subsidiary. */
  subsidiaryId?: string | null;
  currency?: string | null;
  txnAmount?: string | null;
  fxRate?: string | null;
  memo?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  equipmentUnitId?: string | null;
  paymentCardId?: string | null;
  taxCodeId?: string | null;
  extraDims?: Record<string, unknown> | null;
  quantity?: string | null;
  unit?: string | null;
  dueDate?: string | null;
  isOpenItem?: boolean;
  custom?: Record<string, unknown>;
  contributorKind?: string | null;
  contributorRef?: string | null;
  /** 1-based position; defaults to input order. Must be unique per entry. */
  lineNumber?: number;
}

export interface PostEntryInput {
  orgId: string;
  bookId: string;
  subsidiaryId: string;
  entryNumber: string;
  postingDate: string;
  periodId: string;
  memo?: string | null;
  /** Journal origin (disposal, inventory, payroll, translation, ...). */
  origin: string;
  reversesEntryId?: string | null;
  sourceDocumentId?: string | null;
  custom?: Record<string, unknown>;
  actorId?: string | null;
  /** Explicit entry id; omitted lets the database default apply. */
  id?: string;
  /** Default currency for lines that omit one. */
  currency?: string | null;
  /**
   * Exactly-once identity: stamped into custom and, under the organization
   * posting lock, an entry already carrying it is returned instead of
   * posting a duplicate.
   */
  idempotencyKey?: string;
  /** Close modules to check besides the always-implied GL module. */
  closeModules?: CloseModule[];
  /** Historical source replay may cross source-owned locks, never user locks. */
  allowImportedLocks?: boolean;
  /** Historical replay may post to accounts that are inactive today. */
  allowInactiveAccounts?: boolean;
  auditAction?: string;
  requestId?: string | null;
  /** Merged into the audit changes alongside the standard posting fields. */
  auditChanges?: Record<string, unknown>;
  lines: PostEntryLineInput[];
}

export interface PostEntryResult {
  entryId: string;
  /** Inserted line ids in line-number order. */
  lines: { id: string; lineNumber: number }[];
}

const AMOUNT_RE = /^-?\d+(\.\d{1,4})?$/;

function fail(message: string): never {
  throw new LedgerPostError(message);
}

export async function postEntry(
  executor: SqlExecutor,
  input: PostEntryInput,
): Promise<PostEntryResult> {
  const { orgId } = input;
  if (!orgId) fail("postEntry requires an organization id");
  if (!input.bookId) fail("postEntry requires a book id");
  if (!input.subsidiaryId) fail("postEntry requires an entry subsidiary id");
  if (!input.entryNumber) fail("postEntry requires an entry number");
  if (!input.postingDate) fail("postEntry requires a posting date");
  if (!input.periodId) fail("postEntry requires an accounting period id");
  if (!input.origin) fail("postEntry requires a journal origin");
  if (!input.lines || input.lines.length === 0)
    fail(`journal entry ${input.entryNumber} carries no lines — a posting needs at least one balanced line`);

  const seenNumbers = new Set<number>();
  const lines = input.lines.map((line, index) => {
    const position = index + 1;
    if (!line.accountId)
      fail(`journal entry ${input.entryNumber} line ${position}: an account id is required`);
    if (typeof line.amount !== "string" || !AMOUNT_RE.test(line.amount))
      fail(
        `journal entry ${input.entryNumber} line ${position}: amount must be a decimal string with at most 4 places`,
      );
    const lineNumber = line.lineNumber ?? position;
    if (!Number.isInteger(lineNumber) || lineNumber < 1)
      fail(`journal entry ${input.entryNumber} line ${position}: line number must be a positive integer`);
    if (seenNumbers.has(lineNumber))
      fail(`journal entry ${input.entryNumber}: duplicate line number ${lineNumber}`);
    seenNumbers.add(lineNumber);
    const currency = line.currency ?? input.currency ?? null;
    if (!currency)
      fail(`journal entry ${input.entryNumber} line ${position}: a currency is required`);
    return {
      ...line,
      subsidiaryId: line.subsidiaryId ?? input.subsidiaryId,
      currency,
      txnAmount: line.txnAmount ?? line.amount,
      fxRate: line.fxRate ?? "1",
      lineNumber,
    };
  });

  // Balance validation before any write: whole entry and per subsidiary.
  // assertFinalKernelBalance is the shared kernel check (also >= 2 lines).
  try {
    assertFinalKernelBalance(lines.map((line) => ({ amount: line.amount, subsidiaryId: line.subsidiaryId! })));
  } catch (error) {
    if (error instanceof PostingError)
      throw new LedgerPostError(`journal entry ${input.entryNumber}: ${error.message}`);
    throw error;
  }

  // Serialize postings at the organization aggregate root: the idempotency
  // read below and the entry-number insert are atomic against another
  // posting in the same organization while this lock is held.
  await executor.execute(sql`select id from orgs where id = ${orgId} for update`);

  if (input.idempotencyKey) {
    const prior = (await executor.execute<{ id: string }>(sql`
      select id from journal_entries
       where org_id = ${orgId} and custom->>'idempotencyKey' = ${input.idempotencyKey}
       limit 1`)).rows[0];
    if (prior) {
      const priorLines = (await executor.execute<{ id: string; line_number: number }>(sql`
        select id, line_number from journal_lines
         where org_id = ${orgId} and entry_id = ${prior.id}
         order by line_number`)).rows;
      return {
        entryId: prior.id,
        lines: priorLines.map((row) => ({ id: row.id, lineNumber: row.line_number })),
      };
    }
  }

  // Book guard: the book belongs to this org and is an active posting book.
  const book = (await executor.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and id = ${input.bookId} and is_active and posts_gl
     for share`)).rows[0];
  if (!book)
    fail(`journal entry ${input.entryNumber}: book ${input.bookId} is not an active posting book of this organization`);

  // Period guard: the period belongs to this org (a write matching zero rows
  // is a failure, not a success — prove the row first).
  const period = (await executor.execute<{ id: string }>(sql`
    select id from accounting_periods
     where org_id = ${orgId} and id = ${input.periodId}
     limit 1`)).rows[0];
  if (!period)
    fail(`journal entry ${input.entryNumber}: accounting period ${input.periodId} does not exist in this organization`);

  // Entity guards: the entry and every leg reference subsidiaries of this org.
  const subsidiaryIds = [...new Set([input.subsidiaryId, ...lines.map((line) => line.subsidiaryId!)])];
  const foundSubs = (await executor.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${orgId} and id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`)).rows;
  if (foundSubs.length !== subsidiaryIds.length) {
    const found = new Set(foundSubs.map((row) => row.id));
    const missing = subsidiaryIds.find((id) => !found.has(id));
    fail(`journal entry ${input.entryNumber}: subsidiary ${missing} does not exist in this organization`);
  }

  // Account guards: every leg posts to an existing, active, non-summary
  // account of this org whose currency restriction the line honors — the
  // same rules the jl_check_account storage trigger enforces, refused here
  // with names instead of a raw driver error at insert time.
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = (await executor.execute<{
    id: string;
    is_active: boolean;
    is_summary: boolean;
    currency_restriction: string | null;
  }>(sql`
    select id, is_active, is_summary, currency_restriction from accounts
     where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])
     for share`)).rows;
  const byAccount = new Map(accounts.map((row) => [row.id, row]));
  for (const line of lines) {
    const account = byAccount.get(line.accountId);
    if (!account)
      fail(`journal entry ${input.entryNumber}: account ${line.accountId} does not exist in this organization`);
    if (account!.is_summary)
      fail(`journal entry ${input.entryNumber}: account ${line.accountId} is a summary account and cannot be posted to`);
    if (!account!.is_active && !input.allowInactiveAccounts)
      fail(`journal entry ${input.entryNumber}: account ${line.accountId} is inactive`);
    if (account!.currency_restriction && line.currency !== account!.currency_restriction)
      fail(`journal entry ${input.entryNumber}: account ${line.accountId} only accepts ${account!.currency_restriction} postings`);
  }

  if (input.reversesEntryId) {
    const target = (await executor.execute<{ id: string; status: string }>(sql`
      select id, status from journal_entries
       where org_id = ${orgId} and id = ${input.reversesEntryId}
       limit 1`)).rows[0];
    if (!target)
      fail(`journal entry ${input.entryNumber}: reversed entry ${input.reversesEntryId} does not exist in this organization`);
    if (target!.status === "draft")
      fail(`journal entry ${input.entryNumber}: a draft entry cannot be reversed`);
  }

  if (input.sourceDocumentId) {
    const source = (await executor.execute<{ id: string }>(sql`
      select id from documents
       where org_id = ${orgId} and id = ${input.sourceDocumentId}
       limit 1`)).rows[0];
    if (!source)
      fail(`journal entry ${input.entryNumber}: source document ${input.sourceDocumentId} does not exist in this organization`);
  }

  // Open-period check behind the shared close/posting fence, held through
  // commit: a concurrent close either waits behind this posting or this
  // check re-reads its commit. GL is always implied.
  await executor.execute(sql`select period_posting_fence(${orgId}, ${input.periodId}, ${input.bookId})`);
  try {
    await assertPeriodModulesOpen(executor, {
      orgId,
      periodId: input.periodId,
      bookId: input.bookId,
      subsidiaryIds,
      modules: input.closeModules ?? [],
      allowImportedLocks: input.allowImportedLocks,
    });
  } catch (error) {
    if (error instanceof CloseError)
      throw new LedgerPostError(`journal entry ${input.entryNumber}: ${error.message}`);
    throw error;
  }

  const custom =
    input.idempotencyKey || input.custom
      ? { ...(input.custom ?? {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }
      : null;
  const inserted = (await executor.execute<{ id: string }>(
    input.id
      ? sql`insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status,
           origin, reverses_entry_id, source_document_id, custom, created_by, updated_by)
        values (${input.id}, ${orgId}, ${input.bookId}, ${input.subsidiaryId}, ${input.entryNumber},
                ${input.postingDate}, ${input.periodId}, ${input.memo ?? null}, 'draft',
                ${input.origin}, ${input.reversesEntryId ?? null}, ${input.sourceDocumentId ?? null},
                ${custom === null ? "{}" : JSON.stringify(custom)}::jsonb,
                ${input.actorId ?? null}, ${input.actorId ?? null})
        returning id`
      : sql`insert into journal_entries
          (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status,
           origin, reverses_entry_id, source_document_id, custom, created_by, updated_by)
        values (${orgId}, ${input.bookId}, ${input.subsidiaryId}, ${input.entryNumber},
                ${input.postingDate}, ${input.periodId}, ${input.memo ?? null}, 'draft',
                ${input.origin}, ${input.reversesEntryId ?? null}, ${input.sourceDocumentId ?? null},
                ${custom === null ? "{}" : JSON.stringify(custom)}::jsonb,
                ${input.actorId ?? null}, ${input.actorId ?? null})
        returning id`,
  )).rows[0];
  if (!inserted)
    fail(`journal entry ${input.entryNumber} was not created`);
  const entryId = inserted!.id;

  // All lines of the entry in ONE multi-row INSERT statement.
  const tuples = lines.map(
    (line) => sql`(${orgId}, ${entryId}, ${line.lineNumber}, ${line.accountId}, ${line.subsidiaryId},
      ${line.amount}, ${line.currency}, ${line.txnAmount}, ${line.fxRate},
      ${line.memo ?? null}, ${line.partyId ?? null}, ${line.departmentId ?? null},
      ${line.projectId ?? null}, ${line.locationId ?? null}, ${line.classId ?? null},
      ${line.equipmentUnitId ?? null}, ${line.paymentCardId ?? null},
      ${JSON.stringify(line.extraDims ?? {})}::jsonb,
      ${line.quantity ?? null}, ${line.unit ?? null}, ${line.dueDate ?? null},
      ${line.isOpenItem ?? false}, ${line.taxCodeId ?? null},
      ${line.custom === undefined ? "{}" : JSON.stringify(line.custom)}::jsonb,
      ${line.contributorKind ?? null}, ${line.contributorRef ?? null})`,
  );
  const insertedLines = (await executor.execute<{ id: string; line_number: number }>(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
       memo, party_id, department_id, project_id, location_id, class_id, equipment_unit_id, payment_card_id,
       extra_dims, quantity, unit, due_date, is_open_item, tax_code_id, custom, contributor_kind, contributor_ref)
    values ${sql.join(tuples, sql`, `)}
    returning id, line_number`)).rows;
  if (insertedLines.length !== lines.length)
    fail(`journal entry ${input.entryNumber}: posted ${insertedLines.length} of ${lines.length} lines`);
  const lineIdByNumber = new Map(insertedLines.map((row) => [row.line_number, row.id]));
  const orderedLines = [...seenNumbers]
    .sort((a, b) => a - b)
    .map((lineNumber) => ({ id: lineIdByNumber.get(lineNumber)!, lineNumber }));

  // The draft -> posted flip only lands on the draft just created; zero rows
  // is a failure (a concurrent flip or a vanished entry), never success.
  const flipped = (await executor.execute<{ id: string }>(sql`
    update journal_entries
       set status = 'posted', posted_by = ${input.actorId ?? null}, updated_by = ${input.actorId ?? null}
     where org_id = ${orgId} and id = ${entryId} and status = 'draft'
     returning id`)).rows[0];
  if (!flipped)
    fail(`journal entry ${input.entryNumber} could not be posted`);

  await executor.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${orgId}, 'journal_entries', ${entryId}, ${input.auditAction ?? "post"},
            ${JSON.stringify({
              mode: "ledger_post",
              origin: input.origin,
              entryNumber: input.entryNumber,
              postingDate: input.postingDate,
              periodId: input.periodId,
              lineCount: lines.length,
              ...(input.auditChanges ?? {}),
            })}::jsonb, ${input.actorId ?? null}, ${input.requestId ?? null})`);

  return { entryId, lines: orderedLines };
}

/** Total of the entry's base amounts, for callers that settle against it. */
export function postEntryTotal(lines: readonly { amount: string }[]): string {
  return sum(lines.map((line) => line.amount));
}

/**
 * The governed posted -> reversed lifecycle marker. Corrections append a
 * reversal entry through postEntry (linking reverses_entry_id) and then mark
 * the original reversed here; the original's financial content is never
 * edited. Zero matched rows is a failure: only a posted entry of this
 * organization can be marked.
 */
export async function markEntryReversed(
  executor: SqlExecutor,
  input: { orgId: string; entryId: string; actorId?: string | null },
): Promise<void> {
  const updated = (await executor.execute<{ id: string }>(sql`
    update journal_entries
       set status = 'reversed', updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${input.entryId} and status = 'posted'
     returning id`)).rows[0];
  if (!updated)
    throw new LedgerPostError(
      `journal entry ${input.entryId} is not a posted entry of this organization — only a posted entry can be marked reversed; corrections append a reversal through the ledger API instead of editing history`,
    );
}

/**
 * Re-point the project dimension on DRAFT lines only, for merges and
 * corrections that move attribution without touching posted history. The
 * append-only guard admits draft edits and refuses everything else, so the
 * entry-status predicate is the whole safety case: drafts are the only rows
 * this statement can match. Zero matched rows is a legal no-op (nothing
 * attributed) and the count is returned for audit.
 */
export async function repointDraftProjectLines(
  executor: SqlExecutor,
  input: { orgId: string; fromId: string; toId: string },
): Promise<number> {
  const moved = (await executor.execute<{ id: string }>(sql`
    update journal_lines jl set project_id = ${input.toId}
     where jl.org_id = ${input.orgId} and jl.project_id = ${input.fromId}
       and exists (
         select 1 from journal_entries e
          where e.id = jl.entry_id and e.org_id = jl.org_id and e.status = 'draft'
       )
    returning jl.id`)).rows;
  return moved.length;
}
