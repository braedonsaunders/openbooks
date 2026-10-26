import { sql } from "drizzle-orm";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import type { CloseModule } from "../periods/period-policy.ts";
import { inExecutorTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { collectBalancingLegs } from "./balancing-hooks.ts";
import { BookAccountMapError } from "./book-account-maps.ts";
import type { BookProfile } from "./book-basis.ts";
import {
  applyBookPostingPolicy,
  type BookAccountBasis,
  type BookAmountBasis,
  type BookPostingEvidence,
} from "./book-posting-policy.ts";
import { liveReplicaEntryIds, replicateEntryToBooks } from "./book-replication.ts";
import { BookTranslationError } from "./book-translation.ts";
import { insertAuditRecord, type AuditRecord } from "./kernel-audit.ts";
import {
  flipEntryToPosted,
  insertDraftEntry,
  insertKeyedDraftEntry,
  type DraftEntryHeader,
} from "./kernel-entry.ts";
import { holdPeriodPostingFence } from "./kernel-fences.ts";
import {
  identityEvidence,
  postingRequestHash,
  readKeyedEntry,
  readKeyWinner,
  type PostingRequestBasis,
  type PostingRequestIdentity,
} from "./kernel-idempotency.ts";
import { insertEntryLines } from "./kernel-lines.ts";
import { fail, LedgerPostError } from "./ledger-post-error.ts";
import {
  assertLegAccounts,
  assertLegSubsidiaries,
  assertPostingPeriodOpen,
  assertReferencedRecords,
  connectorReplayAuthorized,
  lockPostingBook,
  pointReplayAuthorization,
  resolveEntityPeriod,
  type PreparedLine,
  type ReplayEvidence,
} from "./post-entry-guards.ts";
import { PostingError } from "./posting-contracts.ts";
import { assertFinalKernelBalance } from "./posting-invariants.ts";

export { postingRequestHash };

/**
 * The journal-write API for direct (non-document) postings. postEntry appends one balanced,
 * posted entry as one atomic unit, joining the caller's transaction when handed one;
 * markEntryReversed records the posted -> reversed lifecycle.
 *
 * Document posting (ledger/posting-commit.ts) writes through the same kernel: header, line,
 * posted-flip, audit and fence steps in kernel-*.ts. postEntry adds idempotency keys, book and
 * account guards and connector replay; the document path adds its exactly-once document flip,
 * entry-number collision diagnosis, allocation lineage, secondary books and effects outbox.
 * Nothing outside engine/src/journal and engine/src/ledger writes the journal tables.
 */

export interface PostEntryLineInput {
  accountId: string;
  /** Signed base amount as a canonical ledger string: positive = debit, negative = credit. */
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
  eliminate?: boolean;
  isCurrencyAdjustment?: boolean;
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
   * Exactly-once identity, arbitrated by the partial unique index
   * journal_entries_org_idempotency_key: an entry already carrying it is returned only when its
   * financial request matches.
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
  /**
   * How a non-primary book's amounts are stated: `functional` (the default) translates into the
   * book's currency; `book` means the caller already measured them in it.
   */
  amountBasis?: BookAmountBasis;
  /** Legs read from an existing book ledger already name its physical accounts. */
  accountBasis?: BookAccountBasis;
  /**
   * False marks a primary-book posting as this book's own measurement, so full books do not
   * replicate it. Recorded on the entry as custom.bookSpecific.
   */
  replicate?: boolean;
  lines: PostEntryLineInput[];
}

export interface PostEntryResult {
  entryId: string;
  /** Inserted line ids in line-number order. */
  lines: { id: string; lineNumber: number }[];
}

const AMOUNT_RE = /^-?\d+(\.\d{1,4})?$/;

export async function postEntry(
  executor: SqlExecutor,
  input: PostEntryInput,
): Promise<PostEntryResult> {
  assertEntryShape(input);
  const { lines, seenNumbers } = prepareLines(input);
  // The guards' share locks and the period fence hold through commit, and the header, lines,
  // posted flip and audit record become visible together or not at all.
  return inExecutorTransaction(executor, (tx) => writeEntry(tx, input, lines, seenNumbers));
}

function assertEntryShape(input: PostEntryInput): void {
  if (input.custom?.postingRequestHash !== undefined)
    fail("postingRequestHash is reserved posting evidence — remove it from custom input");
  if (input.custom?.postingRequestBasis !== undefined)
    fail("postingRequestBasis is reserved posting evidence — remove it from custom input");
  if (!input.orgId) fail("postEntry requires an organization id");
  if (!input.bookId) fail("postEntry requires a book id");
  if (!input.subsidiaryId) fail("postEntry requires an entry subsidiary id");
  if (!input.entryNumber) fail("postEntry requires an entry number");
  if (!isIsoCalendarDate(input.postingDate))
    fail("postEntry requires a valid ISO civil posting date");
  if (!input.periodId) fail("postEntry requires an accounting period id");
  if (!input.origin) fail("postEntry requires a journal origin");
  for (const [field, value] of [
    ["reversed entry", input.reversesEntryId],
    ["source document", input.sourceDocumentId],
  ] as const) {
    if (value != null && !isUuid(value))
      fail(`journal entry ${input.entryNumber}: ${field} must be a UUID, not a code or name`);
  }
  for (const [field, value] of [
    ["organization", input.orgId],
    ["book", input.bookId],
    ["subsidiary", input.subsidiaryId],
    ["period", input.periodId],
  ] as const) {
    if (!isUuid(value))
      fail(`journal entry ${input.entryNumber}: ${field} must be a UUID, not a code or name`);
  }
  if (!input.lines || input.lines.length === 0)
    fail(
      `journal entry ${input.entryNumber} carries no lines — a posting needs at least one balanced line`,
    );
}

function prepareLines(input: PostEntryInput): { lines: PreparedLine[]; seenNumbers: Set<number> } {
  const seenNumbers = new Set<number>();
  const lines = input.lines.map((line, index): PreparedLine => {
    const position = index + 1;
    const label = `journal entry ${input.entryNumber} line ${position}`;
    if (!line.accountId) fail(`${label}: an account id is required`);
    if (!isUuid(line.accountId)) fail(`${label}: account must be a UUID, not an account code`);
    if (line.subsidiaryId != null && !isUuid(line.subsidiaryId))
      fail(`${label}: subsidiary must be a UUID, not a code or name`);
    if (typeof line.amount !== "string" || !AMOUNT_RE.test(line.amount))
      fail(`${label}: amount must be a decimal string with at most 4 places`);
    const lineNumber = line.lineNumber ?? position;
    if (!Number.isInteger(lineNumber) || lineNumber < 1)
      fail(`${label}: line number must be a positive integer`);
    if (seenNumbers.has(lineNumber))
      fail(`journal entry ${input.entryNumber}: duplicate line number ${lineNumber}`);
    seenNumbers.add(lineNumber);
    const currency = line.currency ?? input.currency ?? null;
    if (!currency) fail(`${label}: a currency is required`);
    return {
      ...line,
      subsidiaryId: line.subsidiaryId ?? input.subsidiaryId,
      currency,
      txnAmount: line.txnAmount ?? line.amount,
      fxRate: line.fxRate ?? "1",
      lineNumber,
      fxStated: line.txnAmount != null && line.fxRate != null,
    };
  });
  return { lines, seenNumbers };
}

async function writeEntry(
  executor: SqlExecutor,
  requested: PostEntryInput,
  lines: PreparedLine[],
  seenNumbers: Set<number>,
): Promise<PostEntryResult> {
  const requestBasis = requestBasisOf(requested);
  await lockLedgerSetupFence(executor, requested.orgId, "shared");
  const book = await lockPostingBook(executor, requested);
  const input = await resolveEntityPeriod(executor, requested);

  // The request identity hashes the resolved period and the caller's lines, before any book
  // policy or balancing provider appends or translates legs.
  const identity: PostingRequestIdentity | null = input.idempotencyKey
    ? {
        idempotencyKey: input.idempotencyKey,
        requestHash: postingRequestHash(input, lines),
        requestBasis,
      }
    : null;
  const keyed = identity && { orgId: input.orgId, entryNumber: input.entryNumber, identity };
  if (keyed) {
    const prior = await readKeyedEntry(executor, keyed);
    if (prior) return prior;
  }

  await assertReferencedRecords(executor, input);
  await holdPeriodPostingFence(executor, input);
  const replayAuthorized = await connectorReplayAuthorized(executor, input.orgId);
  const bookPosting = await applyBookPolicy(
    executor,
    input,
    book,
    requestBasis,
    lines,
    seenNumbers,
  );
  await appendBalancingLegs(executor, input, lines, seenNumbers, replayAuthorized);
  assertEntryBalanced(input, lines);
  const subsidiaryIds = await assertLegSubsidiaries(
    executor,
    input,
    lines,
    bookPosting.currencyBySub,
  );
  await assertLegAccounts(executor, input, lines);
  const replayEvidence = await assertPostingPeriodOpen(
    executor,
    input,
    subsidiaryIds,
    replayAuthorized,
  );

  const header = draftHeader(input, identity);
  let entryId: string;
  if (keyed) {
    const claimed = await insertKeyedDraftEntry(executor, header);
    // A concurrent identical key won the race: return its entry rather than a second posting.
    if (claimed === null) return await readKeyWinner(executor, keyed);
    entryId = claimed;
  } else {
    entryId = await insertDraftEntry(
      executor,
      header,
      () => new LedgerPostError(`journal entry ${input.entryNumber} was not created`),
    );
  }

  const insertedLines = await insertEntryLines(executor, { orgId: input.orgId, entryId }, lines, {
    admitInactiveAccounts: input.allowInactiveAccounts === true,
    refusal: (inserted) =>
      new LedgerPostError(
        `journal entry ${input.entryNumber}: posted ${inserted} of ${lines.length} lines`,
      ),
  });
  const lineIdByNumber = new Map(insertedLines.map((row) => [row.lineNumber, row.id]));
  const orderedLines = [...seenNumbers]
    .sort((a, b) => a - b)
    .map((lineNumber) => ({ id: lineIdByNumber.get(lineNumber)!, lineNumber }));

  if (replayEvidence) await pointReplayAuthorization(executor, replayEvidence);
  await flipEntryToPosted(
    executor,
    { orgId: input.orgId, entryId, actorId: input.actorId ?? null },
    () => new LedgerPostError(`journal entry ${input.entryNumber} could not be posted`),
  );
  await insertAuditRecord(
    executor,
    postingAudit(input, entryId, lines.length, bookPosting.evidence, replayEvidence),
    () =>
      new LedgerPostError(
        `journal entry ${input.entryNumber}: the posting audit record was not retained`,
      ),
  );
  if (book.isPrimary && input.replicate !== false) await replicateToBooks(executor, input, entryId);

  return { entryId, lines: orderedLines };
}

/** Reversals restate a book's own ledger; other postings state functional source amounts. */
function requestBasisOf(input: PostEntryInput): PostingRequestBasis {
  return {
    amountBasis: input.amountBasis ?? (input.reversesEntryId ? "book" : "functional"),
    accountBasis: input.accountBasis ?? (input.reversesEntryId ? "book" : "source"),
  };
}

function nextLineNumber(seenNumbers: Set<number>): number {
  const next = Math.max(0, ...seenNumbers) + 1;
  seenNumbers.add(next);
  return next;
}

interface BookPosting {
  evidence: BookPostingEvidence | null;
  /** The book's measurement currency per subsidiary, where it is not the primary book. */
  currencyBySub: Map<string, string>;
}

/** A non-primary book carries the legs through its account mappings and translates them. */
async function applyBookPolicy(
  executor: SqlExecutor,
  input: PostEntryInput,
  book: BookProfile,
  basis: PostingRequestBasis,
  lines: PreparedLine[],
  seenNumbers: Set<number>,
): Promise<BookPosting> {
  const currencyBySub = new Map<string, string>();
  if (book.isPrimary) return { evidence: null, currencyBySub };
  try {
    const policy = await applyBookPostingPolicy(executor, {
      orgId: input.orgId,
      book,
      entryLabel: `journal entry ${input.entryNumber}`,
      postingDate: input.postingDate,
      amountBasis: basis.amountBasis,
      accountBasis: basis.accountBasis,
      lines,
      nextLineNumber: () => nextLineNumber(seenNumbers),
    });
    lines.splice(0, lines.length, ...policy.lines);
    for (const [subsidiaryId, bookBasis] of policy.bases)
      currencyBySub.set(subsidiaryId, bookBasis.bookCurrency);
    return { evidence: policy.evidence, currencyBySub };
  } catch (error) {
    if (error instanceof BookTranslationError || error instanceof BookAccountMapError)
      fail(
        error.message.startsWith("journal entry")
          ? error.message
          : `journal entry ${input.entryNumber}: ${error.message}`,
      );
    throw error;
  }
}

/** Registered balancing providers append their legs after the caller's and the book's lines. */
async function appendBalancingLegs(
  executor: SqlExecutor,
  input: PostEntryInput,
  lines: PreparedLine[],
  seenNumbers: Set<number>,
  regeneration: boolean,
): Promise<void> {
  const legs = await collectBalancingLegs(
    executor,
    {
      orgId: input.orgId,
      postingDate: input.postingDate,
      bookId: input.bookId,
      sourceDocumentId: input.sourceDocumentId ?? null,
      regeneration,
      origin: input.origin,
      reversesEntryId: input.reversesEntryId ?? null,
    },
    lines,
  );
  for (const leg of legs) {
    lines.push({
      accountId: leg.accountId,
      amount: leg.amount,
      subsidiaryId: leg.subsidiaryId,
      currency: leg.currency,
      txnAmount: leg.txnAmount,
      fxRate: leg.fxRate,
      memo: leg.memo,
      extraDims: leg.extraDims,
      departmentId: leg.departmentId,
      projectId: leg.projectId,
      locationId: leg.locationId,
      classId: leg.classId,
      lineNumber: nextLineNumber(seenNumbers),
      fxStated: true,
    });
  }
}

/** Balance holds before any write: the whole entry and each subsidiary. */
function assertEntryBalanced(input: PostEntryInput, lines: readonly PreparedLine[]): void {
  try {
    assertFinalKernelBalance(
      lines.map((line) => ({
        amount: line.amount,
        subsidiaryId: line.subsidiaryId,
        quantity: line.quantity,
        unit: line.unit,
      })),
    );
  } catch (error) {
    if (error instanceof PostingError)
      throw new LedgerPostError(`journal entry ${input.entryNumber}: ${error.message}`);
    throw error;
  }
}

function draftHeader(
  input: PostEntryInput,
  identity: PostingRequestIdentity | null,
): DraftEntryHeader {
  const custom =
    identity || input.custom || input.replicate === false
      ? {
          ...(input.custom ?? {}),
          ...(input.replicate === false ? { bookSpecific: true } : {}),
          ...(identity ? identityEvidence(identity) : {}),
        }
      : null;
  return {
    id: input.id,
    orgId: input.orgId,
    bookId: input.bookId,
    subsidiaryId: input.subsidiaryId,
    entryNumber: input.entryNumber,
    postingDate: input.postingDate,
    periodId: input.periodId,
    memo: input.memo,
    origin: input.origin,
    reversesEntryId: input.reversesEntryId,
    sourceDocumentId: input.sourceDocumentId,
    custom,
    actorId: input.actorId ?? null,
  };
}

function postingAudit(
  input: PostEntryInput,
  entryId: string,
  lineCount: number,
  bookEvidence: BookPostingEvidence | null,
  replayEvidence: ReplayEvidence | null,
): AuditRecord {
  return {
    orgId: input.orgId,
    tableName: "journal_entries",
    rowId: entryId,
    action: input.auditAction ?? "post",
    changes: {
      mode: "ledger_post",
      origin: input.origin,
      entryNumber: input.entryNumber,
      postingDate: input.postingDate,
      periodId: input.periodId,
      lineCount,
      ...(input.auditChanges ?? {}),
      ...(bookEvidence ? { bookPosting: bookEvidence } : {}),
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
    },
    actorId: input.actorId ?? null,
    requestId: input.requestId ?? null,
  };
}

/** Full books receive the primary posting in this transaction; both commit or roll back together. */
async function replicateToBooks(
  executor: SqlExecutor,
  input: PostEntryInput,
  entryId: string,
): Promise<void> {
  try {
    await replicateEntryToBooks(executor, postEntry, {
      orgId: input.orgId,
      sourceEntryId: entryId,
      actorId: input.actorId ?? null,
      requestId: input.requestId ?? null,
    });
  } catch (error) {
    if (error instanceof PostingError) throw error;
    if (error instanceof BookTranslationError || error instanceof BookAccountMapError)
      fail(`journal entry ${input.entryNumber}: ${error.message}`);
    throw error;
  }
}

/**
 * The governed posted -> reversed lifecycle marker: a correction appends a reversal through
 * postEntry, then marks the original here; its financial content is never edited. Zero matched
 * rows is a failure.
 */
export async function markEntryReversed(
  executor: SqlExecutor,
  input: { orgId: string; entryId: string; actorId?: string | null },
): Promise<void> {
  // The entry and its book copies change state together or not at all.
  await inExecutorTransaction(executor, async (tx) => {
    const updated = (
      await tx.execute<{ id: string }>(
        sql`
          update journal_entries
             set status = 'reversed', updated_at = now(), updated_by = ${input.actorId ?? null}
           -- Live entries only: an entry already reversed cannot be marked again.
           where org_id = ${input.orgId} and id = ${input.entryId} and status = 'posted'
           returning id`,
        "objects",
      )
    )[0];
    if (!updated)
      throw new LedgerPostError(
        `journal entry ${input.entryId} is not a posted entry of this organization — only a posted entry can be marked reversed; corrections append a reversal through the ledger API instead of editing history`,
      );
    // A primary entry's book copies follow it into the reversed state.
    for (const replicaId of await liveReplicaEntryIds(tx, input.orgId, input.entryId)) {
      await markEntryReversed(tx, {
        orgId: input.orgId,
        entryId: replicaId,
        actorId: input.actorId,
      });
    }
  });
}

/**
 * Re-points the project dimension on DRAFT lines only: the append-only guard admits draft edits,
 * so the entry-status predicate is the whole safety case. Returns the moved count; zero is a no-op.
 */
export async function repointDraftProjectLines(
  executor: SqlExecutor,
  input: { orgId: string; fromId: string; toId: string },
): Promise<number> {
  const moved = await executor.execute<{ id: string }>(
    sql`
      update journal_lines jl set project_id = ${input.toId}
       where jl.org_id = ${input.orgId} and jl.project_id = ${input.fromId}
         and exists (
           select 1 from journal_entries e
            where e.id = jl.entry_id and e.org_id = jl.org_id and e.status = 'draft'
         )
      returning jl.id`,
    "objects",
  );
  return moved.length;
}
