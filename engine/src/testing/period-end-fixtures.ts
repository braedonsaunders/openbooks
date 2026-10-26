import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { closePeriodAllModules } from "../periods/period-locks.ts";
import type { ScratchOrg } from "./fixtures.ts";

/**
 * A scratch fiscal year for period-end journal suites: the twelve monthly
 * periods of FY2026 on the scratch calendar (July already exists), December
 * 2025 for an earlier year left unclosed, January 2027 for the opening
 * journal, equity accounts for retained earnings and the income summary, and
 * the feature switched on. Ledger activity is posted through the kernel.
 */
export interface PeriodEndYear {
  calendarId: string;
  periods: Map<string, string>;
  retainedEarningsId: string;
  incomeSummaryId: string;
  capitalId: string;
  rentId: string;
}

export async function seedPeriodEndYear(org: ScratchOrg): Promise<PeriodEndYear> {
  const calendarId = (
    await db.execute<{ fiscal_calendar_id: string }>(
      sql`
    select fiscal_calendar_id from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`,
      "objects",
    )
  )[0]!.fiscal_calendar_id;
  const periods = new Map<string, string>([["2026-07", org.periodId]]);
  const month = async (year: number, number: number, fiscalYear: number, periodNumber: number) => {
    const key = `${year}-${String(number).padStart(2, "0")}`;
    if (periods.has(key)) return;
    const id = randomUUID();
    const starts = `${key}-01`;
    const ends = (
      await db.execute<{ ends: string }>(
        sql`
      select ((${starts}::date + interval '1 month') - interval '1 day')::date::text as ends`,
        "objects",
      )
    )[0]!.ends;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${id}, ${org.orgId}, ${fiscalYear}, ${periodNumber}, ${key}, ${starts}, ${ends}, false, ${calendarId})`);
    periods.set(key, id);
  };
  await month(2025, 12, 2025, 12);
  for (let number = 1; number <= 12; number++) await month(2026, number, 2026, number);
  await month(2027, 1, 2027, 1);

  const account = async (number: string, name: string, type: string) => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  const retainedEarningsId = await account("3200", "Retained Earnings", "equity");
  const incomeSummaryId = await account("3900", "Income Summary", "equity");
  const capitalId = await account("3100", "Share Capital", "equity");
  const rentId = await account("6100", "Rent", "expense");
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"periodEndJournals": true, "continuousClose": true}'::jsonb)
     where id = ${org.orgId}`);
  return { calendarId, periods, retainedEarningsId, incomeSummaryId, capitalId, rentId };
}

let sequence = 0;

/** Post a balanced manual-origin entry through the kernel for the scratch entity. */
export async function postScratchEntry(
  org: ScratchOrg,
  args: {
    actorId: string;
    periodId: string;
    date: string;
    lines: [accountId: string, amount: string][];
    subsidiaryId?: string;
  },
): Promise<string> {
  sequence += 1;
  const posted = await postEntry(db, {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: args.subsidiaryId ?? org.subsidiaryId,
    entryNumber: `PEJ-TEST-${Date.now()}-${sequence}`,
    postingDate: args.date,
    periodId: args.periodId,
    memo: "period-end fixture",
    origin: "manual",
    actorId: args.actorId,
    currency: "CAD",
    lines: args.lines.map(([accountId, amount]) => ({ accountId, amount })),
  });
  return posted.entryId;
}

/** Hard-close every module of the given periods for the whole organization. */
export async function closeScratchPeriods(
  org: ScratchOrg,
  actorId: string,
  periodIds: readonly string[],
): Promise<void> {
  for (const periodId of periodIds) {
    const { results } = await closePeriodAllModules({
      orgId: org.orgId,
      periodId,
      bookId: org.bookId,
      actorId,
      reason: "Closed for the year-end fixture",
    });
    const failed = results.find((result) => !result.ok);
    if (failed) throw new Error(`could not close period ${periodId}: ${failed.error}`);
  }
}

/** Record a period-end journal policy version. */
export async function recordPeriodEndPolicy(
  org: ScratchOrg,
  year: PeriodEndYear,
  args: {
    actorId: string;
    effectiveFrom?: string;
    incomeSummary?: boolean;
    balanceSheetJournals?: boolean;
  },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into period_end_journal_policies
      (id, org_id, effective_from, closing_method, retained_earnings_account_id, income_summary_account_id,
       balance_sheet_journals, posting_period, reason, created_by, updated_by)
    values (${id}, ${org.orgId}, ${args.effectiveFrom ?? "2026-01-01"},
            ${args.incomeSummary ? "income_summary" : "retained_earnings"}, ${year.retainedEarningsId},
            ${args.incomeSummary ? year.incomeSummaryId : null}, ${args.balanceSheetJournals ?? false},
            'last_period', 'Statutory year-end closing entries', ${args.actorId}, ${args.actorId})`);
  return id;
}

/**
 * The scratch year's standard activity: share capital, revenue, rent and cost
 * of sales across FY2026, plus revenue in December 2025 that no earlier
 * closing ever closed.
 */
export async function postScratchYearActivity(
  org: ScratchOrg,
  year: PeriodEndYear,
  actorId: string,
): Promise<void> {
  const period = (key: string) => year.periods.get(key)!;
  await postScratchEntry(org, {
    actorId,
    periodId: period("2025-12"),
    date: "2025-12-15",
    lines: [
      [org.accounts.bank, "50.0000"],
      [org.accounts.revenue, "-50.0000"],
    ],
  });
  await postScratchEntry(org, {
    actorId,
    periodId: period("2026-01"),
    date: "2026-01-02",
    lines: [
      [org.accounts.bank, "5000.0000"],
      [year.capitalId, "-5000.0000"],
    ],
  });
  await postScratchEntry(org, {
    actorId,
    periodId: period("2026-03"),
    date: "2026-03-10",
    lines: [
      [org.accounts.bank, "1000.2500"],
      [org.accounts.revenue, "-1000.2500"],
    ],
  });
  await postScratchEntry(org, {
    actorId,
    periodId: period("2026-07"),
    date: "2026-07-15",
    lines: [
      [year.rentId, "400.1000"],
      [org.accounts.bank, "-400.1000"],
    ],
  });
  await postScratchEntry(org, {
    actorId,
    periodId: period("2026-12"),
    date: "2026-12-20",
    lines: [
      [org.accounts.cogs, "100.0500"],
      [org.accounts.bank, "-100.0500"],
    ],
  });
}

/** Signed balance of each account for the scratch entity through a date, period-assignment basis. */
export async function balancesThrough(
  org: ScratchOrg,
  endsOn: string,
  subsidiaryId?: string,
): Promise<Map<string, string>> {
  const rows = await db.execute<{ account_id: string; amount: string }>(
    sql`
    select l.account_id, sum(l.amount)::text as amount
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
     where l.org_id = ${org.orgId} and l.subsidiary_id = ${subsidiaryId ?? org.subsidiaryId}
       and e.book_id = ${org.bookId} and e.status in ('posted', 'reversed') and p.ends_on <= ${endsOn}::date
     group by l.account_id`,
    "objects",
  );
  return new Map(rows.map((row) => [row.account_id, row.amount]));
}
