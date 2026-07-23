import { addDays, dayOfMonth, recordCoverage } from "./manifest.ts";
import * as observe from "./observe.ts";
import * as ops from "./ops.ts";
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
    await ops.postBill(world, bill.id);
    recordCoverage(manifest, "vendor_bill");
    summary.billsPosted++;
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
    const res = await ops.payVendor(world, vendorId, lineIds, world.actors.apClerk, today);
    if (res) {
      recordCoverage(manifest, "vendor_payment");
      summary.vendorsPaid++;
    }
  }

  // --- AR: issue prepared invoices, apply the suggested receipts ---------
  const arIn = (await observe.arInbox(world)) as { id: string }[];
  for (const inv of arIn) {
    await ops.issueInvoice(world, inv.id);
    recordCoverage(manifest, "customer_invoice");
    summary.invoicesIssued++;
  }

  const receipts = (await observe.arReceipts(world)) as { id: string; suggested: { lineId: string; amount: string }[] | null }[];
  for (const r of receipts) {
    const alloc = (r.suggested ?? []).map((s) => ({ lineId: s.lineId, amount: s.amount }));
    if (alloc.length === 0) continue;
    await ops.applyReceipt(world, r.id, alloc, world.actors.arClerk);
    recordCoverage(manifest, "customer_payment");
    summary.receiptsApplied++;
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
