import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { addDays, dayOfMonth, isMonthEnd, recordCoverage } from "./manifest.ts";
import * as observe from "./observe.ts";
import * as ops from "./ops.ts";
import * as opsTm from "./ops-tm.ts";
import { autopilotConstruction } from "./construction-autopilot.ts";
import type { SimOrg } from "./world.ts";
import type { RunManifest } from "./manifest.ts";
import type { Profile } from "./profiles/index.ts";

/**
 * A deterministic, non-LLM stand-in for the persona team. It plays one day
 * "by the book": post the inbox, pay what's due, issue invoices, apply the
 * suggested receipts, and close the prior month on the close day. This is what
 * CI runs (no model in the loop) and what lets a developer exercise the whole
 * environment + oracle before handing the wheel to the LLM personas, who add the
 * judgment (disputes, prioritization, exceptions) this baseline omits.
 */

export interface AutopilotSummary {
  billsPosted: number;
  vendorsPaid: number;
  invoicesIssued: number;
  receiptsApplied: number;
  monthsClosed: string[];
}

export async function autopilotDay(profile: Profile, world: SimOrg, manifest: RunManifest): Promise<AutopilotSummary> {
  const today = manifest.simDate;
  const summary: AutopilotSummary = { billsPosted: 0, vendorsPaid: 0, invoicesIssued: 0, receiptsApplied: 0, monthsClosed: [] };

  // --- AP: post the inbox, then pay bills due within a week ---------------
  const inbox = (await observe.apInbox(world)) as { id: string; dispute: string | null }[];
  for (const bill of inbox) {
    if (bill.dispute) continue;
    // A bill left in the inbox past its period is posted as a catch-up in the
    // current open period, not rejected into a locked month.
    await db.execute(sql`
      update documents
         set document_date = ${today},
             due_date = case when due_date is null or due_date < ${today} then ${addDays(today, 30)} else due_date end
       where id = ${bill.id} and org_id = ${world.orgId} and status = 'draft' and document_date < ${today}`);
    try {
      await ops.postBill(world, bill.id);
      recordCoverage(manifest, "vendor_bill");
      summary.billsPosted++;
    } catch (e) { console.error(`[autopilot ${today}] post-bill skipped: ${(e as Error).message}`); }
  }

  const open = (await observe.apOpen(world)) as { vendorId: string; lineId: string; dueDate: string | null }[];
  const horizon = addDays(today, 7);
  const byVendor = new Map<string, string[]>();
  for (const item of open) {
    if (item.dueDate === null || item.dueDate <= horizon) {
      const list = byVendor.get(item.vendorId) ?? [];
      list.push(item.lineId);
      byVendor.set(item.vendorId, list);
    }
  }
  for (const [vendorId, lineIds] of byVendor) {
    try {
      const res = await ops.payVendor(world, vendorId, lineIds, world.actors.apClerk, today);
      if (res) { recordCoverage(manifest, "vendor_payment"); summary.vendorsPaid++; }
    } catch (e) { console.error(`[autopilot ${today}] pay-vendor skipped: ${(e as Error).message}`); }
  }

  // --- AR: issue prepared invoices, apply the suggested receipts ---------
  const arIn = (await observe.arInbox(world)) as { id: string }[];
  for (const inv of arIn) {
    // An invoice is dated when it's issued: re-stamp a draft that's still sitting
    // in the inbox to today (and push its terms forward), so a draft prepared in a
    // now-closed period isn't rejected for posting into a locked month.
    await db.execute(sql`
      update documents
         set document_date = ${today},
             due_date = case when due_date is null or due_date < ${today} then ${addDays(today, 30)} else due_date end,
             expected_pay_date = case when expected_pay_date is null or expected_pay_date < ${today} then ${addDays(today, 38)} else expected_pay_date end
       where id = ${inv.id} and org_id = ${world.orgId} and status = 'draft' and document_date < ${today}`);
    try {
      await ops.issueInvoice(world, inv.id);
      recordCoverage(manifest, "customer_invoice");
      summary.invoicesIssued++;
    } catch (e) { console.error(`[autopilot ${today}] issue-invoice skipped: ${(e as Error).message}`); }
  }

  const receipts = (await observe.arReceipts(world)) as { id: string; suggested: { lineId: string; amount: string }[] | null }[];
  for (const r of receipts) {
    // Only apply positive allocations (a short-pay of a tiny invoice can round to
    // 0.00, which the payment engine correctly rejects).
    const alloc = (r.suggested ?? []).filter((s) => Number(s.amount) > 0.005).map((s) => ({ lineId: s.lineId, amount: s.amount }));
    if (alloc.length === 0) continue;
    try {
      await ops.applyReceipt(world, r.id, alloc, world.actors.arClerk);
      recordCoverage(manifest, "customer_payment");
      summary.receiptsApplied++;
    } catch (e) { console.error(`[autopilot ${today}] apply-receipt skipped: ${(e as Error).message}`); }
  }

  // --- Construction PM: drive the job portfolio (all billing methods) mid-month ----
  const con = await autopilotConstruction(world, today);
  if (con.actions > 0) recordCoverage(manifest, "construction_billing");

  // --- Bottom-up: bill each engagement's accumulated billable time at month-end ----
  if (isMonthEnd(today) && world.engagements.length > 0) {
    for (const eng of world.engagements) {
      const res = await opsTm.billTimeAndMaterials(world, eng.id, today);
      if (res) { recordCoverage(manifest, "customer_invoice"); summary.invoicesIssued++; }
    }
  }

  // --- Controller: close the prior month on the close day ----------------
  if (dayOfMonth(today) === profile.cadence.closeDayOfMonth) {
    const priorMonthEnd = addDays(`${today.slice(0, 7)}-01`, -1); // last day of previous month
    const priorName = priorMonthEnd.slice(0, 7);
    const period = world.periods.find((p) => p.name === priorName);
    if (period) {
      const status = (await observe.periodStatus(world)) as { name: string; gl_state: string }[];
      const glState = status.find((s) => s.name === priorName)?.gl_state ?? "open";
      if (glState !== "closed") {
        await ops.closeMonth(world, period.id, world.actors.controller, "autopilot month-end close");
        recordCoverage(manifest, "period_close");
        summary.monthsClosed.push(priorName);
      }
    }
  }

  return summary;
}
