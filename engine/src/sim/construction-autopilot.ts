import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { isMonthEnd, addDays } from "./manifest.ts";
import { postLaborForProject, billTimeAndMaterials, type ExtraBillLine } from "./ops-tm.ts";
import { runProgressBilling, billFixedPrice, releaseProjectRetainage } from "./ops-construction.ts";
import type { SimJob, SimOrg } from "./world.ts";
import type { Profile } from "./profiles/index.ts";

/**
 * The deterministic "PM autopilot" for a construction company — the mechanical
 * stand-in for the Project Manager persona across a concurrent portfolio of every
 * billing method. Crews logged field-ticket time daily, and materials/subs/rentals
 * arrived as job-tagged vendor bills; this runs at MONTH-END (when the month's cost
 * is fully posted) and bills each job off its ACTUAL posted cost, per its method:
 *   • T&M / NTE: bill the accumulated crew time at the bill rate + equipment at a
 *     day rate + the month's posted materials at a markup (NTE stops at its cap);
 *   • cost-plus: bill the same work at cost + a fee;
 *   • schedule_of_values: an AIA progress draw sized to (month cost × markup) with
 *     retainage, released near substantial completion;
 *   • fixed_price: a milestone invoice sized to (month cost × markup), up to contract.
 * Revenue therefore tracks real posted cost to the penny; margin is emergent, not a
 * target.
 */

const COST_PLUS_FEE = 0.12;
/** Target price/cost multiple for schedule-of-values + fixed progress billing. */
const POC_MARKUP = 1.78;

/**
 * Make a directly-posted construction invoice (AIA draw / fixed milestone /
 * retainage release) collectible: stamp an expected pay date + full pay fraction
 * so the environment's collection cycle remits against it (exercising cash
 * application on progress billings, not just T&M).
 */
async function stampCollectible(world: SimOrg, invoiceId: string, today: string): Promise<void> {
  await db.execute(sql`
    update documents
       set expected_pay_date = ${addDays(today, 40)},
           due_date = coalesce(due_date, ${addDays(today, 30)}),
           custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{sim,payFraction}', '"1"'::jsonb, true)
     where id = ${invoiceId} and org_id = ${world.orgId}`);
}

/** Sum of posted customer-invoice totals tagged to a job (billed-to-date). */
async function billedToDate(world: SimOrg, projectId: string): Promise<number> {
  const r = (await db.execute(sql`
    select coalesce(sum(d.total), 0)::text as billed from documents d
     where d.org_id = ${world.orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
       and (d.custom->'sim'->>'projectId' = ${projectId}
            or exists (select 1 from document_lines dl where dl.document_id = d.id and dl.project_id = ${projectId}))`)) as unknown as {
    rows: { billed: string }[];
  };
  return Number(r.rows[0]?.billed ?? "0");
}

/** Distinct field-ticket days of unbilled crew time on a job (for equipment days). */
async function unbilledCrewDays(world: SimOrg, projectId: string): Promise<number> {
  const r = (await db.execute(sql`
    select count(distinct worked_on)::text as days from time_entries
     where org_id = ${world.orgId} and project_id = ${projectId}
       and status = 'approved' and is_billable and billing_status = 'unbilled'`)) as unknown as {
    rows: { days: string }[];
  };
  return Number(r.rows[0]?.days ?? "0");
}

/** Actual posted job cost this month, from the ledger (project-tagged journal lines). */
async function jobPostedCost(
  world: SimOrg,
  projectId: string,
  month: string,
): Promise<{ labor: number; purchases: number; total: number }> {
  const a = world.accounts;
  const labor = new Set([a.laborWip, a.directLabor].filter(Boolean) as string[]);
  const purchase = new Set([a.materials, a.subcontractor, a.equipmentRental, a.jobTravel, a.cogs].filter(Boolean) as string[]);
  const r = (await db.execute(sql`
    select l.account_id as acct, coalesce(sum(l.amount), 0)::text as amt
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
     where l.org_id = ${world.orgId} and l.project_id = ${projectId}
       and to_char(e.posting_date, 'YYYY-MM') = ${month}
     group by l.account_id`)) as unknown as { rows: { acct: string; amt: string }[] };
  let lab = 0;
  let pur = 0;
  for (const row of r.rows) {
    const amt = Number(row.amt);
    if (labor.has(row.acct)) lab += amt;
    else if (purchase.has(row.acct)) pur += amt;
  }
  return { labor: lab, purchases: pur, total: lab + pur };
}

/** Equipment (owned fleet at day rate) + materials (posted cost at markup) lines. */
async function extraLines(
  profile: Profile,
  world: SimOrg,
  job: SimJob,
  purchases: number,
  fee?: number,
): Promise<ExtraBillLine[]> {
  const lines: ExtraBillLine[] = [];
  if (job.equipment && world.accounts.equipmentRevenue) {
    const days = await unbilledCrewDays(world, job.id);
    const dayRate = profile.equipmentDayRate ?? 350;
    if (days > 0) {
      lines.push({
        accountId: world.accounts.equipmentRevenue,
        description: `Equipment on site — ${days} crew-days @ ${dayRate}/day`,
        amount: (days * dayRate).toFixed(2),
        quantity: String(days),
        unitPrice: String(dayRate),
      });
    }
  }
  if (purchases > 0 && world.accounts.revenueProduct) {
    const markup = fee ?? profile.materialMarkup ?? 0.15;
    lines.push({
      accountId: world.accounts.revenueProduct,
      description: `Materials & subcontractors${fee === undefined ? " + markup" : " + fee"}`,
      amount: (purchases * (1 + markup)).toFixed(2),
    });
  }
  return lines;
}

export async function autopilotConstruction(
  profile: Profile,
  world: SimOrg,
  today: string,
): Promise<{ actions: number }> {
  if (world.jobs.length === 0 || world.employees.length === 0 || !isMonthEnd(today)) return { actions: 0 };
  const month = today.slice(0, 7);

  let actions = 0;
  for (const job of world.jobs) {
    const contract = Number(job.contractValue);
    try {
      // Ensure the month's crew labor is costed to the job before we read cost.
      await postLaborForProject(world, job.id);
      const cost = await jobPostedCost(world, job.id, month);

      if (job.method === "time_and_materials" || job.method === "not_to_exceed") {
        if (job.method === "not_to_exceed" && contract > 0 && (await billedToDate(world, job.id)) >= contract * 0.95) continue;
        const r = await billTimeAndMaterials(world, job.id, today, {
          extraLines: await extraLines(profile, world, job, cost.purchases),
          memo: `${job.method === "not_to_exceed" ? "NTE" : "T&M"} billing — ${job.name}`,
        });
        if (r) actions++;
      } else if (job.method === "cost_plus") {
        const r = await billTimeAndMaterials(world, job.id, today, {
          costPlusFee: COST_PLUS_FEE,
          extraLines: await extraLines(profile, world, job, cost.purchases, COST_PLUS_FEE),
          memo: `Cost-plus billing — ${job.name}`,
        });
        if (r) actions++;
      } else if (job.method === "schedule_of_values") {
        // AIA progress draw sized to this month's posted cost × markup.
        const sovTotal = (await db.execute(sql`
          select coalesce(sum(scheduled_value), 0)::text as t from sov_lines
           where org_id = ${world.orgId} and project_id = ${job.id}`)) as unknown as { rows: { t: string }[] };
        const sov = Number(sovTotal.rows[0]?.t ?? "0");
        const billed = await billedToDate(world, job.id);
        if (sov > 0 && billed < sov * 0.9) {
          const fraction = Math.min((cost.total * POC_MARKUP) / sov, 0.9 - billed / sov);
          if (fraction > 0.0005) {
            const inv = await runProgressBilling(world, job.id, today, fraction.toFixed(4), world.actors.arClerk, world.actors.controller);
            await stampCollectible(world, inv.invoiceId, today);
            actions++;
          }
        } else if (sov > 0 && billed >= sov * 0.9) {
          const ret = (await db.execute(sql`
            select coalesce(sum(l.amount), 0)::text as bal from journal_lines l
              join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
             where l.org_id = ${world.orgId} and l.account_id = ${world.accounts.retainageReceivable}`)) as unknown as {
            rows: { bal: string }[];
          };
          const retBal = Number(ret.rows[0]?.bal ?? "0");
          if (retBal > 1) {
            const inv = await releaseProjectRetainage(world, job.id, today, retBal.toFixed(2), world.actors.controller);
            await stampCollectible(world, inv.invoiceId, today);
            actions++;
          }
        }
      } else if (job.method === "fixed_price") {
        const billed = await billedToDate(world, job.id);
        if (contract > 0 && billed < contract * 0.98) {
          const amt = Math.min(cost.total * POC_MARKUP, contract - billed);
          if (amt > 0.005) {
            const inv = await billFixedPrice(world, job.id, amt.toFixed(2), today, "Monthly progress milestone");
            await stampCollectible(world, inv.invoiceId, today);
            actions++;
          }
        }
      }
    } catch {
      // Expected business-rule rejections (NTE ceiling, over-contract, nothing to
      // bill) must not abort the other jobs. The day-end invariant oracle still
      // gates correctness, so a real defect (unbalanced books) halts the run.
    }
  }
  return { actions };
}
