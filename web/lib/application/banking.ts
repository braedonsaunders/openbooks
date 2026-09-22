import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  BankingError,
  createMatch,
  markReconciled,
  reconciliationTotals,
  startReconciliation,
  unmatchStatementLine,
} from "@openbooks/engine/src/banking/banking.ts";
import { ControlAccountsIncompleteError } from "@openbooks/engine/src/records/control-accounts.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { PostingError } from "@openbooks/engine/src/ledger/posting-contracts.ts";
import { addJournalMatchFromLine } from "../banking-rules";
import { normalizeMoneyValue } from "../cash/core";
import { canonicalDecimal } from "../exact-decimal";
import { isFeatureEnabled } from "../features";
import { clamp, isUuid } from "../list-params";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { executeIdempotent } from "./idempotency";

/**
 * Governed banking actions for the application catalog (chat, MCP, API).
 * Every mutation terminates in the engine/banking-rules service the banking
 * routes call (`startReconciliation`, `createMatch`, `addJournalMatchFromLine`,
 * `unmatchStatementLine`, `markReconciled`) — never a parallel SQL path to
 * the same rows. Permission (`banking.reconcile`), feature (`banking`), and
 * tenant scoping (the reconciliation/account's subsidiary, matching the
 * subsidiary filter the banking read tools apply) are enforced here so every
 * adapter inherits them.
 */

function bankingFailure(error: unknown): never {
  if (
    error instanceof BankingError
    || error instanceof PostingError
    || error instanceof ControlAccountsIncompleteError
  ) {
    // Controlled operator feedback, mirroring bankingErrorResponse (422).
    throw new ApplicationError("invalid_input", error.message, 422);
  }
  throw error;
}

async function requireBankingFeature(orgId: string): Promise<void> {
  // The routes 404 through guardFeaturePermission when the module is off.
  if (!(await isFeatureEnabled(orgId, "banking"))) throw notFound("banking");
}

/** The subsidiary that owns an account; restricted callers fail closed on null. */
async function accountSubsidiary(orgId: string, accountId: string): Promise<string | null> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from accounts
     where id = ${accountId} and org_id = ${orgId}
  `)).rows[0];
  if (!row) throw notFound("account");
  return row.subsidiaryId;
}

/** The subsidiary that owns a reconciliation session, via its account. */
async function reconciliationSubsidiary(orgId: string, reconciliationId: string): Promise<string | null> {
  const row = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select a.subsidiary_id as "subsidiaryId"
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.id = ${reconciliationId} and r.org_id = ${orgId}
  `)).rows[0];
  if (!row) throw notFound("reconciliation");
  return row.subsidiaryId;
}

function bankingContext(context: ApplicationContext): { orgId: string; userId: string } {
  return { orgId: context.authz.user.orgId, userId: context.authz.user.id };
}

/** Reconciliation sessions — same query shape as `list_bank_reconciliations`. */
export async function listApplicationReconciliations(
  context: ApplicationContext,
  input: { accountId?: string; limit?: number },
) {
  assertApplicationPermission(context, "banking.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "banking"))) {
    throw new ApplicationError(
      "not_found",
      "banking is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.account_id, r.through_date, r.statement_balance::text as statement_balance,
           r.status, r.signed_off_at, r.created_at,
           a.number as account_number, a.name as account_name
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.org_id = ${context.authz.user.orgId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, context.authz.allowedSubsidiaryIds)}
       ${input.accountId ? sql` and r.account_id = ${input.accountId}` : sql``}
     order by r.created_at desc
     limit ${limit}
  `)).rows;
  return {
    reconciliations: rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountNumber: row.account_number,
      accountName: row.account_name,
      throughDate: row.through_date,
      statementBalance: normalizeMoneyValue(String(row.statement_balance ?? "0")),
      status: row.status,
      signedOffAt: row.signed_off_at,
      createdAt: row.created_at,
    })),
  };
}

function bankingFeatureOff(): never {
  throw new ApplicationError(
    "not_found",
    "banking is off; enable it from GET /api/v1/settings/features",
    404,
  );
}

/** One session's workspace/sign-off totals — same `reconciliationTotals` reader as `get_bank_reconciliation`. */
export async function getApplicationReconciliation(context: ApplicationContext, reconciliationId: string) {
  assertApplicationPermission(context, "banking.read");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "banking"))) bankingFeatureOff();
  if (!isUuid(reconciliationId)) throw invalidInput("reconciliation id must be a UUID");
  const row = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.account_id, r.through_date, r.status, r.signed_off_at, r.created_at,
           a.number as account_number, a.name as account_name
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.org_id = ${context.authz.user.orgId} and r.id = ${reconciliationId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, context.authz.allowedSubsidiaryIds)}
  `)).rows[0];
  if (!row) throw notFound("reconciliation");
  const totals = await reconciliationTotals(reconciliationId, bankingContext(context));
  return {
    id: row.id,
    accountId: row.account_id,
    accountNumber: row.account_number,
    accountName: row.account_name,
    throughDate: row.through_date,
    status: row.status,
    signedOffAt: row.signed_off_at,
    createdAt: row.created_at,
    statementBalance: normalizeMoneyValue(String(totals.statementBalance)),
    clearedBalance: normalizeMoneyValue(String(totals.clearedBalance)),
    difference: normalizeMoneyValue(String(totals.difference)),
    matchedStatementLines: totals.matchedStatementLines,
    unmatchedStatementLines: totals.unmatchedStatementLines,
    matchedJournalLines: totals.matchedJournalLines,
  };
}

/** Unmatched imported lines — same query shape as `list_unmatched_bank_lines`. */
export async function listApplicationUnmatchedBankLines(
  context: ApplicationContext,
  input: { accountId?: string; limit?: number },
) {
  assertApplicationPermission(context, "banking.reconcile");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "banking"))) bankingFeatureOff();
  if (input.accountId && !isUuid(input.accountId)) throw invalidInput("accountId must be a UUID");
  const limit = clamp(input.limit ?? 50, 1, 200);
  const where = sql`l.org_id = ${context.authz.user.orgId} and l.match_status = 'unmatched'
    ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, context.authz.allowedSubsidiaryIds)}
    ${input.accountId ? sql` and l.account_id = ${input.accountId}` : sql``}`;
  const [rows, count] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select l.id, l.posted_on, l.amount::text as amount, l.description, l.counterparty_ref,
             l.account_id, a.number as account_number, a.name as account_name
        from bank_statement_lines l
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where ${where}
       order by l.posted_on desc, l.line_number
       limit ${limit}
    `),
    db.execute<{ n: string }>(sql`
      select count(*) as n
        from bank_statement_lines l
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where ${where}
    `),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    lines: rows.rows.map((line) => ({
      id: line.id,
      date: line.posted_on,
      description: line.description,
      counterpartyRef: line.counterparty_ref,
      amount: normalizeMoneyValue(String(line.amount ?? "0")),
      accountId: line.account_id,
      accountNumber: line.account_number,
      accountName: line.account_name,
    })),
  };
}

/** Bank feed connections — never selects sealed credentials. */
export async function listApplicationBankFeeds(context: ApplicationContext) {
  assertApplicationPermission(context, "admin.setup.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "bankFeeds"))) {
    throw new ApplicationError(
      "not_found",
      "bankFeeds is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select c.id, c.name, c.provider, c.account_id, c.status,
           c.external_account_id, c.sync_cadence,
           c.next_sync_at, c.last_sync_at, c.last_attempt_at, c.last_result, c.last_error, c.is_active,
           (c.credentials is not null) as has_credentials,
           a.number as account_number, a.name as account_name
      from bank_feed_connections c
      join accounts a on a.id = c.account_id and a.org_id = c.org_id
     where c.org_id = ${context.authz.user.orgId}
     order by c.created_at desc
     limit 200
  `)).rows;
  return {
    connections: rows.map((row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      accountId: row.account_id,
      accountNumber: row.account_number,
      accountName: row.account_name,
      status: row.status,
      externalAccountId: row.external_account_id,
      syncCadence: row.sync_cadence,
      nextSyncAt: row.next_sync_at,
      lastSyncAt: row.last_sync_at,
      lastAttemptAt: row.last_attempt_at,
      lastResult: row.last_result,
      lastError: row.last_error,
      isActive: row.is_active,
      hasCredentials: row.has_credentials,
    })),
  };
}

export async function startReconciliationSession(context: ApplicationContext, input: {
  accountId: string;
  throughDate: string;
  statementBalance: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: { reconciliationId: string } }> {
  assertApplicationPermission(context, "banking.reconcile");
  await requireBankingFeature(context.authz.user.orgId);
  assertSubsidiaryAccess(context, await accountSubsidiary(context.authz.user.orgId, input.accountId));
  // Same exact-decimal normalization the POST /api/banking/reconciliations
  // route applies before calling the engine.
  const raw = canonicalDecimal(input.statementBalance, 4);
  if (raw === null) throw invalidInput("statementBalance must be an exact decimal");
  let statementBalance: string;
  try {
    statementBalance = normalizeMoney(raw);
  } catch {
    throw invalidInput("statementBalance must be an exact decimal");
  }
  const outcome = await executeIdempotent({
    context,
    operation: "banking.reconciliation.start",
    idempotencyKey: input.idempotencyKey,
    request: { accountId: input.accountId, throughDate: input.throughDate, statementBalance },
    execute: async () => {
      try {
        const { id } = await startReconciliation(
          { accountId: input.accountId, throughDate: input.throughDate, statementBalance },
          bankingContext(context),
        );
        return { reconciliationId: id };
      } catch (error) {
        bankingFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function matchStatementLine(context: ApplicationContext, input: {
  reconciliationId: string;
  statementLineId: string;
  journalLineIds: string[];
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "banking.reconcile");
  await requireBankingFeature(context.authz.user.orgId);
  assertSubsidiaryAccess(context, await reconciliationSubsidiary(context.authz.user.orgId, input.reconciliationId));
  const outcome = await executeIdempotent({
    context,
    operation: "banking.statement_line.match",
    idempotencyKey: input.idempotencyKey,
    request: {
      reconciliationId: input.reconciliationId,
      statementLineId: input.statementLineId,
      journalLineIds: input.journalLineIds,
    },
    execute: async () => {
      try {
        const totals = await createMatch(
          {
            reconciliationId: input.reconciliationId,
            statementLineId: input.statementLineId,
            journalLineIds: input.journalLineIds,
          },
          bankingContext(context),
        );
        return { totals };
      } catch (error) {
        bankingFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function matchStatementLineWithJournal(context: ApplicationContext, input: {
  reconciliationId: string;
  statementLineId: string;
  offsetAccountId: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "banking.reconcile");
  await requireBankingFeature(context.authz.user.orgId);
  assertSubsidiaryAccess(context, await reconciliationSubsidiary(context.authz.user.orgId, input.reconciliationId));
  assertSubsidiaryAccess(context, await accountSubsidiary(context.authz.user.orgId, input.offsetAccountId));
  const outcome = await executeIdempotent({
    context,
    operation: "banking.statement_line.match_with_journal",
    idempotencyKey: input.idempotencyKey,
    request: {
      reconciliationId: input.reconciliationId,
      statementLineId: input.statementLineId,
      offsetAccountId: input.offsetAccountId,
    },
    execute: async () => {
      try {
        await addJournalMatchFromLine(context.authz.user.orgId, context.authz.user.id, {
          statementLineId: input.statementLineId,
          offsetAccountId: input.offsetAccountId,
          reconciliationId: input.reconciliationId,
        });
        return { matched: true };
      } catch (error) {
        bankingFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function unmatchStatementLineAction(context: ApplicationContext, input: {
  reconciliationId: string;
  statementLineId: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "banking.reconcile");
  await requireBankingFeature(context.authz.user.orgId);
  assertSubsidiaryAccess(context, await reconciliationSubsidiary(context.authz.user.orgId, input.reconciliationId));
  const outcome = await executeIdempotent({
    context,
    operation: "banking.statement_line.unmatch",
    idempotencyKey: input.idempotencyKey,
    request: { reconciliationId: input.reconciliationId, statementLineId: input.statementLineId },
    execute: async () => {
      try {
        const totals = await unmatchStatementLine(
          { reconciliationId: input.reconciliationId, statementLineId: input.statementLineId },
          bankingContext(context),
        );
        return { totals };
      } catch (error) {
        bankingFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}

export async function signOffReconciliation(context: ApplicationContext, input: {
  reconciliationId: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; result: Record<string, unknown> }> {
  assertApplicationPermission(context, "banking.reconcile");
  await requireBankingFeature(context.authz.user.orgId);
  assertSubsidiaryAccess(context, await reconciliationSubsidiary(context.authz.user.orgId, input.reconciliationId));
  const outcome = await executeIdempotent({
    context,
    operation: "banking.reconciliation.sign_off",
    idempotencyKey: input.idempotencyKey,
    request: { reconciliationId: input.reconciliationId },
    execute: async () => {
      try {
        return await markReconciled(input.reconciliationId, bankingContext(context));
      } catch (error) {
        bankingFailure(error);
      }
    },
  });
  return { replayed: outcome.replayed, result: outcome.value };
}
