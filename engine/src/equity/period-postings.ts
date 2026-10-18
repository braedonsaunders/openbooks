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
import { db, withOrgTransaction } from "../platform/db.ts";
import { compensationRunChange } from "./compensation-run.ts";
import { EQUITY_FEATURE_KEY, EquityError } from "./errors.ts";
import { interestRunChange } from "./interest-run.ts";

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
  refusal: { message: string; remedy: string } | null;
}

export interface EquityPostingsDue {
  throughDate: string;
  compensation: EquityPostingDue;
  interest: EquityPostingDue;
}

const nonZero = (amount: string): boolean => /[1-9]/.test(amount);

async function measured(work: () => Promise<Omit<EquityPostingDue, "due" | "refusal">>, alreadyRun: (last: string | null) => boolean, changed: (row: Omit<EquityPostingDue, "due" | "refusal">) => boolean, currency: string): Promise<EquityPostingDue> {
  try {
    const row = await work();
    return { ...row, due: !alreadyRun(row.lastRunThrough) && changed(row), refusal: null };
  } catch (error) {
    if (!(error instanceof EquityError)) throw error;
    return { amount: "0.0000", releaseLines: 0, lastRunThrough: null, currency, due: true, refusal: { message: error.message, remedy: error.remedy } };
  }
}

/** The legal entity's stock compensation and note interest runs through a date. */
export async function equityPostingsDue(orgId: string, subsidiaryId: string, currency: string, throughDate: string): Promise<EquityPostingsDue> {
  const reached = (last: string | null): boolean => last !== null && last >= throughDate;
  return {
    throughDate,
    compensation: await measured(async () => {
      const change = await compensationRunChange(orgId, subsidiaryId, throughDate);
      return { amount: change.expense, releaseLines: change.releaseLines, lastRunThrough: change.lastRunThrough, currency: change.currency };
    }, reached, (row) => nonZero(row.amount) || row.releaseLines > 0, currency),
    interest: await measured(async () => {
      const change = await interestRunChange(orgId, subsidiaryId, throughDate);
      return { amount: change.total, releaseLines: 0, lastRunThrough: change.lastRunThrough, currency: change.currency };
    }, reached, (row) => nonZero(row.amount), currency),
  };
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
export async function closeEquityPostings(orgId: string, input: { through: string; subsidiaryIds: readonly string[] }): Promise<CloseEquityPostings> {
  const out: CloseEquityPostings = { compensation: [], interest: [] };
  if (!(await orgFeatureEnabled(orgId, EQUITY_FEATURE_KEY))) return out;
  return withOrgTransaction(orgId, async () => {
    const scoped = input.subsidiaryIds.length > 0;
    const entities = (await db.execute<{ id: string; name: string; currency: string }>(sql`
      select s.id, s.name, nullif(trim(s.base_currency), '') as currency from subsidiaries s
       where s.org_id = ${orgId} and s.is_active and not s.is_elimination
         and nullif(trim(s.base_currency), '') is not null
         and exists (select 1 from equity_securities q where q.org_id = s.org_id and q.subsidiary_id = s.id and q.issue_date <= ${input.through}::date)
         ${scoped ? sql`and s.id = any(${`{${input.subsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       order by s.name, s.id`)).rows;
    for (const entity of entities) {
      const due = await equityPostingsDue(orgId, entity.id, entity.currency, input.through);
      if (due.compensation.due) out.compensation.push({ subsidiaryId: entity.id, name: entity.name, refusal: due.compensation.refusal?.message ?? null });
      if (due.interest.due) out.interest.push({ subsidiaryId: entity.id, name: entity.name, refusal: due.interest.refusal?.message ?? null });
    }
    return out;
  });
}
