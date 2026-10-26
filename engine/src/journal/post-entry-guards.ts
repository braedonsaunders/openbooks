import { sql } from "drizzle-orm";
import { normalizeDecimal, normalizeMoney } from "../money/money.ts";
import { assertEntityPostingDate } from "../organization/accounting-preferences.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import {
  assertPeriodModulesOpen,
  canonicalPeriodLabel,
  CloseError,
  periodClosedDetailsOf,
} from "../periods/period-policy.ts";
import type { SqlExecutor } from "../platform/db.ts";
import type { BookProfile } from "./book-basis.ts";
import { LedgerPostError, fail } from "./ledger-post-error.ts";
import type { PostEntryInput, PostEntryLineInput } from "./post-entry.ts";
import { findLiveReplayAuthorization } from "./replay-authorization.ts";

/** A validated line with its entry-level defaults applied. */
export type PreparedLine = PostEntryLineInput & {
  subsidiaryId: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  lineNumber: number;
  /** Whether the caller stated the transaction amount and rate itself. */
  fxStated: boolean;
};

/** The admitted closed-period replay, cited in the posting audit. */
export interface ReplayEvidence {
  authorizationId: string;
  connectionId: string;
}

/** The book belongs to this organization and posts GL; its row is share-locked through commit. */
export async function lockPostingBook(
  executor: SqlExecutor,
  input: PostEntryInput,
): Promise<BookProfile> {
  const row = (
    await executor.execute<{
      id: string;
      code: string;
      name: string;
      is_primary: boolean;
      replication_mode: "adjustment_only" | "full";
      replication_from: string | null;
      currency_difference_account_id: string | null;
    }>(
      sql`
        select id, code, name, is_primary, replication_mode, replication_from::text as replication_from,
               currency_difference_account_id
          from accounting_books
         where org_id = ${input.orgId} and id = ${input.bookId} and is_active and posts_gl
         for share`,
      "objects",
    )
  )[0];
  if (!row)
    fail(
      `journal entry ${input.entryNumber}: book ${input.bookId} is not an active posting book of this organization`,
    );
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isPrimary: row.is_primary,
    replicationMode: row.replication_mode,
    replicationFrom: row.replication_from,
    currencyDifferenceAccountId: row.currency_difference_account_id,
  };
}

/**
 * Proves the period belongs to this organization, moves it onto the entity's effective fiscal
 * calendar when the requested period belongs to another, and proves the date falls inside it.
 */
export async function resolveEntityPeriod(
  executor: SqlExecutor,
  input: PostEntryInput,
): Promise<PostEntryInput> {
  const period = (
    await executor.execute<{
      is_adjustment: boolean;
      fiscal_year: number;
      window_start: string;
      window_end: string;
    }>(
      sql`
        select is_adjustment, fiscal_year,
               window_start::text as window_start, window_end::text as window_end
          from accounting_period_posting_window(${input.orgId}, ${input.periodId})`,
      "objects",
    )
  )[0];
  if (!period)
    fail(
      `journal entry ${input.entryNumber}: accounting period ${input.periodId} does not exist in this organization`,
    );
  // An adjustment period is one fiscal year's close bucket; the storage guard
  // je_adjustment_period_date enforces the same window.
  if (
    period.is_adjustment &&
    (input.postingDate < period.window_start || input.postingDate > period.window_end)
  )
    fail(
      `journal entry ${input.entryNumber}: adjustment period ${canonicalPeriodLabel({ fiscalYear: period.fiscal_year, periodNumber: 0, adjustment: true })} takes postings dated inside fiscal year ${period.fiscal_year} (${period.window_start} to ${period.window_end}), not ${input.postingDate} — date the entry inside that year or post it to the period that covers ${input.postingDate}`,
    );

  const resolved = await entityCalendarPeriod(executor, input, period.is_adjustment);
  const window = (
    await executor.execute<{ window_start: string; window_end: string }>(
      sql`
        select window_start::text as window_start, window_end::text as window_end
          from accounting_period_posting_window(${resolved.orgId}, ${resolved.periodId})`,
      "objects",
    )
  )[0];
  if (
    !window ||
    resolved.postingDate < window.window_start ||
    resolved.postingDate > window.window_end
  ) {
    fail(
      `journal entry ${resolved.entryNumber}: posting date must fall within its accounting period — choose the period covering ${resolved.postingDate}`,
    );
  }
  return resolved;
}

async function entityCalendarPeriod(
  executor: SqlExecutor,
  input: PostEntryInput,
  isAdjustment: boolean,
): Promise<PostEntryInput> {
  const { orgId } = input;
  const basis = (
    await executor.execute<{ calendar: string | null; provided: string; historical: boolean }>(
      sql`
        select public.subsidiary_posting_calendar(${orgId}, ${input.subsidiaryId}, ${input.postingDate}::date) as calendar,
               p.fiscal_calendar_id as provided, public.connector_historical_replay_authorized(${orgId}) as historical
          from accounting_periods p where p.org_id = ${orgId} and p.id = ${input.periodId}`,
      "objects",
    )
  )[0];
  if (basis?.historical || basis?.calendar === basis?.provided) return input;
  if (isAdjustment)
    fail(
      "An adjustment period must belong to the entity's effective fiscal calendar. Choose its own adjustment period.",
    );
  const entityPeriod = await resolveCoveringPeriod(
    executor,
    orgId,
    input.postingDate,
    input.subsidiaryId,
  );
  if (!entityPeriod)
    fail(
      "No entity accounting period covers this posting date. Generate that calendar's periods before posting.",
    );
  return {
    ...input,
    periodId: entityPeriod.id,
    auditChanges: {
      ...input.auditChanges,
      entityCalendarResolution: { requestedPeriodId: input.periodId, periodId: entityPeriod.id },
    },
  };
}

/** A reversal's target is row-locked through commit; a source document must exist. */
export async function assertReferencedRecords(
  executor: SqlExecutor,
  input: PostEntryInput,
): Promise<void> {
  const { orgId } = input;
  if (input.reversesEntryId) {
    const target = (
      await executor.execute<{ id: string; status: string; book_id: string }>(
        sql`
          select id, status, book_id from journal_entries
           where org_id = ${orgId} and id = ${input.reversesEntryId}
           for update`,
        "objects",
      )
    )[0];
    if (!target)
      fail(
        `journal entry ${input.entryNumber}: reversed entry ${input.reversesEntryId} does not exist in this organization`,
      );
    if (target.status !== "posted")
      fail(
        `journal entry ${input.entryNumber}: only a posted entry can be reversed; preserve existing reversal history`,
      );
    const existingReversal = (
      await executor.execute<{ id: string }>(
        sql`
          select id from journal_entries where org_id = ${orgId} and reverses_entry_id = ${input.reversesEntryId}
             and status in ('posted', 'reversed') limit 1`,
        "objects",
      )
    )[0];
    if (existingReversal)
      fail(
        `journal entry ${input.entryNumber}: this target already has a retained reversal; correct through the existing reversal chain instead of reversing it again`,
      );
    if (target.book_id !== input.bookId)
      fail(
        `journal entry ${input.entryNumber}: a reversal must remain in the original accounting book`,
      );
  }

  if (input.sourceDocumentId) {
    const source = (
      await executor.execute<{ id: string }>(
        sql`
          select id from documents
           where org_id = ${orgId} and id = ${input.sourceDocumentId}
           limit 1`,
        "objects",
      )
    )[0];
    if (!source)
      fail(
        `journal entry ${input.entryNumber}: source document ${input.sourceDocumentId} does not exist in this organization`,
      );
  }
}

/**
 * Whether this transaction carries the connector historical replay token, as the database
 * validates it (active sync run, owning connection, automatic policy) — never the caller's claim.
 */
export async function connectorReplayAuthorized(
  executor: SqlExecutor,
  orgId: string,
): Promise<boolean> {
  const row = (
    await executor.execute<{ allowed: boolean }>(
      sql`select connector_historical_replay_authorized(${orgId}) as allowed`,
      "objects",
    )
  )[0];
  return row?.allowed === true;
}

/**
 * Every leg references a subsidiary of this organization, and a leg in a currency other than its
 * measurement currency states its own amount and rate. Returns the entry's subsidiaries.
 */
export async function assertLegSubsidiaries(
  executor: SqlExecutor,
  input: PostEntryInput,
  lines: readonly PreparedLine[],
  bookCurrencyBySub: ReadonlyMap<string, string>,
): Promise<string[]> {
  const subsidiaryIds = [
    ...new Set([input.subsidiaryId, ...lines.map((line) => line.subsidiaryId)]),
  ];
  const foundSubs = await executor.execute<{ id: string; base_currency: string }>(
    sql`
      select id, base_currency from subsidiaries
       where org_id = ${input.orgId} and id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`,
    "objects",
  );
  if (foundSubs.length !== subsidiaryIds.length) {
    const found = new Set(foundSubs.map((row) => row.id));
    const missing = subsidiaryIds.find((id) => !found.has(id));
    fail(
      `journal entry ${input.entryNumber}: subsidiary ${missing} does not exist in this organization`,
    );
  }
  // Defaulting a foreign leg to its base amount at rate 1 would fabricate an exposure that
  // revaluation then remeasures. A non-primary book measures in its own currency per subsidiary.
  const functionalBySub = new Map(
    foundSubs.map((row) => [row.id, bookCurrencyBySub.get(row.id) ?? row.base_currency]),
  );
  for (const line of lines) {
    const functional = functionalBySub.get(line.subsidiaryId);
    if (functional && line.currency !== functional && !line.fxStated)
      fail(
        `journal entry ${input.entryNumber} line ${line.lineNumber}: ${line.currency} differs from the subsidiary's functional currency ${functional} — supply the transaction amount and the exchange rate for this line`,
      );
  }
  return subsidiaryIds;
}

/**
 * Every leg posts to an existing, active, non-summary account of this organization whose
 * currency restriction it honors: the jl_check_account storage rules, refused here by name.
 */
export async function assertLegAccounts(
  executor: SqlExecutor,
  input: PostEntryInput,
  lines: readonly PreparedLine[],
): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  const accounts = await executor.execute<{
    id: string;
    is_active: boolean;
    is_summary: boolean;
    currency_restriction: string | null;
    type: string;
  }>(
    sql`
      select id, is_active, is_summary, currency_restriction, type from accounts
       where org_id = ${input.orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])
       for share`,
    "objects",
  );
  const byAccount = new Map(accounts.map((row) => [row.id, row]));
  for (const line of lines) {
    const account = byAccount.get(line.accountId);
    if (!account)
      fail(
        `journal entry ${input.entryNumber}: account ${line.accountId} does not exist in this organization`,
      );
    if (account.is_summary)
      fail(
        `journal entry ${input.entryNumber}: account ${line.accountId} is a summary account and cannot be posted to`,
      );
    if (!account.is_active && !input.allowInactiveAccounts)
      fail(`journal entry ${input.entryNumber}: account ${line.accountId} is inactive`);
    if (account.type === "statistical") assertStatisticalLeg(input, line);
    if (account.currency_restriction && line.currency !== account.currency_restriction)
      fail(
        `journal entry ${input.entryNumber}: account ${line.accountId} only accepts ${account.currency_restriction} postings`,
      );
  }
}

function assertStatisticalLeg(input: PostEntryInput, line: PreparedLine): void {
  const quantity = line.quantity?.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (
    normalizeMoney(line.amount) !== "0.0000" ||
    normalizeMoney(line.txnAmount) !== "0.0000" ||
    !quantity ||
    !/^-?\d+(?:\.\d{1,4})?$/.test(quantity) ||
    normalizeDecimal(quantity, 4) === "0.0000" ||
    !line.unit?.trim() ||
    line.isOpenItem ||
    line.isCurrencyAdjustment
  ) {
    fail(
      `journal entry ${input.entryNumber}: statistical account ${line.accountId} requires a nonzero quantity with at most four decimal places, a unit, zero money and no open item`,
    );
  }
}

/**
 * The entity posting dates and close modules admit the posting. Under connector replay a closed
 * period opens only with a live controller-recorded authorization covering it, returned as
 * evidence; the flag alone never opens a period.
 */
export async function assertPostingPeriodOpen(
  executor: SqlExecutor,
  input: PostEntryInput,
  subsidiaryIds: readonly string[],
  replayAuthorized: boolean,
): Promise<ReplayEvidence | null> {
  const scope = {
    orgId: input.orgId,
    periodId: input.periodId,
    bookId: input.bookId,
    subsidiaryIds: [...subsidiaryIds],
    modules: input.closeModules ?? [],
    allowImportedLocks: input.allowImportedLocks,
    reversesEntryId: input.reversesEntryId ?? null,
  };
  if (!replayAuthorized) {
    for (const subsidiaryId of subsidiaryIds) {
      await assertEntityPostingDate(executor, input.orgId, subsidiaryId, input.postingDate);
    }
    try {
      await assertPeriodModulesOpen(executor, scope);
    } catch (error) {
      if (error instanceof CloseError)
        throw new LedgerPostError(`journal entry ${input.entryNumber}: ${error.message}`, {
          details: periodClosedDetailsOf(error),
        });
      throw error;
    }
    return null;
  }
  try {
    await assertPeriodModulesOpen(executor, scope);
    return null;
  } catch (error) {
    if (!(error instanceof CloseError)) throw error;
  }
  const authorization = await findLiveReplayAuthorization(executor, {
    orgId: input.orgId,
    periodId: input.periodId,
  });
  if (!authorization)
    fail(
      `journal entry ${input.entryNumber}: closed-period connector replay is not covered by a replay authorization for this connector and period — have a controller record a connector replay authorization (connector, covered period range, expiry, reason) and retry`,
    );
  if (authorization.expiresAt <= new Date())
    fail(
      `journal entry ${input.entryNumber}: connector replay authorization ${authorization.id} expired at ${authorization.expiresAt.toISOString()} — have a controller record a fresh authorization and retry`,
    );
  return { authorizationId: authorization.id, connectionId: authorization.connectionId };
}

/**
 * Points the je_guard closed-period branch at the authorization this replay was admitted
 * against; the setting is transaction-local and dies with the transaction.
 */
export async function pointReplayAuthorization(
  executor: SqlExecutor,
  evidence: ReplayEvidence,
): Promise<void> {
  await executor.execute(sql`
    select set_config('openbooks.connector_replay_authorization', ${evidence.authorizationId}, true)`);
}
