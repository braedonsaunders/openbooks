/** Statement import with dedupe. Split from banking.ts (pure moves only). */
import { BankingError, type ParsedStatementLine, type StatementSource, BANK_STATEMENT_PARSER_VERSION, type StatementSourceEvidence, type BankingContext, requireActorId, type SkippedStatementRow } from "./banking-core"
import { canonicalCsvMapping } from "./statement-parsers/csv"
import { loadReconcilableAccount, lockReconciliationAccount } from "./reconcilable-account"
import { assertRealDate, normalizeAmount } from "./statement-parsers/shared"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { db, schema, type SqlExecutor } from "../platform/db.ts"
import { toUnits } from "../money/money.ts"

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
 * Partition validated lines into fresh imports. Source-identified lines go
 * through the ID filter; ID-less lines match stored content on this account:
 * a tuple colliding with an already-imported line imports flagged with the
 * earliest stored line as its possible-duplicate evidence, because a tuple
 * alone cannot tell a re-export from a genuine twin — only an exact
 * source-byte replay or a bank-provided ID may auto-skip. Batch order is
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
    ...new Set(
      identified.lines.flatMap((line) => (line.bankTransactionId ? [] : [line.postedOn])),
    ),
  ];
  if (idlessDates.length > 0) {
    const stored = (await tx.execute<{
      id: string; posted_on: string; amount: string; description: string | null;
    }>(sql`
      select l.id, l.posted_on::text as posted_on, l.amount::text as amount, l.description
        from bank_statement_lines l
       where l.org_id = ${orgId} and l.account_id = ${accountId}
         and l.posted_on in (${sql.join(idlessDates.map((d) => sql`${d}`), sql`, `)})
       order by l.id
    `));
    for (const row of stored.rows) {
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
  duplicates: number;
  /** Source rows set aside at parse time (see SkippedStatementRow). */
  skipped: SkippedStatementRow[];
  /**
   * ID-less lines imported on unproven content overlap, flagged as possible
   * duplicates of an earlier line for review. The reviewer clears the flag
   * or excludes the line; matching refuses flagged lines until then.
   */
  possibleDuplicates: number;
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
  const csvMapping = supplied?.csvMapping
    ? canonicalCsvMapping(supplied.csvMapping)
    : null;
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
 * Nothing else auto-skips: a matching balance or a matching content tuple
 * is possible overlap, not identity, so an ID-less line colliding with
 * stored content imports flagged as a possible duplicate of the earlier
 * line for review. With `dryRun` nothing is
 * written — used for preview.
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
    if (!dateMatch) throw new BankingError(`Statement line ${index + 1}: posted date must be YYYY-MM-DD`);
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
  // ID-less lines keep a null bankTransactionId: their content is possible
  // overlap, never identity, so no synthetic ID may stand in for a bank
  // key. The account-scoped unique index still guards source-provided IDs.
  const openingBalance = opts.openingBalance
    ? normalizeAmount(opts.openingBalance, "Opening balance")
    : null;
  const closingBalance = opts.closingBalance
    ? normalizeAmount(opts.closingBalance, "Closing balance")
    : null;
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
    account = await loadReconcilableAccount(ctx.orgId, opts.accountId, ctx.allowedSubsidiaryIds, tx, true);
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
    const sourceAlreadyImported = Boolean((await tx.execute<{ imported: boolean }>(sql`
      select exists (
        select 1
          from bank_statements
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and source_file_sha256 = ${evidence.sha256}
      ) as imported
    `)).rows[0]?.imported);
    const ids = sourceAlreadyImported
      ? []
      : [
          ...new Set(
            validated.flatMap((line) =>
              line.bankTransactionId ? [line.bankTransactionId] : [],
            ),
          ),
        ];
    const existingIds = new Set<string>();
    if (ids.length > 0) {
      const existing = (await tx.execute<{ id: string }>(sql`
        select bank_transaction_id as id
          from bank_statement_lines
         where org_id = ${ctx.orgId}
           and account_id = ${account.id}
           and bank_transaction_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      `));
      for (const row of existing.rows) existingIds.add(row.id);
    }
    // ID-less lines partition by content against stored lines on this
    // account. A tuple matching a stored line is possible overlap — both
    // lines import, the new one flagged with the earlier line as its
    // evidence for review. Genuinely new content imports clean.
    const { lines: fresh, duplicates, possibleDuplicates } =
      await partitionIdlessLines(tx, ctx.orgId, account.id, validated, existingIds, sourceAlreadyImported);
    // Serialize with sign-off through the shared reconciliation lock. No
    // other path takes the import lock, so acquiring it first here cannot
    // deadlock; holding both through the insert closes the race with a
    // concurrent sign-off's unmatched check. Then refuse lines dated inside
    // signed-off coverage. Signed-off history is immutable: a late distinct
    // transaction under a signed cutoff would import as unmatched evidence
    // the closed session can never clear, and without the shared lock it
    // could slip in beside a concurrent sign-off's unmatched check. Only
    // fresh lines are fenced — already-imported duplicates stay idempotent
    // so retrying a file never refuses. This runs before the dry-run return
    // so a preview agrees with the import it previews.
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    const signedThrough = (await tx.execute<{ through_date: string }>(sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.id} and status = 'signed_off'
       order by through_date desc limit 1
    `)).rows[0];
    if (signedThrough) {
      const late = fresh.filter((line) => line.postedOn <= signedThrough.through_date);
      if (late.length > 0) {
        throw new BankingError(
          `Cannot import: ${late.length} statement line(s) dated on or before the signed-off reconciliation through ${signedThrough.through_date} — signed-off history is immutable; import only lines dated after ${signedThrough.through_date}`,
        );
      }
    }
    if (opts.dryRun || fresh.length === 0) {
      return {
        statementId: null,
        sourceEvidenceRef: null,
        imported: opts.dryRun ? fresh.length : 0,
        duplicates,
        possibleDuplicates,
        skipped,
        lines: fresh,
      };
    }
    const ordered = fresh
      .map((line, index) => ({ ...line, index }))
      .sort((a, b) =>
        a.postedOn < b.postedOn
          ? -1
          : a.postedOn > b.postedOn
            ? 1
            : a.index - b.index,
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
    await tx.execute(sql`
      insert into audit_log
        (id, org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${evidence.auditId}, ${ctx.orgId}, 'bank_statements', ${statementId}, 'insert',
         ${JSON.stringify(evidence.changes)}::jsonb, ${ctx.userId}, ${ctx.requestId ?? null})
    `);
    return {
      statementId,
      sourceEvidenceRef: evidence.ref,
      imported: fresh.length,
      duplicates,
      possibleDuplicates,
      skipped,
      lines: fresh,
    };
  });
}

// ---------------------------------------------------------------------------
// Reconciliation sessions
// ---------------------------------------------------------------------------
