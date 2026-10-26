import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  loadSubsidiaryContext,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import {
  MONETARY_ACCOUNT_SQL,
  type RevaluationRateEvidenceQuote,
} from "./fx-revaluation-contracts.ts";

/**
 * Recorded closing exchange rates for period-end FX revaluation.
 *
 * A quote is recorded for one exact position — book, legal entity, assigned
 * period, monetary account and transaction currency — and converts into the
 * currency that book measures the entity in, dated the period's final day.
 * Quotes are append-only observations: the first quote for a position is its
 * root and a correction appends a successor version, so the current quote is
 * the newest version while every earlier quote stays immutable for the
 * revaluation audit snapshots that consumed it. Recording a quote never
 * posts a journal and never reopens a period; it only prepares the next
 * revaluation run (or a correction rerun) for that one position.
 */

export class ClosingFxEvidenceError extends Error {
  readonly name: string = "ClosingFxEvidenceError";
}

export class ClosingFxEvidenceFeatureDisabledError extends ClosingFxEvidenceError {
  readonly name: string = "ClosingFxEvidenceFeatureDisabledError";
  constructor() {
    super("multiCurrency feature is disabled");
  }
}

/** The exact position a closing quote is recorded for. */
export interface ClosingFxEvidencePositionKey {
  bookId: string;
  subsidiaryId: string;
  periodId: string;
  accountId: string;
  transactionCurrency: string;
}

export interface RecordClosingFxRateEvidenceInput extends ClosingFxEvidencePositionKey {
  /** Currency the selected book measures the legal entity in. */
  measurementCurrency: string;
  /** Must equal the assigned period's final day when supplied. */
  rateDate?: string;
  rate: string;
  source: string;
  reason: string;
  /** The current quote id the caller saw, or null when recording a root. */
  expectedCurrentId: string | null;
  /** Caller-supplied replay identity for this recording. */
  requestId: string;
}

export interface ClosingFxRateEvidenceRecord extends RevaluationRateEvidenceQuote {
  bookId: string;
  subsidiaryId: string;
  periodId: string;
  accountId: string;
  transactionCurrency: string;
  supersedesId: string | null;
  requestId: string;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

/** Canonical (lower-case) UUID text, or null when the value is not a UUID.
 *  Identities are normalized once at the boundary so the request hash, the
 *  advisory fences and the stored-row comparisons all name the same row. */
function canonicalUuid(value: unknown): string | null {
  return typeof value === "string" && isUuid(value) ? value.toLowerCase() : null;
}

function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length >= min && text.length <= max ? text : null;
}

/**
 * The canonical exact closing rate, or null when the value is not a positive
 * decimal that fits the stored rate (nine whole digits, ten decimal places).
 * Nothing is rounded and nothing crosses binary floating point.
 */
export function closingFxEvidenceRate(value: unknown): string | null {
  const rate = canonicalDecimal(value, 10);
  if (rate === null || compareDecimal(rate, "0") <= 0) return null;
  return rate.split(".")[0]!.length > 9 ? null : rate;
}

/** Validate and normalize a recording request before any row is locked. */
export function parseClosingFxRateEvidenceInput(input: unknown): RecordClosingFxRateEvidenceInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClosingFxEvidenceError(
      "record the closing rate with its book, legal entity, period, account, currencies, rate, source and reason",
    );
  }
  const request = input as Record<string, unknown>;
  for (const field of ["bookId", "subsidiaryId", "periodId", "accountId", "requestId"] as const) {
    if (canonicalUuid(request[field]) === null) {
      throw new ClosingFxEvidenceError(`the closing rate recording needs a valid ${field}`);
    }
  }
  // The expected current quote is a required optimistic-concurrency input:
  // an explicit id names the version being succeeded, null opens a root.
  // Omitting it cannot silently mean "new" — the caller must state which
  // chain state it saw.
  if (
    request.expectedCurrentId === undefined ||
    (request.expectedCurrentId !== null && canonicalUuid(request.expectedCurrentId) === null)
  ) {
    throw new ClosingFxEvidenceError(
      "state the current recorded quote this recording succeeds (its id), or null for a first quote",
    );
  }
  const expectedCurrentId =
    request.expectedCurrentId === null ? null : canonicalUuid(request.expectedCurrentId);
  const rate = closingFxEvidenceRate(request.rate);
  if (rate === null) {
    throw new ClosingFxEvidenceError(
      "enter the closing exchange rate as a positive exact decimal with at most 9 whole digits and 10 decimal places",
    );
  }
  const source = boundedText(request.source, 1, 120);
  if (source === null) {
    throw new ClosingFxEvidenceError(
      "name where the closing exchange rate came from, in 1 to 120 characters",
    );
  }
  const reason = boundedText(request.reason, 8, 500);
  if (reason === null) {
    throw new ClosingFxEvidenceError(
      "state why this closing rate is recorded, in 8 to 500 characters",
    );
  }
  const { transactionCurrency, measurementCurrency, rateDate } = request;
  if (
    typeof transactionCurrency !== "string" ||
    !CURRENCY_CODE.test(transactionCurrency) ||
    typeof measurementCurrency !== "string" ||
    !CURRENCY_CODE.test(measurementCurrency)
  ) {
    throw new ClosingFxEvidenceError(
      "name the transaction and measurement currencies as ISO currency codes",
    );
  }
  if (transactionCurrency === measurementCurrency) {
    throw new ClosingFxEvidenceError(
      `a ${transactionCurrency} position measured in ${measurementCurrency} has no exchange rate to record`,
    );
  }
  if (rateDate !== undefined && (typeof rateDate !== "string" || !isIsoCalendarDate(rateDate))) {
    throw new ClosingFxEvidenceError("date the closing exchange rate with the period's final day");
  }
  return {
    bookId: canonicalUuid(request.bookId)!,
    subsidiaryId: canonicalUuid(request.subsidiaryId)!,
    periodId: canonicalUuid(request.periodId)!,
    accountId: canonicalUuid(request.accountId)!,
    requestId: canonicalUuid(request.requestId)!,
    expectedCurrentId,
    transactionCurrency,
    measurementCurrency,
    rateDate: rateDate as string | undefined,
    rate,
    source,
    reason,
  };
}

/**
 * The replay fingerprint of one recording: the exact payload (including the
 * expected current quote) and the recording actor. An identical retry
 * resolves to the recorded row; the same request id with any other payload
 * or actor refuses.
 */
export function closingFxEvidenceRequestSha256(
  input: RecordClosingFxRateEvidenceInput,
  actorId: string,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        actorId: typeof actorId === "string" ? actorId.toLowerCase() : actorId,
        input,
      }),
      "utf8",
    )
    .digest("hex");
}

/** The advisory fence serializing recordings for one exact position. */
export function closingFxEvidenceFenceKey(
  orgId: string,
  key: ClosingFxEvidencePositionKey,
): string {
  const canon = (value: string) => value.toLowerCase();
  return `fx-revaluation-evidence:${canon(orgId)}:${canon(key.bookId)}:${canon(key.subsidiaryId)}:${canon(key.periodId)}:${canon(key.accountId)}:${key.transactionCurrency}`;
}

/** The advisory fence serializing one request identity across positions. */
export function closingFxEvidenceRequestFenceKey(orgId: string, requestId: string): string {
  return `fx-revaluation-evidence-request:${orgId.toLowerCase()}:${requestId.toLowerCase()}`;
}

type EvidenceRow = {
  id: string;
  book_id: string;
  subsidiary_id: string;
  period_id: string;
  account_id: string;
  transaction_currency: string;
  measurement_currency: string;
  rate_date: string;
  rate: string;
  source: string;
  reason: string;
  version: number;
  supersedes_id: string | null;
  request_id: string;
  request_sha256: string;
  created_at: string;
  created_by: string;
};

function toRecord(row: EvidenceRow): ClosingFxRateEvidenceRecord {
  return {
    id: row.id,
    bookId: row.book_id,
    subsidiaryId: row.subsidiary_id,
    periodId: row.period_id,
    accountId: row.account_id,
    transactionCurrency: row.transaction_currency,
    measurementCurrency: row.measurement_currency,
    rateDate: row.rate_date,
    rate: row.rate,
    source: row.source,
    reason: row.reason,
    version: Number(row.version),
    supersedesId: row.supersedes_id,
    requestId: row.request_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const EVIDENCE_COLUMNS = sql`
  id, book_id, subsidiary_id, period_id, account_id, transaction_currency,
  measurement_currency, rate_date::text as rate_date, rate::text as rate,
  source, reason, version, supersedes_id, request_id, request_sha256,
  created_at::text as created_at, created_by`;

/**
 * The current (newest) quote for one exact position, or null when none is
 * recorded. Resolution follows the successor chain only: measurement
 * currency and rate date are facts of the selected version, never filters,
 * so a stale quote surfaces to its caller instead of being hidden.
 */
export async function loadCurrentClosingFxEvidence(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  key: ClosingFxEvidencePositionKey,
): Promise<ClosingFxRateEvidenceRecord | null> {
  const row = (
    await runner.execute<EvidenceRow>(
      sql`
    select ${EVIDENCE_COLUMNS}
      from fx_revaluation_rate_evidence e
     where e.org_id = ${orgId} and e.book_id = ${key.bookId}
       and e.subsidiary_id = ${key.subsidiaryId} and e.period_id = ${key.periodId}
       and e.account_id = ${key.accountId} and e.transaction_currency = ${key.transactionCurrency}
       and not exists (
         select 1 from fx_revaluation_rate_evidence successor
          where successor.org_id = e.org_id and successor.supersedes_id = e.id
       )
     limit 1`,
      "objects",
    )
  )[0];
  return row ? toRecord(row) : null;
}

/** Every recorded version for one position, oldest first. */
export async function listClosingFxEvidenceVersions(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
  key: ClosingFxEvidencePositionKey,
): Promise<ClosingFxRateEvidenceRecord[]> {
  const rows = await runner.execute<EvidenceRow>(
    sql`
    select ${EVIDENCE_COLUMNS}
      from fx_revaluation_rate_evidence e
     where e.org_id = ${orgId} and e.book_id = ${key.bookId}
       and e.subsidiary_id = ${key.subsidiaryId} and e.period_id = ${key.periodId}
       and e.account_id = ${key.accountId} and e.transaction_currency = ${key.transactionCurrency}
     order by e.version asc`,
    "objects",
  );
  return rows.map(toRecord);
}

/**
 * Why a recorded quote cannot price its position today, or null when it can:
 * the quote was bound to the book's measurement currency and the period's
 * final day when recorded, and a successor must correct either fact after
 * the native basis changed. A stale quote never falls back to the
 * organization's exchange rates.
 */
export function staleClosingFxEvidenceRefusal(
  quote: ClosingFxRateEvidenceRecord,
  measurementCurrency: string,
  rateDate: string,
): string | null {
  if (quote.measurementCurrency === measurementCurrency && quote.rateDate === rateDate) return null;
  return (
    `the recorded closing rate for this position converts into ${quote.measurementCurrency} as of ${quote.rateDate}, ` +
    `but this book now measures the legal entity in ${measurementCurrency} at ${rateDate}; ` +
    "record a successor closing rate for the current measurement before revaluing"
  );
}

/**
 * Record one closing quote under the caller's live command authority. The
 * shared ledger-setup fence precedes every read, matching the revaluation
 * run's own order, and the position fence serializes root creation and
 * successor appends for the exact scope. Recording prepares a revaluation
 * (including a correction in an already-closed period); it posts nothing.
 */
export async function recordClosingFxRateEvidence(args: {
  orgId: string;
  actorId: string;
  input: unknown;
}): Promise<{ evidence: ClosingFxRateEvidenceRecord; replayed: boolean }> {
  const input = parseClosingFxRateEvidenceInput(args.input);
  // Native identities are canonical UUID text from here on: the request
  // hash, both advisory fences, the replay actor comparison and every
  // stored-row read name the same organization and actor.
  const orgId = canonicalUuid(args.orgId) ?? args.orgId;
  const actorId = canonicalUuid(args.actorId) ?? args.actorId;
  const requestSha256 = closingFxEvidenceRequestSha256(input, actorId);
  return withOrgTransaction(orgId, async () => {
    await lockLedgerSetupFence(db, orgId, "shared");
    // One request identity serializes across every position before the
    // position fence: a concurrent retry of the same request (even one
    // naming another position) waits, then re-reads the recorded row below
    // and resolves as an exact replay or the supported payload refusal —
    // never as a raw unique-index error from a missed read.
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${closingFxEvidenceRequestFenceKey(orgId, input.requestId)}, 0))`);
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${closingFxEvidenceFenceKey(orgId, input)}, 0))`);
    await lockActorCommandAuthority(db, orgId, actorId, input.subsidiaryId, "close.run");
    if (!(await lockAndCheckOrgFeature(db, orgId, "multiCurrency"))) {
      throw new ClosingFxEvidenceFeatureDisabledError();
    }

    // Exact replay: the same request id, payload and actor resolve to the
    // recorded quote even if the position has since gained a successor.
    const replay = (
      await db.execute<EvidenceRow>(
        sql`
      select ${EVIDENCE_COLUMNS} from fx_revaluation_rate_evidence
       where org_id = ${orgId} and request_id = ${input.requestId}`,
        "objects",
      )
    )[0];
    if (replay) {
      if (replay.request_sha256 !== requestSha256 || replay.created_by !== actorId) {
        throw new ClosingFxEvidenceError(
          "this request has already recorded a different closing rate; reload the position and record again with a new request",
        );
      }
      return { evidence: toRecord(replay), replayed: true };
    }

    // Source rows are share-locked in a fixed order before their facts are
    // read, so the validated book, entity, period and account cannot change
    // before the quote commits.
    const book = (
      await db.execute<{ is_active: boolean; posts_gl: boolean }>(
        sql`
      select is_active, posts_gl from accounting_books
       where org_id = ${orgId} and id = ${input.bookId} for share`,
        "objects",
      )
    )[0];
    if (!book || !book.is_active || !book.posts_gl) {
      throw new ClosingFxEvidenceError(
        "record the closing rate on an active posting book; choose the book this close runs on",
      );
    }
    const subsidiary = (
      await db.execute<{ is_active: boolean; is_elimination: boolean }>(
        sql`
      select is_active, is_elimination from subsidiaries
       where org_id = ${orgId} and id = ${input.subsidiaryId} for share`,
        "objects",
      )
    )[0];
    if (!subsidiary || !subsidiary.is_active || subsidiary.is_elimination) {
      throw new ClosingFxEvidenceError(
        "record the closing rate for an active legal entity in this organization",
      );
    }
    const period = (
      await db.execute<{ ends_on: string }>(
        sql`
      select ends_on::text as ends_on from accounting_periods
       where org_id = ${orgId} and id = ${input.periodId} for share`,
        "objects",
      )
    )[0];
    if (!period) {
      throw new ClosingFxEvidenceError(
        "record the closing rate for an assigned accounting period in this organization",
      );
    }
    if (input.rateDate !== undefined && input.rateDate !== period.ends_on) {
      throw new ClosingFxEvidenceError(
        `the closing exchange rate must be dated ${period.ends_on}, the final day of its assigned period`,
      );
    }
    const account = (
      await db.execute<{ is_active: boolean; is_summary: boolean; is_monetary: boolean }>(
        sql`
      select a.is_active, a.is_summary, ${MONETARY_ACCOUNT_SQL} as is_monetary
        from accounts a
       where a.org_id = ${orgId} and a.id = ${input.accountId} for share`,
        "objects",
      )
    )[0];
    if (!account || !account.is_active || account.is_summary || !account.is_monetary) {
      throw new ClosingFxEvidenceError(
        "record the closing rate for an active monetary account — a bank, receivable, payable or monetary balance-sheet account",
      );
    }
    // The account must also be available to this legal entity under the
    // native subsidiary restrictions posting itself enforces: an account
    // restricted to another entity is not an inert quote reference here.
    try {
      const ctx = await loadSubsidiaryContext(db, orgId);
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx,
        docSubsidiaryId: input.subsidiaryId,
        lines: [{ accountId: input.accountId, amount: "0", subsidiaryId: input.subsidiaryId }],
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) {
        throw new ClosingFxEvidenceError(
          `${error.message}; record the closing rate on an account available to this legal entity`,
        );
      }
      throw error;
    }
    const currencies = await db.execute<{ code: string }>(
      sql`
      select code from currencies where code in (${input.transactionCurrency}, ${input.measurementCurrency}) for share`,
      "objects",
    );
    if (currencies.length !== 2) {
      throw new ClosingFxEvidenceError("name registered transaction and measurement currencies");
    }
    const measured = (
      await db.execute<{ currency: string | null }>(
        sql`
      select public.accounting_book_currency(${orgId}, ${input.bookId}, ${input.subsidiaryId}) as currency`,
        "objects",
      )
    )[0]?.currency;
    if (!measured) throw new ScopeNotFoundError();
    if (measured !== input.measurementCurrency) {
      throw new ClosingFxEvidenceError(
        `this book measures the legal entity in ${measured}; record the closing rate into ${measured}, or correct the book's measurement currency first`,
      );
    }

    const current = await loadCurrentClosingFxEvidence(db, orgId, input);
    const currentId = current?.id ?? null;
    if (input.expectedCurrentId !== currentId) {
      throw new ClosingFxEvidenceError(
        currentId === null
          ? "this position has no recorded closing rate yet; reload it and record the first quote without expecting a current version"
          : input.expectedCurrentId === null
            ? `this position already has a recorded closing rate (version ${current!.version}); reload it and record a successor against the current version`
            : "the recorded closing rate for this position has changed since it was loaded; reload it and record the successor against the current version",
      );
    }

    const inserted = await db.execute<EvidenceRow>(
      sql`
      insert into fx_revaluation_rate_evidence
        (id, org_id, book_id, subsidiary_id, period_id, account_id,
         transaction_currency, measurement_currency, rate_date, rate,
         source, reason, version, supersedes_id, request_id, request_sha256, created_by)
      values (${randomUUID()}, ${orgId}, ${input.bookId}, ${input.subsidiaryId}, ${input.periodId},
        ${input.accountId}, ${input.transactionCurrency}, ${measured}, ${period.ends_on}, ${input.rate},
        ${input.source}, ${input.reason}, ${current ? current.version + 1 : 1},
        ${currentId}, ${input.requestId}, ${requestSha256}, ${actorId})
      returning ${EVIDENCE_COLUMNS}`,
      "objects",
    );
    const row = inserted[0];
    if (!row) {
      throw new ClosingFxEvidenceError(
        "the closing rate was not recorded; reload the position and record again",
      );
    }
    return { evidence: toRecord(row), replayed: false };
  });
}
