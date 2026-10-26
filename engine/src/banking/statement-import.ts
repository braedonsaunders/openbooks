/** Statement import with dedupe. Split from banking.ts (pure moves only). */
import {
  BankingError,
  statementTotalsAgree,
  type ParsedStatementLine,
  type StatementSource,
  BANK_STATEMENT_PARSER_VERSION,
  type StatementSourceEvidence,
  type BankingContext,
  requireActorId,
  type SkippedStatementRow,
  type BalanceCandidateLine,
} from "./banking-core";
import { canonicalCsvMapping } from "./statement-parsers/csv";
import {
  loadReconcilableAccount,
  lockBankAccountInScope,
  lockReconciliationAccount,
} from "./reconcilable-account";
import {
  assertRealDate,
  detectStatementBalanceRole,
  normalizeAmount,
} from "./statement-parsers/shared";
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, type SqlExecutor } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";

export function normalizeFingerprintText(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/** An imported (or previewed) line with its possible-duplicate flag state. */
export type FlaggedStatementLine = ParsedStatementLine & { possibleDuplicateOf: string | null };

/**
 * Apply the safe automatic statement dedupe rules to source-identified
 * lines. An exact retry of source bytes is the same import, and a
 * source-provided ID (OFX FITID) already on the account — or already seen in
 * this batch — marks the line a duplicate. ID-less lines bypass this
 * filter: no content tuple may auto-skip (see importStatement), so they are
 * partitioned there.
 */
export function filterDuplicateStatementLines(
  lines: ParsedStatementLine[],
  existingTransactionIds: ReadonlySet<string>,
  exactSourceRetry = false,
): { lines: ParsedStatementLine[]; duplicates: number } {
  if (exactSourceRetry) return { lines: [], duplicates: lines.length };
  const batchSeen = new Set<string>();
  const fresh: ParsedStatementLine[] = [];
  let duplicates = 0;
  for (const line of lines) {
    const key = line.bankTransactionId;
    if (key && (existingTransactionIds.has(key) || batchSeen.has(key))) {
      duplicates += 1;
      continue;
    }
    if (key) batchSeen.add(key);
    fresh.push(line);
  }
  return { lines: fresh, duplicates };
}

type StoredContentCandidate = { id: string; amountUnits: bigint };

/**
 * Partition validated lines for import. Source-identified lines go through the
 * ID filter; ID-less lines match stored content on this account: a tuple
 * colliding with an already-imported line is returned flagged with the earliest
 * stored line as its possible-duplicate evidence. A tuple alone cannot tell a
 * re-export from a genuine twin, so the flag never skips on its own; the caller
 * decides whether flagged lines import (see importStatement). Batch order is
 * preserved so the dry-run preview reads file order.
 */
async function partitionIdlessLines(
  tx: SqlExecutor,
  orgId: string,
  accountId: string,
  lines: (ParsedStatementLine & { bankTransactionId: string | null })[],
  existingIds: ReadonlySet<string>,
  exactSourceRetry: boolean,
): Promise<{ lines: FlaggedStatementLine[]; duplicates: number; possibleDuplicates: number }> {
  const identified = filterDuplicateStatementLines(lines, existingIds, exactSourceRetry);
  if (exactSourceRetry) {
    return {
      lines: identified.lines.map((line) => ({ ...line, possibleDuplicateOf: null })),
      duplicates: identified.duplicates,
      possibleDuplicates: 0,
    };
  }
  // Stored content candidates for the incoming lines' tuples, earliest
  // first: uuid v7 orders chronologically, so the first row per tuple is
  // the earlier import a flag points at.
  const storedByTuple = new Map<string, StoredContentCandidate[]>();
  const idlessDates = [
    ...new Set(identified.lines.flatMap((line) => (line.bankTransactionId ? [] : [line.postedOn]))),
  ];
  if (idlessDates.length > 0) {
    const stored = await tx.execute<{
      id: string;
      posted_on: string;
      amount: string;
      description: string | null;
    }>(
      sql`
      select l.id, l.posted_on::text as posted_on, l.amount::text as amount, l.description
        from bank_statement_lines l
       where l.org_id = ${orgId} and l.account_id = ${accountId}
         and l.posted_on in (${sql.join(
           idlessDates.map((d) => sql`${d}`),
           sql`, `,
         )})
       order by l.id
    `,
      "objects",
    );
    for (const row of stored) {
      const key = `${row.posted_on}\0${normalizeFingerprintText(row.description)}`;
      const list = storedByTuple.get(key) ?? [];
      list.push({ id: row.id, amountUnits: toUnits(row.amount) });
      storedByTuple.set(key, list);
    }
  }
  const fresh: FlaggedStatementLine[] = [];
  const duplicates = identified.duplicates;
  let possibleDuplicates = 0;
  for (const line of identified.lines) {
    if (line.bankTransactionId) {
      fresh.push({ ...line, possibleDuplicateOf: null });
      continue;
    }
    const tupleKey = `${line.postedOn}\0${normalizeFingerprintText(line.description)}`;
    const amountUnits = toUnits(line.amount);
    const colliding = (storedByTuple.get(tupleKey) ?? []).filter(
      (candidate) => candidate.amountUnits === amountUnits,
    );
    if (colliding.length > 0) {
      possibleDuplicates += 1;
      fresh.push({ ...line, possibleDuplicateOf: colliding[0]!.id });
      continue;
    }
    fresh.push({ ...line, possibleDuplicateOf: null });
  }
  return { lines: fresh, duplicates, possibleDuplicates };
}

export interface ImportResult {
  /** Null when every line was a duplicate (nothing was written). */
  statementId: string | null;
  /** Pointer to the append-only audit row containing the exact source bytes. */
  sourceEvidenceRef: string | null;
  imported: number;
  /**
   * Parsed rows set aside as likely statement balances (CSV/OFX
   * balance-hint tags): offered as opening/closing balances in the
   * preview, never written as statement lines, never deduped against.
   */
  balanceCandidates: BalanceCandidateLine[];
  duplicates: number;
  /** Source rows set aside at parse time (see SkippedStatementRow). */
  skipped: SkippedStatementRow[];
  /**
   * ID-less lines whose content overlaps a line already on the account
   * without proven identity. They are excluded by default and listed in
   * `possibleDuplicateLines`; with `includePossibleDuplicates` they import
   * flagged with the earlier line as evidence, and matching refuses flagged
   * lines until the reviewer clears the flag or excludes the line.
   */
  possibleDuplicates: number;
  /**
   * The possible-duplicate candidates (flagged, `possibleDuplicateOf` set),
   * whether or not they were imported. The preview shows them so the operator
   * can decide before committing.
   */
  possibleDuplicateLines: FlaggedStatementLine[];
  /**
   * The prior signed-off statement's closing balance for this account, when
   * one chains into this import: the operator's opening-balance default.
   * Null when no signed-off history covers an earlier closing.
   */
  suggestedOpening: SuggestedStatementOpening | null;
  /**
   * Set when the supplied opening balance differs from the chained closing:
   * a flag for review, never a refusal — a missing month explains most
   * mismatches, and the operator may know better.
   */
  openingMismatch: OpeningBalanceMismatch | null;
  /**
   * Net of every transaction line in the file, duplicates of earlier
   * imports included: opening plus this is the statement's closing. The
   * preview checks the typed balances against it as they change.
   */
  statementLinesTotal: string;
  /**
   * Set when both balances are supplied and opening plus the file's lines
   * does not reach the closing: a flag for review, like the opening
   * mismatch — sign-off refuses any closing the matched lines do not reach.
   */
  balanceMismatch: StatementBalanceMismatch | null;
  /** The deduped lines (dry-run preview shows exactly what import would write, flags included). */
  lines: FlaggedStatementLine[];
}

const MAX_STATEMENT_EVIDENCE_BYTES = 25 * 1024 * 1024;

/** Stable identity for exact statement source bytes (filename is metadata). */
export function statementSourceSha256(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultStatementContentType(source: StatementSource): string {
  if (source === "ofx") return "application/x-ofx";
  if (source === "csv") return "text/csv";
  if (source === "camt053") return "application/xml";
  if (source === "feed_api") return "application/json";
  return "text/plain";
}

function defaultStatementFilename(source: StatementSource, hash: string): string {
  const extension = source === "camt053" ? "xml" : source === "feed_api" ? "json" : source;
  return `bank-statement-${hash.slice(0, 16)}.${extension}`;
}

function sourceEvidence(
  opts: {
    source: StatementSource;
    sourceEvidence?: StatementSourceEvidence | null;
    statementDate?: string | null;
    openingBalance?: string | null;
    closingBalance?: string | null;
    currency?: string | null;
  },
  lines: ParsedStatementLine[],
): {
  auditId: string;
  ref: string;
  sha256: string;
  changes: Record<string, unknown>;
} {
  const supplied = opts.sourceEvidence;
  const bytes = supplied
    ? typeof supplied.content === "string"
      ? Buffer.from(supplied.content, "utf8")
      : Buffer.from(supplied.content)
    : Buffer.from(
        JSON.stringify({
          source: opts.source,
          statementDate: opts.statementDate ?? null,
          openingBalance: opts.openingBalance ?? null,
          closingBalance: opts.closingBalance ?? null,
          currency: opts.currency ?? null,
          lines,
        }),
        "utf8",
      );
  if (bytes.length === 0) {
    throw new BankingError("Statement source evidence is empty");
  }
  if (bytes.length > MAX_STATEMENT_EVIDENCE_BYTES) {
    throw new BankingError("Statement source evidence exceeds the 25 MB limit");
  }
  const sha256 = statementSourceSha256(bytes);
  const requestedContentType = supplied?.contentType?.trim().toLowerCase();
  const contentType =
    requestedContentType &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(requestedContentType)
      ? requestedContentType
      : defaultStatementContentType(opts.source);
  const requestedFilename = supplied?.filename
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^.*[\\/]/, "")
    .trim()
    .slice(0, 240);
  const filename = requestedFilename || defaultStatementFilename(opts.source, sha256);
  const requestedParserVersion = supplied?.parserVersion?.trim();
  if (supplied?.parserVersion != null && !requestedParserVersion) {
    throw new BankingError("Statement parser version evidence is empty");
  }
  if (requestedParserVersion && requestedParserVersion.length > 100) {
    throw new BankingError("Statement parser version evidence exceeds 100 characters");
  }
  const parserVersion = requestedParserVersion ?? BANK_STATEMENT_PARSER_VERSION;
  const csvMapping = supplied?.csvMapping ? canonicalCsvMapping(supplied.csvMapping) : null;
  if (opts.source === "csv" && !csvMapping) {
    throw new BankingError("CSV source evidence requires the column mapping used to parse it");
  }
  if (opts.source !== "csv" && csvMapping) {
    throw new BankingError("CSV mapping evidence is only valid for CSV statements");
  }
  const auditId = randomUUID();
  return {
    auditId,
    ref: `audit-log:${auditId}#sha256=${sha256}`,
    sha256,
    changes: {
      operation: "statement_import",
      source: opts.source,
      sourceEvidence: {
        encoding: "base64",
        content: bytes.toString("base64"),
        filename,
        contentType,
        byteLength: bytes.length,
        sha256,
        provenance: supplied ? "original_source" : "normalized_import_request",
        parserVersion,
        csvMapping,
      },
    },
  };
}

/**
 * Import normalized statement lines for a reconcilable account. Lines whose
 * source-provided `bankTransactionId` already exists on the account are
 * skipped, as is an exact retry of source bytes for the same account.
 * An ID-less line whose content matches a line already on the account is a
 * possible duplicate: it is excluded from the import unless the caller passes
 * `includePossibleDuplicates`, and when imported it is flagged for review.
 * A matching balance or content tuple is never identity on its own. With
 * `dryRun` nothing is written — used for preview; the preview reports the
 * same partition the commit would apply.
 * Committed imports retain their exact source bytes in the append-only audit
 * log and point `rawFileRef` to that evidence. Engine callers without an
 * external file/feed payload retain a canonical copy of the import request.
 */
export async function importStatement(
  opts: {
    accountId: string;
    source: StatementSource;
    lines: ParsedStatementLine[];
    /**
     * Rows the parser set aside (see SkippedStatementRow): echoed in the
     * result so the import and the dry-run preview report them. Never
     * written, never deduped against.
     */
    skippedLines?: SkippedStatementRow[];
    statementDate?: string | null;
    openingBalance?: string | null;
    closingBalance?: string | null;
    currency?: string | null;
    sourceEvidence?: StatementSourceEvidence | null;
    /**
     * Import possible duplicates flagged for review instead of excluding them.
     * Operator commits pass the reviewer's explicit choice; unattended feeds
     * pass true because no operator is present to review an exclusion, so
     * their flagged lines enter the review queue rather than disappearing.
     */
    includePossibleDuplicates?: boolean;
    dryRun?: boolean;
    beforeWrite?: (executor: SqlExecutor) => Promise<void>;
    /** Domain fence checked on the import writer immediately before persistence. */
    writeFence?: (tx: SqlExecutor) => Promise<void>;
  },
  ctx: BankingContext,
): Promise<ImportResult> {
  const skipped = opts.skippedLines ?? [];
  if (opts.lines.length === 0) throw new BankingError("No statement lines to import");
  // Provenance gate: every persisted statement/line/audit actor comes from
  // ctx.userId, so a no-actor placeholder arriving here would sink into all
  // three evidence surfaces. Fail closed before any write.
  requireActorId(ctx.userId);
  let account = await loadReconcilableAccount(ctx.orgId, opts.accountId, ctx.allowedSubsidiaryIds);
  let currency = (opts.currency ?? account.currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new BankingError("Statement currency must be a three-letter ISO currency code");
  }
  if (account.currency && currency !== account.currency) {
    throw new BankingError(
      `Statement currency ${currency} does not match account currency ${account.currency}`,
    );
  }
  const validated = opts.lines.map((line, index) => {
    const dateMatch = line.postedOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch)
      throw new BankingError(`Statement line ${index + 1}: posted date must be YYYY-MM-DD`);
    const postedOn = assertRealDate(
      dateMatch[1]!,
      dateMatch[2]!,
      dateMatch[3]!,
      `Statement line ${index + 1} date`,
    );
    const bankTransactionId = line.bankTransactionId?.trim() || null;
    return {
      ...line,
      postedOn,
      amount: normalizeAmount(line.amount, `Statement line ${index + 1} amount`),
      bankTransactionId,
    };
  });
  // Balance-hint tags (CSV/OFX "Opening balance …" rows) split out before
  // dedupe: a summary row has no GL counterpart, so importing it as a
  // transaction would block sign-off forever. Candidates are offered as
  // opening/closing balances in the preview and never written. Lines that
  // arrive without a parser hint are detected here too, so pre-parsed
  // callers get the same contract as source-text imports.
  const balanceCandidates: BalanceCandidateLine[] = [];
  const transactable: typeof validated = [];
  for (const line of validated) {
    const role = line.balanceHint ?? detectStatementBalanceRole(line.description);
    if (role) {
      balanceCandidates.push({
        postedOn: line.postedOn,
        amount: line.amount,
        description: line.description,
        counterpartyRef: line.counterpartyRef ?? null,
        bankTransactionId: line.bankTransactionId ?? null,
        role,
      });
    } else {
      transactable.push(line);
    }
  }
  // ID-less lines keep a null bankTransactionId: their content is possible
  // overlap, never identity, so no synthetic ID may stand in for a bank
  // key. The account-scoped unique index still guards source-provided IDs.
  const openingBalance = opts.openingBalance
    ? normalizeAmount(opts.openingBalance, "Opening balance")
    : null;
  const closingBalance = opts.closingBalance
    ? normalizeAmount(opts.closingBalance, "Closing balance")
    : null;
  // A statement is arithmetic: opening plus its lines is its closing. Both
  // balances supplied and disagreeing means a mistyped figure, a file that
  // covers only part of the statement, or a line the bank's own balance
  // leaves out. The preview and the result name the gap before and after
  // import; sign-off stays the strict gate against the typed closing.
  const statementLinesTotal = fromUnits(
    transactable.reduce((sum, line) => sum + toUnits(line.amount), 0n),
  );
  const balanceMismatch = statementBalanceMismatch(
    openingBalance,
    closingBalance,
    statementLinesTotal,
    account.type,
  );
  // Prepare before opening the transaction so preview exercises the same
  // evidence limits as import and hashing/base64 work never holds the account
  // dedupe lock.
  const evidence = sourceEvidence(opts, opts.lines);

  return db.transaction(async (tx) => {
    // Serialize dedupe decisions for this tenant/account. The unique index is
    // the database backstop; the lock lets a concurrent retry return a clean
    // duplicate result instead of leaking a constraint error.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`bank-statement-import:${ctx.orgId}:${account.id}`}, 0)
      )
    `);
    // The preflight above routes and validates the request only. Re-read the
    // bank account under a row lock inside the write transaction so a
    // concurrent subsidiary rehome cannot authorize statement rows in the
    // account's new scope using the caller's stale permission snapshot.
    account = await loadReconcilableAccount(
      ctx.orgId,
      opts.accountId,
      ctx.allowedSubsidiaryIds,
      tx,
      true,
    );
    currency = (opts.currency ?? account.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new BankingError("Statement currency must be a three-letter ISO currency code");
    }
    if (currency !== account.currency) {
      throw new BankingError(
        `Statement currency ${currency} does not match account currency ${account.currency}`,
      );
    }
    await opts.beforeWrite?.(tx);
    await opts.writeFence?.(tx);
    const sourceAlreadyImported = Boolean(
      (
        await tx.execute<{ imported: boolean }>(
          sql`
      select exists (
        select 1
          from bank_statements
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and source_file_sha256 = ${evidence.sha256}
      ) as imported
    `,
          "objects",
        )
      )[0]?.imported,
    );
    const ids = sourceAlreadyImported
      ? []
      : [
          ...new Set(
            transactable.flatMap((line) =>
              line.bankTransactionId ? [line.bankTransactionId] : [],
            ),
          ),
        ];
    const existingIds = new Set<string>();
    if (ids.length > 0) {
      const existing = await tx.execute<{ id: string }>(
        sql`
        select bank_transaction_id as id
          from bank_statement_lines
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and bank_transaction_id in (${sql.join(
             ids.map((id) => sql`${id}`),
             sql`, `,
           )})
      `,
        "objects",
      );
      for (const row of existing) existingIds.add(row.id);
    }
    // ID-less lines partition by content against stored lines on this
    // account. A tuple matching a stored line is a possible duplicate: it
    // carries the earlier line as its evidence and imports only on the
    // reviewer's opt-in. Genuinely new content imports clean.
    const partitioned = await partitionIdlessLines(
      tx,
      ctx.orgId,
      account.id,
      transactable,
      existingIds,
      sourceAlreadyImported,
    );
    const duplicates = partitioned.duplicates;
    const possibleDuplicates = partitioned.possibleDuplicates;
    const possibleDuplicateLines = partitioned.lines.filter(
      (line) => line.possibleDuplicateOf !== null,
    );
    // Possible duplicates import only on the reviewer's explicit opt-in; by
    // default they are reported (preview) and left out of the write.
    const fresh = opts.includePossibleDuplicates
      ? partitioned.lines
      : partitioned.lines.filter((line) => line.possibleDuplicateOf === null);
    // Serialize with sign-off through the shared reconciliation lock. No
    // other path takes the import lock, so acquiring it first here cannot
    // deadlock; holding both through the insert closes the race with a
    // concurrent sign-off's unmatched check. Then refuse lines dated inside
    // signed-off coverage. Signed-off history is immutable: a late distinct
    // transaction under a signed cutoff would import as unmatched evidence
    // the closed session can never clear, and without the shared lock it
    // could slip in beside a concurrent sign-off's unmatched check. Only
    // lines that would be written are fenced — excluded duplicates and
    // already-imported lines stay idempotent so retrying a file never
    // refuses. This runs before the dry-run return so a preview agrees with
    // the import it previews.
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    const signedThrough = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status = 'signed_off'
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (signedThrough) {
      const late = fresh.filter((line) => line.postedOn <= signedThrough.through_date);
      if (late.length > 0) {
        throw new BankingError(
          `Cannot import: ${late.length} statement line(s) dated on or before the signed-off reconciliation through ${signedThrough.through_date} — signed-off history is immutable; import only lines dated after ${signedThrough.through_date}, or reopen Banking for that period and withdraw the sign-off (newest first) to import them at their true dates`,
        );
      }
    }
    // Chained opening: the latest earlier statement with a closing balance
    // fully inside signed-off history defaults the next import's opening.
    // Uncovered closings are skipped — an unproven figure must not seed the
    // next month. A supplied opening that differs is flagged, never refused.
    let suggestedOpening: SuggestedStatementOpening | null = null;
    let openingMismatch: OpeningBalanceMismatch | null = null;
    {
      const anchor =
        opts.statementDate ??
        validated.reduce(
          (max, line) => (line.postedOn > max ? line.postedOn : max),
          validated[0]!.postedOn,
        );
      if (signedThrough) {
        const prior = (
          await tx.execute<{
            id: string;
            statement_date: string;
            closing_balance: string | null;
          }>(
            sql`
          select s.id, s.statement_date::text as statement_date, s.closing_balance::text as closing_balance
            from bank_statements s
           where s.org_id = ${ctx.orgId} and s.account_id = ${account.id}
             and s.closing_balance is not null
             and s.statement_date < ${anchor}
             and not exists (
               select 1 from bank_statement_lines l
                where l.statement_id = s.id and l.org_id = s.org_id
                  and l.posted_on > ${signedThrough.through_date}
             )
           order by s.statement_date desc, s.imported_at desc
           limit 1
        `,
            "objects",
          )
        )[0];
        if (prior?.closing_balance) {
          suggestedOpening = {
            balance: prior.closing_balance,
            sourceStatementId: prior.id,
            sourceStatementDate: prior.statement_date,
          };
          if (openingBalance && toUnits(openingBalance) !== toUnits(prior.closing_balance)) {
            openingMismatch = { expected: prior.closing_balance, supplied: openingBalance };
          }
        }
      }
    }
    if (opts.dryRun || fresh.length === 0) {
      return {
        statementId: null,
        sourceEvidenceRef: null,
        imported: opts.dryRun ? fresh.length : 0,
        balanceCandidates,
        duplicates,
        possibleDuplicates,
        possibleDuplicateLines,
        skipped,
        suggestedOpening,
        openingMismatch,
        statementLinesTotal,
        balanceMismatch,
        lines: fresh,
      };
    }
    const ordered = fresh
      .map((line, index) => ({ ...line, index }))
      .sort((a, b) =>
        a.postedOn < b.postedOn ? -1 : a.postedOn > b.postedOn ? 1 : a.index - b.index,
      );
    const statementDate = opts.statementDate ?? ordered[ordered.length - 1]!.postedOn;
    const statementDateMatch = statementDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!statementDateMatch) {
      throw new BankingError("Statement date must be YYYY-MM-DD");
    }
    assertRealDate(
      statementDateMatch[1]!,
      statementDateMatch[2]!,
      statementDateMatch[3]!,
      "Statement date",
    );
    const [stmt] = await tx
      .insert(schema.bankStatements)
      .values({
        orgId: ctx.orgId,
        accountId: account.id,
        source: opts.source,
        statementDate,
        openingBalance,
        closingBalance,
        rawFileRef: evidence.ref,
        sourceFileSha256: evidence.sha256,
        createdBy: ctx.userId,
      })
      .returning({ id: schema.bankStatements.id });
    const statementId = stmt!.id;
    await tx.insert(schema.bankStatementLines).values(
      ordered.map((l, i) => ({
        orgId: ctx.orgId,
        statementId,
        accountId: account.id,
        lineNumber: i + 1,
        postedOn: l.postedOn,
        amount: l.amount,
        currency,
        description: l.description,
        counterpartyRef: l.counterpartyRef ?? null,
        bankTransactionId: l.bankTransactionId ?? null,
        possibleDuplicateOf: l.possibleDuplicateOf ?? null,
        matchStatus: "unmatched" as const,
        createdBy: ctx.userId,
      })),
    );
    // Possible duplicates held out of this import are part of its audit
    // record: the reviewer's default exclusion must be reconstructable from
    // the statement's audit row, not only from the source bytes.
    const excludedPossibleDuplicates = opts.includePossibleDuplicates ? [] : possibleDuplicateLines;
    const auditChanges =
      excludedPossibleDuplicates.length === 0
        ? evidence.changes
        : {
            ...evidence.changes,
            possibleDuplicatesExcluded: excludedPossibleDuplicates.map((line) => ({
              postedOn: line.postedOn,
              amount: line.amount,
              description: line.description,
              possibleDuplicateOf: line.possibleDuplicateOf,
            })),
          };
    await tx.execute(sql`
      insert into audit_log
        (id, org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${evidence.auditId}, ${ctx.orgId}, 'bank_statements', ${statementId}, 'insert',
         ${JSON.stringify(auditChanges)}::jsonb, ${ctx.userId}, ${ctx.requestId ?? null})
    `);
    return {
      statementId,
      sourceEvidenceRef: evidence.ref,
      imported: fresh.length,
      balanceCandidates,
      duplicates,
      possibleDuplicates,
      possibleDuplicateLines,
      skipped,
      suggestedOpening,
      openingMismatch,
      statementLinesTotal,
      balanceMismatch,
      lines: fresh,
    };
  });
}

/**
 * Delete a whole statement import with every line it brought in — the remedy
 * when an import is wrong beyond line-level correction, and the path that
 * frees a re-import (the sha backstop otherwise refuses the same file as a
 * duplicate). Only an untouched import can go: matched lines carry journal
 * evidence (unmatch first), excluded lines carry a review decision (restore
 * first), lines inside signed-off history are immutable, and other lines'
 * possible-duplicate pointers into this import are their review evidence
 * (clear those flags first). Every removed row is audited with its
 * before-image; nothing posts.
 */

/**
 * A prior statement's closing balance offered as the next import's opening.
 * Statement balances share one sign convention, so a closing chains into
 * the next opening unchanged.
 */
export interface SuggestedStatementOpening {
  /** Canonical decimal string. */
  balance: string;
  sourceStatementId: string;
  sourceStatementDate: string;
}

/** Opening plus the statement's lines against its supplied closing. */
export interface StatementBalanceMismatch {
  opening: string;
  linesTotal: string;
  expectedClosing: string;
  closing: string;
}

/**
 * Null when the balances are incomplete or agree. The lines total covers
 * every transaction line in the file, duplicates of earlier imports
 * included: the bank's balances describe the whole statement, not what this
 * import adds. Liability accounts accept either sign pairing, as their
 * statement totals do.
 */
export function statementBalanceMismatch(
  openingBalance: string | null,
  closingBalance: string | null,
  linesTotal: string,
  accountType: string,
): StatementBalanceMismatch | null {
  if (openingBalance === null || closingBalance === null) return null;
  const opening = toUnits(openingBalance);
  const closing = toUnits(closingBalance);
  const net = toUnits(linesTotal);
  if (statementTotalsAgree(closing - opening, net, accountType)) return null;
  return {
    opening: fromUnits(opening),
    linesTotal: fromUnits(net),
    expectedClosing: fromUnits(opening + net),
    closing: fromUnits(closing),
  };
}

/** A supplied opening that differs from the chained closing, for review. */
export interface OpeningBalanceMismatch {
  expected: string;
  supplied: string;
}

export interface StatementBalanceCorrection {
  /** Signed decimal string; null clears the balance; undefined leaves it. */
  openingBalance?: string | null;
  /** Signed decimal string; null clears the balance; undefined leaves it. */
  closingBalance?: string | null;
}

/**
 * Set the opening/closing balances on an imported statement — the CSV path,
 * which unlike OFX carries no bank-reported balances. Only before any match:
 * matched lines already footed sessions against these figures (unmatch
 * first), and never inside signed-off history. Every change is audited with
 * its before/after image; nothing posts.
 */
export async function correctStatementBalances(
  statementId: string,
  patch: StatementBalanceCorrection,
  ctx: BankingContext,
): Promise<{ openingBalance: string | null; closingBalance: string | null }> {
  const next: { openingBalance?: string | null; closingBalance?: string | null } = {};
  if (patch.openingBalance !== undefined) {
    next.openingBalance =
      patch.openingBalance === null
        ? null
        : normalizeAmount(patch.openingBalance, "Opening balance");
  }
  if (patch.closingBalance !== undefined) {
    next.closingBalance =
      patch.closingBalance === null
        ? null
        : normalizeAmount(patch.closingBalance, "Closing balance");
  }
  if (next.openingBalance === undefined && next.closingBalance === undefined) {
    throw new BankingError(
      "No balance supplied: set the opening balance, the closing balance, or both",
    );
  }
  const statement = (
    await db.execute<{ id: string; account_id: string }>(
      sql`
    select s.id, s.account_id
      from bank_statements s
     where s.id = ${statementId} and s.org_id = ${ctx.orgId}
  `,
      "objects",
    )
  )[0];
  if (!statement) throw new ScopeNotFoundError();
  const account = await loadReconcilableAccount(
    ctx.orgId,
    statement.account_id,
    ctx.allowedSubsidiaryIds,
  );
  return db.transaction(async (tx) => {
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    await lockBankAccountInScope(tx, ctx.orgId, account.id, ctx.allowedSubsidiaryIds);
    const before = (
      await tx.execute<{ opening_balance: string | null; closing_balance: string | null }>(
        sql`
      select s.opening_balance::text as opening_balance, s.closing_balance::text as closing_balance
        from bank_statements s
       where s.id = ${statementId} and s.org_id = ${ctx.orgId}
       for update
    `,
        "objects",
      )
    )[0]!;
    const matched = (
      await tx.execute<{ count: number }>(
        sql`
      select count(*)::int as count from reconciliation_matches m
       join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
       where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0]!.count;
    if (matched > 0) {
      throw new BankingError(`This import has ${matched} matched line(s) — unmatch them first`);
    }
    // Signed-off history is immutable (the import fence): balances feed the
    // opening carry and the closing-balance check, so they must not move
    // under a closed session.
    const signedThrough = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status = 'signed_off'
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (signedThrough) {
      const inside = (
        await tx.execute<{ count: number }>(
          sql`
        select count(*)::int as count from bank_statement_lines l
         where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
           and l.posted_on <= ${signedThrough.through_date}
      `,
          "objects",
        )
      )[0]!.count;
      if (inside > 0) {
        throw new BankingError(
          `This import reaches on or before the signed-off reconciliation through ${signedThrough.through_date} — signed-off history is immutable`,
        );
      }
    }
    const after = {
      openingBalance:
        next.openingBalance !== undefined ? next.openingBalance : before.opening_balance,
      closingBalance:
        next.closingBalance !== undefined ? next.closingBalance : before.closing_balance,
    };
    if (
      after.openingBalance === before.opening_balance &&
      after.closingBalance === before.closing_balance
    )
      return after;
    await tx.execute(sql`
      update bank_statements
         set opening_balance = ${after.openingBalance},
             closing_balance = ${after.closingBalance}
       where id = ${statementId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statements', ${statementId}, 'update',
         ${JSON.stringify({
           operation: "correct_balances",
           before: {
             openingBalance: before.opening_balance,
             closingBalance: before.closing_balance,
           },
           after,
         })}::jsonb,
         ${ctx.userId})
    `);
    return after;
  });
}
export async function deleteStatementImport(
  statementId: string,
  ctx: BankingContext,
): Promise<{ deletedLines: number }> {
  const statement = (
    await db.execute<{
      id: string;
      account_id: string;
      source: string;
      statement_date: string;
      opening_balance: string | null;
      closing_balance: string | null;
      imported_at: string;
    }>(
      sql`
    select s.id, s.account_id, s.source, s.statement_date::text as statement_date,
           s.opening_balance::text as opening_balance, s.closing_balance::text as closing_balance,
           s.imported_at::text as imported_at
      from bank_statements s
      join accounts a on a.id = s.account_id and a.org_id = s.org_id
     where s.id = ${statementId} and s.org_id = ${ctx.orgId}
  `,
      "objects",
    )
  )[0];
  if (!statement) throw new ScopeNotFoundError();
  const account = await loadReconcilableAccount(
    ctx.orgId,
    statement.account_id,
    ctx.allowedSubsidiaryIds,
  );
  return db.transaction(async (tx) => {
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    await lockBankAccountInScope(tx, ctx.orgId, account.id, ctx.allowedSubsidiaryIds);
    const lines = await tx.execute<{
      id: string;
      line_number: number;
      posted_on: string;
      amount: string;
      currency: string;
      description: string | null;
      counterparty_ref: string | null;
      bank_transaction_id: string | null;
      match_status: string;
    }>(
      sql`
      select l.id, l.line_number, l.posted_on::text as posted_on, l.amount::text as amount,
             l.currency, l.description, l.counterparty_ref, l.bank_transaction_id, l.match_status
        from bank_statement_lines l
       where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
       order by l.line_number
    `,
      "objects",
    );
    const matched = lines.filter((line) => line.match_status === "matched").length;
    if (matched > 0) {
      throw new BankingError(`This import has ${matched} matched line(s) — unmatch them first`);
    }
    const excluded = lines.filter((line) => line.match_status === "excluded").length;
    if (excluded > 0) {
      throw new BankingError(`This import has ${excluded} excluded line(s) — restore them first`);
    }
    // Defensive: status says unmatched only when no match rows remain, but
    // the rows are the evidence — never delete under them.
    const matchRows = (
      await tx.execute<{ count: number }>(
        sql`
      select count(*)::int as count from reconciliation_matches m
       join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
       where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0]!.count;
    if (matchRows > 0) {
      throw new BankingError(`This import has ${matchRows} matched line(s) — unmatch them first`);
    }
    // Signed-off history is immutable (the import fence): refuse below the
    // cutoff even with every line unmatched.
    const signedThrough = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status = 'signed_off'
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (signedThrough && lines.some((line) => line.posted_on <= signedThrough.through_date)) {
      throw new BankingError(
        `This import reaches on or before the signed-off reconciliation through ${signedThrough.through_date} — signed-off history is immutable`,
      );
    }
    // Other lines' possible-duplicate pointers into this import are their
    // review evidence; nulling them from a delete would rewrite it.
    const inboundFlags = (
      await tx.execute<{ count: number }>(
        sql`
      select count(*)::int as count from bank_statement_lines o
       where o.org_id = ${ctx.orgId}
         and o.possible_duplicate_of in (
           select l.id from bank_statement_lines l
            where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
         )
         and not (o.statement_id = ${statementId} and o.org_id = ${ctx.orgId})
    `,
        "objects",
      )
    )[0]!.count;
    if (inboundFlags > 0) {
      throw new BankingError(
        `This import is flagged as a possible duplicate by ${inboundFlags} other line(s) — clear those flags first`,
      );
    }
    for (const line of lines) {
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${ctx.orgId}, 'bank_statement_lines', ${line.id}, 'delete',
           ${JSON.stringify({
             operation: "delete_import_line",
             statementId,
             before: {
               lineNumber: line.line_number,
               postedOn: line.posted_on,
               amount: line.amount,
               currency: line.currency,
               description: line.description,
               counterpartyRef: line.counterparty_ref,
               bankTransactionId: line.bank_transaction_id,
             },
           })}::jsonb,
           ${ctx.userId})
      `);
    }
    // Governed-deletion marker for the statement-line guard: transaction
    // scoped, so only this untouched import's audited delete passes the
    // line-immutability fence.
    await tx.execute(sql`select set_config('app.statement_import_delete', ${statementId}, true)`);
    await tx.execute(sql`
      delete from bank_statement_lines
       where statement_id = ${statementId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statements', ${statementId}, 'delete',
         ${JSON.stringify({
           operation: "delete_import",
           before: {
             source: statement.source,
             statementDate: statement.statement_date,
             openingBalance: statement.opening_balance,
             closingBalance: statement.closing_balance,
             importedAt: statement.imported_at,
             lineCount: lines.length,
           },
         })}::jsonb,
         ${ctx.userId})
    `);
    await tx.execute(sql`
      delete from bank_statements
       where id = ${statementId} and org_id = ${ctx.orgId}
    `);
    return { deletedLines: lines.length };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation sessions
// ---------------------------------------------------------------------------
