/** Reconciliation lifecycle. Split from banking.ts (ARCH-FILE-SPLIT; pure moves only). */
import { BankingError, type BankingContext, subsidiaryScopeSql } from "./banking-core"
import { loadReconcilableAccount, requireSessionRowInScope, validateReconciliationDate, lockReconciliationAccount, requireCutoffAfterSignedHistory, type BankingSqlExecutor } from "./reconcilable-account"
import { normalizeAmount } from "./statement-parsers/shared"
import { sql } from "drizzle-orm"
import { db, schema, type SqlExecutor, withOrgTransaction } from "../platform/db.ts"
import { fromUnits, isZero, toUnits } from "../money/money.ts"
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts"

export type ReconciliationRow = {
  id: string;
  account_id: string;
  through_date: string;
  currency: string;
  statement_balance: string;
  status: "in_progress" | "balanced" | "signed_off";
};

async function loadReconciliation(
  orgId: string,
  reconciliationId: string,
  scope: ReadonlySet<string> | null,
): Promise<ReconciliationRow> {
  const r = (await db.execute<ReconciliationRow>(sql`
    select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.id = ${reconciliationId} and r.org_id = ${orgId}
       ${subsidiaryScopeSql(scope, sql`a.subsidiary_id`)}
     for share of a
  `));
  const recon = r.rows[0];
  // Missing and out-of-scope sessions refuse identically (uniform not-found).
  if (!recon) throw new ScopeNotFoundError();
  return recon;
}

/**
 * Gate a locked session row by its bank account's owning subsidiary.
 * Missing and out-of-scope sessions refuse identically (uniform not-found),
 * so a restricted caller can never distinguish "no such session" from "a
 * session on another entity's account". Call on the locked row so the gate
 * and the verb serialize on the same lock.
 */
export async function startReconciliation(
  opts: { accountId: string; throughDate: string; statementBalance: string },
  ctx: BankingContext,
): Promise<{ id: string }> {
  const account = await loadReconcilableAccount(ctx.orgId, opts.accountId, ctx.allowedSubsidiaryIds);
  validateReconciliationDate(opts.throughDate);
  const statementBalance = normalizeAmount(opts.statementBalance, "Statement balance");
  return db.transaction(async (tx) => {
    await reconciliationBookId(tx, ctx.orgId);
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    // The unlocked lookup above is only a preflight. The account can be
    // rehomed while this request waits for the reconciliation fence, so lock
    // and revalidate its current owner before creating account-owned state.
    const lockedAccount = await loadReconcilableAccount(ctx.orgId, opts.accountId, ctx.allowedSubsidiaryIds, tx, true);
    const open = (await tx.execute<{ id: string }>(sql`
      select id from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${lockedAccount.id} and status <> 'signed_off'
       limit 1
    `));
    if (open.rows[0]) {
      throw new BankingError(
        "This account already has an open reconciliation — finish or discard it first",
      );
    }
    await requireCutoffAfterSignedHistory(tx, ctx.orgId, lockedAccount.id, opts.throughDate);
    const [recon] = await tx
      .insert(schema.reconciliations)
      .values({
        orgId: ctx.orgId,
        accountId: lockedAccount.id,
        throughDate: opts.throughDate,
        currency: lockedAccount.currency,
        statementBalance,
        status: "in_progress",
        createdBy: ctx.userId,
      })
      .returning({ id: schema.reconciliations.id });
    return { id: recon!.id };
  });
}

interface FirstReconciliationCarry {
  /** First imported statement line covered by the session. */
  startDate: string;
  /** Imported opening balance proven by the pre-coverage ledger. */
  amount: string;
}

/**
 * Opening carry-forward for an account's first reconciliation. The earliest
 * imported statement's opening balance counts only when the ledger that
 * predates its first covered line proves the same amount; nothing on or
 * after coverage starts is carried. The first sign-off persists the proven
 * amount and coverage start in its audit record so later sessions reuse the
 * same opening instead of re-proving (or double-counting) it.
 */
export async function firstReconciliationCarry(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
  bookId: string,
): Promise<FirstReconciliationCarry | null> {
  const earliestSigned = (await executor.execute<{ id: string }>(sql`
    select id from reconciliations
     where org_id = ${ctx.orgId} and account_id = ${recon.account_id}
       and status = 'signed_off' and id <> ${recon.id}
     order by through_date asc, created_at asc, id asc
     limit 1
  `)).rows[0];
  if (earliestSigned) {
    const approval = (await executor.execute<{ changes: { openingCarriedForward?: unknown; openingCarryStartDate?: unknown } }>(sql`
      select changes from audit_log
       where org_id = ${ctx.orgId} and table_name = 'reconciliations'
         and row_id = ${earliestSigned.id} and action = 'approve'
       order by at asc limit 1
    `)).rows[0]?.changes;
    const amount = typeof approval?.openingCarriedForward === "string" ? approval.openingCarriedForward : null;
    const startDate = typeof approval?.openingCarryStartDate === "string" ? approval.openingCarryStartDate : null;
    if (!amount || !startDate || isZero(amount)) return null;
    return { startDate, amount: fromUnits(toUnits(amount)) };
  }

  const coverage = (await executor.execute<{ opening_balance: string | null; start_date: string }>(sql`
    with coverage as (
      select s.opening_balance,
             min(l.posted_on)::text as start_date,
             s.statement_date,
             s.id
        from bank_statements s
        join bank_statement_lines l
          on l.statement_id = s.id and l.org_id = s.org_id
       where s.org_id = ${ctx.orgId}
         and s.account_id = ${recon.account_id}
         and s.statement_date <= ${recon.through_date}
         and l.currency = ${recon.currency}
         and l.posted_on <= ${recon.through_date}
       group by s.id, s.statement_date, s.opening_balance
    )
    select opening_balance, start_date
      from coverage
     order by statement_date asc, start_date asc, id asc
     limit 1
  `)).rows[0];
  if (!coverage || coverage.opening_balance === null) return null;

  const openingUnits = toUnits(coverage.opening_balance);
  // Opening balances include immutable originals and their dated reversals.
  // Match eligibility is narrower than the ledger history proving this carry.
  const history = (await executor.execute<{ carry: string; matched_old: string }>(sql`
    select
      coalesce(sum(jl.txn_amount) filter (where m.journal_line_id is null), 0) as carry,
      coalesce(sum(jl.txn_amount) filter (where m.journal_line_id is not null), 0) as matched_old
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
      left join reconciliation_matches m
        on m.journal_line_id = jl.id and m.org_id = jl.org_id
       and m.reconciliation_id = ${recon.id} and m.org_id = ${ctx.orgId}
     where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
       and je.book_id = ${bookId}
       and jl.currency = ${recon.currency}
       and je.posting_date <= ${recon.through_date}
       and je.posting_date < ${coverage.start_date}
       and (jl.reconciled_at is null or m.journal_line_id is not null)
       and not exists (
         select 1 from reconciliation_matches other
          where other.journal_line_id = jl.id and other.org_id = jl.org_id
            and other.reconciliation_id <> ${recon.id}
       )
  `)).rows[0]!;
  const carryUnits = toUnits(history.carry);
  if (openingUnits !== carryUnits + toUnits(history.matched_old)) return null;
  return { startDate: coverage.start_date, amount: fromUnits(openingUnits) };
}

export interface ReconciliationTotals {
  statementBalance: string;
  /** Previously-reconciled lines, this session's matches, and a proven first-statement opening carry. */
  clearedBalance: string;
  /** statementBalance − clearedBalance; sign-off requires exactly 0. */
  difference: string;
  matchedStatementLines: number;
  unmatchedStatementLines: number;
  matchedJournalLines: number;
}

export type BankingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Bank statements describe physical cash once. Secondary accounting
 * representations are not additional deposits or withdrawals. The primary
 * book cannot be reassigned through setup once reconciliation records exist.
 * Share setup's fence so starting the first session and changing the primary
 * book cannot pass each other's checks. Writes hold both locks to commit. */
export async function reconciliationBookId(executor: SqlExecutor, orgId: string): Promise<string> {
  await executor.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`accounting-books:${orgId}`}, 0))`);
  const books = (await executor.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(sql`
    select id,is_active,posts_gl from accounting_books
     where org_id=${orgId} and is_primary order by id for share`)).rows;
  if (books.length !== 1 || !books[0]!.is_active || !books[0]!.posts_gl) {
    throw new BankingError("Bank reconciliation requires exactly one active primary posting book");
  }
  return books[0]!.id;
}

async function reconciliationTotalsUsing(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const bookId = await reconciliationBookId(executor, ctx.orgId);
  const carry = await firstReconciliationCarry(executor, recon, ctx, bookId);
  const carryStart = carry?.startDate ?? null;
  const carryUnits = carry ? toUnits(carry.amount) : 0n;
  const r = (await executor.execute<{ cleared: string; matched_journal: string; matched_stmt: string; unmatched_stmt: string }>(sql`
    select
      coalesce((
        select sum(jl.txn_amount)
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
         where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
           and je.book_id = ${bookId}
           and jl.currency = ${recon.currency}
           and je.posting_date <= ${recon.through_date}
           and (${carryStart}::date is null or je.posting_date >= ${carryStart}::date)
           and (jl.reconciled_at is not null
                or jl.id in (select journal_line_id from reconciliation_matches
                              where reconciliation_id = ${recon.id}
                                and org_id = ${ctx.orgId}))
      ), 0) as cleared,
      (select count(distinct m.journal_line_id) from reconciliation_matches m
        where m.reconciliation_id = ${recon.id} and m.org_id = ${ctx.orgId}) as matched_journal,
      (select count(distinct m.statement_line_id) from reconciliation_matches m
        where m.reconciliation_id = ${recon.id} and m.org_id = ${ctx.orgId}) as matched_stmt,
      (select count(*)
         from bank_statement_lines l
        where l.account_id = ${recon.account_id} and l.org_id = ${ctx.orgId}
          and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}) as unmatched_stmt
  `));
  const row = r.rows[0]!;
  const clearedBalance = fromUnits(carryUnits + toUnits(row.cleared));
  const difference = fromUnits(toUnits(recon.statement_balance) - carryUnits - toUnits(row.cleared));
  return {
    statementBalance: fromUnits(toUnits(recon.statement_balance)),
    clearedBalance,
    difference,
    matchedStatementLines: Number(row.matched_stmt),
    unmatchedStatementLines: Number(row.unmatched_stmt),
    matchedJournalLines: Number(row.matched_journal),
  };
}

/** Running totals for a session — the workspace difference badge and the sign-off gate. */
export async function reconciliationTotals(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return withOrgTransaction(ctx.orgId, async () => {
    const recon = await loadReconciliation(ctx.orgId, reconciliationId, ctx.allowedSubsidiaryIds);
    return reconciliationTotalsUsing(db, recon, ctx);
  });
}

/** Keep `status` honest: balanced ⇔ difference is 0 (signed_off never changes). */
export async function refreshStatus(
  recon: ReconciliationRow,
  ctx: BankingContext,
  executor: BankingSqlExecutor = db,
): Promise<ReconciliationTotals> {
  const totals = await reconciliationTotalsUsing(executor, recon, ctx);
  await executor.execute(sql`
    update reconciliations
       set status = ${isZero(totals.difference) ? "balanced" : "in_progress"},
           updated_at = now(), updated_by = ${ctx.userId}
     where id = ${recon.id} and org_id = ${ctx.orgId} and status <> 'signed_off'
  `);
  return totals;
}

/** Adjust a session under the same account fence as creation and sign-off.
 * Its matches, totals, lifecycle status and audit snapshot must all describe
 * the same committed cutoff and statement balance. */
export async function adjustReconciliation(
  reconciliationId: string,
  opts: { throughDate?: string; statementBalance?: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals | null> {
  if (opts.throughDate !== undefined) validateReconciliationDate(opts.throughDate);
  const statementBalance = opts.statementBalance === undefined
    ? undefined
    : normalizeAmount(opts.statementBalance, "Statement balance");
  return db.transaction(async (tx) => {
    await reconciliationBookId(tx, ctx.orgId);
    const account = (await tx.execute<{ account_id: string }>(sql`
      select account_id from reconciliations where id = ${reconciliationId} and org_id = ${ctx.orgId}
    `)).rows[0];
    if (!account) return null;
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    const before = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
      select r.id, r.org_id, r.through_date, r.statement_balance, r.account_id, r.currency, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId} and r.status <> 'signed_off'
       for update of r
    `)).rows[0];
    if (!before) return null;
    // A missing session stays a null (the route's 404); an out-of-scope one
    // refuses the same uniform not-found as every other session verb.
    if (!subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, before.subsidiary_id)) {
      throw new ScopeNotFoundError();
    }
    const throughDate = opts.throughDate ?? before.through_date;
    await requireCutoffAfterSignedHistory(tx, ctx.orgId, before.account_id, throughDate);
    const stranded = (await tx.execute<{ id: string }>(sql`
      select m.id from reconciliation_matches m
      join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
      join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where m.reconciliation_id = ${reconciliationId} and m.org_id = ${ctx.orgId}
         and (l.posted_on > ${throughDate} or je.posting_date > ${throughDate})
       limit 1
    `)).rows[0];
    if (stranded) {
      throw new BankingError("Through date cannot exclude matched statement or journal lines; unmatch them first");
    }
    const after = (await tx.execute<ReconciliationRow>(sql`
      update reconciliations
         set through_date = ${throughDate},
             statement_balance = ${statementBalance ?? before.statement_balance},
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${reconciliationId} and org_id = ${ctx.orgId}
       returning id, account_id, through_date, currency, statement_balance, status
    `)).rows[0]!;
    const totals = await refreshStatus(after, ctx, tx);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${ctx.orgId}, 'reconciliations', ${reconciliationId}, 'update',
        ${JSON.stringify({
          mode: "session_adjustment",
          before: { throughDate: before.through_date, statementBalance: before.statement_balance, status: before.status },
          after: { throughDate: after.through_date, statementBalance: after.statement_balance,
            status: isZero(totals.difference) ? "balanced" : "in_progress" },
        })}::jsonb, ${ctx.userId})
    `);
    return totals;
  });
}

/**
 * Discard an unsigned session: delete its matches and release its statement
 * lines back to unmatched. Signed-off sessions are permanent.
 */
export async function discardReconciliation(reconciliationId: string, ctx: BankingContext): Promise<void> {
  await db.transaction(async (tx) => {
    const reconResult = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
       for update of r
    `));
    const recon = reconResult.rows[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") {
      throw new BankingError("Signed-off reconciliations cannot be discarded");
    }
    const released = (await tx.execute<{ statement_line_id: string }>(sql`
      delete from reconciliation_matches
       where reconciliation_id = ${recon.id} and org_id = ${ctx.orgId}
      returning statement_line_id
    `));
    const stmtIds = [...new Set(released.rows.map((r) => r.statement_line_id))];
    if (stmtIds.length > 0) {
      await tx.execute(sql`
        update bank_statement_lines l
           set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
         where l.id = any(${sql.param(stmtIds)}::uuid[])
           and l.org_id = ${ctx.orgId}
           and not exists (select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id)
      `);
    }
    await tx.execute(sql`
      delete from reconciliations where id = ${recon.id} and org_id = ${ctx.orgId}
    `);
    // The session row is gone after this delete, so its evidence must land
    // in the same transaction: match count, session summary, and actor —
    // like every other reconciliation lifecycle write.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'discard',
         ${JSON.stringify({
           operation: "discard",
           releasedMatches: released.rows.length,
           releasedStatementLines: stmtIds.length,
           before: {
             accountId: recon.account_id,
             throughDate: recon.through_date,
             statementBalance: fromUnits(toUnits(recon.statement_balance)),
             currency: recon.currency,
             status: recon.status,
           },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}

// ---------------------------------------------------------------------------
// Sign-off
// ---------------------------------------------------------------------------

/**
 * Sign off a session whose difference is exactly zero: stamp every matched
 * journal line's `reconciled_at`/`reconciliation_id` (allowed on posted lines
 * by jl_guard's metadata carve-out) and mark the session signed_off.
 */
export async function markReconciled(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<{ journalLinesReconciled: number }> {
  return db.transaction(async (tx) => {
    const account = (await tx.execute<{ account_id: string; status: string; subsidiary_id: string | null }>(sql`
      select r.account_id, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
    `)).rows[0];
    // Gate before the idempotent-retry early return: the retry reports the
    // session's line counts, which a restricted caller must never observe
    // for another entity's account.
    requireSessionRowInScope(account, ctx.allowedSubsidiaryIds);
    // A completed sign-off is immutable evidence. Retrying it does not create
    // a new accounting action or require today's book configuration to remain active.
    if (account.status === "signed_off") {
      const existing = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from journal_lines
         where org_id = ${ctx.orgId} and reconciliation_id = ${reconciliationId}
      `)).rows[0]!;
      return { journalLinesReconciled: existing.count };
    }
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    const r = (await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
       for update of r
    `));
    const recon = r.rows[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") {
      const existing = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count
          from journal_lines
         where org_id = ${ctx.orgId} and reconciliation_id = ${recon.id}
      `));
      return { journalLinesReconciled: existing.rows[0]!.count };
    }
    await requireCutoffAfterSignedHistory(tx, ctx.orgId, recon.account_id, recon.through_date);

    const statementEvidence = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
    `));
    if (statementEvidence.rows[0]!.count === 0) {
      throw new BankingError(
        "Cannot sign off without imported statement evidence through the reconciliation date",
      );
    }

    // The session's statement balance is typed by hand; the imported bank
    // statement's closing balance is the bank's own figure for the cutoff.
    // When a statement on the cutoff date carries a closing balance, the two
    // must agree — otherwise the operator balanced the GL against a number
    // the bank never reported.
    const cutoffStatements = (await tx.execute<{ closing_balance: string }>(sql`
      select closing_balance::text as closing_balance
        from bank_statements
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and statement_date = ${recon.through_date}::date
         and closing_balance is not null
    `));
    for (const stmt of cutoffStatements.rows) {
      if (toUnits(stmt.closing_balance) !== toUnits(recon.statement_balance)) {
        throw new BankingError(
          `Cannot sign off: the imported statement closing balance ${fromUnits(toUnits(stmt.closing_balance))} for ${recon.through_date} does not match the session statement balance ${fromUnits(toUnits(recon.statement_balance))} — adjust the session balance to the imported closing balance`,
        );
      }
    }

    const unmatched = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'unmatched'
    `));
    if (unmatched.rows[0]!.count > 0) {
      throw new BankingError(
        `Cannot sign off: ${unmatched.rows[0]!.count} statement line(s) through the cutoff remain unmatched`,
      );
    }

    const invalidMatches = (await tx.execute<{ statement_line_id: string }>(sql`
      select m.statement_line_id
        from reconciliation_matches m
        join bank_statement_lines l
          on l.id = m.statement_line_id
         and l.org_id = m.org_id
        join journal_lines jl
          on jl.id = m.journal_line_id
         and jl.org_id = m.org_id
        join journal_entries je
          on je.id = jl.entry_id
         and je.org_id = jl.org_id
       where m.reconciliation_id = ${recon.id}
         and m.org_id = ${ctx.orgId}
       group by m.statement_line_id, l.amount, l.account_id, l.currency,
                l.posted_on, l.match_status
      having l.account_id <> ${recon.account_id}
          or l.currency <> ${recon.currency}
          or l.posted_on > ${recon.through_date}
          or l.match_status <> 'matched'
          or bool_or(jl.account_id <> ${recon.account_id})
          or bool_or(jl.currency <> ${recon.currency})
          or bool_or(je.book_id <> ${bookId})
          or bool_or(je.status <> 'posted')
          or bool_or(je.posting_date > ${recon.through_date})
          or bool_or(jl.reconciled_at is not null)
          or sum(jl.txn_amount) <> l.amount
          ${ctx.allowedSubsidiaryIds == null
            ? sql``
            : sql`or bool_or(not (jl.subsidiary_id = any(${`{${[...ctx.allowedSubsidiaryIds].join(",")}}`}::uuid[])))`}
       limit 1
    `));
    if (invalidMatches.rows[0]) {
      throw new BankingError(
        "Cannot sign off: one or more matches fail book, account, currency, cutoff, availability, or exact-amount cross-footing",
      );
    }

    const carry = await firstReconciliationCarry(tx, recon, ctx, bookId);
    const carryStart = carry?.startDate ?? null;
    const carryUnits = carry ? toUnits(carry.amount) : 0n;
    const bal = (await tx.execute<{ cleared: string }>(sql`
      select coalesce(sum(jl.txn_amount), 0) as cleared
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and (${carryStart}::date is null or je.posting_date >= ${carryStart}::date)
         and (jl.reconciled_at is not null
              or jl.id in (select journal_line_id from reconciliation_matches rm
                            where rm.reconciliation_id = ${recon.id}
                              and rm.org_id = ${ctx.orgId}))
    `));
    const difference = fromUnits(toUnits(recon.statement_balance) - carryUnits - toUnits(bal.rows[0]!.cleared));
    if (!isZero(difference)) {
      throw new BankingError(
        `Cannot sign off: difference is ${difference}, not 0.0000 — match or unmatch lines until it balances`,
      );
    }

    // journal_lines carries no row-level audit columns. The reconciliation
    // stamp is its own evidence; transaction amendments are preserved through
    // immutable document + GL snapshots in audit_log.
    const stamped = (await tx.execute<{ id: string }>(sql`
      update journal_lines jl
         set reconciled_at = now(), reconciliation_id = ${recon.id}
       where jl.org_id = ${ctx.orgId} and jl.reconciled_at is null
         and jl.id in (select journal_line_id from reconciliation_matches
                        where reconciliation_id = ${recon.id}
                          and org_id = ${ctx.orgId})
      returning jl.id
    `));

    await tx.execute(sql`
      update reconciliations
         set status = 'signed_off', signed_off_by = ${ctx.userId}, signed_off_at = now(),
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${recon.id} and org_id = ${ctx.orgId}
    `);
    const excluded = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'excluded'
    `));
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'approve',
         ${JSON.stringify({
           operation: "sign_off",
           bookId,
           statementBalance: fromUnits(toUnits(recon.statement_balance)),
           currency: recon.currency,
           throughDate: recon.through_date,
           matchedJournalLines: stamped.rows.length,
           openingCarriedForward: carry?.amount ?? "0.0000",
           openingCarryStartDate: carry?.startDate ?? null,
           excludedStatementLines: excluded.rows[0]!.count,
           difference: "0.0000",
         })}::jsonb,
         ${ctx.userId})
    `);

    return { journalLinesReconciled: stamped.rows.length };
  });
}
