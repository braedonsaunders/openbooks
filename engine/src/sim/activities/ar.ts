import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { createPaymentDocument, postPaymentWithApplications, sameCurrencyAllocation, type AllocationInput } from "../../payments.ts";
import { mulDecimal } from "../../money.ts";
import { addDays } from "../manifest.ts";
import { mark, nextNumber, type SimContext } from "../context.ts";
import { createAndPostDocument, collectibleOpenItems } from "./documents.ts";
import type { SimCustomer } from "../world.ts";

/**
 * AR side: invoices go out, and each is stamped at creation with a realistic
 * expected-pay-date and pay-fraction drawn from the customer's behavior profile
 * (on-time / late / very-late / short-pay / delinquent). The collection activity
 * simply settles whatever is due by today — so DSO, disputes, and bad debt emerge
 * from the population rather than being scripted.
 */

type Behavior = "onTime" | "late" | "veryLate" | "shortPay" | "delinquent";

function drawBehavior(rng: SimContext["rng"], c: SimCustomer): { behavior: Behavior; delayDays: number | null; payFraction: string } {
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

/** Issue one customer invoice (occasionally a credit memo). */
export async function invoiceCustomer(ctx: SimContext): Promise<void> {
  const rng = ctx.rng.stream(`ar:inv:${ctx.simDate}:${ctx.counters["seq:INV"] ?? 0}`);
  const customer = rng.pick(ctx.world.customers);
  const category = rng.pick(customer.revenueCategories);
  const accountId = ctx.world.accounts[category] ?? ctx.world.accounts.revenueService!;

  // ~4% credit memos (scope reductions / goodwill).
  if (rng.chance(0.04)) {
    await createAndPostDocument(ctx.world, {
      kind: "customer_credit",
      documentNumber: nextNumber(ctx, "CCR"),
      partyId: customer.id,
      documentDate: ctx.simDate,
      createdBy: ctx.world.actors.arClerk,
      currency: ctx.world.currency,
      memo: `Credit memo — ${customer.name}`,
      lines: [{ accountId, description: "Scope adjustment credit", amount: rng.money(300, Math.max(600, customer.invoiceMin)) }],
    });
    mark(ctx, "customer_credit");
    return;
  }

  const amount = rng.money(customer.invoiceMin, customer.invoiceMax);
  const dueDate = addDays(ctx.simDate, customer.termDays);
  const { behavior, delayDays, payFraction } = drawBehavior(rng, customer);
  const expectedPayDate = delayDays === null ? null : addDays(dueDate, delayDays);

  await createAndPostDocument(ctx.world, {
    kind: "customer_invoice",
    documentNumber: nextNumber(ctx, "INV"),
    partyId: customer.id,
    documentDate: ctx.simDate,
    dueDate,
    expectedPayDate,
    createdBy: ctx.world.actors.arClerk,
    currency: ctx.world.currency,
    memo: `Invoice — ${customer.name}`,
    custom: { sim: { behavior, payFraction } },
    lines: [{ accountId, description: `${category} work`, amount }],
  });
  mark(ctx, "customer_invoice");
}

/** Settle every customer invoice whose expected-pay-date has arrived. */
export async function collectReceivables(ctx: SimContext): Promise<void> {
  for (const customer of ctx.world.customers) {
    const items = await collectibleOpenItems(ctx.world.orgId, customer.id, "ar");
    const due = items.filter(
      (i) =>
        i.kind === "customer_invoice" &&
        i.expectedPayDate !== null &&
        i.expectedPayDate <= ctx.simDate &&
        (i.custom as { sim?: { collected?: boolean } })?.sim?.collected !== true,
    );
    if (due.length === 0) continue;

    const allocations: AllocationInput[] = [];
    const collectedDocs: string[] = [];
    for (const item of due) {
      const fraction = (item.custom as { sim?: { payFraction?: string } })?.sim?.payFraction ?? "1";
      const payAmount = fraction === "1" ? item.open : mulDecimal(item.open, fraction);
      if (Number(payAmount) <= 0) continue;
      allocations.push(sameCurrencyAllocation(item.lineId, payAmount));
      collectedDocs.push(item.documentId);
    }
    if (allocations.length === 0) continue;

    const payment = await createPaymentDocument({
      orgId: ctx.world.orgId,
      kind: "customer_payment",
      createdBy: ctx.world.actors.arClerk,
      partyId: customer.id,
      documentDate: ctx.simDate,
      currency: ctx.world.currency,
      memo: `Receipt ${ctx.simDate} — ${customer.name}`,
    });
    await postPaymentWithApplications(payment.id, allocations, ctx.world.actors.arClerk);
    mark(ctx, "customer_payment");

    // Flag each invoice as collected so a short-paid remainder ages as a dispute
    // rather than being chased to zero on later days.
    for (const docId of collectedDocs) {
      await db.execute(sql`
        update documents set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{sim,collected}', 'true'::jsonb, true)
         where id = ${docId} and org_id = ${ctx.world.orgId}`);
    }
  }
}
