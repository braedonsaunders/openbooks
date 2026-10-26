import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { businessTodayInTx } from "../platform/business-date.ts";

export class AccountingPreferenceError extends Error {
  readonly name = "AccountingPreferenceError";
  readonly status = 422;
  constructor(
    message: string,
    readonly remedy: string,
  ) {
    super(message);
  }
}

export interface AccountingPreferences {
  id: string | null;
  fiscalCalendarId: string | null;
  postingRateType: string;
  allowBackdatedPosting: boolean;
  allowFuturePosting: boolean;
  defaultJournalFormId: string | null;
}

/** One effective entity policy; an unconfigured entity retains the native organization defaults. */
export async function accountingPreferences(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  onDate: string,
): Promise<AccountingPreferences> {
  const subsidiary = (
    await runner.execute<{ id: string }>(
      sql`
    select id from subsidiaries where org_id=${orgId} and id=${subsidiaryId}`,
      "objects",
    )
  )[0];
  if (!subsidiary)
    throw new AccountingPreferenceError(
      "The accounting entity is unavailable.",
      "Choose a subsidiary of this organization.",
    );
  const row = (
    await runner.execute<AccountingPreferences & Record<string, unknown>>(
      sql`
    select id, fiscal_calendar_id as "fiscalCalendarId", posting_rate_type as "postingRateType",
           allow_backdated_posting as "allowBackdatedPosting",
           allow_future_posting as "allowFuturePosting", default_journal_form_id as "defaultJournalFormId"
    from subsidiary_accounting_preferences where org_id=${orgId} and subsidiary_id=${subsidiaryId} and effective_from<=${onDate}::date
    order by effective_from desc limit 1`,
      "objects",
    )
  )[0];
  return (
    row ?? {
      id: null,
      fiscalCalendarId: null,
      postingRateType: "spot",
      allowBackdatedPosting: true,
      allowFuturePosting: true,
      defaultJournalFormId: null,
    }
  );
}

export async function assertEntityPostingDate(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  postingDate: string,
): Promise<void> {
  const policy = await accountingPreferences(runner, orgId, subsidiaryId, postingDate);
  if (policy.allowBackdatedPosting && policy.allowFuturePosting) return;
  const today = await businessTodayInTx(runner, orgId);
  if (!policy.allowBackdatedPosting && postingDate < today)
    throw new AccountingPreferenceError(
      "This entity's accounting policy refuses backdated postings.",
      "Use an allowed posting date or record a prospective policy version in Setup → Subsidiary accounting preferences.",
    );
  if (!policy.allowFuturePosting && postingDate > today)
    throw new AccountingPreferenceError(
      "This entity's accounting policy refuses future-dated postings.",
      "Post on the accounting date or record a prospective policy version in Setup → Subsidiary accounting preferences.",
    );
}
