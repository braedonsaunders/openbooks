import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createPaymentDocument } from "../payments.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { add, cmp, mulDecimal, neg, sum } from "../money.ts";
import { addDays, isWeekend, isMonthEnd, dayOfMonth } from "./manifest.ts";
import { mark, nextNumber, type SimContext } from "./context.ts";
import type { SimJob } from "./world.ts";
import { createDraftDocument, collectibleOpenItems } from "./activities/documents.ts";
import { isBottomUp, isLaborBased, logDailyBillableTime, monthEndLaborAndPayroll, hasJobPortfolio, logDailyCrewTime, monthEndConstructionCosts } from "./bottomup.ts";
import type { Rng } from "./rng.ts";
import type { SimCustomer } from "./world.ts";

/**
 * The seeded backbone of the hybrid model. Each simulated day it injects the raw
 * economic events that "happen to" the business — vendor bills arrive in the AP
 * inbox, billable work is prepared into draft invoices, and customer money lands
 * ready to be applied. It does NOT decide what the team does about any of it;
 * that judgment is the personas' job. Everything here is drawn from the seeded
 * RNG so the raw event stream is reproducible for a given (profile, seed).
 */

type Behavior = "onTime" | "late" | "veryLate" | "shortPay" | "delinquent";

function drawBehavior(rng: Rng, c: SimCustomer): { behavior: Behavior; delayDays: number | null; payFraction: string } {
  const behaviors: Behavior[] = ["onTime", "late", "veryLate", "shortPay", "delinquent"];
  const weights = [c.payment.onTime, c.payment.late, c.payment.veryLate, c.payment.shortPay, c.payment.delinquent];
  const behavior = rng.weighted(behaviors, weights);
  switch (behavior) {
    case "onTime": return { behavior, delayDays: rng.int(-3, 2), payFraction: "1" };
    case "late": return { behavior, delayDays: rng.int(3, 20), payFraction: "1" };
    case "veryLate": return { behavior, delayDays: rng.int(25, 75), payFraction: "1" };
    case "shortPay": return { behavior, delayDays: rng.int(3, 25), payFraction: (rng.int(80, 95) / 100).toFixed(2) };
    case "delinquent": return { behavior, delayDays: null, payFraction: "0" };
  }
}

/** Sample an integer count around a per-day rate, with a weekend slowdown. */
function sampleCount(rng: Rng, ratePerDay: number, weekend: boolean): number {
  const rate = weekend ? ratePerDay * 0.15 : ratePerDay;
  let n = Math.floor(rate);
  if (rng.chance(rate - n)) n += 1;
  // occasional busy day
  if (rng.chance(0.05)) n += rng.int(1, 2);
  return n;
}

export interface DayEvents {
  billsArrived: number;
  invoicesPrepared: number;
  paymentsArrived: number;
}

export async function generateDay(ctx: SimContext): Promise<DayEvents> {
  const weekend = isWeekend(ctx.simDate);
  const rng = ctx.rng.stream(`gen:${ctx.simDate}`);
  const events: DayEvents = { billsArrived: 0, invoicesPrepared: 0, paymentsArrived: 0 };

  // 1. Overhead vendor bills arrive → AP inbox (draft vendor_bill). Job-cost
  // vendors (materials/subs/equipment rental) are EXCLUDED here — they only bill
  // job-tagged via generateJobCostBills, so job costs never enter the ledger
  // untagged and unbillable.
  const jobCostCats = new Set(["materials", "subcontractor", "equipmentRental"]);
  const overheadVendors = ctx.world.jobs.length > 0
    ? ctx.world.vendors.filter((v) => !v.expenseCategories.some((c) => jobCostCats.has(c)))
    : ctx.world.vendors;
  const billCount = overheadVendors.length === 0 ? 0 : sampleCount(rng, ctx.profile.cadence.billsPerDay, weekend);
  for (let i = 0; i < billCount; i++) {
    const r = rng.stream(`bill:${i}`);
    const vendor = r.pick(overheadVendors);
    const category = r.pick(vendor.expenseCategories);
    const accountId = ctx.world.accounts[category] ?? ctx.world.accounts.materials!;
    await createDraftDocument(ctx.world, {
      kind: "vendor_bill",
      documentNumber: nextNumber(ctx, "BILL"),
      partyId: vendor.id,
      documentDate: ctx.simDate,
      dueDate: addDays(ctx.simDate, vendor.termDays),
      createdBy: ctx.world.actors.apClerk,
      currency: ctx.world.currency,
      memo: `${category} from ${vendor.name}`,
      custom: { sim: { source: "generator", category } },
      lines: [{ accountId, description: `${category} purchase`, amount: r.money(vendor.billMin, vendor.billMax) }],
    });
    events.billsArrived++;
  }
  if (events.billsArrived > 0) mark(ctx, "bill_arrived");

  // 1b. Job-cost vendor bills — materials, subcontractors, and outside equipment
  // rentals arrive tagged to specific jobs (real construction job costing through
  // the AP cycle). These post to the ledger project-tagged, so the PM autopilot
  // bills each job off its ACTUAL posted cost, to the penny.
  await generateJobCostBills(ctx);

  // 1c. Crew expense reports — per-diems, travel, meals, small tools — costed to
  // the job they were incurred on (real expense_report documents, employee-payable
  // subledger). These job-tagged costs are reimbursed to the crew and billed out
  // to the customer at a markup on T&M work.
  await generateExpenseReports(ctx, rng, weekend);

  // 2. Revenue driver. Bottom-up companies (workforce + engagements) log billable
  // TIME each day — revenue emerges when that time is billed. Others prepare draft
  // invoices directly.
  if (isBottomUp(ctx)) {
    await logDailyBillableTime(ctx);
  } else if (hasJobPortfolio(ctx)) {
    // Construction: crews log field-ticket time against the job portfolio. Revenue
    // emerges when the PM autopilot bills each job (per method) monthly.
    await logDailyCrewTime(ctx);
  } else {
    const invCount = sampleCount(rng, ctx.profile.cadence.invoicesPerDay, weekend);
    for (let i = 0; i < invCount; i++) {
      const r = rng.stream(`inv:${i}`);
      const customer = r.pick(ctx.world.customers);
      const category = r.pick(customer.revenueCategories);
      const accountId = ctx.world.accounts[category] ?? ctx.world.accounts.revenueService!;
      const dueDate = addDays(ctx.simDate, customer.termDays);
      const { behavior, delayDays, payFraction } = drawBehavior(r, customer);
      const expectedPayDate = delayDays === null ? null : addDays(dueDate, delayDays);
      await createDraftDocument(ctx.world, {
        kind: "customer_invoice",
        documentNumber: nextNumber(ctx, "INV"),
        partyId: customer.id,
        documentDate: ctx.simDate,
        dueDate,
        expectedPayDate,
        createdBy: ctx.world.actors.arClerk,
        currency: ctx.world.currency,
        memo: `Work for ${customer.name}`,
        custom: { sim: { source: "generator", behavior, payFraction } },
        lines: [{ accountId, description: `${category} work`, amount: r.money(customer.invoiceMin, customer.invoiceMax) }],
      });
      events.invoicesPrepared++;
    }
    if (events.invoicesPrepared > 0) mark(ctx, "invoice_prepared");
  }

  // 3. Customer money arrives for issued invoices now due → AR cash-application inbox.
  for (const customer of ctx.world.customers) {
    const items = await collectibleOpenItems(ctx.world.orgId, customer.id, "ar");
    const due = items.filter((i) => {
      const s = (i.custom as { sim?: { paymentDrafted?: boolean; collected?: boolean } })?.sim;
      return (
        i.kind === "customer_invoice" &&
        i.expectedPayDate !== null &&
        i.expectedPayDate <= ctx.simDate &&
        s?.paymentDrafted !== true &&
        s?.collected !== true
      );
    });
    if (due.length === 0) continue;

    const suggest = due.map((i) => {
      const fraction = (i.custom as { sim?: { payFraction?: string } })?.sim?.payFraction ?? "1";
      const amount = fraction === "1" ? i.open : (Number(i.open) * Number(fraction)).toFixed(2);
      return { lineId: i.lineId, documentId: i.documentId, amount };
    });

    const payment = await createPaymentDocument({
      orgId: ctx.world.orgId,
      kind: "customer_payment",
      createdBy: ctx.world.actors.arClerk,
      partyId: customer.id,
      documentDate: ctx.simDate,
      currency: ctx.world.currency,
      memo: `Remittance from ${customer.name}`,
    });
    // Attach the suggested matching for the persona to review/apply.
    await db.execute(sql`
      update documents set custom = ${JSON.stringify({ sim: { source: "generator", suggest } })}::jsonb
       where id = ${payment.id} and org_id = ${ctx.world.orgId}`);
    // Flag the invoices so we don't draft another remittance for them tomorrow.
    for (const s of suggest) {
      await db.execute(sql`
        update documents set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{sim,paymentDrafted}', 'true'::jsonb, true)
         where id = ${s.documentId} and org_id = ${ctx.world.orgId}`);
    }
    events.paymentsArrived++;
  }
  if (events.paymentsArrived > 0) mark(ctx, "payment_arrived");

  // 4. Month-end costs. Bottom-up: cost the month's billable labor + run payroll
  // actuals (washes clearing, bench labor to overhead). Otherwise: the top-down
  // revenue-pegged delivery cost.
  if (isMonthEnd(ctx.simDate)) {
    if (isLaborBased(ctx)) await monthEndLaborAndPayroll(ctx);
    else if (ctx.profile.economics) await postMonthlyLaborAndCogs(ctx);
    // Non-labor job costs (materials consumed + equipment depreciation).
    if (hasJobPortfolio(ctx)) await monthEndConstructionCosts(ctx);
  }

  return events;
}

/**
 * Book the month's payroll run and direct delivery cost, sized to the revenue
 * actually delivered this month, so the P&L carries a realistic cost structure
 * (labor is the dominant cost) instead of revenue-with-token-costs. Posted as a
 * balanced journal dated month-end. Skips months with no revenue.
 */
async function postMonthlyLaborAndCogs(ctx: SimContext): Promise<void> {
  const econ = ctx.profile.economics!;
  const monthStart = `${ctx.simDate.slice(0, 7)}-01`;
  const rev = (await db.execute(sql`
    select coalesce(sum(case when kind = 'customer_invoice' then total
                             when kind = 'customer_credit'  then -total else 0 end), 0)::text as revenue
      from documents
     where org_id = ${ctx.world.orgId} and status = 'posted'
       and kind in ('customer_invoice', 'customer_credit')
       and document_date >= ${monthStart} and document_date <= ${ctx.simDate}`)) as unknown as {
    rows: { revenue: string }[];
  };
  const revenue = rev.rows[0]?.revenue ?? "0";
  if (cmp(revenue, "0") <= 0) return;

  const labor = mulDecimal(revenue, econ.laborPctOfRevenue);
  const salaries = mulDecimal(labor, "0.68");
  const benefits = mulDecimal(labor, "0.20");
  // Use the exact residual so rounded components always cross-foot to labor.
  const payrollTax = add(labor, neg(sum([salaries, benefits])));
  const cogs = mulDecimal(revenue, econ.cogsPctOfRevenue);
  const a = ctx.world.accounts;
  const lines = [
    { accountId: a.payroll!, amount: salaries, description: "Salaries & wages" },
    { accountId: a.benefits!, amount: benefits, description: "Employee benefits" },
    { accountId: a.payrollTaxExpense!, amount: payrollTax, description: "Payroll taxes" },
    { accountId: a.cogs!, amount: cogs, description: "Direct delivery cost" },
  ];
  const total = sum([salaries, benefits, payrollTax, cogs]);
  lines.push({ accountId: a.bank!, amount: neg(total), description: "Payroll & cost paid" });

  await createScriptJournal(
    ctx.world.orgId,
    ctx.world.actors.controller,
    { documentDate: ctx.simDate, memo: `Payroll & delivery cost — ${ctx.simDate.slice(0, 7)}`, referenceNumber: "PAYROLL", lines },
    { post: true },
  );
  mark(ctx, "payroll_run");
}

/**
 * Materials, subcontractor, and outside-equipment-rental vendor bills arrive
 * tagged to jobs across four checkpoints a month. Each bill is a REAL draft
 * vendor_bill (posted + paid by the AP cycle) whose line carries the job's
 * project_id, so the cost lands in the ledger project-tagged. Sized so a job's
 * monthly purchases ≈ its `monthlyMaterials` budget, split materials/subs/rentals.
 */
async function generateJobCostBills(ctx: SimContext): Promise<number> {
  if (isWeekend(ctx.simDate) || ctx.world.jobs.length === 0) return 0;
  if (![4, 11, 18, 25].includes(dayOfMonth(ctx.simDate))) return 0;
  const a = ctx.world.accounts;
  const byCat = (cat: string) => ctx.world.vendors.filter((v) => v.expenseCategories.includes(cat));
  const matV = byCat("materials");
  const subV = byCat("subcontractor");
  const rentV = byCat("equipmentRental");
  const rng = ctx.rng.stream(`jobcost:${ctx.simDate}`);
  let count = 0;
  for (const job of ctx.world.jobs) {
    if (job.monthlyMaterials <= 0) continue;
    const r = rng.stream(job.id);
    const perCk = job.monthlyMaterials / 4;
    if (matV.length && a.materials) {
      const amt = perCk * 0.65 * r.float(0.7, 1.3);
      if (amt > 50) { await mkJobBill(ctx, r.pick(matV), a.materials, job, "materials", amt); count++; }
    }
    if (subV.length && a.subcontractor && r.chance(0.5)) {
      const amt = perCk * 0.5 * r.float(0.6, 1.4);
      if (amt > 50) { await mkJobBill(ctx, r.pick(subV), a.subcontractor, job, "subcontractor", amt); count++; }
    }
    if (job.equipment && rentV.length && a.equipmentRental && r.chance(0.35)) {
      const amt = perCk * 0.3 * r.float(0.5, 1.2);
      if (amt > 50) { await mkJobBill(ctx, r.pick(rentV), a.equipmentRental, job, "equipmentRental", amt); count++; }
    }
  }
  if (count > 0) mark(ctx, "bill_arrived");
  return count;
}

/**
 * Crew members file expense reports for job-incurred costs — per diems, mileage,
 * meals, small tools. Each is a real draft `expense_report` whose lines are tagged
 * to the job (project_id) and hit the Job Cost — Travel & Per Diem account, so the
 * cost is billable and reimbursable. The environment approves + reimburses them.
 */
async function generateExpenseReports(ctx: SimContext, rng: SimContext["rng"], weekend: boolean): Promise<number> {
  const a = ctx.world.accounts;
  if (ctx.world.jobs.length === 0 || ctx.world.employees.length === 0 || !a.jobTravel) return 0;
  const count = sampleCount(rng, ctx.profile.cadence.expenseReportsPerDay, weekend);
  const kinds: [string, number, number][] = [
    ["Per diem", 45, 75], ["Mileage & fuel", 30, 220], ["Job-site meals (crew)", 60, 340],
    ["Small tools & consumables", 40, 480], ["Lodging (out-of-town job)", 120, 620],
  ];
  const weights = ctx.world.jobs.map((j) => Math.max(1, j.crewSize));
  const totalW = weights.reduce((x, y) => x + y, 0);
  let made = 0;
  for (let i = 0; i < count; i++) {
    const r = rng.stream(`exp:${i}`);
    const emp = r.pick(ctx.world.employees);
    // Weighted job pick (crew is where the work — and the expense — is).
    let x = r.float(0, totalW);
    let idx = 0;
    while (idx < weights.length - 1 && x > weights[idx]!) { x -= weights[idx]!; idx++; }
    const job = ctx.world.jobs[idx]!;
    const nLines = 1 + (r.chance(0.4) ? 1 : 0);
    const lines: { accountId: string; description: string; amount: string; projectId: string }[] = [];
    for (let k = 0; k < nLines; k++) {
      const [label, lo, hi] = r.pick(kinds);
      lines.push({ accountId: a.jobTravel!, description: `${label} — ${job.code}`, amount: r.money(lo, hi), projectId: job.id });
    }
    await createDraftDocument(ctx.world, {
      kind: "expense_report",
      documentNumber: nextNumber(ctx, "EXP"),
      partyId: emp.id,
      documentDate: ctx.simDate,
      dueDate: addDays(ctx.simDate, 14),
      createdBy: ctx.world.actors.apClerk,
      currency: ctx.world.currency,
      memo: `Expense report — ${emp.name}`,
      custom: { sim: { source: "generator", expense: true, projectId: job.id } },
      lines,
    });
    made++;
  }
  if (made > 0) mark(ctx, "expense_report");
  return made;
}

async function mkJobBill(
  ctx: SimContext,
  vendor: SimContext["world"]["vendors"][number],
  accountId: string,
  job: SimJob,
  category: string,
  amount: number,
): Promise<void> {
  await createDraftDocument(ctx.world, {
    kind: "vendor_bill",
    documentNumber: nextNumber(ctx, "BILL"),
    partyId: vendor.id,
    documentDate: ctx.simDate,
    dueDate: addDays(ctx.simDate, vendor.termDays),
    createdBy: ctx.world.actors.apClerk,
    currency: ctx.world.currency,
    memo: `${category} — ${job.name}`,
    custom: { sim: { source: "generator", category, projectId: job.id } },
    lines: [{ accountId, description: `${category} — ${job.code}`, amount: amount.toFixed(2), projectId: job.id }],
  });
}
