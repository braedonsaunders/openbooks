import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { addDays, dayOfMonth, isMonthEnd } from "./manifest.ts";
import { createScriptJournal } from "../journal-writes.ts";
import { runDueSubscriptions, changeSubscription } from "../subscription-billing.ts";
import { createObligationsFromInvoice, runRevenueRecognition } from "../revenue-recognition.ts";
import { runDunningForOrg } from "../dunning.ts";
import type { SimOrg } from "./world.ts";
import type { Profile } from "./profiles/index.ts";

/**
 * The deterministic "RevOps autopilot" for a SaaS company — the mechanical stand-in
 * for the billing/finance team, driving the real recurring-revenue product surface:
 *   • daily: bill every due subscription (recurring-billing engine) → the invoice
 *     posts money into DEFERRED REVENUE; then build its recognition schedule
 *     (obligations) and make it collectible;
 *   • month-end: recognize all due revenue (deferred → earned, ratably) and book the
 *     fixed R&D/S&M/G&A payroll;
 *   • mid-month: run dunning on overdue subscribers;
 *   • periodically: expand (seat upgrades → prorated) and churn (cancellations).
 * Every step is a real engine call; the invariant oracle checks the books to the penny.
 */

interface SaasResult {
  billed: number;
  obligationsBuilt: number;
  recognized: number;
  dunned: number;
  changed: number;
  actions: number;
}

/** Make a subscription invoice collectible so the AR cycle remits against it. */
async function stampCollectible(world: SimOrg, invoiceId: string, today: string): Promise<void> {
  await db.execute(sql`
    update documents
       set due_date = coalesce(due_date, ${addDays(today, 30)}),
           expected_pay_date = coalesce(expected_pay_date, ${addDays(today, 32)}),
           custom = jsonb_set(
             jsonb_set(coalesce(custom, '{}'::jsonb), '{sim,payFraction}', '"1"'::jsonb, true),
             '{sim,obligated}', 'true'::jsonb, true)
     where id = ${invoiceId} and org_id = ${world.orgId}`);
}

export async function autopilotSaas(profile: Profile, world: SimOrg, today: string): Promise<SaasResult> {
  const res: SaasResult = { billed: 0, obligationsBuilt: 0, recognized: 0, dunned: 0, changed: 0, actions: 0 };
  if (world.subscriptions.length === 0) return res;
  const a = world.accounts;

  // 1. Bill every due subscription (monthly + annual cycles). Posts to deferred.
  const run = await runDueSubscriptions(today);
  res.billed = run.posted;

  // 2. Build recognition schedules for freshly-billed, posted, not-yet-obligated
  //    subscription invoices; make each collectible.
  const fresh = (await db.execute<{ id: string }>(sql`
    select d.id from documents d
     where d.org_id = ${world.orgId} and d.kind = 'customer_invoice' and d.status = 'posted'
       and coalesce((d.custom->'sim'->>'obligated')::boolean, false) = false`));
  for (const inv of fresh.rows) {
    try {
      const r = await createObligationsFromInvoice(inv.id, world.orgId, world.actors.controller);
      if (r.created > 0) res.obligationsBuilt += r.created;
    } catch (e) { console.error(`[saas ${today}] obligations skipped: ${(e as Error).message}`); }
    await stampCollectible(world, inv.id, today);
  }

  // 3. Month-end: recognize due revenue (deferred → earned) + book fixed payroll.
  if (isMonthEnd(today)) {
    try {
      const rec = await runRevenueRecognition(world.orgId, today, world.actors.controller);
      res.recognized = rec.posted;
    } catch (e) { console.error(`[saas ${today}] recognition skipped: ${(e as Error).message}`); }

    const payroll = profile.saasMonthlyPayroll ?? 0;
    if (payroll > 0 && a.bank && a.rdExpense && a.smExpense && a.gaExpense) {
      const rd = Math.round(payroll * 0.5);
      const sm = Math.round(payroll * 0.3);
      const ga = payroll - rd - sm;
      await createScriptJournal(
        world.orgId,
        world.actors.controller,
        {
          documentDate: today,
          memo: `Payroll & opex — ${today.slice(0, 7)}`,
          referenceNumber: "PAYROLL",
          lines: [
            { accountId: a.rdExpense!, amount: rd, description: "R&D payroll" },
            { accountId: a.smExpense!, amount: sm, description: "Sales & marketing" },
            { accountId: a.gaExpense!, amount: ga, description: "G&A" },
            { accountId: a.bank!, amount: -payroll, description: "Payroll paid" },
          ],
        },
        { post: true },
      );
    }
  }

  // 4. Dunning on overdue subscribers (mid-month).
  if (dayOfMonth(today) === 12) {
    try {
      // The simulator may share a database with real tenants. Dunning's
      // scheduler entry point scans every production org, so use the explicit
      // tenant runner here to keep this simulation's collections work inside
      // its own org.
      const d = await runDunningForOrg(world.orgId, today);
      res.dunned = d.scanned; // subscribers evaluated by the dunning policy this cycle
    } catch (e) { console.error(`[saas ${today}] dunning skipped: ${(e as Error).message}`); }
  }

  // 5. Expansion + churn: seat upgrades (prorated) and the occasional cancellation.
  if (dayOfMonth(today) === 18) {
    const seed = Number(today.slice(5, 7)); // month, for a deterministic pick
    const active = (await db.execute<{ id: string; quantity: string }>(sql`
      select id, quantity from subscriptions where org_id = ${world.orgId} and status = 'active' order by id`));
    if (active.rows.length > 0) {
      // Expansion: bump seats on one subscription.
      const up = active.rows[seed % active.rows.length]!;
      try {
        await changeSubscription(up.id, { quantity: (Number(up.quantity) + 1 + (seed % 3)).toString() }, today);
        res.changed++;
      } catch (e) { console.error(`[saas ${today}] expansion skipped: ${(e as Error).message}`); }
      // Churn: cancel one subscription a few times a year (when the date hashes to it).
      if (active.rows.length > 8 && seed % 6 === 0) {
        const churn = active.rows[(seed * 7) % active.rows.length]!;
        await db.execute(sql`
          update subscriptions set status = 'canceled', canceled_on = ${today}
           where id = ${churn.id} and org_id = ${world.orgId} and status = 'active'`);
        res.changed++;
      }
    }
  }

  res.actions = res.billed + res.obligationsBuilt + res.recognized + res.dunned + res.changed;
  return res;
}
