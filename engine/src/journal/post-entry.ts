import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertPeriodModulesOpen, CloseError, type CloseModule } from "../periods/period-policy.ts";
import { inExecutorTransaction, type SqlExecutor } from "../platform/db.ts";
import { PostingError } from "./posting-contracts.ts";
import { collectBalancingLegs } from "./balancing-hooks.ts";
import { assertFinalKernelBalance } from "./posting-invariants.ts";
import { findLiveReplayAuthorization } from "./replay-authorization.ts";

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
 * One call owns the whole posting as one atomic unit: balance validation
 * (whole entry and per subsidiary), the book / period / entity / account
 * guards, the open-period check behind the shared close/posting fence,
 * exactly-once numbering, the header and line inserts, the draft -> posted
 * flip, and the audit record. Handed a transaction, it joins it; handed a
 * pool-backed executor, it opens its own, so no reader ever sees a header
 * without its lines. All lines of the entry go in ONE multi-row INSERT
 * statement, which is the invariant the statement-level balance triggers
 * (migration 0381) rely on: each touched entry is validated once per
 * statement.
 *
 * Amounts are canonical ledger strings (no floats, ever). Errors are
 * LedgerPostError (a PostingError), naming the refused value and the remedy.
 */
class LedgerPostError extends PostingError {
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
   * Exactly-once identity: stamped into custom and arbitrated by the partial
   * unique index journal_entries_org_idempotency_key — an entry already
   * carrying it is returned instead of posting a duplicate.
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

/** A validated line with its entry-level defaults applied. */
type PreparedLine = PostEntryLineInput & {
  subsidiaryId: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  lineNumber: number;
};

const AMOUNT_RE = /^-?\d+(\.\d{1,4})?$/;

function fail(message: string): never {
  throw new LedgerPostError(message);
}

/** A decimal string with insignificant trailing zeros removed ("10.50" -> "10.5"). */
function canonicalAmount(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/**
 * Fingerprint of everything an idempotent posting asserts about the ledger:
 * the book, entity, date, period, lineage and every line's account, amounts,
 * currency, rate and dimensions. Presentation that a retry may legitimately
 * regenerate (entry number, memos, actor, request id) is excluded, so an
 * identical retry matches and a different posting under a reused key does not.
 */
function postingFingerprint(input: PostEntryInput, lines: PreparedLine[]): string {
  const payload = {
    bookId: input.bookId,
    subsidiaryId: input.subsidiaryId,
    postingDate: input.postingDate,
    periodId: input.periodId,
    origin: input.origin,
    reversesEntryId: input.reversesEntryId ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    lines: [...lines].sort((a, b) => a.lineNumber - b.lineNumber).map((line) => ({
      lineNumber: line.lineNumber,
      accountId: line.accountId,
      subsidiaryId: line.subsidiaryId,
      amount: canonicalAmount(line.amount),
      currency: line.currency,
      txnAmount: canonicalAmount(line.txnAmount),
      fxRate: canonicalAmount(line.fxRate),
      partyId: line.partyId ?? null,
      departmentId: line.departmentId ?? null,
      projectId: line.projectId ?? null,
      locationId: line.locationId ?? null,
      classId: line.classId ?? null,
      equipmentUnitId: line.equipmentUnitId ?? null,
      paymentCardId: line.paymentCardId ?? null,
      taxCodeId: line.taxCodeId ?? null,
      extraDims: line.extraDims ?? {},
      quantity: canonicalAmount(line.quantity),
      unit: line.unit ?? null,
      dueDate: line.dueDate ?? null,
      isOpenItem: line.isOpenItem ?? false,
    })),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
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
  const lines = input.lines.map((line, index): PreparedLine => {
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

  // The posting's reads and writes run in one transaction: the guards' share
  // locks and the period fence hold through commit, and the header, its lines,
  // the posted flip and the audit record become visible together or not at all.
  return inExecutorTransaction(executor, (tx) => writeEntry(tx, input, lines, seenNumbers));
}

async function writeEntry(
  executor: SqlExecutor,
  input: PostEntryInput,
  lines: PreparedLine[],
  seenNumbers: Set<number>,
): Promise<PostEntryResult> {
  const { orgId } = input;

  // Idempotent postings converge on the partial unique index
  // journal_entries_org_idempotency_key (org_id, custom->>'idempotencyKey')
  // instead of an organization row lock: the friendly read below returns an
  // already-posted entry without touching the write path, and a key that
  // races past the read loses the keyed insert below and reads back the
  // winner. Entry numbers need no lock here either — allocation takes
  // fine-grained per-candidate advisory locks (records/entry-number.ts),
  // and every other guard here reads shared state — so unrelated posts stay
  // parallel instead of serializing onto one row (which deadlocked
  // concurrent multi-post flows with 40P01).
  // A keyed replay must return the winner's full posted entry — header AND
  // lines — in the one shape below, whichever path finds it. One statement
  // reads both, and the winner committed both in one transaction, so a
  // visible header always has its lines. A lineless keyed header is damaged
  // ledger data, never a success and never a replay in progress — it is
  // refused by name instead of returned with zero lines.
  // The fingerprint of the REQUEST (before balancing legs are derived), so a
  // replay compares like with like.
  const fingerprint = input.idempotencyKey ? postingFingerprint(input, lines) : null;
  const readKeyedEntry = async (idempotencyKey: string): Promise<PostEntryResult | null> => {
    const rows = (await executor.execute<{
      entry_id: string;
      id: string | null;
      line_number: number | null;
      book_id: string;
      subsidiary_id: string;
      posting_date: string;
      period_id: string;
      origin: string;
      fingerprint: string | null;
    }>(sql`
      select je.id as entry_id, jl.id as id, jl.line_number as line_number,
             je.book_id, je.subsidiary_id, je.posting_date::text as posting_date,
             je.period_id, je.origin, je.custom->>'idempotencyFingerprint' as fingerprint
        from journal_entries je
        left join journal_lines jl
          on jl.org_id = je.org_id and jl.entry_id = je.id
       where je.org_id = ${orgId} and je.custom->>'idempotencyKey' = ${idempotencyKey}
       order by jl.line_number`)).rows;
    if (rows.length === 0) return null;
    const head = rows[0]!;
    const entryId = head.entry_id;
    // A key names ONE posting. Returning the earlier entry for a different
    // payload would report success while posting nothing the caller asked
    // for. The stored header is always compared; the line-level fingerprint
    // is compared whenever the keyed entry recorded one.
    const differs =
      head.book_id !== input.bookId ||
      head.subsidiary_id !== input.subsidiaryId ||
      head.posting_date !== input.postingDate ||
      head.period_id !== input.periodId ||
      head.origin !== input.origin ||
      (head.fingerprint !== null && head.fingerprint !== fingerprint);
    if (differs)
      fail(
        `journal entry ${input.entryNumber}: this idempotency key was already used for a different entry (entry ${entryId}) — an identical retry returns that entry, but a different posting needs its own idempotency key`,
      );
    const replayed = rows.flatMap((row) =>
      row.id === null ? [] : [{ id: row.id, lineNumber: row.line_number! }],
    );
    if (replayed.length === 0)
      fail(
        `journal entry ${input.entryNumber}: idempotency key ${idempotencyKey} resolves to entry ${entryId}, which has no lines — a keyed posting commits its header and lines together, so this entry is damaged ledger data, not a replay; retrying resolves to the same entry, so have entry ${entryId} investigated before posting again`,
      );
    return { entryId, lines: replayed };
  };
  if (input.idempotencyKey) {
    const prior = await readKeyedEntry(input.idempotencyKey);
    if (prior) {
      return prior;
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
  // Authenticated connector historical replay carries a transaction-local
  // token the DATABASE validates (connector_historical_replay_authorized:
  // active sync run, owning connection, attributable automatic policy). The
  // trigger guards honor that token through period_module_blocks_write. This
  // application-level companion honors it only with durable evidence: the
  // token names the replaying sync run (re-validated here by calling the
  // same function, never trusted from the caller), and a
  // controller-recorded connector_replay_authorizations row for that run's
  // connector must cover the posting period before a closed period opens.
  // The triggers re-validate the token again at write time.
  // The policy state comes from the same transaction-local predicate used
  // by the closed-period check. Integrity providers still run on replay.
  const replayAuthorized = (
    await executor.execute<{ allowed: boolean }>(sql`
      select connector_historical_replay_authorized(${orgId}) as allowed`)
  ).rows[0]?.allowed === true;
  const segmentLegs = await collectBalancingLegs(
    executor,
    {
      orgId,
      postingDate: input.postingDate,
      bookId: input.bookId,
      sourceDocumentId: input.sourceDocumentId ?? null,
      regeneration: replayAuthorized,
    },
    lines,
  );
  let nextLineNumber = Math.max(0, ...seenNumbers);
  for (const leg of segmentLegs) {
    nextLineNumber += 1;
    seenNumbers.add(nextLineNumber);
    lines.push({
      accountId: leg.accountId,
      amount: leg.amount,
      subsidiaryId: leg.subsidiaryId,
      currency: leg.currency,
      txnAmount: leg.txnAmount,
      fxRate: leg.fxRate,
      memo: leg.memo,
      extraDims: leg.extraDims,
      lineNumber: nextLineNumber,
    });
  }

  // Balance validation before any write: whole entry and per subsidiary.
  try {
    assertFinalKernelBalance(lines.map((line) => ({ amount: line.amount, subsidiaryId: line.subsidiaryId! })));
  } catch (error) {
    if (error instanceof PostingError)
      throw new LedgerPostError(`journal entry ${input.entryNumber}: ${error.message}`);
    throw error;
  }

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
  // Evidence for an admitted closed-period replay, cited in the posting
  // audit below. The flag alone never opens a closed period: it only names
  // the replaying sync run, and a controller-recorded authorization row for
  // that run's connector must cover the posting period.
  let replayEvidence: { authorizationId: string; connectionId: string } | null = null;
  if (!replayAuthorized) {
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
  } else {
    let closedForReplay = false;
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
      if (!(error instanceof CloseError)) throw error;
      closedForReplay = true;
    }
    if (closedForReplay) {
      const authorization = await findLiveReplayAuthorization(executor, {
        orgId,
        periodId: input.periodId,
      });
      if (!authorization)
        fail(
          `journal entry ${input.entryNumber}: closed-period connector replay is not covered by a replay authorization for this connector and period — have a controller record a connector replay authorization (connector, covered period range, expiry, reason) and retry`,
        );
      if (authorization!.expiresAt <= new Date())
        fail(
          `journal entry ${input.entryNumber}: connector replay authorization ${authorization!.id} expired at ${authorization!.expiresAt.toISOString()} — have a controller record a fresh authorization and retry`,
        );
      replayEvidence = {
        authorizationId: authorization!.id,
        connectionId: authorization!.connectionId,
      };
    }
  }

  const custom =
    input.idempotencyKey || input.custom
      ? {
          ...(input.custom ?? {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey, idempotencyFingerprint: fingerprint } : {}),
        }
      : null;
  // With an idempotencyKey the entry insert is ON CONFLICT DO NOTHING on
  // the partial (org_id, custom->>'idempotencyKey') index and a conflicting
  // retry reads back the winner's entry. The DO NOTHING is load-bearing
  // dedupe, not a dropped write: a conflict is only possible when this
  // exact key already committed, and the follow-up read makes that entry
  // the returned effect — every conflict is therefore observed, never
  // swallowed. Unlike a bare 23505 catch, it never leaves a joined caller
  // transaction aborted.
  const keyConflict = input.idempotencyKey
    ? sql`on conflict (org_id, (custom->>'idempotencyKey')) where custom ? 'idempotencyKey' do nothing`
    : sql``;
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
        ${keyConflict} returning id`
      : sql`insert into journal_entries
          (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status,
           origin, reverses_entry_id, source_document_id, custom, created_by, updated_by)
        values (${orgId}, ${input.bookId}, ${input.subsidiaryId}, ${input.entryNumber},
                ${input.postingDate}, ${input.periodId}, ${input.memo ?? null}, 'draft',
                ${input.origin}, ${input.reversesEntryId ?? null}, ${input.sourceDocumentId ?? null},
                ${custom === null ? "{}" : JSON.stringify(custom)}::jsonb,
                ${input.actorId ?? null}, ${input.actorId ?? null})
        ${keyConflict} returning id`,
  )).rows[0];
  if (!inserted && !input.idempotencyKey)
    fail(`journal entry ${input.entryNumber} was not created`);
  if (!inserted) {
    // A concurrent identical key won the race: return its full entry rather
    // than a second posting, through the same keyed read as the friendly
    // path above — one shape for every replay. The conflict above is the
    // proof the entry exists — a zero-row read here is a failure, not a
    // success.
    const raced = await readKeyedEntry(input.idempotencyKey!);
    if (!raced)
      fail(`journal entry ${input.entryNumber} collided on its idempotency key but the winning entry is not visible — retry the posting`);
    return raced;
  }
  const entryId = inserted.id;

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
  if (replayEvidence) {
    // Transaction-local grant pointer the je_guard closed-period branch
    // re-validates at write time: the authorization row this replay was
    // admitted against. It dies with the transaction, so nothing is cleared.
    await executor.execute(sql`
      select set_config('openbooks.connector_replay_authorization', ${replayEvidence.authorizationId}, true)`);
  }
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
              ...(replayEvidence
                ? {
                    historicalReplay: {
                      mode: "authenticated_connector_historical_replay",
                      authorizationId: replayEvidence.authorizationId,
                      connectionId: replayEvidence.connectionId,
                      periodLocksPreserved: true,
                    },
                  }
                : {}),
            })}::jsonb, ${input.actorId ?? null}, ${input.requestId ?? null})`);

  return { entryId, lines: orderedLines };
}

/** Total of the entry's base amounts, for callers that settle against it. */

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
     -- Live entries only: an entry already reversed cannot be marked again.
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
