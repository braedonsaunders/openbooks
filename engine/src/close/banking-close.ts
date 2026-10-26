import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { CloseError } from "../periods/period-policy.ts";
import {
  reconciliationStaleness,
  reconciliationTotals,
  sourceEvidencePolicyActive,
  type BankingContext,
} from "../banking/banking.ts";
import { closeBankStatementScope } from "./close-scope.ts";
import { excludePeriodEndJournals } from "../records/period-end-origins.ts";

/**
 * Close policy code an organization may create (Setup → period close →
 * save-policy, any policy type) to demand signed-off bank reconciliations
 * before the Banking module closes. Absent the policy the close warns and
 * requires an explicit acknowledgement instead of refusing.
 */
export const BANK_SIGNED_RECONCILIATION_POLICY_CODE = "bank-signed-reconciliation";

export type BankingCloseAccountState = "signed_off" | "in_progress" | "none";

export interface BankingCloseAccountStatus {
  accountId: string;
  number: string | null;
  name: string;
  status: BankingCloseAccountState;
  /** Signed-off cutoff, or the unsigned session's cutoff; null when none. */
  throughDate: string | null;
  /** Unsigned session's statement-minus-cleared difference; null otherwise. */
  difference: string | null;
  /** A covering sign-off the ledger has since moved underneath. */
  stale: boolean;
  staleSince: string | null;
  clearedEffect: string | null;
}

export interface BankingCloseEvaluation {
  accounts: BankingCloseAccountStatus[];
  /** Accounts that are not cleanly signed off (unsigned or stale). */
  issues: BankingCloseAccountStatus[];
  /** True when the org policy demands signed reconciliations. */
  strict: boolean;
}

function accountLabel(account: BankingCloseAccountStatus): string {
  const name = account.number ? `${account.number} ${account.name}` : account.name;
  if (account.status === "none") return `${name}: no reconciliation through the period`;
  if (account.stale) {
    return `${name}: signed off through ${account.throughDate} but stale since ${account.staleSince} (late effect ${account.clearedEffect})`;
  }
  if (account.status === "in_progress") {
    return `${name}: reconciliation in progress through ${account.throughDate} with difference ${account.difference}`;
  }
  return `${name}: signed off through ${account.throughDate}`;
}

/**
 * Every bank account's reconciliation status for one period close. The
 * population mirrors the close-run readiness check: reconcilable, active,
 * non-summary accounts with statements, posted lines, or a nonzero balance
 * in the period. A covering sign-off (through the period end) reads clean
 * unless the ledger moved underneath it — staleness is read from the
 * ledger every time, exactly like the reconciliation workspace.
 */
/**
 * The accounts one Banking close governs: reconcilable, active,
 * non-summary accounts with statements, posted lines, or a nonzero balance
 * in the period. Shared by the status check and the unmatched-line count
 * so both read the same population — never two checkers.
 */
async function bankingClosePopulation(
  orgId: string,
  args: { periodId: string; bookId: string; subsidiaryId?: string },
  periodEndsOn: string,
): Promise<{ id: string; number: string | null; name: string }[]> {
  const statementScope = closeBankStatementScope(
    orgId,
    args.subsidiaryId ? [args.subsidiaryId] : [],
  );
  const lineScope = args.subsidiaryId
    ? sql`jl.subsidiary_id = ${args.subsidiaryId}::uuid`
    : sql`true`;
  return await db.execute<{ id: string; number: string | null; name: string }>(
    sql`
    select a.id, a.number, a.name
      from accounts a
     where a.org_id = ${orgId} and a.reconcilable and a.is_active and not a.is_summary
       and (
         exists (
           select 1 from bank_statement_lines bsl
            where bsl.org_id = ${orgId} and bsl.account_id = a.id
              and (${statementScope})
              and bsl.posted_on between
                (select starts_on from accounting_periods where id = ${args.periodId} and org_id = ${orgId})
                and ${periodEndsOn}::date
         )
         or exists (
           select 1 from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
            where jl.org_id = ${orgId} and jl.account_id = a.id and coalesce(jl.period_id, je.period_id) = ${args.periodId}
              and je.book_id = ${args.bookId} and je.status in ('posted','reversed') and (${lineScope})
              and ${excludePeriodEndJournals(sql`je.origin`)}
         )
         or exists (
           select 1 from journal_lines jl
           join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           join accounting_periods jp on jp.id = coalesce(jl.period_id, je.period_id) and jp.org_id = je.org_id
            where jl.org_id = ${orgId} and jl.account_id = a.id and je.book_id = ${args.bookId}
              and je.status in ('posted','reversed') and jp.ends_on <= ${periodEndsOn}
              and ${excludePeriodEndJournals(sql`je.origin`)}
              and (${lineScope})
            group by jl.subsidiary_id having sum(jl.amount) <> 0
         )
       )
     order by a.number nulls last, a.name
  `,
    "objects",
  );
}

export async function bankingCloseStatus(
  orgId: string,
  args: { periodId: string; bookId: string; subsidiaryId?: string; actorId: string },
): Promise<BankingCloseAccountStatus[]> {
  const period = (
    await db.execute<{ ends_on: string }>(
      sql`
    select ends_on::text as ends_on from accounting_periods
     where id = ${args.periodId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!period) throw new CloseError("period not found");
  const accounts = await bankingClosePopulation(orgId, args, period.ends_on);
  const sourceEvidenceOn = await sourceEvidencePolicyActive(orgId);
  // The route already enforced the operator's subsidiary scope; the session
  // readers below run unrestricted so shared (null-subsidiary) accounts —
  // visible only to unrestricted callers — resolve instead of refusing.
  const ctx: BankingContext = {
    orgId,
    userId: args.actorId,
    allowedSubsidiaryIds: null,
  };
  const statuses: BankingCloseAccountStatus[] = [];
  for (const account of accounts) {
    const covering = (
      await db.execute<{ id: string; through_date: string }>(
        sql`
      select id, through_date::text as through_date from reconciliations
       where org_id = ${orgId} and account_id = ${account.id} and status = 'signed_off'
         and through_date >= ${period.ends_on}::date
         and (${sourceEvidenceOn} or evidence_kind = 'statement')
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (covering) {
      const staleness = await reconciliationStaleness(covering.id, ctx);
      statuses.push({
        accountId: account.id,
        number: account.number,
        name: account.name,
        status: "signed_off",
        throughDate: covering.through_date,
        difference: null,
        stale: staleness.stale,
        staleSince: staleness.staleSince,
        clearedEffect: staleness.stale ? staleness.clearedEffect : null,
      });
      continue;
    }
    const open = (
      await db.execute<{ id: string; through_date: string }>(
        sql`
      select id, through_date::text as through_date from reconciliations
       where org_id = ${orgId} and account_id = ${account.id} and status <> 'signed_off'
         and through_date <= ${period.ends_on}::date
       order by through_date desc limit 1
    `,
        "objects",
      )
    )[0];
    if (!open) {
      statuses.push({
        accountId: account.id,
        number: account.number,
        name: account.name,
        status: "none",
        throughDate: null,
        difference: null,
        stale: false,
        staleSince: null,
        clearedEffect: null,
      });
      continue;
    }
    const totals = await reconciliationTotals(open.id, ctx);
    statuses.push({
      accountId: account.id,
      number: account.number,
      name: account.name,
      status: "in_progress",
      throughDate: open.through_date,
      difference: totals.difference,
      stale: false,
      staleSince: null,
      clearedEffect: null,
    });
  }
  return statuses;
}

/**
 * Statement lines still needing a match on the close population: posted in
 * the period, on a governed account, never matched or excluded. Read over
 * the same population as the status check so the close confirm names one
 * consistent set of books.
 */
export async function bankingUnmatchedStatementLines(
  orgId: string,
  args: { periodId: string; bookId: string; subsidiaryId?: string },
): Promise<number> {
  const period = (
    await db.execute<{ starts_on: string; ends_on: string }>(
      sql`
    select starts_on::text as starts_on, ends_on::text as ends_on from accounting_periods
     where id = ${args.periodId} and org_id = ${orgId}
  `,
      "objects",
    )
  )[0];
  if (!period) throw new CloseError("period not found");
  const population = await bankingClosePopulation(orgId, args, period.ends_on);
  if (population.length === 0) return 0;
  const ids = population.map((account) => account.id);
  const unmatched = await db.execute<{ n: string }>(
    sql`
    select count(*)::text as n from bank_statement_lines
     where org_id = ${orgId} and account_id = any(${`{${ids.join(",")}}`}::uuid[])
       and match_status = 'unmatched'
       and posted_on between ${period.starts_on}::date and ${period.ends_on}::date`,
    "objects",
  );
  return Number(unmatched[0]?.n ?? 0);
}

async function bankingStrictPolicy(orgId: string): Promise<boolean> {
  const policy = (
    await db.execute<{ rules: { requireSignedReconciliation?: boolean } | null }>(
      sql`
    select rules from close_policies
     where org_id = ${orgId} and code = ${BANK_SIGNED_RECONCILIATION_POLICY_CODE} and is_active
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!policy) return false;
  return policy.rules?.requireSignedReconciliation !== false;
}

/**
 * Gate a Banking module close for one period. Every account's status is
 * always computed so the caller can show it; when any account is not
 * cleanly signed off the close either refuses (strict org policy) or
 * requires an explicit acknowledgement reason (warn by default), which the
 * caller audits on the close event.
 */
export async function evaluateBankingModuleClose(
  orgId: string,
  args: {
    periodId: string;
    bookId: string;
    subsidiaryId?: string;
    actorId: string;
    acknowledgement?: string | null;
  },
): Promise<BankingCloseEvaluation> {
  const accounts = await bankingCloseStatus(orgId, args);
  const issues = accounts.filter((account) => account.status !== "signed_off" || account.stale);
  const strict = issues.length > 0 ? await bankingStrictPolicy(orgId) : false;
  if (issues.length === 0) return { accounts, issues, strict: false };
  const listed = issues.map(accountLabel).join("; ");
  if (strict) {
    throw new CloseError(
      `cannot close Banking: ${listed}; sign off each account's reconciliation through the period and close again`,
    );
  }
  const acknowledgement = args.acknowledgement?.trim() ?? "";
  if (acknowledgement.length < 10 || acknowledgement.length > 2000) {
    throw new CloseError(
      `closing Banking with unsigned bank reconciliations requires an explicit acknowledgement reason: ${listed}; close again with an acknowledgement that names these accounts`,
    );
  }
  return { accounts, issues, strict };
}

/**
 * Audit a Banking module close that proceeded with unsigned or stale
 * reconciliations: the per-account statuses and the operator's
 * acknowledgement join the close event stream alongside the lock change.
 */
export async function auditBankingModuleClose(
  orgId: string,
  args: {
    periodId: string;
    bookId: string;
    subsidiaryId?: string;
    actorId: string;
    reason: string;
    acknowledgement: string;
    evaluation: BankingCloseEvaluation;
  },
): Promise<void> {
  await db.execute(sql`
    insert into close_events (org_id, event_type, actor_id, payload)
    values (${orgId}, 'period.banking_close_acknowledged', ${args.actorId},
            ${JSON.stringify({
              periodId: args.periodId,
              bookId: args.bookId,
              subsidiaryId: args.subsidiaryId ?? null,
              reason: args.reason,
              acknowledgement: args.acknowledgement,
              strict: args.evaluation.strict,
              accounts: args.evaluation.accounts.map((account) => ({
                accountId: account.accountId,
                number: account.number,
                name: account.name,
                status: account.status,
                throughDate: account.throughDate,
                difference: account.difference,
                stale: account.stale,
                staleSince: account.staleSince,
                clearedEffect: account.clearedEffect,
              })),
            })}::jsonb)`);
}
