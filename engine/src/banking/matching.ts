/** Auto/manual matching. Split from banking.ts (pure moves only). */
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
  requireBankAccountInScope,
  lockBankAccountInScope,
  requireStatementLineAccountInScope,
  lockReconciliationAccount,
} from "./reconcilable-account";
import {
  type ReconciliationRow,
  firstReconciliationCarry,
  type ReconciliationTotals,
  type BankingTransaction,
  reconciliationBookId,
  refreshStatus,
} from "./reconciliation";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  db,
  inDbTransaction,
  withOrgTransaction,
  withTransactionSavepoint,
} from "../platform/db.ts";
import { fromUnits, sum, toUnits } from "../money/money.ts";
import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
import {
  assignOneToOne,
  counterpartyTokens,
  REVIEW_SCORE_CEILING,
  scoreLedgerCandidate,
  type MatchReason,
  type PairProposal,
  type PriorPayee,
} from "./match-scoring";
import { lockScopeRows, ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { assertRealDate, isBalanceSummaryRow, normalizeAmount } from "./statement-parsers/shared";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export interface AutoMatchResult {
  matched: number;
  /** Pairs scoring above REVIEW_SCORE_CEILING (confidence above 0.70). */
  highConfidence: number;
  /** Pairs at or below the ceiling: held in the review tab. */
  mediumConfidence: number;
  totals: ReconciliationTotals;
}

/** Most recent confirmed matches consulted for the same-party evidence. */
const PRIOR_PAYEE_HISTORY_LIMIT = 500;

/**
 * Auto-match unmatched statement lines to unreconciled, unclaimed posted
 * journal lines on the session's account. Eligibility is unchanged and
 * strict: exact amount under the account's statement sign convention
 * (liability accounts pair either sign: CSV portals print charges
 * owing-positive while OFX carries them GL-signed) and dates no more than
 * LEDGER_MATCH_WINDOW_DAYS apart. Every eligible pair is scored with
 * explainable reasons (match-scoring.ts): the date lag, asymmetric because
 * banks post after the book date far more often than before it; a shared
 * cheque or document reference; shared counterparty words between the
 * statement text and the journal memo or party; and the same party as an
 * earlier confirmed match for the same payee. Pairs are assigned one-to-one,
 * strongest first, with deterministic tie-breaks; the score and reasons are
 * stored on the match. Lines flagged as possible duplicates are never
 * auto-matched — the reviewer clears the flag or excludes the line first —
 * and neither are balance-summary rows ("Opening balance …"), which have no
 * GL counterpart to pair with.
 */
export async function autoMatch(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<AutoMatchResult> {
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
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    const reconResult = await tx.execute<
      ReconciliationRow & { subsidiary_id: string | null; account_type: string }
    >(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id, a.type as account_type
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
    // Lines covered by a proven statement opening are cleared by the carry,
    // not by matching: claiming one would double-count the opening.
    const carryStart = (await firstReconciliationCarry(tx, recon, ctx, bookId))?.startDate ?? null;

    const stmtRes = await tx.execute<{
      id: string;
      posted_on: string;
      amount: string;
      description: string | null;
      counterparty_ref: string | null;
    }>(
      sql`
      select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref
       from bank_statement_lines l
       where l.account_id = ${recon.account_id} and l.org_id = ${ctx.orgId}
         and l.currency = ${recon.currency}
         and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
         and l.possible_duplicate_of is null
       order by l.posted_on, l.line_number
       for update
    `,
      "objects",
    );
    const glRes = await tx.execute<{
      id: string;
      posting_date: string;
      amount: string;
      memo: string | null;
      party_id: string | null;
      party_name: string | null;
      document_number: string | null;
      reference_number: string | null;
    }>(
      sql`
      select jl.id, je.posting_date, jl.txn_amount as amount,
             coalesce(jl.memo, je.memo) as memo,
             p.id as party_id, p.display_name as party_name,
             d.document_number, d.reference_number
        from journal_lines jl
        -- Live entries only: a reversed original is no longer an item to clear, so it is never a candidate.
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
        left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
        left join parties p on p.id = coalesce(jl.party_id, d.party_id) and p.org_id = jl.org_id
       where jl.account_id = ${recon.account_id} and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.currency = ${recon.currency}
         and je.posting_date <= ${recon.through_date}
         and (${carryStart}::date is null or je.posting_date >= ${carryStart}::date)
         and jl.reconciled_at is null
         and ${excludePeriodEndJournals(sql`je.origin`)}
         and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
         ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`jl.subsidiary_id`)}
       order by je.posting_date, jl.line_number
       for update of jl
    `,
      "objects",
    );

    // Candidates by exact amount under the account's statement sign
    // convention: liability accounts bucket each journal under both signs,
    // because card feeds disagree (owing-positive CSV vs GL-signed OFX).
    // A journal claimed through one bucket must not pair again through the
    // other, so usage is tracked separately from bucket membership.
    const inverted = statementComparisonSign(recon.account_type) === -1;
    // On a liability account the session's typed balance names the feed's
    // convention: an owing-positive balance pairs the negated bucket first,
    // a GL-signed (negative) balance the direct one.
    const preferFlipped = inverted && toUnits(recon.statement_balance) >= 0n;
    const byAmount = new Map<string, { id: string; flipped: boolean }[]>();
    for (const jl of glRes) {
      const units = toUnits(jl.amount);
      const entries =
        inverted && units !== 0n
          ? [
              { key: units.toString(), flipped: false },
              { key: (-units).toString(), flipped: true },
            ]
          : [{ key: units.toString(), flipped: false }];
      for (const entry of entries) {
        const list = byAmount.get(entry.key) ?? [];
        list.push({ id: jl.id, flipped: entry.flipped });
        byAmount.set(entry.key, list);
      }
    }

    // Balance-summary rows ("Opening balance …", "Opening 1,914.90")
    // never pair: they have no GL counterpart, so pairing one with a
    // same-amount payment is the mismatch this guard exists to prevent.
    // The reviewer matches or excludes the row by hand.
    const pairable = stmtRes.filter((line) => !isBalanceSummaryRow(line.description));
    const priorPayees =
      pairable.length > 0 && glRes.some((row) => row.party_id)
        ? await confirmedPayees(tx, ctx.orgId, recon.account_id)
        : [];
    const journalById = new Map(glRes.map((row, index) => [row.id, { row, index }]));
    // Every eligible pair is scored; one-to-one assignment then takes the
    // strongest first. The same-day date score outranks every other date,
    // so a farther line takes a same-day line's journal only on stronger
    // reference, counterparty or history evidence.
    const proposals: (PairProposal & { confidence: string; reasons: MatchReason[] })[] = [];
    pairable.forEach((line, lineOrder) => {
      for (const bucket of byAmount.get(toUnits(line.amount).toString()) ?? []) {
        const journal = journalById.get(bucket.id)!;
        const scored = scoreLedgerCandidate(
          {
            id: line.id,
            postedOn: line.posted_on,
            description: line.description,
            counterpartyRef: line.counterparty_ref,
          },
          {
            id: journal.row.id,
            postingDate: journal.row.posting_date,
            memo: journal.row.memo,
            partyId: journal.row.party_id,
            partyName: journal.row.party_name,
            references: [journal.row.reference_number, journal.row.document_number],
          },
          priorPayees,
        );
        if (!scored) continue;
        proposals.push({
          lineId: line.id,
          candidateId: bucket.id,
          score: scored.score,
          lagDays: scored.lagDays,
          preferred: bucket.flipped === preferFlipped,
          lineOrder,
          candidateOrder: journal.index,
          confidence: scored.confidence,
          reasons: scored.reasons,
        });
      }
    });
    const pairs = assignOneToOne(proposals).map((proposal) => ({
      statementLineId: proposal.lineId,
      journalLineId: proposal.candidateId,
      score: proposal.score,
      confidence: proposal.confidence,
      reasons: proposal.reasons,
    }));
    const highConfidence = pairs.filter((p) => p.score > REVIEW_SCORE_CEILING).length;

    if (pairs.length > 0) {
      // Each automatic pair is its own group: unmatching one line removes
      // only its pair, exactly the pre-group granularity.
      await tx.execute(sql`
        insert into reconciliation_matches
          (org_id, reconciliation_id, statement_line_id, journal_line_id, group_id, matched_by, confidence, match_reasons, created_by)
        values ${sql.join(
          pairs.map(
            (p) =>
              sql`(${ctx.orgId}, ${recon.id}, ${p.statementLineId}, ${p.journalLineId}, ${randomUUID()}, 'auto', ${p.confidence}, ${JSON.stringify(p.reasons)}::jsonb, ${ctx.userId})`,
          ),
          sql`, `,
        )}
      `);
      const updated = await tx.execute<{ id: string }>(
        sql`
        update bank_statement_lines
           set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
         where id = any(${sql.param(pairs.map((p) => p.statementLineId))})
           and org_id = ${ctx.orgId}
        returning id
      `,
        "objects",
      );
      if (updated.length !== pairs.length) {
        throw new BankingError("Statement lines changed while auto-matching; run auto-match again");
      }
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
             highConfidence,
             mediumConfidence: pairs.length - highConfidence,
             pairs: pairs.map((p) => ({
               statementLineId: p.statementLineId,
               journalLineId: p.journalLineId,
               confidence: p.confidence,
               reasons: p.reasons,
             })),
           })}::jsonb,
           ${ctx.userId})
      `);
    }

    const totals = await refreshStatus(recon, ctx, tx);
    return {
      matched: pairs.length,
      highConfidence,
      mediumConfidence: pairs.length - highConfidence,
      totals,
    };
  });
}

/**
 * Payee words of the account's confirmed matches and the party each cleared:
 * manual and rule matches, plus automatic matches inside signed-off
 * sessions. Unreviewed automatic matches are not evidence for new ones.
 */
async function confirmedPayees(
  tx: BankingTransaction,
  orgId: string,
  accountId: string,
): Promise<PriorPayee[]> {
  const rows = await tx.execute<{
    party_id: string;
    description: string | null;
    counterparty_ref: string | null;
  }>(
    sql`
    select coalesce(jl.party_id, d.party_id) as party_id, sl.description, sl.counterparty_ref
      from reconciliation_matches m
      join reconciliations r on r.id = m.reconciliation_id and r.org_id = m.org_id
      join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
      join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
     where m.org_id = ${orgId} and r.account_id = ${accountId}
       and (m.matched_by in ('manual', 'rule') or r.status = 'signed_off')
       and coalesce(jl.party_id, d.party_id) is not null
     order by m.created_at desc, m.id
     limit ${PRIOR_PAYEE_HISTORY_LIMIT}
  `,
    "objects",
  );
  return rows
    .map((row) => ({
      partyId: row.party_id,
      tokens: counterpartyTokens(row.description, row.counterparty_ref),
    }))
    .filter((payee) => payee.tokens.length > 0);
}

type MatchOptions = {
  reconciliationId: string;
  statementLineIds: string[];
};

type MatchOrigin = "auto" | "manual" | "rule";

/**
 * Validate and persist a grouped match on an already-open transaction: any
 * non-empty set of statement lines clears against any non-empty set of
 * journal lines when both sides sum exactly alike. One match operation is one
 * group (a shared group_id): unmatch removes the whole group and sign-off
 * cross-foots group sums, so a $4k+$4k wire pair clears one $8k journal
 * without voiding and re-posting it. The statement line locks are
 * deliberately acquired before the optional journal factory: a concurrent
 * rule invocation therefore waits for the winner and then fails without
 * creating/posting a second journal.
 */
async function createMatchInTransaction(
  tx: BankingTransaction,
  opts: MatchOptions,
  ctx: BankingContext,
  journalLineIdsOrFactory: string[] | (() => Promise<string>),
  matchedBy: MatchOrigin,
): Promise<ReconciliationTotals> {
  const statementLineIds = [...new Set(opts.statementLineIds)];
  if (statementLineIds.length === 0) throw new BankingError("Select at least one statement line");
  const account = (
    await tx.execute<{ account_id: string }>(
      sql`
    select account_id from reconciliations
     where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
  `,
      "objects",
    )
  )[0];
  if (!account) throw new ScopeNotFoundError();
  await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
  const bookId = await reconciliationBookId(tx, ctx.orgId);
  const reconResult = await tx.execute<
    ReconciliationRow & { subsidiary_id: string | null; account_type: string }
  >(
    sql`
    select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id, a.type as account_type
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
     for update of r
  `,
    "objects",
  );
  const recon = reconResult[0];
  requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
  if (recon.status === "signed_off") throw new BankingError("Reconciliation is already signed off");

  const stmt = await tx.execute<{
    id: string;
    amount: string;
    currency: string;
    possible_duplicate_of: string | null;
  }>(
    sql`
    select l.id, l.amount, l.currency, l.possible_duplicate_of
      from bank_statement_lines l
     where l.id = any(${sql.param(statementLineIds)}::uuid[]) and l.org_id = ${ctx.orgId}
       and l.account_id = ${recon.account_id}
       and l.currency = ${recon.currency}
       and l.posted_on <= ${recon.through_date}
       and l.match_status = 'unmatched'
     order by l.id
     for update
  `,
    "objects",
  );
  if (stmt.length !== statementLineIds.length) {
    throw new BankingError(
      "One or more statement lines are unavailable, outside the reconciliation cutoff, or already matched; refresh Match Bank Data to see their current state",
    );
  }
  if (stmt.some((row) => row.possible_duplicate_of)) {
    throw new BankingError(
      "A statement line is flagged as a possible duplicate of an earlier import — clear the flag or exclude the line before matching",
    );
  }

  const journalLineIds = [
    ...new Set(
      typeof journalLineIdsOrFactory === "function"
        ? [await journalLineIdsOrFactory()]
        : journalLineIdsOrFactory,
    ),
  ];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  const gl = await tx.execute<{ id: string; amount: string; posting_date: string }>(
    sql`
    select jl.id, jl.txn_amount as amount, je.posting_date
      from journal_lines jl
      -- Live entries only: a reversed original is no longer an item to clear, so it cannot be matched.
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
     where jl.id = any(${sql.param(journalLineIds)}::uuid[])
       and jl.org_id = ${ctx.orgId}
       and je.book_id = ${bookId}
       and jl.account_id = ${recon.account_id}
       and jl.currency = ${recon.currency}
       and jl.reconciled_at is null
       and ${excludePeriodEndJournals(sql`je.origin`)}
       and je.posting_date <= ${recon.through_date}
       and not exists (
         select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id
       )
       ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`jl.subsidiary_id`)}
     order by jl.id
     for update of jl
  `,
    "objects",
  );
  if (gl.length !== journalLineIds.length) {
    throw new BankingError(
      "One or more journal lines are unavailable, outside the cutoff, already reconciled, or already matched",
    );
  }
  const carryStart = (await firstReconciliationCarry(tx, recon, ctx, bookId))?.startDate ?? null;
  if (carryStart && gl.some((line) => line.posting_date < carryStart)) {
    throw new BankingError(
      "One or more journal lines predate the carried statement opening balance and cannot be matched",
    );
  }
  // Both sides foot exactly, in the account currency and in exact units —
  // a cent apart is a refusal naming both totals, never a silent rounding.
  // Liability accounts foot under the statement sign convention (statement
  // charges positive are GL credits), accepting either pairing because
  // card feeds disagree; sign-off's difference stays the strict gate.
  const statementTotal = sum(stmt.map((line) => line.amount));
  const journalTotal = sum(gl.map((line) => line.amount));
  if (!statementTotalsAgree(toUnits(statementTotal), toUnits(journalTotal), recon.account_type)) {
    throw new BankingError(
      `Selected bank lines total ${statementTotal}; selected journal lines total ${journalTotal}`,
    );
  }

  // Complete bipartite: every bank line of the group clears against every
  // journal line of the group. A journal still belongs to a single group —
  // matched journals cannot be re-matched — so unmatching any member removes
  // exactly this group, and sign-off foots the group as one unit.
  const groupId = randomUUID();
  await tx.execute(sql`
    insert into reconciliation_matches
      (org_id, reconciliation_id, statement_line_id, journal_line_id, group_id, matched_by, confidence, created_by)
    values ${sql.join(
      statementLineIds.flatMap((statementLineId) =>
        journalLineIds.map(
          (journalLineId) =>
            sql`(${ctx.orgId}, ${recon.id}, ${statementLineId}, ${journalLineId}, ${groupId}, ${matchedBy}, null, ${ctx.userId})`,
        ),
      ),
      sql`, `,
    )}
  `);
  await tx.execute(sql`
    update bank_statement_lines
       set match_status = 'matched', updated_at = now(), updated_by = ${ctx.userId}
     where id = any(${sql.param(statementLineIds)}::uuid[]) and org_id = ${ctx.orgId}
  `);
  // Manual and rule-built matches attribute the same way the line's
  // exclude/restore writes do: actor, line, and target, beside the
  // before/after the audit history cross-foots. One row per grouped line so
  // each line's history names the group that cleared it.
  for (const statementLineId of statementLineIds) {
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'bank_statement_lines', ${statementLineId}, 'update',
         ${JSON.stringify({
           operation: "match",
           reconciliationId: recon.id,
           matchedBy,
           groupId,
           statementLineIds,
           journalLineIds,
           before: { matchStatus: "unmatched" },
           after: { matchStatus: "matched" },
         })}::jsonb,
         ${ctx.userId})
    `);
  }
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
  opts: MatchOptions & {
    createJournal: () => Promise<string>;
    matchedBy?: MatchOrigin;
    additionalAccountIds?: readonly string[];
  },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return withOrgTransaction(ctx.orgId, () =>
    inDbTransaction((tx) =>
      withTransactionSavepoint(tx, async () => {
        const reconciliation = (
          await tx.execute<{ account_id: string }>(
            sql`
      select account_id from reconciliations where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `,
            "objects",
          )
        )[0];
        if (!reconciliation) throw new ScopeNotFoundError();
        // Lock every account touched by the posting in one global order before
        // the reconciliation and statement-line locks. In particular, a manual
        // contra account cannot be rehomed after its preflight scope read.
        await lockScopeRows(
          tx,
          ctx.orgId,
          [
            { kind: "account", id: reconciliation.account_id },
            ...(opts.additionalAccountIds ?? []).map((id) => ({ kind: "account" as const, id })),
          ],
          ctx.allowedSubsidiaryIds,
          "update",
        );
        return createMatchInTransaction(
          tx,
          opts,
          ctx,
          opts.createJournal,
          opts.matchedBy ?? "rule",
        );
      }),
    ),
  );
}

/** Manually pair statement lines with journal lines as one group: both sides sum exactly alike. */
export async function createMatch(
  opts: MatchOptions & { journalLineIds: string[] },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const journalLineIds = [...new Set(opts.journalLineIds)];
  if (journalLineIds.length === 0) throw new BankingError("Select at least one journal line");

  return db.transaction((tx) => createMatchInTransaction(tx, opts, ctx, journalLineIds, "manual"));
}

/**
 * Clear GL-only offsetting items with no bank counterpart (a voided deposit
 * and its correcting journal netting to zero): journal lines only, same
 * account, posted, within the cutoff, summing exactly to zero. Stored as a
 * match group with no statement side — claimed journals cannot be matched
 * elsewhere, sign-off cross-foots the group (an empty statement side foots
 * a zero journal sum), and the cleared sum is unchanged because the group
 * nets to zero. Audited as one row on the session; unmatch removes the
 * whole group by id (see unmatchGlClearingGroup).
 */
export async function createGlClearingGroup(
  opts: { reconciliationId: string; journalLineIds: string[] },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  const journalLineIds = [...new Set(opts.journalLineIds)];
  if (journalLineIds.length === 0)
    throw new BankingError("Select at least one journal line to clear");
  return db.transaction(async (tx) => {
    const account = (
      await tx.execute<{ account_id: string }>(
        sql`
      select account_id from reconciliations
       where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) throw new ScopeNotFoundError();
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const bookId = await reconciliationBookId(tx, ctx.orgId);
    const reconResult = await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `,
      "objects",
    );
    const recon = reconResult[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off")
      throw new BankingError("Reconciliation is already signed off");

    const gl = await tx.execute<{ id: string; amount: string; posting_date: string }>(
      sql`
      select jl.id, jl.txn_amount as amount, je.posting_date
        from journal_lines jl
        -- Live entries only: a reversed original is no longer an item to clear.
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status = 'posted'
       where jl.id = any(${sql.param(journalLineIds)}::uuid[])
         and jl.org_id = ${ctx.orgId}
         and je.book_id = ${bookId}
         and jl.account_id = ${recon.account_id}
         and jl.currency = ${recon.currency}
         and jl.reconciled_at is null
         and ${excludePeriodEndJournals(sql`je.origin`)}
         and je.posting_date <= ${recon.through_date}
         and not exists (
           select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id
         )
         ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`jl.subsidiary_id`)}
       order by jl.id
       for update of jl
    `,
      "objects",
    );
    if (gl.length !== journalLineIds.length) {
      throw new BankingError(
        "One or more journal lines are unavailable, outside the cutoff, already reconciled, or already matched",
      );
    }
    // No carried-opening cutoff here, unlike statement matching: a zero-sum
    // group nets to nothing, so clearing pre-carry book lines (a book
    // opening entry with no bank line) cannot double-count the opening the
    // carry proves. The carry proof sums the same history either way.
    // Exact zero in the account currency and in exact units — a cent apart
    // is a refusal naming the total, never a silent rounding.
    const total = sum(gl.map((line) => line.amount));
    if (toUnits(total) !== 0n) {
      throw new BankingError(
        `Selected journal lines total ${total}, not zero — a GL clearing group must sum exactly to zero`,
      );
    }

    const groupId = randomUUID();
    await tx.execute(sql`
      insert into reconciliation_matches
        (org_id, reconciliation_id, statement_line_id, journal_line_id, group_id, matched_by, confidence, created_by)
      values ${sql.join(
        journalLineIds.map(
          (journalLineId) =>
            sql`(${ctx.orgId}, ${recon.id}, null, ${journalLineId}, ${groupId}, 'manual', null, ${ctx.userId})`,
        ),
        sql`, `,
      )}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'update',
         ${JSON.stringify({
           operation: "gl_clear",
           reconciliationId: recon.id,
           groupId,
           journalLineIds,
           total: "0.0000",
         })}::jsonb,
         ${ctx.userId})
    `);
    return refreshStatus(recon, ctx, tx);
  });
}

/**
 * Undo a GL-only clearing group within a session: every row of the group
 * goes and its journals return to the unreconciled pool. Groups that clear
 * statement lines are refused here — unmatch those from a statement line
 * so the bank side releases with them.
 */
export async function unmatchGlClearingGroup(
  opts: { reconciliationId: string; groupId: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return db.transaction(async (tx) => {
    const account = (
      await tx.execute<{ account_id: string }>(
        sql`
      select account_id from reconciliations
       where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) throw new ScopeNotFoundError();
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const reconResult = await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `,
      "objects",
    );
    const recon = reconResult[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off")
      throw new BankingError("Reconciliation is already signed off");

    const members = await tx.execute<{ statement_line_id: string | null; journal_line_id: string }>(
      sql`
      select m.statement_line_id, m.journal_line_id
        from reconciliation_matches m
       where m.reconciliation_id = ${recon.id}
         and m.group_id = ${opts.groupId}
         and m.org_id = ${ctx.orgId}
    `,
      "objects",
    );
    if (members.length === 0) {
      throw new BankingError("No clearing group with that id in this reconciliation");
    }
    if (members.some((row) => row.statement_line_id !== null)) {
      throw new BankingError(
        "That group clears statement lines — unmatch it from one of its statement lines instead",
      );
    }
    const journalLineIds = [...new Set(members.map((row) => row.journal_line_id))];
    await tx.execute(sql`
      delete from reconciliation_matches m
       where m.reconciliation_id = ${recon.id}
         and m.group_id = ${opts.groupId}
         and m.org_id = ${ctx.orgId}
         and m.statement_line_id is null
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${ctx.orgId}, 'reconciliations', ${recon.id}, 'update',
         ${JSON.stringify({
           operation: "unmatch_gl_clear",
           reconciliationId: recon.id,
           groupId: opts.groupId,
           journalLineIds,
         })}::jsonb,
         ${ctx.userId})
    `);
    return refreshStatus(recon, ctx, tx);
  });
}

/**
 * Unmatch every group touching an import's lines — the "Unmatch all" behind
 * a blocked import delete. Groups are removed whole (journals shared with
 * other lines release with them, exactly as unmatching by line), each in
 * its own session. Any group already inside a signed-off session refuses
 * the whole verb naming that session's cutoff: signed-off history is
 * immutable. Every released line is audited; nothing posts.
 */
export async function unmatchStatementImport(
  statementId: string,
  ctx: BankingContext,
): Promise<{ unmatchedGroups: number; unmatchedLines: number }> {
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
    await lockBankAccountInScope(tx, ctx.orgId, account.id, ctx.allowedSubsidiaryIds);
    // No row locks here (DISTINCT forbids FOR UPDATE): the account lock
    // above plus each session's FOR UPDATE below serialize with sign-off,
    // and match rows are deleted, never updated, further down.
    const groups = await tx.execute<{ reconciliation_id: string; group_id: string }>(
      sql`
      select distinct m.reconciliation_id, m.group_id
        from reconciliation_matches m
        join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
       where l.statement_id = ${statementId} and l.org_id = ${ctx.orgId}
       order by m.reconciliation_id, m.group_id
    `,
      "objects",
    );
    if (groups.length === 0) return { unmatchedGroups: 0, unmatchedLines: 0 };
    const sessions = new Map<string, ReconciliationRow & { subsidiary_id: string | null }>();
    for (const group of groups) {
      if (!sessions.has(group.reconciliation_id)) {
        const recon = (
          await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
            sql`
          select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
            from reconciliations r
            join accounts a on a.id = r.account_id and a.org_id = r.org_id
           where r.id = ${group.reconciliation_id} and r.org_id = ${ctx.orgId} and r.account_id = ${account.id}
           for update of r
        `,
            "objects",
          )
        )[0];
        if (!recon) throw new ScopeNotFoundError();
        requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
        if (recon.status === "signed_off") {
          throw new BankingError(
            `This import has matches in the signed-off reconciliation through ${recon.through_date} — signed-off history is immutable`,
          );
        }
        sessions.set(group.reconciliation_id, recon);
      }
    }
    let unmatchedLines = 0;
    for (const group of groups) {
      const deleted = await tx.execute<{ statement_line_id: string; journal_line_id: string }>(
        sql`
        delete from reconciliation_matches m
         where m.reconciliation_id = ${group.reconciliation_id}
           and m.group_id = ${group.group_id}
           and m.org_id = ${ctx.orgId}
        returning m.statement_line_id, m.journal_line_id
      `,
        "objects",
      );
      const releasedLineIds = [...new Set(deleted.map((row) => row.statement_line_id))];
      await tx.execute(sql`
        update bank_statement_lines l
           set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
         where l.id = any(${sql.param(releasedLineIds)}::uuid[]) and l.org_id = ${ctx.orgId}
           and not exists (
             select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id
           )
      `);
      for (const releasedLineId of releasedLineIds) {
        await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id)
          values
            (${ctx.orgId}, 'bank_statement_lines', ${releasedLineId}, 'update',
             ${JSON.stringify({
               operation: "unmatch",
               reconciliationId: group.reconciliation_id,
               groupIds: [group.group_id],
               journalLineIds: [
                 ...new Set(
                   deleted
                     .filter((row) => row.statement_line_id === releasedLineId)
                     .map((row) => row.journal_line_id),
                 ),
               ],
               before: { matchStatus: "matched" },
               after: { matchStatus: "unmatched" },
             })}::jsonb,
             ${ctx.userId})
        `);
      }
      unmatchedLines += releasedLineIds.length;
    }
    for (const recon of sessions.values()) {
      await refreshStatus(recon, ctx, tx);
    }
    return { unmatchedGroups: groups.length, unmatchedLines };
  });
}

/** Undo a statement line's match group within a session: every row bound to
 * the group's journals goes, and every grouped line left with no matches
 * returns to unmatched. A journal belongs to a single group — matched
 * journals cannot be re-matched — so the cascade removes exactly the group
 * the line was cleared with, restoring all of it. */
export async function unmatchStatementLine(
  opts: { reconciliationId: string; statementLineId: string },
  ctx: BankingContext,
): Promise<ReconciliationTotals> {
  return db.transaction(async (tx) => {
    const account = (
      await tx.execute<{ account_id: string }>(
        sql`
      select account_id from reconciliations
       where id = ${opts.reconciliationId} and org_id = ${ctx.orgId}
    `,
        "objects",
      )
    )[0];
    if (!account) throw new ScopeNotFoundError();
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const reconResult = await tx.execute<ReconciliationRow & { subsidiary_id: string | null }>(
      sql`
      select r.id, r.account_id, r.through_date, r.currency, r.statement_balance, r.status, a.subsidiary_id
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${opts.reconciliationId} and r.org_id = ${ctx.orgId} and r.account_id = ${account.account_id}
       for update of r
    `,
      "objects",
    );
    const recon = reconResult[0];
    requireSessionRowInScope(recon, ctx.allowedSubsidiaryIds);
    if (recon.status === "signed_off")
      throw new BankingError("Reconciliation is already signed off");

    const own = await tx.execute<{ group_id: string; journal_line_id: string }>(
      sql`
      select m.group_id, m.journal_line_id
        from reconciliation_matches m
       where m.reconciliation_id = ${recon.id}
         and m.statement_line_id = ${opts.statementLineId}
         and m.org_id = ${ctx.orgId}
    `,
      "objects",
    );
    if (own.length === 0) {
      throw new BankingError("No matches for that statement line in this reconciliation");
    }
    const journalLineIds = [...new Set(own.map((row) => row.journal_line_id))];
    const deleted = await tx.execute<{
      statement_line_id: string;
      journal_line_id: string;
      group_id: string;
    }>(
      sql`
      delete from reconciliation_matches m
       where m.reconciliation_id = ${recon.id}
         and m.org_id = ${ctx.orgId}
         and m.journal_line_id = any(${sql.param(journalLineIds)}::uuid[])
      returning m.statement_line_id, m.journal_line_id, m.group_id
    `,
      "objects",
    );
    const releasedLineIds = [...new Set(deleted.map((row) => row.statement_line_id))];
    await tx.execute(sql`
      update bank_statement_lines l
         set match_status = 'unmatched', updated_at = now(), updated_by = ${ctx.userId}
       where l.id = any(${sql.param(releasedLineIds)}::uuid[]) and l.org_id = ${ctx.orgId}
         and not exists (
           select 1 from reconciliation_matches m where m.statement_line_id = l.id and m.org_id = l.org_id
         )
    `);
    for (const releasedLineId of releasedLineIds) {
      const groupIds = [
        ...new Set(
          deleted
            .filter((row) => row.statement_line_id === releasedLineId)
            .map((row) => row.group_id),
        ),
      ];
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${ctx.orgId}, 'bank_statement_lines', ${releasedLineId}, 'update',
           ${JSON.stringify({
             operation: "unmatch",
             reconciliationId: recon.id,
             groupIds,
             journalLineIds: [
               ...new Set(
                 deleted
                   .filter((row) => row.statement_line_id === releasedLineId)
                   .map((row) => row.journal_line_id),
               ),
             ],
             before: { matchStatus: "matched" },
             after: { matchStatus: "unmatched" },
           })}::jsonb,
           ${ctx.userId})
      `);
    }
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
  const account = await requireStatementLineAccountInScope(
    db,
    ctx.orgId,
    statementLineId,
    ctx.allowedSubsidiaryIds,
  );
  await db.transaction(async (tx) => {
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const res = await tx.execute<{ id: string }>(
      sql`
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
    `,
      "objects",
    );
    if (!res[0]) throw new BankingError("Only unmatched lines can be excluded");
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
  const account = await requireStatementLineAccountInScope(
    db,
    ctx.orgId,
    statementLineId,
    ctx.allowedSubsidiaryIds,
  );
  await db.transaction(async (tx) => {
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    // Read the evidence first: UPDATE ... RETURNING would hand back the NEW
    // (nulled) flag, not the before-image the audit row must record.
    const before = (
      await tx.execute<{ id: string; possible_duplicate_of: string }>(
        sql`
      select l.id, l.possible_duplicate_of
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'unmatched'
         and l.possible_duplicate_of is not null
       for update
    `,
        "objects",
      )
    )[0];
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
    const rows = await tx.execute<{ id: string; possible_duplicate_of: string }>(
      sql`
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
    `,
      "objects",
    );
    for (const row of rows) {
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
    return { excluded: rows.length };
  });
}

/** Restore an excluded statement line back to the unmatched queue. */
export async function restoreStatementLine(
  statementLineId: string,
  ctx: BankingContext,
): Promise<void> {
  const account = await requireStatementLineAccountInScope(
    db,
    ctx.orgId,
    statementLineId,
    ctx.allowedSubsidiaryIds,
  );
  await db.transaction(async (tx) => {
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const candidateResult = await tx.execute<{
      id: string;
      account_id: string;
      posted_on: string;
      exclusion_reason: string;
    }>(
      sql`
      select l.id, l.account_id, l.posted_on, l.exclusion_reason
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'excluded'
    `,
      "objects",
    );
    const candidate = candidateResult[0];
    if (!candidate) throw new BankingError("Only excluded lines can be restored");
    // Cover sessions that do not exist yet or whose cutoff does not overlap
    // yet. Header locks alone cannot serialize their creation/extension and
    // sign-off with an exclusion restore that has not committed.
    // Reconciliation sessions lock their header before touching statement
    // lines. Acquire the same locks first so restore cannot deadlock with a
    // concurrent match/unmatch/sign-off transaction.
    const overlapping = await tx.execute<{ id: string; status: string }>(
      sql`
      select id, status
        from reconciliations
       where org_id = ${ctx.orgId}
         and account_id = ${candidate.account_id}
         and through_date >= ${candidate.posted_on}
       order by id
       for update
    `,
      "objects",
    );
    if (overlapping.some((reconciliation) => reconciliation.status === "signed_off")) {
      throw new BankingError(
        "This exclusion is covered by a signed-off reconciliation and cannot be restored",
      );
    }
    const lineResult = await tx.execute<{
      id: string;
      account_id: string;
      posted_on: string;
      exclusion_reason: string;
    }>(
      sql`
      select l.id, l.account_id, l.posted_on, l.exclusion_reason
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
         and l.match_status = 'excluded'
       for update
    `,
      "objects",
    );
    const line = lineResult[0];
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

export interface StatementLineCorrection {
  /** Signed decimal string from the bank's perspective; sign flips allowed. */
  amount?: string;
  /** ISO date (YYYY-MM-DD). */
  postedOn?: string;
  /** Null clears the description; undefined leaves it. */
  description?: string | null;
}

/**
 * Correct an unmatched statement line's amount, sign, date or description —
 * the import-time sign error that otherwise leaves the account
 * unreconcilable. Only unmatched lines can be corrected (matched lines carry
 * journal evidence: unmatch first; excluded lines carry a review decision:
 * restore first), and never inside signed-off history. The possible-duplicate
 * flag is review evidence about the line's identity and survives the edit.
 * Every change is audited with its before/after image; nothing posts — no
 * adjusting entry is ever booked for an import correction.
 */
export async function correctStatementLine(
  statementLineId: string,
  patch: StatementLineCorrection,
  ctx: BankingContext,
): Promise<void> {
  const next: { amount?: string; postedOn?: string; description?: string | null } = {};
  if (patch.amount !== undefined) next.amount = normalizeAmount(patch.amount, "Line amount");
  if (patch.postedOn !== undefined) {
    const dateMatch = patch.postedOn.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!dateMatch) throw new BankingError("Corrected posted date must be YYYY-MM-DD");
    next.postedOn = assertRealDate(
      dateMatch[1]!,
      dateMatch[2]!,
      dateMatch[3]!,
      "Corrected posted date",
    );
  }
  if (patch.description !== undefined) {
    const trimmed = patch.description?.trim() ?? "";
    next.description = trimmed === "" ? null : trimmed;
  }
  if (next.amount === undefined && next.postedOn === undefined && next.description === undefined) {
    throw new BankingError("No correction supplied: change the amount, date or description");
  }
  const account = await requireStatementLineAccountInScope(
    db,
    ctx.orgId,
    statementLineId,
    ctx.allowedSubsidiaryIds,
  );
  await db.transaction(async (tx) => {
    await lockReconciliationAccount(tx, ctx.orgId, account.account_id);
    await lockBankAccountInScope(tx, ctx.orgId, account.account_id, ctx.allowedSubsidiaryIds);
    const before = (
      await tx.execute<{
        id: string;
        posted_on: string;
        amount: string;
        description: string | null;
        match_status: string;
      }>(
        sql`
      select l.id, l.posted_on::text as posted_on, l.amount::text as amount,
             l.description, l.match_status
        from bank_statement_lines l
       where l.id = ${statementLineId}
         and l.org_id = ${ctx.orgId}
         and l.account_id = ${account.account_id}
       for update
    `,
        "objects",
      )
    )[0];
    if (!before) throw new BankingError("Only unmatched lines can be corrected — unmatch it first");
    if (before.match_status === "matched") {
      throw new BankingError("Only unmatched lines can be corrected — unmatch it first");
    }
    if (before.match_status === "excluded") {
      throw new BankingError("Only unmatched lines can be corrected — restore it first");
    }
    // Signed-off history is immutable (the import fence): a correction must
    // neither touch a line inside it nor move a line into it, or the closed
    // session would carry evidence it can never clear.
    const signedThrough = (
      await tx.execute<{ through_date: string }>(
        sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${account.account_id} and status = 'signed_off'
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    const afterPostedOn = next.postedOn ?? before.posted_on;
    if (
      signedThrough &&
      (before.posted_on <= signedThrough.through_date ||
        afterPostedOn <= signedThrough.through_date)
    ) {
      throw new BankingError(
        `This line is dated on or before the signed-off reconciliation through ${signedThrough.through_date} — signed-off history is immutable`,
      );
    }
    const after = {
      amount: next.amount ?? fromUnits(toUnits(before.amount)),
      postedOn: afterPostedOn,
      description: next.description !== undefined ? next.description : before.description,
    };
    const beforeCanonical = {
      amount: fromUnits(toUnits(before.amount)),
      postedOn: before.posted_on,
      description: before.description,
    };
    // Idempotent success without audit noise: an identical re-correction
    // writes nothing. Amounts compare in exact units — database text keeps
    // its stored scale while normalized input is canonical.
    if (
      toUnits(after.amount) === toUnits(beforeCanonical.amount) &&
      after.postedOn === beforeCanonical.postedOn &&
      after.description === beforeCanonical.description
    ) {
      return;
    }
    // Governed-correction marker for the statement-line guard: transaction
    // scoped, so only this line's audited update passes the content fence.
    await tx.execute(
      sql`select set_config('app.statement_correction_line', ${statementLineId}, true)`,
    );
    await tx.execute(sql`
      update bank_statement_lines
         set amount = ${after.amount},
             posted_on = ${after.postedOn},
             description = ${after.description},
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
           operation: "correct_line",
           before: beforeCanonical,
           after: {
             amount: after.amount,
             postedOn: after.postedOn,
             description: after.description,
           },
         })}::jsonb,
         ${ctx.userId})
    `);
  });
}
