/** Banking core: errors, statement types, context, scope SQL, actor helpers, and the two types shared parsers and import both point at. Split from banking.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Domain error → API 422. Message is safe to show to the user. */
export class BankingError extends Error {
  readonly name = "BankingError";
  readonly status = 422;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedStatementLine {
  /** ISO date (YYYY-MM-DD). */
  postedOn: string;
  /** Signed decimal string from the bank's perspective (+ deposit / − withdrawal). */
  amount: string;
  description: string | null;
  counterpartyRef?: string | null;
  /** Source-provided dedupe key (OFX FITID); null when the source supplies no sound transaction identity. */
  bankTransactionId?: string | null;
}

export interface ParsedStatement {
  lines: ParsedStatementLine[];
  currency?: string;
  /** Balance-as-of date when the file carries one (OFX LEDGERBAL/DTASOF). */
  statementDate?: string;
  closingBalance?: string;
  /**
   * The file's own bank-account identifier when the format carries one
   * (OFX ACCTID, BAI2 account record, MT940 :25:, CAMT.053 account
   * IBAN/Id). Absent for CSV and for files whose format omits it. The
   * scheduled SFTP import compares this against the schedule's expected
   * identifier and refuses mismatches instead of filing one account's
   * lines and balance evidence into another.
   */
  externalAccountId?: string;
}

/**
 * Canonical form for comparing a file's account identifier against a
 * schedule's expected binding: surrounding and inner whitespace removed
 * (IBAN print format), uppercased (IBANs and BAI2 numbers are
 * case-insensitive identifiers). Returns undefined for blank input so an
 * absent identifier and an empty one compare alike. Used both when
 * storing the binding and when comparing, so neither side can smuggle a
 * mismatch past spacing or case.
 */
export function normalizeExternalAccountId(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const canonical = raw.replace(/\s+/g, "").toUpperCase();
  return canonical === "" ? undefined : canonical;
}

export type StatementSource = "ofx" | "csv" | "camt053" | "bai2" | "mt940" | "feed_api" | "manual";

/** Increment whenever statement-to-line normalization semantics change. */
export const BANK_STATEMENT_PARSER_VERSION = "2026.08.6";

export type StatementSourceContent = string | Uint8Array;
export type StatementTextSource = Extract<StatementSource, "ofx" | "csv" | "camt053" | "bai2" | "mt940">;

/** Exact source and transformation evidence retained for later audit. */
export interface StatementSourceEvidence {
  content: StatementSourceContent;
  filename?: string | null;
  contentType?: string | null;
  parserVersion?: string | null;
  csvMapping?: CsvMapping | null;
}

const CTX = Symbol();
export interface BankingContext {
  orgId: string;
  userId: string;
  /**
   * Durable job marker persisted as `audit_log.request_id` on the rows an
   * engine-initiated write produces (e.g. `sftp-import:<scheduleId>` for a
   * scheduled SFTP statement pull — see sftpImportAuditSource). Engine callers
   * that have no background-job identity leave it unset, which persists null
   * exactly as before. It names the JOB, never a human actor: attribution of
   * people stays on `userId`.
   */
  requestId?: string | null;
  /**
   * Subsidiaries the caller may see, using the canonical subsidiary-scope
   * module's contract: REQUIRED, explicit null only, never omission. Null
   * means unrestricted (system-initiated work such as the SFTP daemon and
   * scheduled feed syncs). A present set — even empty — restricts: an empty
   * set sees nothing, failing closed. Bank accounts are scoped by their
   * owning `accounts.subsidiary_id`; a null (shared) account is visible
   * only to unrestricted callers, and journal-line claims are additionally
   * filtered to the caller's own subsidiaries.
   */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  // prevents accidental structural-typing mixups with other {orgId,userId} bags
  [CTX]?: never;
}

/**
 * SQL fragment restricting a subsidiary column to the caller's scope —
 * used both for a bank account's owning subsidiary and for journal-line
 * subsidiaries. A null (shared) subsidiary never matches, so restricted
 * callers fail closed exactly like subsidiaryVisibleFilter without
 * orgWideNull; an empty set reads zero rows.
 */
export function subsidiaryScopeSql(
  scope: ReadonlySet<string> | null,
  column: ReturnType<typeof sql>,
): ReturnType<typeof sql> {
  if (scope == null) return sql``;
  return sql` and ${column} = any(${`{${[...scope].join(",")}}`}::uuid[])`;
}

/**
 * Explicit actor for engine-initiated financial writes that no signed-in human
 * performed — scheduled bank-feed pulls and other background jobs. Persistence
 * sites must carry this documented id so provenance stays queryable and is
 * never confused with a real operator; the zero UUID means "no actor at all"
 * and must never be persisted. It has no users row and must never be granted a
 * session, role, or credential.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000001";

/** The zero UUID means "no actor at all" and is never persisted; see {@link requireActorId}. */
const NO_ACTOR_SENTINEL_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The zero UUID means "no actor at all" — an absence, not an identity. It must
 * never name who performed a financial write, so the import boundary rejects
 * it (and blank/whitespace actors) outright instead of silently persisting it
 * where an audit query would read it as a person.
 */
export function requireActorId(userId: string): void {
  const trimmed = userId?.trim() ?? "";
  if (!trimmed || trimmed === NO_ACTOR_SENTINEL_ID) {
    throw new BankingError(
      "A bank statement import requires a real actor: the authenticated operator or SYSTEM_ACTOR_ID — never a no-actor placeholder",
    );
  }
}

// ---------------------------------------------------------------------------
// Source decoding
// ---------------------------------------------------------------------------

export interface CsvMapping {
  /** Zero-based column indexes into each CSV row. */
  date: number;
  amount: number;
  description: number;
  counterpartyRef?: number;
  bankTransactionId?: number;
  /**
   * Some bank exports split money into Debit and Credit columns; when set,
   * `amount` is the credit (money-in) column and this is the money-out
   * column, negated on import.
   */
  debitAmount?: number;
}
/**
 * A source row the parser set aside without importing: the 1-based file
 * line, a reason CODE, and the raw date-column cell the sentence renders.
 * The code (not English prose) crosses the engine boundary so every locale
 * renders the sentence from its own catalog. Reported in the import result
 * and the dry-run preview — a skipped row is a visible fact, never a silent
 * loss. Column-header rows are consumed, not skipped (see parseCsv); a row
 * that looks like a transaction is never skipped: the parse refuses
 * instead.
 */
export type SkippedStatementRowCode = "csv_metadata_row";
export interface SkippedStatementRow {
  line: number;
  code: SkippedStatementRowCode;
  /** Raw date-column cell of the set-aside row, for the localized sentence. */
  dateCell: string;
}
