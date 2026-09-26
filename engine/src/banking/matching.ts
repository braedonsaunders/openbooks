/** Auto/manual matching. Split from banking.ts (pure moves only). */
import { BankingError, type BankingContext, subsidiaryScopeSql } from "./banking-core"
import { requireSessionRowInScope, requireBankAccountInScope, lockBankAccountInScope, requireStatementLineAccountInScope, lockReconciliationAccount } from "./reconcilable-account"
import { type ReconciliationRow, firstReconciliationCarry, type ReconciliationTotals, type BankingTransaction, reconciliationBookId, refreshStatus } from "./reconciliation"
import { sql } from "drizzle-orm"
import { db, inDbTransaction, schema, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts"
import { fromUnits, sum, toUnits } from "../money/money.ts"
import { lockScopeRows, ScopeNotFoundError } from "../organization/subsidiary-scope.ts"

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

export interface AutoMatchResult {
  matched: number;
  highConfidence: number; // exact amount, ≤ 3 days apart → 0.9
  mediumConfidence: number; // exact amount, ≤ 14 days apart → 0.7
  totals: ReconciliationTotals;
}

/**
 * Auto-match unmatched statement lines to unreconciled, unclaimed posted
 * journal lines on the session's account: exact signed amount + posting date
 * within 3 days ⇒ confidence 0.9; within 14 days ⇒ 0.7. Each journal line is
 * used at most once; the closest date wins. Lines flagged as possible
 * duplicates are never auto-matched — the reviewer clears the flag or
 * excludes the line first.
 */
export async function autoMatch(reconciliationId: string, ctx: BankingContext): Promise<AutoMatchResult> {
  return db.transaction(async (tx) => {
    const account = (await tx.execute<{ account_id: string }>(sql`
      select account_id from reconciliations where id = ${reconciliationId} and org_id = ${ctx.orgId}
    `)).rows[0];
    if (!account) throw new ScopeNotFoundError();
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    const reconResult = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `));
    const recon = reconResult.rows[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");
    // Lines covered by a proven statement opening are cleared by the carry,
    // not by matching: claiming one would double-count the opening.
    const carryStart = (await firstReconciliationCarry(tx, recon, ctx, bookId))?.startDate ?? null;

    const stmtRes = (await tx.execute<{ id: string; posted_on: string; amount: string }>(sql`
      select l.id, l.posted_on, l.amount
       from bank_statement_lines l
       where l.account_id = ${recon.account_id} and l.org_id = ${ctx.orgId}
         and l.currency = ${recon.currency}
         and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
         and l.possible_duplicate_of is null
       order by l.posted_on, l.line_number
       for update
    `));
    const glRes = (await tx.execute<{ id: string; posting_date: string; amount: string }>(sql`
      select jl.id, je.posting_date, jl.txn_amount as amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and (${carryStart}::date is null or je.posting_date >= ${carryStart}::date)
         and jl.reconciled_at is null
         and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
         ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`jl.subsidiary_id`)}
       order by je.posting_date, jl.line_number
       for update of jl
    `));

    // candidates by exact signed amount
    const byAmount = new Map<string, { id: string; date: string }[]>();
    for (const jl of glRes.rows) {
      const key = toUnits(jl.amount).toString();
      const list = byAmount.get(key) ?? [];
      list.push({ id: jl.id, date: jl.posting_date });
      byAmount.set(key, list);
    }

    const pairs: { statementLineId: string; journalLineId: string; confidence: string }[] = [];
    for (const line of stmtRes.rows) {
      const candidates = byAmount.get(toUnits(line.amount).toString());
      if (!candidates?.length) continue;
      let bestIdx = -1;
      let bestDays = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const days = daysBetween(line.posted_on, candidates[i]!.date);
        if (days < bestDays) {
          bestDays = days;
          bestIdx = i;
        }
      }
      if (bestIdx === -1 || bestDays > 14) continue;
      const [winner] = candidates.splice(bestIdx, 1);
      pairs.push({
        statementLineId: line.id,
        journalLineId: winner!.id,
        confidence: bestDays <= 3 ? "0.9" : "0.7",
      });
    }

    if (pairs.length > 0) {
      await tx.insert(schema.reconciliationMatches).values(
        pairs.map((p) => ({
          orgId: ctx.orgId,
          reconciliationId: recon.id,
          statementLineId: p.statementLineId,
          journalLineId: p.journalLineId,
          matchedBy: "auto" as const,
          confidence: p.confidence,
          createdBy: ctx.userId,
        })),
      );
      await tx.execute(sql`
        update bank_statement_lines
           set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
         where id = any(${sql.param(pairs.map((p) => p.statementLineId))})
           and org_id = ${ctx.orgId}
      `);
      // One row per auto-match run, carrying the matched pairs — per-pair
      // rows would spam the log on large sessions, while no row leaves
      // machine-made matches unattributed.
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${ctx.orgId}, 'reconciliations', ${recon.id}, 'update',
           ${JSON.stringify({
             operation: "auto_match",
             matched: pairs.length,
             highConfidence: pairs.filter((p) => p.confidence === "0.9").length,
             mediumConfidence: pairs.filter((p) => p.confidence === "0.7").length,
             pairs: pairs.map((p) => ({
               statementLineId: p.statementLineId,
               journalLineId: p.journalLineId,
               confidence: p.confidence,
             })),
           })}::jsonb,
           ${ctx.userId})
      `);
    }

    const totals = await refreshStatus(recon, ctx, tx);
    return {
      matched: pairs.length,
      highConfidence: pairs.filter((p) => p.confidence === "0.9").length,
      mediumConfidence: pairs.filter((p) => p.confidence === "0.7").length,
      totals,
    };
  });
}

type MatchOptions = {
  reconciliationId: string;
  statementLineId: string;
};

type MatchOrigin = "auto" | "manual" | "rule";

/**
 * Validate and persist a match on an already-open transaction. The statement
 * line lock is deliberately acquired before the optional journal factory: a
 * concurrent rule invocation therefore waits for the winner and then fails
 * without creating/posting a second journal.
 */
async function createMatchInTransaction(
  tx: BankingTransaction,
  opts: MatchOptions,
  ctx: BankingContext,
  journalLineIdsOrFactory: string[] | (() => Promise<string>),
  matchedBy: MatchOrigin,
): Promise<ReconciliationTotals> {
  const account = (await tx.execute<{ account_id: string }>(sql`
    select account_id from reconciliations
     where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
  `)).rows[0];
  if (!account) throw new ScopeNotFoundError();
  await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
  const bookId = await reconciliationBookId(tx, ctx.orgId);
  const reconResult = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
    select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
     for update of r
  `));
  const recon = reconResult.rows[0];
  requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
  if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

  const stmt = (await tx.execute<{ id: string; amount: string; currency: string; possible_duplicate_of: string | null }>(sql`
    select l.id, l.amount, l.currency, l.possible_duplicate_of
      from bank_statement_lines l
     where l.id = ${opts.statementLineId} and l.org_id = ${ctx.orgId}
       and l.account_id = ${recon.account_id}
       and l.currency = ${recon.currency}
       and l.posted_on <= ${recon.through_date}
       and l.match_status = 'unmatched'
     for update
  `));
  if (!stmt.rows[0]) {
    throw new BankingError(
      "Statement line is unavailable, outside the reconciliation cutoff, or already matched",
    );
  }
  if (stmt.rows[0].possible_duplicate_of) {
    throw new BankingError(
      "Statement line is flagged as a possible duplicate of an earlier import — clear the flag or exclude the line before matching",
    );
  }

  const journalLineIds = [...new Set(
    typeof journalLineIdsOrFactory === "function"
      ? [await journalLineIdsOrFactory()]
      : journalLineIdsOrFactory,
  )];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  const gl = (await tx.execute<{ id: string; amount: string; posting_date: string }>(sql`
    select jl.id, jl.txn_amount as amount, je.posting_date
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
     where jl.id = any(${sql.param(journalLineIds)}::uuid[])
       and jl.org_id = ${ctx.orgId}
       and je.book_id = ${bookId}
       and jl.account_id = ${recon.account_id}
       and jl.currency = ${recon.currency}
       and jl.reconciled_at is null
       and je.posting_date <= ${recon.through_date}
       and not exists (
         select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id
       )
       ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`jl.subsidiary_id`)}
     order by jl.id
     for update of jl
  `));
  if (gl.rows.length !== journalLineIds.length) {
    throw new BankingError(
      "One or more journal lines are unavailable, outside the cutoff, already reconciled, or already matched",
    );
  }
  const carryStart = (await firstReconciliationCarry(tx, recon, ctx, bookId))?.startDate ?? null;
  if (carryStart && gl.rows.some((line) => line.posting_date < carryStart)) {
    throw new BankingError(
      "One or more journal lines predate the carried statement opening balance and cannot be matched",
    );
  }
  const journalTotal = sum(gl.rows.map((line) => line.amount));
  if (toUnits(journalTotal) !== toUnits(stmt.rows[0].amount)) {
    throw new BankingError(
      `Selected journal lines total ${journalTotal}; the statement line is ${fromUnits(toUnits(stmt.rows[0].amount))}`,
    );
  }

  await tx.insert(schema.reconciliationMatches).values(
    journalLineIds.map((journalLineId) => ({
      orgId: ctx.orgId,
      reconciliationId: recon.id,
      statementLineId: opts.statementLineId,
      journalLineId,
      matchedBy,
      confidence: null,
      createdBy: ctx.userId,
    })),
  );
  await tx.execute(sql`
    update bank_statement_lines
       set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
       where id = ${opts.statementLineId} and org_id = ${ctx.orgId}
  `);
  // Manual and rule-built matches attribute the same way the line's
  // exclude/restore writes do: actor, line, and target, beside the
  // before/after the audit history cross-foots.
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id)
    values
      (${ctx.orgId}, 'bank_statement_lines', ${opts.statementLineId}, 'update',
       ${JSON.stringify({
         operation: "match",
         reconciliationId: recon.id,
         matchedBy,
         journalLineIds,
         before: { matchStatus: "unmatched" },
         after: { matchStatus: "matched" },
       })}::jsonb,
       ${ctx.userId})
  `);
  return refreshStatus(recon, ctx, tx);
}

/**
 * Claim an unmatched statement line and create/match its journal atomically.
 * The callback runs while the line row is locked and inside the transaction
 * pinned by `withOrgTransaction`; engine/web calls that use the shared `db`
 * handle therefore join this exact transaction. If the line was claimed by a
 * concurrent invocation, the callback is never called and no journal exists
 * to orphan.
 */
export async function createMatchWithJournal(
  opts: MatchOptions & { createJournal: () => Promise<string>; matchedBy?: MatchOrigin; additionalAccountIds?: readonly string[] },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return withOrgTransaction(ctx.orgId, () => inDbTransaction((tx) => withTransactionSavepoint(tx, async () => {
    const reconciliation = (await tx.execute<{ account_id: string }>(sql`
      select account_id from reconciliations where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `)).rows[0];
    if (!reconciliation) throw new ScopeNotFoundError();
    // Lock every account touched by the posting in one global order before
    // the reconciliation and statement-line locks. In particular, a manual
    // contra account cannot be rehomed after its preflight scope read.
    await lockScopeRows(tx, ctx.orgId, [
      { kind: "account", id: reconciliation.account_id },
      ...(opts.additionalAccountIds ?? []).map((id) => ({ kind: "account" as const, id })),
    ], ctx.allowedSubsidiaryIds, "update");
    return createMatchInTransaction(tx, opts, ctx, opts.createJournal, opts.matchedBy ?? "rule");
  })));
}

/** Manually pair one statement line with one or more journal lines. */
export async function createMatch(
  opts: MatchOptions & { journalLineIds: string[] },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const journalLineIds = [...new Set(opts.journalLineIds)];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  return db.transaction((tx) =>
    createMatchInTransaction(tx, opts, ctx, journalLineIds, "manual"),
  );
}

/** Undo all of a statement line's matches within a session. */
export async function unmatchStatementLine(
  opts: { reconciliationId: string; statementLineId: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return db.transaction(async (tx) => {
    const account = (await tx.execute<{ account_id: string }>(sql`
      select account_id from reconciliations
       where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `)).rows[0];
    if (!account) throw new ScopeNotFoundError();
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const reconResult = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `));
    const recon = reconResult.rows[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

    const deleted = (await tx.execute<{ id: string; journal_line_id: string }>(sql`
      delete from reconciliation_matches
       where reconciliation_id = ${recon.id}
         and statement_line_id = ${opts.statementLineId}
         and org_id = ${ctx.orgId}
      returning id, journal_line_id
    `));
    if (deleted.rows.length === 0) {
      throw new BankingError("No matches for that statement line in this reconciliation");
    }
    await tx.execute(sql`
      update bank_statement_lines l
         set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
       where l.id = ${opts.statementLineId} and l.org_id = ${ctx.orgId}
         and not exists (
           select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id
         )
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${opts.statementLineId}, 'update',
         ${JSON.stringify({
           operation: "unmatch",
           reconciliationId: recon.id,
           journalLineIds: deleted.rows.map((row) => row.journal_line_id),
           before: { matchStatus: "matched" },
           after: { matchStatus: "unmatched" },
         })}::jsonb,
         ${ctx.userId})
    `);
    return refreshStatus(recon, ctx, tx);
  });
}

/**
 * Exclude an unmatched statement line from reconciliation (bank fees you book
 * elsewhere, duplicates, opening entries). Only unmatched lines can be
 * excluded; matched lines must be unmatched first.
 */
export async function excludeStatementLine(
  statementLineId: string,
  reasonInput: string,
  ctx: BankingContext,
): Promise<void> {
  const reason = reasonInput.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new BankingError("Exclusion reason must be between 5 and 500 characters");
  }
  const account = await requireStatementLineAccountInScope(db, ctx.orgId, statementLineId, ctx.allowedSubsidiaryIds);
  await db.transaction(async (tx) => {
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const res = (await tx.execute<{ id: string }>(sql`
      update bank_statement_lines l
         set match_status = 'excluded',
             exclusion_reason = ${reason},
             excluded_at = now(),
             excluded_by = ${ctx.userId},
             updated_at = now(),
             updated_by = ${ctx.userId}
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'unmatched'
      returning l.id
    `));
    if (!res.rows[0]) throw new BankingError("Only unmatched lines can be excluded");
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "exclude",
           reason,
           before: { matchStatus: "unmatched" },
           after: { matchStatus: "excluded" },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}

/**
 * Clear a possible-duplicate flag after review: the line is a genuine
 * transaction, not a replay. The line stays unmatched (match_status never
 * moves here), so sign-off still holds it until it matches, and clearing
 * needs no reconciliation lock for the same reason. Audited with the
 * evidence it was cleared against.
 */
export async function clearPossibleDuplicateFlag(
  statementLineId: string,
  ctx: BankingContext,
): Promise<void> {
  // Clearing the flag mutates another entity's evidence when out of scope:
  // uniform not-found before any read or write, like exclude/restore.
  const account = await requireStatementLineAccountInScope(db, ctx.orgId, statementLineId, ctx.allowedSubsidiaryIds);
  await db.transaction(async (tx) => {
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    // Read the evidence first: UPDATE ... RETURNING would hand back the NEW
    // (nulled) flag, not the before-image the audit row must record.
    const before = (await tx.execute<{ id: string; possible_duplicate_of: string }>(sql`
      select l.id, l.possible_duplicate_of
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'unmatched'
         and l.possible_duplicate_of is not null
       for update
    `)).rows[0];
    if (!before) throw new BankingError("Only flagged unmatched lines can be cleared");
    await tx.execute(sql`
      update bank_statement_lines l
         set possible_duplicate_of = null,
             updated_at = now(),
             updated_by = ${ctx.userId}
       where l.id = ${statementLineId} and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "clear_possible_duplicate",
           before: { possibleDuplicateOf: before.possible_duplicate_of },
           after: { possibleDuplicateOf: null },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}

/**
 * Bulk-exclude every flagged unmatched line on an account as duplicates of
 * their earlier imports: the reviewer's answer to a re-exported file, so it
 * is not one click per line. Same eligibility as the single-line exclude,
 * one audited row per line in a single transaction, and the flag is kept as
 * the evidence the exclusion was decided against.
 */
export async function excludePossibleDuplicates(
  accountId: string,
  reasonInput: string,
  ctx: BankingContext,
): Promise<{ excluded: number }> {
  const reason = reasonInput.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new BankingError("Exclusion reason must be between 5 and 500 characters");
  }
  // Bulk-excluding another entity's flagged lines is the same cross-boundary
  // write as excluding them one by one: gate the account up front so an
  // out-of-scope account refuses before any line is touched.
  await requireBankAccountInScope(db, ctx.orgId, accountId, ctx.allowedSubsidiaryIds);
  return db.transaction(async (tx) => {
    await lockBankAccountInScope(tx, ctx.orgId, accountId, ctx.allowedSubsidiaryIds);
    const rows = (await tx.execute<{ id: string; possible_duplicate_of: string }>(sql`
      update bank_statement_lines l
         set match_status = 'excluded',
             exclusion_reason = ${reason},
             excluded_at = now(),
             excluded_by = ${ctx.userId},
             updated_at = now(),
             updated_by = ${ctx.userId}
       where l.account_id = ${accountId}
         and l.org_id = ${ctx.orgId}
         and l.match_status = 'unmatched'
         and l.possible_duplicate_of is not null
      returning l.id, l.possible_duplicate_of
    `));
    for (const row of rows.rows) {
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${ctx.orgId}, 'bank_statement_lines', ${row.id}, 'update',
           ${JSON.stringify({
             operation: "exclude",
             bulk: true,
             reason,
             possibleDuplicateOf: row.possible_duplicate_of,
             before: { matchStatus: "unmatched" },
             after: { matchStatus: "excluded" },
           })}::jsonb,
           ${ctx.userId})
      `);
    }
    return { excluded: rows.rows.length };
  });
}

/** Restore an excluded statement line back to the unmatched queue. */
export async function restoreStatementLine(statementLineId: string, ctx: BankingContext): Promise<void> {
  const account = await requireStatementLineAccountInScope(db, ctx.orgId, statementLineId, ctx.allowedSubsidiaryIds);
  await db.transaction(async (tx) => {
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const candidateResult = (await tx.execute<{
        id: string;
        account_id: string;
        posted_on: string;
        exclusion_reason: string;
      }>(sql`
      select l.id, l.account_id, l.posted_on, l.exclusion_reason
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'excluded'
    `));
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new BankingError("Only excluded lines can be restored");
    // Cover sessions that do not exist yet or whose cutoff does not overlap
    // yet. Header locks alone cannot serialize their creation/extension and
    // sign-off with an exclusion restore that has not committed.
    // Reconciliation sessions lock their header before touching statement
    // lines. Acquire the same locks first so restore cannot deadlock with a
    // concurrent match/unmatch/sign-off transaction.
    const overlapping = (await tx.execute<{ id: string; status: string }>(sql`
      select id, status
        from reconciliations
       where org_id = ${ctx.orgId}
         and account_id = ${candidate.account_id}
         and through_date >= ${candidate.posted_on}
       order by id
       for update
    `));
    if (overlapping.rows.some((reconciliation) => reconciliation.status === "signed_off")) {
      throw new BankingError(
        "This exclusion is covered by a signed-off reconciliation and cannot be restored",
      );
    }
    const lineResult = (await tx.execute<{
      id: string;
      account_id: string;
      posted_on: string;
      exclusion_reason: string;
    }>(sql`
      select l.id, l.account_id, l.posted_on, l.exclusion_reason
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'excluded'
       for update
    `));
    const line = lineResult.rows[0];
    if (!line) throw new BankingError("Only excluded lines can be restored");
    await tx.execute(sql`
      update bank_statement_lines
         set match_status = 'unmatched',
             exclusion_reason = null,
             excluded_at = null,
             excluded_by = null,
             updated_at = now(),
             updated_by = ${ctx.userId}
       where id = ${statementLineId} and org_id = ${ctx.orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "restore_exclusion",
           priorReason: line.exclusion_reason,
           before: { matchStatus: "excluded" },
           after: { matchStatus: "unmatched" },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}
