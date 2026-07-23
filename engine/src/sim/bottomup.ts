import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { postProjectLaborCost } from "../project-recognition.ts";
import { logTime } from "./ops-tm.ts";
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

/** Is this company running the bottom-up model (has a workforce + engagements)? */
export function isBottomUp(ctx: SimContext): boolean {
  return ctx.world.engagements.length > 0 && ctx.world.employees.length > 0 && !!ctx.world.accounts.laborClearing;
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
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where l.org_id = ${ctx.world.orgId} and l.account_id = ${a.laborClearing}`)) as unknown as { rows: { s: string }[] };
  const clearingCredit = -Number(bal.rows[0]?.s ?? "0"); // credit magnitude = billable labor accrued this month
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const salary = r2(totalSalary);
  const wash = r2(Math.max(0, clearingCredit));
  const bench = r2(salary - wash);
  const lines = [
    { accountId: a.laborClearing!, amount: wash, description: "Clear billable labor (payroll)" },
    { accountId: (a.payrollOverhead ?? a.payroll)!, amount: bench, description: "Non-billable / bench labor" },
    { accountId: a.bank!, amount: -(wash + bench), description: "Payroll paid" },
  ];
  await createScriptJournal(
    ctx.world.orgId,
    ctx.world.actors.controller,
    { documentDate: ctx.simDate, memo: `Payroll actuals — ${ctx.simDate.slice(0, 7)}`, referenceNumber: "PAYROLL", lines },
    { post: true },
  );
  mark(ctx, "payroll_run");
}
