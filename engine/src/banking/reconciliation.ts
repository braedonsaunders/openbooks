import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { lockApprovalSubject, requestNativeCommandApproval } from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
/** Reconciliation lifecycle. Split from banking.ts (pure moves only). */
import {
  BankingError,
  statementComparisonSign,
  statementTotalsAgree,
  type BankingContext,
  subsidiaryScopeSql,
} from "./banking-core";
import {
  loadReconcilableAccount,
  requireSessionRowInScope,
  validateReconciliationDate,
  lockReconciliationAccount,
  requireCutoffAfterSignedHistory,
  type BankingSqlExecutor,
} from "./reconcilable-account";
import { normalizeAmount } from "./statement-parsers/shared";
import { sql } from "drizzle-orm";
import { db, schema, type SqlExecutor, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, isZero, toUnits } from "../money/money.ts";
import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { canonicalPeriodLabel } from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import {
  applicableSignOffRevalidation,
  originalSignOffProofAgrees,
  reconciliationReviewProof,
  type SignOffRevalidationCertificate,
} from "./reconciliation-review-proof.ts";

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
  const r = await db.execute<ReconciliationRow>(
    sql`
    select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.id = ${reconciliationId} and r.org_id = ${orgId}
       ${subsidiaryScopeSql(scope, sql`a.subsidiary_id`)}
     for share of a
  `,
    "objects",
  );
  const recon = r[0];
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
  const account = await loadReconcilableAccount(
    ctx.orgId,
    opts.accountId,
    ctx.allowedSubsidiaryIds,
  );
  validateReconciliationDate(opts.throughDate);
  const statementBalance = normalizeAmount(opts.statementBalance, "Statement balance");
  return db.transaction(async (tx) => {
    await reconciliationBookId(tx, ctx.orgId);
    await lockReconciliationAccount(tx, ctx.orgId, account.id);
    // The unlocked lookup above is only a preflight. The account can be
    // rehomed while this request waits for the reconciliation fence, so lock
    // and revalidate its current owner before creating account-owned state.
    const lockedAccount = await loadReconcilableAccount(
      ctx.orgId,
      opts.accountId,
      ctx.allowedSubsidiaryIds,
      tx,
      true,
    );
    const open = await tx.execute<{ id: string }>(
      sql`
      select id from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${lockedAccount.id} and status <> 'signed_off'
       limit 1
    `,
      "objects",
    );
    if (open[0]) {
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

interface StatementCoverage {
  openingBalance: string | null;
  startDate: string;
}

async function readStatementCoverage(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<StatementCoverage | null> {
  const coverage = (
    await executor.execute<{ opening_balance: string | null; start_date: string }>(
      sql`
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
  `,
      "objects",
    )
  )[0];
  if (!coverage) return null;
  return { openingBalance: coverage.opening_balance, startDate: coverage.start_date };
}

async function readAccountType(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<string> {
  return (
    (
      await executor.execute<{ type: string }>(
        sql`
    select type from accounts where id = ${recon.account_id} and org_id = ${ctx.orgId}
  `,
        "objects",
      )
    )[0]?.type ?? ""
  );
}

/**
 * The pre-coverage ledger proving an opening: book lines on the account
 * dated before coverage starts, counting each journal once no matter how
 * many bank lines share it. Lines already matched in this session count
 * beside the unclaimed ones, so confirming after matching still proves the
 * same opening the carry will foot.
 */
async function readPreCoverageHistory(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
  bookId: string,
  coverageStart: string,
): Promise<{ carry: string; matchedOld: string }> {
  // Opening balances include immutable originals and their dated reversals.
  // Match eligibility is narrower than the ledger history proving this carry.
  const history = (
    await executor.execute<{ carry: string; matched_old: string }>(
      sql`
    select
      coalesce(sum(jl.txn_amount) filter (where m.journal_line_id is null), 0) as carry,
      coalesce(sum(jl.txn_amount) filter (where m.journal_line_id is not null), 0) as matched_old
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
      -- Distinct journals: one journal of a many-to-one group joins one row
      -- here, so its amount counts once no matter how many bank lines share it.
      left join (
        select distinct journal_line_id from reconciliation_matches
         where reconciliation_id = ${recon.id} and org_id = ${ctx.orgId}
      ) m on m.journal_line_id = jl.id
     where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
       and je.book_id = ${bookId}
       and jl.currency = ${recon.currency}
       and je.posting_date <= ${recon.through_date}
       and je.posting_date < ${coverageStart}
       and ${excludePeriodEndJournals(sql`je.origin`)}
       and (jl.reconciled_at is null or m.journal_line_id is not null)
       and not exists (
         select 1 from reconciliation_matches other
          where other.journal_line_id = jl.id and other.org_id = jl.org_id
            and other.reconciliation_id <> ${recon.id}
       )
  `,
      "objects",
    )
  )[0]!;
  return { carry: history.carry, matchedOld: history.matched_old };
}

/**
 * Pair a statement-side opening with the GL-signed history proving it, in
 * GL terms. Asset-style accounts require exact equality; liability accounts
 * accept either pairing (owing-positive CSV vs GL-signed OFX). Null proves
 * nothing and must stay a refusal, never an invented opening.
 */
function pairOpeningToGlTerms(
  openingAmount: string,
  historyTotal: string,
  accountType: string,
): string | null {
  const openingUnits = toUnits(openingAmount);
  const historyUnits = toUnits(historyTotal);
  if (openingUnits === historyUnits) return fromUnits(openingUnits);
  if (statementComparisonSign(accountType) === -1 && -openingUnits === historyUnits) {
    return fromUnits(-openingUnits);
  }
  return null;
}

export interface OpeningConfirmation {
  /** Confirmed opening in GL terms, matching the cleared sums it joins. */
  amount: string;
  /** Coverage start the confirmation was proven against. */
  startDate: string;
  reason: string;
  confirmedAt: string;
  confirmedByName: string | null;
}

async function readLatestConfirmation(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<OpeningConfirmation | null> {
  const row = (
    await executor.execute<{
      changes: { openingBalance?: unknown; openingBalanceStartDate?: unknown; reason?: unknown };
      confirmed_at: string;
      confirmed_by_name: string | null;
    }>(
      sql`
    select al.changes, al.at::text as confirmed_at, u.name as confirmed_by_name
      from audit_log al
      left join users u on u.id = al.actor_id and u.org_id = al.org_id
     where al.org_id = ${ctx.orgId} and al.table_name = 'reconciliations'
       and al.row_id = ${recon.id} and al.action = 'update'
       and al.changes->>'operation' = 'confirm_opening'
     order by al.at desc, al.id desc
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!row) return null;
  const amount = typeof row.changes.openingBalance === "string" ? row.changes.openingBalance : null;
  const startDate =
    typeof row.changes.openingBalanceStartDate === "string"
      ? row.changes.openingBalanceStartDate
      : null;
  const reason = typeof row.changes.reason === "string" ? row.changes.reason : null;
  if (!amount || !startDate || !reason) return null;
  return {
    amount: fromUnits(toUnits(amount)),
    startDate,
    reason,
    confirmedAt: row.confirmed_at,
    confirmedByName: row.confirmed_by_name,
  };
}

/**
 * Opening carry-forward for an account's first reconciliation. The earliest
 * imported statement's opening balance counts only when the ledger that
 * predates its first covered line proves the same amount; nothing on or
 * after coverage starts is carried. A balance-less first statement carries
 * nothing on its own — the operator confirms the book balance carried in
 * as the opening (see confirmOpeningBalance), and the confirmation counts
 * only while the ledger still proves it. The first sign-off persists the
 * carried amount and coverage start in its audit record so later sessions
 * reuse the same opening instead of re-proving (or double-counting) it.
 */
export async function firstReconciliationCarry(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
  bookId: string,
): Promise<FirstReconciliationCarry | null> {
  const earliestSigned = (
    await executor.execute<{ id: string }>(
      sql`
    select id from reconciliations
     where org_id = ${ctx.orgId} and account_id = ${recon.account_id}
       and status = 'signed_off' and id <> ${recon.id}
     order by through_date asc, created_at asc, id asc
     limit 1
  `,
      "objects",
    )
  )[0];
  if (earliestSigned) {
    const approval = (
      await executor.execute<{
        changes: { openingCarriedForward?: unknown; openingCarryStartDate?: unknown };
      }>(
        sql`
      select changes from audit_log
       where org_id = ${ctx.orgId} and table_name = 'reconciliations'
         and row_id = ${earliestSigned.id} and action = 'approve'
       order by at asc limit 1
    `,
        "objects",
      )
    )[0]?.changes;
    const amount =
      typeof approval?.openingCarriedForward === "string" ? approval.openingCarriedForward : null;
    const startDate =
      typeof approval?.openingCarryStartDate === "string" ? approval.openingCarryStartDate : null;
    if (!amount || !startDate || isZero(amount)) return null;
    return { startDate, amount: fromUnits(toUnits(amount)) };
  }

  const coverage = await readStatementCoverage(executor, recon, ctx);
  if (!coverage) return null;
  const accountType = await readAccountType(executor, recon, ctx);

  // A balance-less first statement states no opening of its own: the
  // operator's explicit confirmation stands in for the bank's figure, and
  // only while the pre-coverage ledger still proves the confirmed amount.
  // A confirmation the ledger has moved away from goes stale — fail closed
  // to no carry so the moved lines resurface as outstanding items instead
  // of footing a number nothing proves anymore.
  if (coverage.openingBalance === null) {
    const confirmation = await readLatestConfirmation(executor, recon, ctx);
    if (!confirmation || isZero(confirmation.amount)) return null;
    const history = await readPreCoverageHistory(executor, recon, ctx, bookId, coverage.startDate);
    const historyTotal = fromUnits(toUnits(history.carry) + toUnits(history.matchedOld));
    const stillProven = pairOpeningToGlTerms(confirmation.amount, historyTotal, accountType);
    if (stillProven === null || toUnits(stillProven) !== toUnits(confirmation.amount)) return null;
    return { startDate: coverage.startDate, amount: confirmation.amount };
  }

  const history = await readPreCoverageHistory(executor, recon, ctx, bookId, coverage.startDate);
  // The imported opening is statement-signed; the proving history is
  // GL-signed. The carry is stored in GL terms, matching the cleared sums
  // it joins.
  const historyTotal = fromUnits(toUnits(history.carry) + toUnits(history.matchedOld));
  const glCarry = pairOpeningToGlTerms(coverage.openingBalance, historyTotal, accountType);
  if (glCarry === null) return null;
  return { startDate: coverage.startDate, amount: glCarry };
}

async function readPriorSignedOff(
  executor: BankingSqlExecutor,
  recon: ReconciliationRow,
  ctx: BankingContext,
): Promise<{ id: string; throughDate: string } | null> {
  const row = (
    await executor.execute<{ id: string; through_date: string }>(
      sql`
    select id, through_date
      from reconciliations
     where org_id = ${ctx.orgId} and account_id = ${recon.account_id}
       and status = 'signed_off' and id <> ${recon.id}
     order by through_date asc, created_at asc, id asc
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!row) return null;
  return { id: row.id, throughDate: row.through_date };
}

export interface OpeningPosition {
  /** True while the account has no signed-off reconciliation to chain from. */
  isFirst: boolean;
  /** The earliest covered statement's own opening balance, when imported. */
  statementOpening: string | null;
  /** First imported statement line covered by the session. */
  coverageStart: string | null;
  /** Pre-coverage book balance in GL terms: the only confirmable opening. */
  bookBalance: string;
  confirmation: OpeningConfirmation | null;
  /** True while the carry (proven or confirmed) currently foots the session. */
  carryApplies: boolean;
  /** Coverage start clearing pre-carry lines from matching, when carrying. */
  carryStart: string | null;
}

/** Read-time opening position for a session — what the workspace confirms. */
export async function openingPosition(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<OpeningPosition> {
  return withOrgTransaction(ctx.orgId, async () => {
    const recon = await loadReconciliation(ctx.orgId, reconciliationId, ctx.allowedSubsidiaryIds);
    const bookId = await reconciliationBookId(db, ctx.orgId);
    const prior = await readPriorSignedOff(db, recon, ctx);
    const coverage = await readStatementCoverage(db, recon, ctx);
    const history = coverage
      ? await readPreCoverageHistory(db, recon, ctx, bookId, coverage.startDate)
      : { carry: "0", matchedOld: "0" };
    const historyTotal = fromUnits(toUnits(history.carry) + toUnits(history.matchedOld));
    const statementOpening =
      coverage?.openingBalance === null || coverage?.openingBalance === undefined
        ? null
        : fromUnits(toUnits(coverage.openingBalance));
    const confirmation = await readLatestConfirmation(db, recon, ctx);
    const carry = await firstReconciliationCarry(db, recon, ctx, bookId);
    return {
      isFirst: prior === null,
      statementOpening,
      coverageStart: coverage?.startDate ?? null,
      bookBalance: historyTotal,
      confirmation,
      carryApplies: carry !== null,
      carryStart: carry?.startDate ?? null,
    };
  });
}

/**
 * Confirm the opening position of an account's first reconciliation from a
 * balance-less statement. The earliest imported statement states no opening
 * of its own, so the operator names the statement opening explicitly — and
 * it must equal the book balance carried in (pre-coverage ledger, GL
 * terms): a confirmation the ledger does not prove is refused, never
 * carried. The confirmation, its reason and the proven book balance persist
 * in the session's audit history; the carry re-verifies them on every read,
 * so a ledger that moves underneath the confirmation fails closed to no
 * carry instead of footing a stale number. Later sessions chain from this
 * session's sign-off as before.
 */
export async function confirmOpeningBalance(
  reconciliationId: string,
  opts: { openingBalance: string; reason: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const reason = opts.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new BankingError("Opening confirmation reason must be between 5 and 500 characters");
  }
  const openingBalance = normalizeAmount(opts.openingBalance, "Opening balance");
  if (isZero(openingBalance)) {
    throw new BankingError(
      "An opening balance of zero carries nothing — leave the opening unconfirmed and match the period lines",
    );
  }
  return db.transaction(async (tx) => {
    const account = (
      await tx.execute<{ account_id: string }>(
        sql`
      select account_id from reconciliations where id = ${reconciliationId} and org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) throw new ScopeNotFoundError();
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    const reconResult = await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `,
      "objects",
    );
    const recon = reconResult[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off")
      throw new BankingError("Reconciliation is already signed off");
    const bookId = await reconciliationBookId(tx, ctx.orgId);

    const prior = await readPriorSignedOff(tx, recon, ctx);
    if (prior) {
      throw new BankingError(
        `Only the first reconciliation of an account confirms an opening balance — later sessions chain from the sign-off through ${prior.throughDate}`,
      );
    }
    const coverage = await readStatementCoverage(tx, recon, ctx);
    if (!coverage) {
      throw new BankingError(
        "Import the statement lines first — there is no covered period to carry an opening into",
      );
    }
    const accountType = await readAccountType(tx, recon, ctx);
    const history = await readPreCoverageHistory(tx, recon, ctx, bookId, coverage.startDate);
    const bookBalance = fromUnits(toUnits(history.carry) + toUnits(history.matchedOld));
    if (coverage.openingBalance !== null) {
      const proven = pairOpeningToGlTerms(coverage.openingBalance, bookBalance, accountType);
      if (proven !== null) {
        throw new BankingError(
          `The imported statement already carries its opening balance of ${fromUnits(toUnits(coverage.openingBalance))}, proven by the ledger — nothing to confirm`,
        );
      }
      throw new BankingError(
        `The imported statement states its own opening balance of ${fromUnits(toUnits(coverage.openingBalance))}, but the book balance carried in is ${bookBalance} — post the book entries that prove the statement opening instead of confirming a different one`,
      );
    }
    const glTerms = pairOpeningToGlTerms(openingBalance, bookBalance, accountType);
    if (glTerms === null) {
      throw new BankingError(
        `The confirmed opening ${fromUnits(toUnits(openingBalance))} does not match the book balance carried in (${bookBalance} through ${coverage.startDate}) — correct the amount or post the missing book entries first`,
      );
    }
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'update',
         ${JSON.stringify({
           operation: "confirm_opening",
           reconciliationId: recon.id,
           confirmedAmount: fromUnits(toUnits(openingBalance)),
           openingBalance: glTerms,
           openingBalanceStartDate: coverage.startDate,
           bookBalance,
           reason,
         })}::jsonb,
         ${ctx.userId})
    `);
    return refreshStatus(recon, ctx, tx);
  });
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

/**
 * Foot a session's cleared balance and sign-off difference under the
 * account's statement sign convention. Asset-style accounts foot in GL
 * terms, exactly as before. Liability accounts whose typed statement
 * balance is owing-positive (CSV card portals) foot in statement terms —
 * otherwise a matched book could never reach a zero difference; a
 * negative typed balance (OFX GL-signed feeds) keeps GL terms, preserving
 * the existing behavior byte for byte. The typed balance selects the
 * convention, so the choice is deterministic and stays in the audit record.
 */
function footSessionBalance(
  statementBalance: string,
  carryAmount: string | null,
  cleared: string,
  accountType: string,
): { clearedBalance: string; difference: string } {
  const statementUnits = toUnits(statementBalance);
  const clearedGlUnits = (carryAmount ? toUnits(carryAmount) : 0n) + toUnits(cleared);
  const owingPositive = statementComparisonSign(accountType) === -1 && statementUnits >= 0n;
  const clearedTerms = owingPositive ? -clearedGlUnits : clearedGlUnits;
  return {
    clearedBalance: fromUnits(clearedTerms),
    difference: fromUnits(statementUnits - clearedTerms),
  };
}

/** Bank statements describe physical cash once. Secondary accounting
 * representations are not additional deposits or withdrawals. The primary
 * book cannot be reassigned through setup once reconciliation records exist.
 * Share setup's fence so starting the first session and changing the primary
 * book cannot pass each other's checks. Writes hold both locks to commit. */
export async function reconciliationBookId(executor: SqlExecutor, orgId: string): Promise<string> {
  await executor.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`accounting-books:${orgId}`}, 0))`,
  );
  const books = await executor.execute<{ id: string; is_active: boolean; posts_gl: boolean }>(
    sql`
    select id,is_active,posts_gl from accounting_books
     where org_id=${orgId} and is_primary order by id for share`,
    "objects",
  );
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
  const accountType =
    (
      await executor.execute<{ type: string }>(
        sql`
    select type from accounts where id = ${recon.account_id} and org_id = ${ctx.orgId}
  `,
        "objects",
      )
    )[0]?.type ?? "";
  const r = await executor.execute<{
    cleared: string;
    matched_journal: string;
    matched_stmt: string;
    unmatched_stmt: string;
  }>(
    sql`
    select
      coalesce((
        select sum(jl.txn_amount)
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
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
  `,
    "objects",
  );
  const row = r[0]!;
  const { clearedBalance, difference } = footSessionBalance(
    recon.statement_balance,
    carry?.amount ?? null,
    row.cleared,
    accountType,
  );
  return {
    statementBalance: fromUnits(toUnits(recon.statement_balance)),
    clearedBalance,
    difference,
    matchedStatementLines: Number(row.matched_stmt),
    unmatchedStatementLines: Number(row.unmatched_stmt),
    matchedJournalLines: Number(row.matched_journal),
  };
}

export type SignOffBlocker = {
  id: string;
  postedOn: string;
  amount: string;
  description: string | null;
  /** The earlier line this one may duplicate; null when the line is unflagged. */
  possibleDuplicateOf: string | null;
  /** The duplicated line's date and amount, so the blocker names what it duplicates. */
  possibleDuplicateOfPostedOn: string | null;
  possibleDuplicateOfAmount: string | null;
};

/**
 * The unmatched statement lines through the cutoff that refuse sign-off,
 * oldest first, with the total count. The workspace renders these beside
 * the refusal so the operator sees exactly which lines block the session
 * instead of a bare count.
 */
export async function listSignOffBlockers(
  reconciliationId: string,
  ctx: BankingContext,
  limit = 50,
): Promise<{ lines: SignOffBlocker[]; total: number }> {
  return withOrgTransaction(ctx.orgId, async () => {
    const recon = await loadReconciliation(ctx.orgId, reconciliationId, ctx.allowedSubsidiaryIds);
    const lines = await db.execute<SignOffBlocker>(
      sql`
      select l.id, l.posted_on as "postedOn", l.amount::text as amount, l.description,
             l.possible_duplicate_of as "possibleDuplicateOf",
             dup.posted_on::text as "possibleDuplicateOfPostedOn",
             dup.amount::text as "possibleDuplicateOfAmount"
        from bank_statement_lines l
        left join bank_statement_lines dup
          on dup.id = l.possible_duplicate_of and dup.org_id = l.org_id
       where l.org_id = ${ctx.orgId}
         and l.account_id = ${recon.account_id}
         and l.currency = ${recon.currency}
         and l.posted_on <= ${recon.through_date}
         and l.match_status = 'unmatched'
       order by l.posted_on, l.line_number
       limit ${limit}
    `,
      "objects",
    );
    const total = (
      await db.execute<{ count: number }>(
        sql`
      select count(*)::int as count
        from bank_statement_lines l
       where l.org_id = ${ctx.orgId}
         and l.account_id = ${recon.account_id}
         and l.currency = ${recon.currency}
         and l.posted_on <= ${recon.through_date}
         and l.match_status = 'unmatched'
    `,
        "objects",
      )
    )[0]!.count;
    return { lines, total };
  });
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
  const statementBalance =
    opts.statementBalance === undefined
      ? undefined
      : normalizeAmount(opts.statementBalance, "Statement balance");
  return db.transaction(async (tx) => {
    await reconciliationBookId(tx, ctx.orgId);
    const account = (
      await tx.execute<{ account_id: string }>(
        sql`
      select account_id from reconciliations where id = ${reconciliationId} and org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) return null;
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    const before = (
      await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
        sql`
      select r.id, r.org_id, r.through_date, r.statement_balance, r.account_id, r.currency, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId} and r.status <> 'signed_off'
       for update of r
    `,
        "objects",
      )
    )[0];
    if (!before) return null;
    // A missing session stays a null (the route's 404); an out-of-scope one
    // refuses the same uniform not-found as every other session verb.
    if (!subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, before.subsidiary_id)) {
      throw new ScopeNotFoundError();
    }
    const throughDate = opts.throughDate ?? before.through_date;
    await requireCutoffAfterSignedHistory(tx, ctx.orgId, before.account_id, throughDate);
    const stranded = (
      await tx.execute<{ id: string }>(
        sql`
      select m.id from reconciliation_matches m
      join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
      join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where m.reconciliation_id = ${reconciliationId} and m.org_id = ${ctx.orgId}
         and (l.posted_on > ${throughDate} or je.posting_date > ${throughDate})
       limit 1
    `,
        "objects",
      )
    )[0];
    if (stranded) {
      throw new BankingError(
        "Through date cannot exclude matched statement or journal lines; unmatch them first",
      );
    }
    const after = (
      await tx.execute<ReconciliationRow>(
        sql`
      update reconciliations
         set through_date = ${throughDate},
             statement_balance = ${statementBalance ?? before.statement_balance},
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${reconciliationId} and org_id = ${ctx.orgId}
       returning id, account_id, through_date, currency, statement_balance, status
    `,
        "objects",
      )
    )[0]!;
    const totals = await refreshStatus(after, ctx, tx);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${ctx.orgId}, 'reconciliations', ${reconciliationId}, 'update',
        ${JSON.stringify({
          mode: "session_adjustment",
          before: {
            throughDate: before.through_date,
            statementBalance: before.statement_balance,
            status: before.status,
          },
          after: {
            throughDate: after.through_date,
            statementBalance: after.statement_balance,
            status: isZero(totals.difference) ? "balanced" : "in_progress",
          },
        })}::jsonb, ${ctx.userId})
    `);
    return totals;
  });
}

/**
 * Discard an unsigned session: delete its matches and release its statement
 * lines back to unmatched. Signed-off sessions are permanent.
 */
export async function discardReconciliation(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const reconResult = await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
       for update of r
    `,
      "objects",
    );
    const recon = reconResult[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") {
      throw new BankingError("Signed-off reconciliations cannot be discarded");
    }
    const released = await tx.execute<{ statement_line_id: string }>(
      sql`
      delete from reconciliation_matches
       where reconciliation_id = ${recon.id} and org_id = ${ctx.orgId}
      returning statement_line_id
    `,
      "objects",
    );
    const stmtIds = [...new Set(released.map((r) => r.statement_line_id))];
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
           releasedMatches: released.length,
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

/**
 * Withdraw the newest sign-off on an account so its period can be corrected.
 * Signed history is otherwise permanent; this is the governed exception for
 * a period Banking has been reopened for (or never closed): late entries
 * dated inside it, or bank lines that arrived after sign-off, can then be
 * matched at their true dates and the session signed off again.
 *
 * Sign-offs unwind newest first, and only while no unsigned session builds
 * on them. The session returns to an unsigned state with its matches intact,
 * the reconciliation stamp it placed on journal lines is released, and the
 * audit log keeps the reason and the withdrawn sign-off's evidence.
 */
export async function withdrawReconciliationSignOff(
  reconciliationId: string,
  reason: string,
  ctx: BankingContext,
): Promise<{ journalLinesReleased: number; status: "in_progress" | "balanced" }> {
  const stated = reason.trim();
  if (stated.length < 10 || stated.length > 500) {
    throw new BankingError("Withdrawing a sign-off requires a 10-500 character reason");
  }
  return db.transaction(async (tx) => {
    const head = (
      await tx.execute<{ account_id: string; subsidiary_id: string | null }>(
        sql`
      select r.account_id, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    requireSessionRowInScope(head, ctx.allowedSubsidiaryIds);
    await lockReconciliationAccount(tx, ctx.orgId, head.account_id);
    const recon = (
      await tx.execute<
        ReconciliationRow & {
          subsidiary_id: string | null;
          signed_off_by: string | null;
          signed_off_at: string | null;
        }
      >(
        sql`
      select r.id, r.account_id, r.through_date::text as through_date, r.currency,
             r.statement_balance::text as statement_balance, r.status, a.subsidiary_id,
             r.signed_off_by, r.signed_off_at::text as signed_off_at
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
       for update of r
    `,
        "objects",
      )
    )[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status !== "signed_off") {
      throw new BankingError("Only a signed-off reconciliation can be withdrawn");
    }
    const later = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${recon.account_id}
         and status = 'signed_off' and id <> ${recon.id}
         and through_date >= ${recon.through_date}::date
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (later) {
      throw new BankingError(
        `Withdraw the later sign-off through ${later.through_date} first — sign-offs are withdrawn newest first`,
      );
    }
    const open = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${recon.account_id} and status <> 'signed_off'
       limit 1
    `,
        "objects",
      )
    )[0];
    if (open) {
      throw new BankingError(
        `Discard the open reconciliation through ${open.through_date} first — it continues from this sign-off`,
      );
    }
    const period = await resolveCoveringPeriod(
      tx,
      ctx.orgId,
      recon.through_date,
      recon.subsidiary_id,
    );
    if (period) {
      const bookId = await reconciliationBookId(tx, ctx.orgId);
      const blocked = (
        await tx.execute<{ blocked: boolean }>(
          sql`
        select period_module_blocks_write(
          ${ctx.orgId}, ${period.id}, ${bookId}, ${recon.subsidiary_id}, 'banking', false
        ) as blocked
      `,
          "objects",
        )
      )[0]?.blocked;
      if (blocked) {
        throw new BankingError(
          `Banking is closed for ${canonicalPeriodLabel({ fiscalYear: period.fiscal_year, periodNumber: period.period_number, adjustment: false })} — request a controlled reopen of Banking for that period, then withdraw the sign-off`,
        );
      }
    }
    const withdrawn = await tx.execute<{ id: string }>(
      sql`
      update reconciliations
         set status = 'in_progress', signed_off_by = null, signed_off_at = null,
             updated_at = now(), updated_by = ${ctx.userId}
       where id = ${recon.id} and org_id = ${ctx.orgId} and status = 'signed_off'
      returning id
    `,
      "objects",
    );
    if (withdrawn.length !== 1) {
      throw new BankingError(
        "The sign-off changed while it was being withdrawn — reload and retry",
      );
    }
    // The journal-line guard admits clearing exactly this reconciliation's
    // stamp while the marker names it, for this transaction only.
    await tx.execute(sql`select set_config('app.reconciliation_withdrawal', ${recon.id}, true)`);
    const released = await tx.execute<{ id: string }>(
      sql`
      update journal_lines
         set reconciled_at = null, reconciliation_id = null
       where org_id = ${ctx.orgId} and reconciliation_id = ${recon.id}
      returning id
    `,
      "objects",
    );
    await tx.execute(sql`select set_config('app.reconciliation_withdrawal', '', true)`);
    const totals = await refreshStatus({ ...recon, status: "in_progress" }, ctx, tx);
    const status = isZero(totals.difference) ? ("balanced" as const) : ("in_progress" as const);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${ctx.orgId}, 'reconciliations', ${recon.id}, 'update',
        ${JSON.stringify({
          operation: "withdraw_sign_off",
          reason: stated,
          releasedJournalLines: released.length,
          before: {
            status: "signed_off",
            signedOffBy: recon.signed_off_by,
            signedOffAt: recon.signed_off_at,
            throughDate: recon.through_date,
            statementBalance: fromUnits(toUnits(recon.statement_balance)),
            currency: recon.currency,
          },
          after: { status },
        })}::jsonb, ${ctx.userId})
    `);
    return { journalLinesReleased: released.length, status };
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
  approvalRunId?: string,
): Promise<
  { status: "signed_off"; journalLinesReconciled: number } | { status: "pending_approval" }
> {
  return withOrgTransaction(ctx.orgId, async () => {
    const tx = db;
    await lockApprovalSubject(ctx.orgId, "bank_reconciliation_sign_off", reconciliationId);
    if (!(await lockAndCheckOrgFeature(db, ctx.orgId, "banking"))) throw new ScopeNotFoundError();
    const account = (
      await tx.execute<{
        account_id: string;
        status: string;
        subsidiary_id: string | null;
        account_type: string;
      }>(
        sql`
      select r.account_id, r.status, a.subsidiary_id, a.type as account_type
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) throw new ScopeNotFoundError();
    const actualScope = await lockActorCommandAuthority(
      tx,
      ctx.orgId,
      ctx.userId,
      account.subsidiary_id,
      "banking.reconcile",
    );
    requireSessionRowInScope(account, actualScope);
    // Gate before the idempotent-retry early return: the retry reports the
    // session's line counts, which a restricted caller must never observe
    // for another entity's account.
    requireSessionRowInScope(account, ctx.allowedSubsidiaryIds);
    // A completed sign-off is immutable evidence. Retrying it does not create
    // a new accounting action or require today's book configuration to remain active.
    if (account.status === "signed_off") {
      const existing = (
        await tx.execute<{ count: number }>(
          sql`
        select count(*)::int as count from journal_lines
         where org_id = ${ctx.orgId} and reconciliation_id = ${reconciliationId}
      `,
          "objects",
        )
      )[0]!;
      return {
        status: "signed_off" as const,
        journalLinesReconciled: existing.count,
      };
    }
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    const r = await tx.execute<
      ReconciliationRow & { subsidiary_id: string | null; account_type: string }
    >(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id, a.type as account_type
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
       for update of r
    `,
      "objects",
    );
    const recon = r[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off") {
      const existing = await tx.execute<{ count: number }>(
        sql`
        select count(*)::int as count
          from journal_lines
         where org_id = ${ctx.orgId} and reconciliation_id = ${recon.id}
      `,
        "objects",
      );
      return {
        status: "signed_off" as const,
        journalLinesReconciled: existing[0]!.count,
      };
    }
    await requireCutoffAfterSignedHistory(tx, ctx.orgId, recon.account_id, recon.through_date);

    const statementEvidence = await tx.execute<{ count: number }>(
      sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
    `,
      "objects",
    );
    if (statementEvidence[0]!.count === 0) {
      throw new BankingError(
        "Cannot sign off without imported statement evidence through the reconciliation date",
      );
    }

    // The session's statement balance is typed by hand; the imported bank
    // statement's closing balance is the bank's own figure for the cutoff.
    // When a statement on the cutoff date carries a closing balance, the two
    // must agree — otherwise the operator balanced the GL against a number
    // the bank never reported.
    const cutoffStatements = await tx.execute<{ closing_balance: string }>(
      sql`
      select closing_balance::text as closing_balance
        from bank_statements
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and statement_date = ${recon.through_date}::date
         and closing_balance is not null
    `,
      "objects",
    );
    for (const stmt of cutoffStatements) {
      // Card statements disagree on sign (OFX carries the GL-signed balance,
      // the session holds it owing-positive), so a liability account
      // compares under its statement sign convention, like the matches.
      if (
        !statementTotalsAgree(
          toUnits(stmt.closing_balance),
          toUnits(recon.statement_balance),
          recon.account_type,
        )
      ) {
        throw new BankingError(
          `Cannot sign off: the imported statement closing balance ${fromUnits(toUnits(stmt.closing_balance))} for ${recon.through_date} does not match the session statement balance ${fromUnits(toUnits(recon.statement_balance))} — adjust the session balance to the imported closing balance`,
        );
      }
    }

    const unmatched = await tx.execute<{ count: number }>(
      sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'unmatched'
    `,
      "objects",
    );
    if (unmatched[0]!.count > 0) {
      throw new BankingError(
        `Cannot sign off: ${unmatched[0]!.count} statement line(s) through the cutoff remain unmatched`,
      );
    }

    // Group cross-footing in exact units: every condition the old
    // per-statement having clause enforced, now footed per match group so a
    // many-to-one group (two wires, one journal) validates as the unit it
    // cleared as. A group foots only when every member still reads as it did
    // at match time and both sides sum exactly alike.
    const groupRows = await tx.execute<{
      group_id: string;
      stmt_id: string | null;
      stmt_amount: string | null;
      stmt_account: string | null;
      stmt_currency: string | null;
      stmt_posted_on: string | null;
      stmt_status: string | null;
      journal_id: string;
      journal_amount: string;
      journal_account: string;
      journal_currency: string;
      journal_subsidiary: string | null;
      journal_reconciled_at: string | null;
      entry_book: string;
      entry_status: string;
      entry_posting_date: string;
    }>(
      sql`
      select m.group_id,
             l.id as stmt_id, l.amount::text as stmt_amount, l.account_id as stmt_account,
             l.currency as stmt_currency, l.posted_on::text as stmt_posted_on, l.match_status as stmt_status,
             jl.id as journal_id, jl.txn_amount::text as journal_amount, jl.account_id as journal_account,
             jl.currency as journal_currency, jl.subsidiary_id as journal_subsidiary,
             jl.reconciled_at::text as journal_reconciled_at,
             je.book_id as entry_book, je.status as entry_status, je.posting_date::text as entry_posting_date
        from reconciliation_matches m
        -- GL-only clearing rows name no statement line: the statement side
        -- is optional, the journal side is not.
        left join bank_statement_lines l
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
    `,
      "objects",
    );
    const groups = new Map<string, typeof groupRows>();
    for (const row of groupRows) {
      const list = groups.get(row.group_id) ?? [];
      list.push(row);
      groups.set(row.group_id, list);
    }
    const groupInvalid = (rows: typeof groupRows): string | null => {
      for (const row of rows) {
        // GL-only clearing rows carry no statement side; only the journal
        // side is footed for them.
        if (
          row.stmt_id !== null &&
          (row.stmt_account !== recon.account_id ||
            row.stmt_currency !== recon.currency ||
            (row.stmt_posted_on ?? "") > recon.through_date ||
            row.stmt_status !== "matched")
        ) {
          return "one or more matches fail book, account, currency, cutoff, or availability";
        }
        if (
          row.journal_account !== recon.account_id ||
          row.journal_currency !== recon.currency ||
          row.entry_book !== bookId ||
          // Live entries only: a match whose entry has since been reversed is stale.
          row.entry_status !== "posted" ||
          row.entry_posting_date > recon.through_date ||
          row.journal_reconciled_at !== null ||
          (ctx.allowedSubsidiaryIds !== null &&
            !subsidiaryScopeAllows(ctx.allowedSubsidiaryIds, row.journal_subsidiary))
        ) {
          return "one or more matches fail book, account, currency, cutoff, or availability";
        }
      }
      // Distinct members only: the group's rows are the complete bipartite
      // edges, so a naive sum would count each side's members many times.
      // GL-only groups sum an empty statement side against a zero journal
      // sum. Liability accounts foot under the statement sign convention
      // (see statementTotalsAgree): card feeds disagree on charge signs.
      const stmtTotal = [
        ...new Map(
          rows
            .filter((row) => row.stmt_id !== null)
            .map((row) => [row.stmt_id, row.stmt_amount as string]),
        ).values(),
      ].reduce((total, amount) => total + toUnits(amount), 0n);
      const journalTotal = [
        ...new Map(rows.map((row) => [row.journal_id, row.journal_amount])).values(),
      ].reduce((total, amount) => total + toUnits(amount), 0n);
      if (!statementTotalsAgree(stmtTotal, journalTotal, recon.account_type)) {
        return `group total ${fromUnits(stmtTotal)} does not foot to ${fromUnits(journalTotal)}`;
      }
      return null;
    };
    for (const rows of groups.values()) {
      const reason = groupInvalid(rows);
      if (reason) {
        throw new BankingError(`Cannot sign off: ${reason} in exact-amount cross-footing`);
      }
    }

    const carry = await firstReconciliationCarry(tx, recon, ctx, bookId);
    const carryStart = carry?.startDate ?? null;
    const bal = await tx.execute<{ cleared: string }>(
      sql`
      select coalesce(sum(jl.txn_amount), 0) as cleared
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and (${carryStart}::date is null or je.posting_date >= ${carryStart}::date)
         and (jl.reconciled_at is not null
              or jl.id in (select journal_line_id from reconciliation_matches rm
                            where rm.reconciliation_id = ${recon.id}
                              and rm.org_id = ${ctx.orgId}))
    `,
      "objects",
    );
    const { difference } = footSessionBalance(
      recon.statement_balance,
      carry?.amount ?? null,
      bal[0]!.cleared,
      recon.account_type,
    );
    if (!isZero(difference)) {
      throw new BankingError(
        `Cannot sign off: difference is ${difference}, not 0.0000 — match or unmatch lines until it balances`,
      );
    }

    if (
      await requestNativeCommandApproval({
        orgId: ctx.orgId,
        actorId: ctx.userId,
        subjectKind: "bank_reconciliation_sign_off",
        subjectId: reconciliationId,
        command: {},
        approvalRunId,
      })
    )
      return { status: "pending_approval" as const };
    // journal_lines carries no row-level audit columns. The reconciliation
    // stamp is its own evidence; transaction amendments are preserved through
    // immutable document + GL snapshots in audit_log.
    const stamped = await tx.execute<{ id: string }>(
      sql`
      update journal_lines jl
         set reconciled_at = now(), reconciliation_id = ${recon.id}
       where jl.org_id = ${ctx.orgId} and jl.reconciled_at is null
         and jl.id in (select journal_line_id from reconciliation_matches
                        where reconciliation_id = ${recon.id}
                          and org_id = ${ctx.orgId})
      returning jl.id
    `,
      "objects",
    );

    // Stamp matched lines while their locked session is unsigned, then seal
    // the session under the same native Flow decision and transaction.
    const signed = await tx.execute(
      sql`update reconciliations set status='signed_off',signed_off_by=${ctx.userId},signed_off_at=now(),updated_at=now(),updated_by=${ctx.userId}
      where org_id=${ctx.orgId} and id=${recon.id} and status in('in_progress','balanced') returning id`,
      "objects",
    );
    if (signed.length !== 1)
      throw new BankingError(
        "The reconciliation changed before sign-off was recorded. Reload its current state.",
      );

    const excluded = await tx.execute<{ count: number }>(
      sql`
      select count(*)::int as count
        from bank_statement_lines
       where org_id = ${ctx.orgId}
         and account_id = ${recon.account_id}
         and currency = ${recon.currency}
         and posted_on <= ${recon.through_date}
         and match_status = 'excluded'
    `,
      "objects",
    );
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
           matchedJournalLines: stamped.length,
           openingCarriedForward: carry?.amount ?? "0.0000",
           openingCarryStartDate: carry?.startDate ?? null,
           excludedStatementLines: excluded[0]!.count,
           difference: "0.0000",
         })}::jsonb,
         ${ctx.userId})
    `);

    return {
      status: "signed_off" as const,
      journalLinesReconciled: stamped.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Sign-off staleness
// ---------------------------------------------------------------------------

/** One journal entry posted into a signed-off period after its sign-off. */
export type StaleJournalEntry = {
  entryNumber: string;
  /** True (business) date of the entry. */
  postingDate: string;
  /** Signed bank-account amount in GL terms. */
  amount: string;
  postedBy: string | null;
  postedAt: string | null;
};

/** A matched line the sign-off relied on that was later reversed. */
export type ReversedMatchEntry = StaleJournalEntry & {
  reversalNumber: string | null;
  reversedAt: string | null;
};

export interface ReconciliationStaleness {
  stale: boolean;
  /** Civil date of the earliest late posting or reversal, once stale. */
  staleSince: string | null;
  /** In-period entries posted after the sign-off, oldest first. */
  lateEntries: StaleJournalEntry[];
  /** Session matches whose entry has since been reversed. */
  reversedMatches: ReversedMatchEntry[];
  /** Net effect of the late entries on the cleared balance. */
  clearedEffect: string;
  /** Independent append-only review of this exact neutral late history.
   * The late entries stay visible and retain their uncleared ledger state. */
  revalidation?: SignOffRevalidationCertificate;
}

const CLEAN_STALENESS: ReconciliationStaleness = {
  stale: false,
  staleSince: null,
  lateEntries: [],
  reversedMatches: [],
  clearedEffect: "0.0000",
};

type StalenessSession = ReconciliationRow & { signed_off_at: string | null };

async function loadSignedSession(
  executor: BankingSqlExecutor,
  reconciliationId: string,
  ctx: BankingContext,
): Promise<StalenessSession> {
  // The scope gate reads exactly like every other session verb: a restricted
  // caller cannot distinguish another entity's session from a missing one.
  const recon = await loadReconciliation(ctx.orgId, reconciliationId, ctx.allowedSubsidiaryIds);
  const row = (
    await executor.execute<StalenessSession>(
      sql`
    select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status,
           r.signed_off_at::text as signed_off_at
      from reconciliations r
     where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
  `,
      "objects",
    )
  )[0]!;
  return { ...recon, signed_off_at: row.signed_off_at };
}

/**
 * A signed-off session is STALE when the ledger kept moving underneath it:
 * a posted (or reversed) journal line on its account dated on or before its
 * cutoff arrived (posted_at) after the sign-off, or a matched line it
 * relied on was later reversed. Read from the ledger every time — the
 * sign-off row stays immutable, so staleness is history, not state.
 */
export async function reconciliationStaleness(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<ReconciliationStaleness> {
  return withOrgTransaction(ctx.orgId, async () => {
    const recon = await loadSignedSession(db, reconciliationId, ctx);
    if (recon.status !== "signed_off" || !recon.signed_off_at) return { ...CLEAN_STALENESS };
    const bookId = await reconciliationBookId(db, ctx.orgId);
    const lateEntries = await db.execute<StaleJournalEntry & { posted_at: string }>(
      sql`
      select je.entry_number as "entryNumber", je.posting_date::text as "postingDate",
             coalesce(sum(jl.txn_amount), 0)::text as amount,
             max(u.name) as "postedBy", min(je.posted_at)::text as posted_at
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join users u on u.id = je.posted_by and u.org_id = je.org_id
       where jl.org_id = ${ctx.orgId} and jl.account_id = ${recon.account_id}
         and jl.currency = ${recon.currency}
         and je.book_id = ${bookId}
         and je.status in ('posted', 'reversed')
         and je.posting_date <= ${recon.through_date}
         and je.posted_at > ${recon.signed_off_at}::timestamptz
       group by je.id, je.entry_number, je.posting_date
       order by je.posting_date, je.entry_number
    `,
      "objects",
    );
    const reversedMatches = await db.execute<
      ReversedMatchEntry & { posted_at: string; updated_at: string }
    >(
      sql`
      select je.entry_number as "entryNumber", je.posting_date::text as "postingDate",
             coalesce(sum(jl.txn_amount), 0)::text as amount,
             max(u.name) as "postedBy", min(je.posted_at)::text as posted_at,
             max(rev.entry_number) as "reversalNumber",
             coalesce(max(rev.posted_at), max(je.updated_at))::text as "reversedAt",
             max(je.updated_at)::text as updated_at
        from reconciliation_matches m
        join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        left join journal_entries rev
          on rev.org_id = je.org_id and rev.reverses_entry_id = je.id
        left join users u on u.id = coalesce(rev.posted_by, je.posted_by) and u.org_id = je.org_id
       where m.org_id = ${ctx.orgId} and m.reconciliation_id = ${recon.id}
         and je.status = 'reversed'
         and coalesce(rev.posted_at, je.updated_at) > ${recon.signed_off_at}::timestamptz
       group by je.id, je.entry_number, je.posting_date
       order by je.posting_date, je.entry_number
    `,
      "objects",
    );
    const late = lateEntries.map(({ posted_at: _postedAt, ...entry }) => ({
      ...entry,
      amount: fromUnits(toUnits(entry.amount)),
      postedAt: _postedAt,
    }));
    const reversed = reversedMatches.map(
      ({ posted_at: _postedAt, updated_at: _updatedAt, ...entry }) => ({
        ...entry,
        amount: fromUnits(toUnits(entry.amount)),
        postedAt: _postedAt,
        reversedAt: entry.reversedAt,
      }),
    );
    // The sign-off footed posted lines only, so a reversal never restates the
    // cleared balance the way a late posting does: the effect is the late
    // postings' net, and the reversed matches stand apart as void evidence.
    const clearedEffect = fromUnits(
      late.reduce((total, entry) => total + toUnits(entry.amount), 0n),
    );
    const since =
      [...late.map((entry) => entry.postedAt), ...reversed.map((entry) => entry.reversedAt)]
        .filter((value): value is string => value !== null)
        .map((value) => value.slice(0, 10))
        .sort()[0] ?? null;
    let revalidation: SignOffRevalidationCertificate | null = null;
    if (late.length > 0 && reversed.length === 0) {
      // Healthy unreviewed sessions retain the ordinary lightweight read.
      // A retained certificate requires full keyed evidence comparison;
      // its timestamp alone never suppresses a later financial event.
      const recorded = (
        await db.execute(
          sql`
        select al.id from audit_log al join reconciliations r on r.org_id=al.org_id and r.id=al.row_id
          where al.org_id=${ctx.orgId} and al.table_name='reconciliations'
          and r.account_id=${recon.account_id} and r.currency=${recon.currency}
          and r.through_date<=${recon.through_date}::date and r.status='signed_off'
          and al.action='update' and al.changes->>'operation'='revalidate_sign_off'
        limit 1
      `,
          "objects",
        )
      )[0];
      const signer = recorded
        ? (
            await db.execute<{ id: string; signed_off_by: string | null; evidence_kind: string }>(
              sql`
        select id,signed_off_by,evidence_kind from reconciliations where org_id=${ctx.orgId} and id=${recon.id}
      `,
              "objects",
            )
          )[0]
        : null;
      if (signer?.signed_off_by && signer.evidence_kind === "statement") {
        const subject = {
          orgId: ctx.orgId,
          id: recon.id,
          accountId: recon.account_id,
          bookId,
          currency: recon.currency,
          throughDate: recon.through_date,
          signedOffAt: recon.signed_off_at,
          statementBalance: fromUnits(toUnits(recon.statement_balance)),
          signedOffBy: signer.signed_off_by,
        };
        const proof = await reconciliationReviewProof(db, subject);
        const totals = await reconciliationTotals(recon.id, ctx);
        if (
          (await originalSignOffProofAgrees(db, subject, proof)) &&
          totals.unmatchedStatementLines === 0 &&
          isZero(totals.difference) &&
          toUnits(totals.statementBalance) === toUnits(subject.statementBalance)
        ) {
          revalidation = await applicableSignOffRevalidation(db, subject, proof);
        }
      }
    }
    return {
      stale: !revalidation && (late.length > 0 || reversed.length > 0),
      staleSince: !revalidation && (late.length > 0 || reversed.length > 0) ? since : null,
      lateEntries: late,
      reversedMatches: reversed,
      clearedEffect,
      ...(revalidation ? { revalidation } : {}),
    };
  });
}

export interface ReconciliationStalenessSummary {
  stale: boolean;
  staleSince: string | null;
  clearedEffect: string;
}

/**
 * One batched staleness read for an account's session list. Sessions share
 * one transaction and reuse the single-session reader, so the list badge can
 * never disagree with the workspace panel.
 */
export async function reconciliationStalenessSummaries(
  accountId: string,
  reconciliationIds: readonly string[],
  ctx: BankingContext,
): Promise<Record<string, ReconciliationStalenessSummary>> {
  if (reconciliationIds.length === 0) return {};
  return withOrgTransaction(ctx.orgId, async () => {
    // The account read already gated the caller; confirm every id belongs to
    // it so a mixed list cannot leak another account's sessions.
    const owned = new Set(
      (
        await db.execute<{ id: string }>(
          sql`
      select id from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${accountId}
         and id = any(${sql.param([...reconciliationIds])}::uuid[])
    `,
          "objects",
        )
      ).map((row) => row.id),
    );
    const summaries: Record<string, ReconciliationStalenessSummary> = {};
    for (const id of reconciliationIds) {
      if (!owned.has(id)) continue;
      const detail = await reconciliationStaleness(id, ctx);
      summaries[id] = {
        stale: detail.stale,
        staleSince: detail.staleSince,
        clearedEffect: detail.clearedEffect,
      };
    }
    return summaries;
  });
}

export interface PriorPeriodLateEffect {
  /** Cutoff of the earlier signed-off session the late entries landed in. */
  throughDate: string;
  amount: string;
}

/**
 * The opening-difference explanation for an unsigned session: every earlier
 * signed-off session's late in-period effect, oldest period first. The late
 * lines themselves appear as outstanding ledger lines; this names the periods
 * whose sign-offs they landed behind.
 */
export async function priorPeriodLateEffect(
  accountId: string,
  throughDate: string,
  ctx: BankingContext,
): Promise<PriorPeriodLateEffect[]> {
  return withOrgTransaction(ctx.orgId, async () => {
    const bookId = await reconciliationBookId(db, ctx.orgId);
    const rows = await db.execute<{ through_date: string; amount: string }>(
      sql`
      select r.through_date::text as through_date, coalesce(sum(jl.txn_amount), 0)::text as amount
        from reconciliations r
        join journal_lines jl
          on jl.org_id = r.org_id and jl.account_id = r.account_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where r.org_id = ${ctx.orgId} and r.account_id = ${accountId}
         and r.status = 'signed_off' and r.through_date < ${throughDate}::date
         and jl.currency = r.currency
         and je.book_id = ${bookId}
         and je.status in ('posted', 'reversed')
         and je.posting_date <= r.through_date
         and je.posted_at > r.signed_off_at
       group by r.id, r.through_date
      having coalesce(sum(jl.txn_amount), 0) <> 0
       order by r.through_date
    `,
      "objects",
    );
    const byPeriod = new Map<string, bigint>();
    for (const row of rows) {
      byPeriod.set(row.through_date, (byPeriod.get(row.through_date) ?? 0n) + toUnits(row.amount));
    }
    return [...byPeriod.entries()]
      .filter(([, total]) => total !== 0n)
      .map(([period, total]) => ({ throughDate: period, amount: fromUnits(total) }));
  });
}
