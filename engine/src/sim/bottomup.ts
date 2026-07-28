import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { postProjectLaborCost } from "../project-recognition.ts";
import { logTime, logCrewDay } from "./ops-tm.ts";
import { mark, type SimContext } from "./context.ts";
import { isWeekend } from "./manifest.ts";

/**
 * The FULLY BOTTOM-UP economic engine. Revenue is not injected — it EMERGES from
 * billable work:
 *   • each business day, workers log billable hours against engagements at their
 *     cost + bill rate (logDailyBillableTime);
 *   • at month-end the billable labor COST flows through the ledger (DR billable
 *     labor cost / CR labor clearing, via the real project-labor poster), and
 *     PAYROLL ACTUALS pay the workforce — washing the clearing for the billable
 *     portion and expensing the rest as non-billable/bench labor;
 *   • the AR/PM side bills the accumulated time at the bill rate (autopilot/persona).
 * Gross margin = billed (bill rate) − labor cost (cost rate); net margin then
 * falls out after overhead — a consequence of rates × utilization, not a peg.
 */

const HOURS_PER_MONTH = 173.33; // 2080 / 12

/** Is this company AUTO-driving revenue from billable time (workforce + engagements)? */
export function isBottomUp(ctx: SimContext): boolean {
  return ctx.world.engagements.length > 0 && ctx.world.employees.length > 0 && !!ctx.world.accounts.laborClearing;
}

/**
 * Does this company carry its labor through the crew/payroll engine? True for any
 * company with a workforce + labor clearing — including construction, whose crews
 * are put on jobs by the PM (not auto-engagements) but whose payroll is still
 * ACTUALS (clearing wash + bench overhead), never random vendor bills.
 */
export function isLaborBased(ctx: SimContext): boolean {
  return ctx.world.employees.length > 0 && !!ctx.world.accounts.laborClearing;
}

/**
 * Does this company run a construction JOB PORTFOLIO? True when jobs are seeded +
 * a crew + labor clearing exist. Crews log field tickets against these jobs daily,
 * and the PM autopilot bills each per its method — a labor-based bottom-up company
 * whose revenue emerges from job work, never injected.
 */
export function hasJobPortfolio(ctx: SimContext): boolean {
  return ctx.world.jobs.length > 0 && ctx.world.employees.length > 0 && !!ctx.world.accounts.laborClearing;
}

/**
 * Each business day: assign every crew member to an active job (weighted by the
 * job's crew size) and log a field-ticket day. This is the bottom-up labor engine
 * for construction — one field ticket per job/day, crew hours on it, costed +
 * billed later. Total daily labor is bounded by real headcount (each worker is on
 * exactly one job), so cost stays honest no matter how many jobs are open.
 */
export async function logDailyCrewTime(ctx: SimContext): Promise<number> {
  if (isWeekend(ctx.simDate) || !hasJobPortfolio(ctx)) return 0;
  const rng = ctx.rng.stream(`crew:${ctx.simDate}`);
  const util = ctx.profile.utilization ?? 0.8;
  const jobs = ctx.world.jobs;
  const weights = jobs.map((j) => Math.max(1, j.crewSize));
  const totalW = weights.reduce((a, b) => a + b, 0);

  const byJob = new Map<string, string[]>();
  for (const emp of ctx.world.employees) {
    const r = rng.stream(emp.id);
    if (r.chance(0.05)) continue; // out today
    let x = r.float(0, totalW);
    let idx = 0;
    while (idx < weights.length - 1 && x > weights[idx]!) {
      x -= weights[idx]!;
      idx++;
    }
    const job = jobs[idx]!;
    const list = byJob.get(job.id) ?? [];
    list.push(emp.id);
    byJob.set(job.id, list);
  }

  let count = 0;
  for (const [jobId, empIds] of byJob) {
    const r = rng.stream(jobId);
    const hours = Math.min(10, Math.max(4, util * 8 * r.float(0.85, 1.2))).toFixed(2);
    await logCrewDay(ctx.world, { projectId: jobId, workedOn: ctx.simDate, hours, employeeIds: empIds });
    count += empIds.length;
  }
  if (count > 0) mark(ctx, "billable_time");
  return count;
}

/**
 * Month-end job costs that are NOT labor: consumed materials (a real cost on every
 * period-end MANUAL JOURNALS a contractor really books: office/PM overhead payroll
 * and equipment depreciation. (Job materials/subs/rentals are NOT posted here — they
 * flow through the ledger as real, job-tagged VENDOR BILLS via the AP cycle, so the
 * job-cost total each billing reads is the actual posted cost, to the penny.)
 */
export async function monthEndConstructionCosts(ctx: SimContext): Promise<void> {
  const a = ctx.world.accounts;
  if (ctx.world.jobs.length === 0) return;
  const month = ctx.simDate.slice(0, 7);

  // Office/PM/admin overhead payroll — the staff carried beyond the field crew.
  const officeOh = ctx.profile.officeOverheadPerMonth ?? 0;
  if (officeOh > 0 && a.payroll && a.bank) {
    await createScriptJournal(
      ctx.world.orgId,
      ctx.world.actors.controller,
      {
        documentDate: ctx.simDate,
        memo: `Office & PM overhead payroll — ${month}`,
        referenceNumber: "OHPAY",
        lines: [
          { accountId: a.payroll!, amount: officeOh, description: "Office/PM/admin salaries" },
          { accountId: a.bank!, amount: -officeOh, description: "Overhead payroll paid" },
        ],
      },
      { post: true },
    );
  }

  // Equipment depreciation: the owned fleet's monthly ownership cost, sized per
  // equipment-bearing job (the fleet each job carries), booked against accum. dep.
  const equipJobs = ctx.world.jobs.filter((j) => j.equipment).length;
  const depreciation = equipJobs * 2400;
  if (depreciation > 0 && a.depreciation && a.accumDep) {
    await createScriptJournal(
      ctx.world.orgId,
      ctx.world.actors.controller,
      {
        documentDate: ctx.simDate,
        memo: `Equipment depreciation — ${month}`,
        referenceNumber: "DEPR",
        lines: [
          { accountId: a.depreciation!, amount: depreciation, description: "Fleet depreciation" },
          { accountId: a.accumDep!, amount: -depreciation, description: "Accumulated depreciation" },
        ],
      },
      { post: true },
    );
  }
}

/** Each business day: workers log billable time against engagements. */
export async function logDailyBillableTime(ctx: SimContext): Promise<number> {
  if (isWeekend(ctx.simDate) || !isBottomUp(ctx)) return 0;
  const rng = ctx.rng.stream(`time:${ctx.simDate}`);
  const util = ctx.profile.utilization ?? 0.75;
  let count = 0;
  for (const emp of ctx.world.employees) {
    const r = rng.stream(emp.id);
    if (r.chance(0.1)) continue; // out / fully non-billable day
    const hours = Math.min(9, Math.max(0, util * 8 * r.float(0.55, 1.3)));
    if (hours < 0.5) continue;
    const eng = r.pick(ctx.world.engagements);
    await logTime(ctx.world, { projectId: eng.id, employeeId: emp.id, hours: hours.toFixed(2), workedOn: ctx.simDate });
    count++;
  }
  if (count > 0) mark(ctx, "billable_time");
  return count;
}

/**
 * Month-end: flow the month's billable labor cost to the ledger, then run payroll
 * actuals — DR labor clearing for the billable portion (washing it to zero) and
 * DR bench-labor overhead for the remainder, CR cash for total payroll.
 */
export async function monthEndLaborAndPayroll(ctx: SimContext): Promise<void> {
  const a = ctx.world.accounts;
  if (!a.laborClearing || !a.laborWip) return;

  // 1. Cost the month's approved time: DR billable labor cost / CR labor clearing.
  const uncosted = (await db.execute(sql`
    select id from time_entries
     where org_id = ${ctx.world.orgId} and status = 'approved'
       and cost_journal_entry_id is null and project_id is not null`)) as unknown as { rows: { id: string }[] };
  if (uncosted.rows.length > 0) {
    await postProjectLaborCost(ctx.world.orgId, ctx.world.actors.controller, uncosted.rows.map((r) => r.id));
  }

  // 2. Payroll actuals. Total payroll = headcount × fully-loaded monthly cost.
  const totalSalary = ctx.world.employees.reduce((acc, e) => acc + Number(e.costRate) * HOURS_PER_MONTH, 0);
  const bal = (await db.execute(sql`
    select coalesce(sum(l.amount), 0)::text as s from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${ctx.world.orgId} and l.account_id = ${a.laborClearing}`)) as unknown as { rows: { s: string }[] };
  const clearingCredit = -Number(bal.rows[0]?.s ?? "0"); // credit magnitude = billable labor accrued this month
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const salary = r2(totalSalary);
  const wash = r2(Math.max(0, clearingCredit));
  const bench = r2(salary - wash);
  const lines = [
    { accountId: a.laborClearing!, amount: wash, description: "Clear billable labor (payroll)" },
    { accountId: (a.payrollOverhead ?? a.payroll)!, amount: bench, description: "Non-billable / bench labor" },
    { accountId: a.bank!, amount: r2(-(wash + bench)), description: "Payroll paid" },
  ].filter((l) => Math.abs(l.amount) > 0.0001); // a zero leg (no bench, or no billable labor) is dropped, not posted as $0
  if (lines.length >= 2) {
    await createScriptJournal(
      ctx.world.orgId,
      ctx.world.actors.controller,
      { documentDate: ctx.simDate, memo: `Payroll actuals — ${ctx.simDate.slice(0, 7)}`, referenceNumber: "PAYROLL", lines },
      { post: true },
    );
    mark(ctx, "payroll_run");
  }
}
