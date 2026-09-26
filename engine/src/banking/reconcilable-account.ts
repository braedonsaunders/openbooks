/** Reconcilable-account loading plus scope/lock helpers. Split from banking.ts (pure moves only). */
import { BankingError } from "./banking-core"
export type BankingSqlExecutor = SqlExecutor;
import { assertRealDate } from "./statement-parsers/shared"
import { sql } from "drizzle-orm"
import { db, type SqlExecutor } from "../platform/db.ts"
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts"

type ReconcilableAccount = {
  id: string;
  name: string;
  number: string | null;
  currency: string;
};

export async function loadReconcilableAccount(
  orgId: string,
  accountId: string,
  scope: ReadonlySet<string> | null,
  executor: SqlExecutor = db,
  lock = false,
): Promise<ReconcilableAccount> {
  const r = (await executor.execute<ReconcilableAccount & { subsidiary_id: string | null }>(sql`
    select a.id, a.name, a.number, a.currency_restriction as currency, a.subsidiary_id
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId}
       and a.reconcilable and a.is_active and not a.is_summary
       ${lock ? sql`for update` : sql``}
  `));
  const account = r.rows[0];
  if (!account) throw new BankingError("Account not found or not reconcilable");
  // Scope before eligibility: an out-of-scope account reads exactly like a
  // missing one, never as "exists but ineligible".
  if (!subsidiaryScopeAllows(scope, account.subsidiary_id)) {
    throw new ScopeNotFoundError();
  }
  if (!account.currency) {
    throw new BankingError(
      "Reconcilable accounts require an explicit currency before statement import or reconciliation",
    );
  }
  return account;
}

/** Description normalization for content-overlap comparison (see above). */
export function requireSessionRowInScope<T extends { subsidiary_id: string | null }>(
  row: T | undefined,
  scope: ReadonlySet<string> | null,
): asserts row is T {
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw new ScopeNotFoundError();
  }
}

/**
 * Gate a bank account by its owning subsidiary. Missing and out-of-scope
 * accounts refuse identically through the canonical uniform not-found, so a
 * restricted caller can never distinguish "no such account" from "another
 * entity's account". Exported for the feed sync engine, which re-loads its
 * connection inside the call.
 */
export async function requireBankAccountInScope(
  executor: BankingSqlExecutor,
  orgId: string,
  accountId: string,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const row = (await executor.execute<{ subsidiary_id: string | null }>(sql`
    select a.subsidiary_id
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId}
  `)).rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw new ScopeNotFoundError();
  }
}

/** Lock the account before mutating account-owned statement/reconciliation rows. */
export async function lockBankAccountInScope(
  executor: BankingSqlExecutor,
  orgId: string,
  accountId: string,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const row = (await executor.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from accounts
     where id = ${accountId} and org_id = ${orgId}
     for update
  `)).rows[0];
  requireSessionRowInScope(row, scope);
}

/**
 * Gate a statement line by its bank account's owning subsidiary. Statement
 * lines carry no subsidiary of their own; their account does.
 */
export async function requireStatementLineAccountInScope(
  executor: BankingSqlExecutor,
  orgId: string,
  statementLineId: string,
  scope: ReadonlySet<string> | null,
): Promise<{ account_id: string }> {
  const row = (await executor.execute<{ account_id: string; subsidiary_id: string | null }>(sql`
    select l.account_id, a.subsidiary_id
      from bank_statement_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.id = ${statementLineId} and l.org_id = ${orgId}
  `)).rows[0];
  if (!row || !subsidiaryScopeAllows(scope, row.subsidiary_id)) {
    throw new ScopeNotFoundError();
  }
  return { account_id: row.account_id };
}

export function validateReconciliationDate(value: string): void {
  const match = typeof value === "string" ? value.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!match) throw new BankingError("Through date must be YYYY-MM-DD");
  assertRealDate(match[1]!, match[2]!, match[3]!, "Through date");
}

export async function lockReconciliationAccount(
  executor: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<void> {
  await executor.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`bank-reconciliation:${orgId}:${accountId}`}, 0)
    )
  `);
}

export async function requireCutoffAfterSignedHistory(
  executor: SqlExecutor,
  orgId: string,
  accountId: string,
  throughDate: string,
): Promise<void> {
  const latestSigned = (await executor.execute<{ through_date: string }>(sql`
    select through_date from reconciliations
     where org_id = ${orgId} and account_id = ${accountId} and status = 'signed_off'
     order by through_date desc limit 1
  `)).rows[0];
  if (latestSigned && throughDate <= latestSigned.through_date) {
    throw new BankingError(
      `Through date must be after the last signed-off reconciliation (${latestSigned.through_date})`,
    );
  }
}

/**
 * Start a reconciliation session. One open session per account: a second
 * concurrent session would double-claim the same journal lines.
 */
