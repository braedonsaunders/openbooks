/**
 * Whether a legal entity's periodic equity postings are current through a
 * date. Two runs post periodically: the stock compensation run (expense and
 * restricted stock releases) and the convertible note interest run. A run is
 * due when no run has reached the date and a run through it would post a
 * change. The close checklist asks this for every legal entity in a close's
 * scope; the equity overview asks it for the entity on screen.
 */
import { sql } from "drizzle-orm";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { canonicalPeriodLabel } from "../periods/period-policy.ts";
import { catalogRefusalOf, type CatalogRefusal } from "../platform/catalog-refusal.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import {
  compensationCatchUp,
  compensationRunChange,
  compensationRunChanges,
} from "./compensation-run.ts";
import { EQUITY_FEATURE_KEY, EquityError } from "./errors.ts";
import { assertEquityReadable, requireEquityReader } from "./internal.ts";
import { interestCatchUp, interestRunChange, interestRunChanges } from "./interest-run.ts";
import { postingPeriodOpen, type RunPeriodAfter } from "./posting.ts";

export interface EquityPostingDue {
  /** A run through the date would post a change no run has posted yet. */
  due: boolean;
  /** The functional-currency change the run would post (expense, or interest). */
  amount: string;
  /** Restricted stock release lines the compensation run would post (zero for interest). */
  releaseLines: number;
  lastRunThrough: string | null;
  currency: string;
  /** A run that cannot be measured (a missing exchange rate, say) is due with its refusal. */
  refusal: CatalogRefusal | null;
  /**
   * Once the runs have reached the date: what was recognized through the
   * last run after it was posted (a backdated grant or issue), which the next
   * run catches up, and the period that run is dated to. It does not hold
   * back the close of a period already run.
   */
  catchUp: EquityCatchUp | null;
}

export interface EquityCatchUp {
  recognizedThrough: string;
  amount: string;
  currency: string;
  /** The period the catching-up run is dated to, and whether it has ended so the run can post now. */
  postsWith: RunPeriodAfter | null;
  /** With no open period after the last run: the fiscal year of the default calendar to generate for it. */
  generatePeriods: { calendarId: string; fiscalYear: number } | null;
}

export interface EquityPostingsDue {
  throughDate: string;
  compensation: EquityPostingDue;
  interest: EquityPostingDue;
}

const nonZero = (amount: string): boolean => /[1-9]/.test(amount);

type Measured = Omit<EquityPostingDue, "due" | "refusal" | "catchUp">;

async function measured(
  throughDate: string,
  work: () => Promise<Measured>,
  alreadyRun: (last: string | null) => boolean,
  changed: (row: Measured) => boolean,
  catchUp: (asOf: string) => Promise<EquityCatchUp | null>,
  currency: string,
): Promise<EquityPostingDue> {
  try {
    const row = await work();
    const reached = alreadyRun(row.lastRunThrough);
    return {
      ...row,
      due: !reached && changed(row),
      refusal: null,
      catchUp: reached ? await catchUp(throughDate) : null,
    };
  } catch (error) {
    if (!(error instanceof EquityError)) throw error;
    return {
      amount: "0.0000",
      releaseLines: 0,
      lastRunThrough: null,
      currency,
      due: true,
      refusal: catalogRefusalOf(error),
      catchUp: null,
    };
  }
}

/** The legal entity's stock compensation and note interest runs through a date. */
export async function equityPostingsDue(
  orgId: string,
  subsidiaryId: string,
  currency: string,
  throughDate: string,
): Promise<EquityPostingsDue> {
  const reached = (last: string | null): boolean => last !== null && last >= throughDate;
  return {
    throughDate,
    compensation: await measured(
      throughDate,
      async () => {
        const change = await compensationRunChange(orgId, subsidiaryId, throughDate);
        return {
          amount: change.expense,
          releaseLines: change.releaseLines,
          lastRunThrough: change.lastRunThrough,
          currency: change.currency,
        };
      },
      reached,
      (row) => nonZero(row.amount) || row.releaseLines > 0,
      async (asOf) => {
        const late = await compensationCatchUp(orgId, subsidiaryId, asOf);
        return late
          ? {
              recognizedThrough: late.recognizedThrough,
              amount: late.expense,
              currency: late.currency,
              postsWith: late.postsWith,
              generatePeriods: late.generatePeriods,
            }
          : null;
      },
      currency,
    ),
    interest: await measured(
      throughDate,
      async () => {
        const change = await interestRunChange(orgId, subsidiaryId, throughDate);
        return {
          amount: change.total,
          releaseLines: 0,
          lastRunThrough: change.lastRunThrough,
          currency: change.currency,
        };
      },
      reached,
      (row) => nonZero(row.amount),
      async (asOf) => {
        const late = await interestCatchUp(orgId, subsidiaryId, asOf);
        return late
          ? {
              recognizedThrough: late.recognizedThrough,
              amount: late.total,
              currency: late.currency,
              postsWith: late.postsWith,
              generatePeriods: late.generatePeriods,
            }
          : null;
      },
      currency,
    ),
  };
}

/**
 * What the next stock compensation or note interest run would catch up:
 * recognized through the last posted run after that run was posted
 * (equity.read). Null when nothing is pending.
 */
export async function equityRunCatchUp(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  kind: "compensation" | "interest";
}): Promise<EquityCatchUp | null> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      if (input.kind === "compensation") {
        const late = await compensationCatchUp(input.orgId, input.subsidiaryId);
        return late
          ? {
              recognizedThrough: late.recognizedThrough,
              amount: late.expense,
              currency: late.currency,
              postsWith: late.postsWith,
              generatePeriods: late.generatePeriods,
            }
          : null;
      }
      const late = await interestCatchUp(input.orgId, input.subsidiaryId);
      return late
        ? {
            recognizedThrough: late.recognizedThrough,
            amount: late.total,
            currency: late.currency,
            postsWith: late.postsWith,
            generatePeriods: late.generatePeriods,
          }
        : null;
    },
    { isolationLevel: "REPEATABLE READ" },
  );
}

export interface CloseEquityPostings {
  /** Legal entities whose stock compensation run is due through the date. */
  compensation: { subsidiaryId: string; name: string; refusal: string | null }[];
  /** Legal entities whose note interest run is due through the date. */
  interest: { subsidiaryId: string; name: string; refusal: string | null }[];
}

/**
 * Legal entities with equity records whose periodic runs are not current
 * through a period end, within a close's entity scope (every entity when the
 * scope is empty). Nothing is due while Equity & cap table is switched off:
 * its runs cannot be posted then, and its records are preserved as they stand.
 */
export async function closeEquityPostings(
  orgId: string,
  input: { through: string; subsidiaryIds: readonly string[] },
): Promise<CloseEquityPostings> {
  const out: CloseEquityPostings = { compensation: [], interest: [] };
  if (!(await orgFeatureEnabled(orgId, EQUITY_FEATURE_KEY))) return out;
  return withOrgTransaction(orgId, async () => {
    const scoped = input.subsidiaryIds.length > 0;
    const entities = await db.execute<{ id: string; name: string; currency: string }>(
      sql`
      select s.id, s.name, nullif(trim(s.base_currency), '') as currency from subsidiaries s
       where s.org_id = ${orgId} and s.is_active and not s.is_elimination
         and nullif(trim(s.base_currency), '') is not null
         and exists (select 1 from equity_securities q where q.org_id = s.org_id and q.subsidiary_id = s.id and q.issue_date <= ${input.through}::date)
         ${scoped ? sql`and s.id = any(${`{${input.subsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       order by s.name, s.id`,
      "objects",
    );
    for (const entity of entities) {
      const due = await equityPostingsDue(orgId, entity.id, entity.currency, input.through);
      if (due.compensation.due)
        out.compensation.push({
          subsidiaryId: entity.id,
          name: entity.name,
          refusal: due.compensation.refusal?.message ?? null,
        });
      if (due.interest.due)
        out.interest.push({
          subsidiaryId: entity.id,
          name: entity.name,
          refusal: due.interest.refusal?.message ?? null,
        });
    }
    return out;
  });
}

export interface EquityRunPeriod {
  periodId: string;
  /** The period's canonical fiscal label (P03 FY2026). */
  name: string;
  endsOn: string;
}

/** Candidate periods the runs view weighs at most, oldest first. */
const RUN_PERIOD_HORIZON = 36;

/**
 * The period a stock compensation or note interest run is due for: the
 * earliest accounting period of the default calendar that has ended by
 * `today`, ends after the latest posted run, is open for posting, and
 * through whose end the run would post a change. Null when nothing is due,
 * so a closed period, an empty run or a period still under way is never
 * offered (equity.read).
 */
export async function nextEquityRunPeriod(input: {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  kind: "compensation" | "interest";
  today: string;
}): Promise<EquityRunPeriod | null> {
  await assertEquityReadable(input.orgId);
  return withOrgTransaction(
    input.orgId,
    async () => {
      await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
      const table =
        input.kind === "compensation" ? sql`equity_compensation_runs` : sql`equity_interest_runs`;
      const last =
        (
          await db.execute<{ through: string | null }>(
            sql`
      select max(through_date)::text as through from ${table} where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId}`,
            "objects",
          )
        )[0]?.through ?? null;
      const periods = await db.execute<{
        id: string;
        fiscal_year: number;
        period_number: number;
        ends_on: string;
      }>(
        sql`
      select p.id, p.fiscal_year, p.period_number, p.ends_on::text as ends_on from accounting_periods p
       where p.org_id = ${input.orgId} and not p.is_adjustment and p.ends_on <= ${input.today}::date
         ${last ? sql`and p.ends_on > ${last}::date` : sql``}
         and p.fiscal_calendar_id in (select id from fiscal_calendars where org_id = ${input.orgId} and is_default and is_active)
       order by p.ends_on, p.id
       limit ${RUN_PERIOD_HORIZON}`,
        "objects",
      );
      const open: typeof periods = [];
      for (const period of periods)
        if (await postingPeriodOpen(db, input.orgId, input.subsidiaryId, period.ends_on))
          open.push(period);
      if (open.length === 0) return null;
      const dates = open.map((period) => period.ends_on);
      const due =
        input.kind === "compensation"
          ? (await compensationRunChanges(input.orgId, input.subsidiaryId, dates)).map(
              (row) => nonZero(row.expense) || row.releaseLines > 0,
            )
          : (await interestRunChanges(input.orgId, input.subsidiaryId, dates)).map(
              (row) => row.lines > 0,
            );
      const index = due.findIndex(Boolean);
      if (index < 0) return null;
      const period = open[index]!;
      return {
        periodId: period.id,
        name: canonicalPeriodLabel({
          fiscalYear: period.fiscal_year,
          periodNumber: period.period_number,
          adjustment: false,
        }),
        endsOn: period.ends_on,
      };
    },
    { isolationLevel: "REPEATABLE READ" },
  );
}
