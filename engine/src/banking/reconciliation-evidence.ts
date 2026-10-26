/**
 * Audit evidence for one reconciliation session: the bank statements that
 * support its balance, the statement lines excluded in its window with their
 * reasons, and the lifecycle history that explains how the signed figure
 * reached its current value.
 *
 * Read-only. The session's bank account must lie in the caller's subsidiary
 * scope; a missing or out-of-scope session refuses with the uniform not-found.
 *
 * Window: the session covers the account's statement lines in its currency
 * that post after the previous signed-off session's through date (or from the
 * beginning of the account) and on or before this session's through date.
 * A statement supports the session when it has a line in that window or when
 * one of its lines is matched by this session.
 */
import { sql } from "drizzle-orm";
import { subsidiaryScopeSql, type BankingContext } from "./banking-core";
import { db, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";

export interface EvidenceStatement {
  id: string;
  source: string;
  statementDate: string;
  importedAt: string;
  openingBalance: string | null;
  closingBalance: string | null;
  /** Statement lines inside the session window, by match state. */
  windowLines: number;
  matchedLines: number;
  excludedLines: number;
  unmatchedLines: number;
  /** Signed sum of the statement's lines inside the window, in any state. */
  windowTotal: string;
}

export interface EvidenceExcludedLine {
  id: string;
  statementId: string;
  postedOn: string;
  amount: string;
  description: string | null;
  exclusionReason: string;
  excludedAt: string | null;
  excludedByName: string | null;
  /** The earlier line this excluded line was flagged as duplicating, when flagged. */
  possibleDuplicateOf: { postedOn: string; amount: string } | null;
}

interface HistoryBase {
  at: string;
  actorName: string | null;
}

interface SessionState {
  throughDate: string;
  statementBalance: string | null;
  status: string | null;
}

export type ReconciliationHistoryEvent = HistoryBase &
  (
    | {
        kind: "revalidate_sign_off";
        reason: string | null;
        throughDate: string | null;
        statementBalance: string | null;
        originalSignedOffAt: string | null;
        reviewedEntries: number | null;
        evidenceDigest: string | null;
      }
    | {
        kind: "sign_off";
        evidenceKind: "statement" | "source";
        throughDate: string | null;
        currency: string | null;
        statementBalance: string | null;
        matchedJournalLines: number | null;
        excludedStatementLines: number | null;
      }
    | {
        kind: "withdraw_sign_off";
        reason: string | null;
        throughDate: string | null;
        currency: string | null;
        priorStatementBalance: string | null;
        priorSignedOffAt: string | null;
        priorSignedOffByName: string | null;
        releasedJournalLines: number | null;
        status: string | null;
      }
    | {
        kind: "discard";
        throughDate: string | null;
        currency: string | null;
        statementBalance: string | null;
        releasedMatches: number | null;
        releasedStatementLines: number | null;
      }
    | {
        kind: "confirm_opening";
        amount: string | null;
        startDate: string | null;
        reason: string | null;
      }
    | {
        kind: "session_adjustment";
        before: SessionState | null;
        after: SessionState | null;
      }
  );

export interface ReconciliationEvidence {
  reconciliation: {
    id: string;
    accountId: string;
    currency: string;
    throughDate: string;
    status: string;
    evidenceKind: string;
    /** Through date of the previous signed-off session; the window opens the day after. */
    windowStart: string | null;
  };
  statements: EvidenceStatement[];
  excludedLines: EvidenceExcludedLine[];
  history: ReconciliationHistoryEvent[];
}

interface SessionRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  through_date: string;
  currency: string;
  status: string;
  evidence_kind: string;
}

interface StatementRow extends Record<string, unknown> {
  id: string;
  source: string;
  statement_date: string;
  imported_at: string;
  opening_balance: string | null;
  closing_balance: string | null;
  window_lines: number;
  matched_lines: number;
  excluded_lines: number;
  unmatched_lines: number;
  window_total: string;
}

interface ExcludedRow extends Record<string, unknown> {
  id: string;
  statement_id: string;
  posted_on: string;
  amount: string;
  description: string | null;
  exclusion_reason: string;
  excluded_at: string | null;
  excluded_by_name: string | null;
  dup_posted_on: string | null;
  dup_amount: string | null;
}

interface HistoryRow extends Record<string, unknown> {
  at: string;
  changes: Record<string, unknown>;
  actor_name: string | null;
  prior_signer_name: string | null;
}

/** Decimal text normalized to the four-place money scale; null for absent values. */
function moneyText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return fromUnits(toUnits(value));
}

function textValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * A timestamp recorded in an audit payload as Postgres text (for example
 * `2026-10-01 10:00:00.123456+00`) as ISO 8601 UTC. Text that does not parse
 * is returned unchanged rather than dropped, so the record stays readable.
 */
function payloadInstant(value: unknown): string | null {
  const text = textValue(value);
  if (text === null) return null;
  const normalized = text
    .trim()
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d{2})$/, "$1:00");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function countValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sessionState(value: unknown): SessionState | null {
  const state = objectValue(value);
  const throughDate = textValue(state.throughDate);
  if (throughDate === null) return null;
  return {
    throughDate,
    statementBalance: moneyText(state.statementBalance),
    status: textValue(state.status),
  };
}

function historyEvent(row: HistoryRow): ReconciliationHistoryEvent {
  const changes = row.changes;
  const base = { at: row.at, actorName: row.actor_name };
  if (changes.mode === "session_adjustment") {
    return {
      ...base,
      kind: "session_adjustment",
      before: sessionState(changes.before),
      after: sessionState(changes.after),
    };
  }
  const before = objectValue(changes.before);
  switch (changes.operation) {
    case "revalidate_sign_off": {
      const proof = objectValue(changes.proof);
      return {
        ...base,
        kind: "revalidate_sign_off",
        reason: textValue(changes.reason),
        throughDate: textValue(changes.throughDate),
        statementBalance: moneyText(changes.statementBalance),
        originalSignedOffAt: payloadInstant(changes.originalSignedOffAt),
        reviewedEntries: countValue(
          proof.neutralBasis === "outstanding_movements"
            ? proof.outstandingEntries
            : proof.lateEntries,
        ),
        evidenceDigest: textValue(proof.digest),
      };
    }
    case "sign_off": {
      const evidenceKind = changes.evidenceKind === "source" ? "source" : "statement";
      return {
        ...base,
        kind: "sign_off",
        evidenceKind,
        throughDate: textValue(changes.throughDate),
        currency: textValue(changes.currency),
        statementBalance: moneyText(changes.statementBalance),
        matchedJournalLines: countValue(changes.matchedJournalLines ?? changes.clearedJournalLines),
        excludedStatementLines: countValue(changes.excludedStatementLines),
      };
    }
    case "withdraw_sign_off":
      return {
        ...base,
        kind: "withdraw_sign_off",
        reason: textValue(changes.reason),
        throughDate: textValue(before.throughDate),
        currency: textValue(before.currency),
        priorStatementBalance: moneyText(before.statementBalance),
        priorSignedOffAt: payloadInstant(before.signedOffAt),
        priorSignedOffByName: row.prior_signer_name,
        releasedJournalLines: countValue(changes.releasedJournalLines),
        status: textValue(objectValue(changes.after).status),
      };
    case "discard":
      return {
        ...base,
        kind: "discard",
        throughDate: textValue(before.throughDate),
        currency: textValue(before.currency),
        statementBalance: moneyText(before.statementBalance),
        releasedMatches: countValue(changes.releasedMatches),
        releasedStatementLines: countValue(changes.releasedStatementLines),
      };
    case "confirm_opening":
      return {
        ...base,
        kind: "confirm_opening",
        amount: moneyText(changes.confirmedAmount),
        startDate: textValue(changes.openingBalanceStartDate),
        reason: textValue(changes.reason),
      };
    default:
      // Only the operations selected below reach this mapping.
      throw new Error("Unexpected reconciliation history operation");
  }
}

/**
 * The session's window lines, shared by the statement, excluded-line and
 * count reads so every section of the evidence describes the same lines.
 */
function windowLinesCte(session: {
  orgId: string;
  accountId: string;
  currency: string;
  throughDate: string;
  windowStart: string | null;
}) {
  return sql`window_lines as (
    select l.id, l.statement_id, l.line_number, l.posted_on, l.amount, l.description,
           l.match_status, l.exclusion_reason, l.excluded_at, l.excluded_by, l.possible_duplicate_of
      from bank_statement_lines l
     where l.org_id = ${session.orgId}
       and l.account_id = ${session.accountId}
       and l.currency = ${session.currency}
       and l.posted_on <= ${session.throughDate}::date
       and (${session.windowStart}::date is null or l.posted_on > ${session.windowStart}::date)
  )`;
}

/**
 * Every bank statement that supports a reconciliation session, its counts
 * inside the session window, the excluded lines in that window with their
 * reasons, and the session's governed history.
 */
export async function reconciliationEvidence(
  reconciliationId: string,
  ctx: BankingContext,
): Promise<ReconciliationEvidence> {
  return withOrgTransaction(
    ctx.orgId,
    async () => {
      const session = (
        await db.execute<SessionRow>(
          sql`
      select r.id, r.account_id, r.through_date::text as through_date, r.currency, r.status, r.evidence_kind
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.id = ${reconciliationId} and r.org_id = ${ctx.orgId}
         ${subsidiaryScopeSql(ctx.allowedSubsidiaryIds, sql`a.subsidiary_id`)}
    `,
          "objects",
        )
      )[0];
      // Missing and out-of-scope sessions refuse identically.
      if (!session) throw new ScopeNotFoundError();

      const windowStart =
        (
          await db.execute<{ through_date: string }>(
            sql`
      select through_date::text as through_date from reconciliations
       where org_id = ${ctx.orgId} and account_id = ${session.account_id}
         and status = 'signed_off' and id <> ${session.id}
         and through_date < ${session.through_date}::date
       order by through_date desc, created_at desc, id desc
       limit 1
    `,
            "objects",
          )
        )[0]?.through_date ?? null;

      const scope = {
        orgId: ctx.orgId,
        accountId: session.account_id,
        currency: session.currency,
        throughDate: session.through_date,
        windowStart,
      };
      const windowLines = windowLinesCte(scope);

      const statements = await db.execute<StatementRow>(
        sql`
      with ${windowLines},
      session_statements as (
        select distinct l.statement_id
          from reconciliation_matches m
          join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
         where m.reconciliation_id = ${session.id} and m.org_id = ${ctx.orgId}
      )
      select s.id, s.source, s.statement_date::text as statement_date,
             to_char(s.imported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as imported_at,
             s.opening_balance::text as opening_balance, s.closing_balance::text as closing_balance,
             c.window_lines, c.matched_lines, c.excluded_lines, c.unmatched_lines, c.window_total
        from bank_statements s
        left join lateral (
          select count(w.id)::int as window_lines,
                 (count(w.id) filter (where w.match_status = 'matched'))::int as matched_lines,
                 (count(w.id) filter (where w.match_status = 'excluded'))::int as excluded_lines,
                 (count(w.id) filter (where w.match_status = 'unmatched'))::int as unmatched_lines,
                 coalesce(sum(w.amount), 0)::text as window_total
            from window_lines w
           where w.statement_id = s.id
        ) c on true
       where s.org_id = ${ctx.orgId} and s.account_id = ${session.account_id}
         and (c.window_lines > 0 or exists (select 1 from session_statements ss where ss.statement_id = s.id))
       order by s.statement_date asc, s.imported_at asc, s.id asc
    `,
        "objects",
      );

      const excluded = await db.execute<ExcludedRow>(
        sql`
      with ${windowLines}
      select w.id, w.statement_id, w.posted_on::text as posted_on, w.amount::text as amount,
             w.description, w.exclusion_reason,
             to_char(w.excluded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as excluded_at,
             u.name as excluded_by_name,
             dup.posted_on::text as dup_posted_on, dup.amount::text as dup_amount
        from window_lines w
        left join bank_statement_lines dup on dup.id = w.possible_duplicate_of and dup.org_id = ${ctx.orgId}
        left join users u on u.id = w.excluded_by and u.org_id = ${ctx.orgId}
       where w.match_status = 'excluded'
       order by w.posted_on asc, w.statement_id asc, w.line_number asc
    `,
        "objects",
      );

      // Sign-offs, withdrawals, discards, confirmations and adjustments. A
      // discard is keyed to the deleted session, so discards are matched by the
      // account they released; the account is already scope-checked above.
      const history = await db.execute<HistoryRow>(
        sql`
      select to_char(al.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
             al.changes, actor.name as actor_name, prior.name as prior_signer_name
        from audit_log al
        left join users actor on actor.id = al.actor_id and actor.org_id = al.org_id
        left join users prior on prior.id::text = al.changes->'before'->>'signedOffBy' and prior.org_id = al.org_id
       where al.org_id = ${ctx.orgId}
         and al.table_name = 'reconciliations'
         and (
           (al.row_id = ${session.id}::uuid and (
              al.changes->>'operation' in ('sign_off', 'withdraw_sign_off', 'confirm_opening', 'revalidate_sign_off')
              or al.changes->>'mode' = 'session_adjustment'))
           or (al.changes->>'operation' = 'discard'
               and al.changes->'before'->>'accountId' = ${session.account_id}::text)
         )
       order by al.at asc, al.id asc
    `,
        "objects",
      );

      return {
        reconciliation: {
          id: session.id,
          accountId: session.account_id,
          currency: session.currency,
          throughDate: session.through_date,
          status: session.status,
          evidenceKind: session.evidence_kind,
          windowStart,
        },
        statements: statements.map((row) => ({
          id: row.id,
          source: row.source,
          statementDate: row.statement_date,
          importedAt: row.imported_at,
          openingBalance: moneyText(row.opening_balance),
          closingBalance: moneyText(row.closing_balance),
          windowLines: row.window_lines,
          matchedLines: row.matched_lines,
          excludedLines: row.excluded_lines,
          unmatchedLines: row.unmatched_lines,
          windowTotal: moneyText(row.window_total) ?? "0.0000",
        })),
        excludedLines: excluded.map((row) => ({
          id: row.id,
          statementId: row.statement_id,
          postedOn: row.posted_on,
          amount: moneyText(row.amount) ?? "0.0000",
          description: row.description,
          exclusionReason: row.exclusion_reason,
          excludedAt: row.excluded_at,
          excludedByName: row.excluded_by_name,
          possibleDuplicateOf:
            row.dup_posted_on !== null && row.dup_amount !== null
              ? { postedOn: row.dup_posted_on, amount: moneyText(row.dup_amount) ?? "0.0000" }
              : null,
        })),
        history: history.map(historyEvent),
      };
    },
    { readOnly: true, isolationLevel: "REPEATABLE READ" },
  );
}
