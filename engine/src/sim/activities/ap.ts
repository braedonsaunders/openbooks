import { createPaymentDocument, postPaymentWithApplications, sameCurrencyAllocation, type AllocationInput } from "../../payments.ts";
import { addDays } from "../manifest.ts";
import { mark, nextNumber, type SimContext } from "../context.ts";
import { createAndPostDocument, collectibleOpenItems } from "./documents.ts";

/**
 * AP side: bills arrive daily, a periodic pay run settles what is due, and a few
 * bills come back as vendor credits (returns / rebates). All through the real
 * posting + payment-application engine.
 */

/** Receive one vendor bill (occasionally a vendor credit) from a random vendor. */
export async function receiveBill(ctx: SimContext): Promise<void> {
  const rng = ctx.rng.stream(`ap:bill:${ctx.simDate}:${ctx.counters["seq:BILL"] ?? 0}`);
  const vendor = rng.pick(ctx.world.vendors);
  const category = rng.pick(vendor.expenseCategories);
  const accountId = ctx.world.accounts[category] ?? ctx.world.accounts.materials!;
  const amount = rng.money(vendor.billMin, vendor.billMax);

  // ~5% of vendor activity is a credit memo against prior purchases.
  if (rng.chance(0.05)) {
    await createAndPostDocument(ctx.world, {
      kind: "vendor_credit",
      documentNumber: nextNumber(ctx, "VCR"),
      partyId: vendor.id,
      documentDate: ctx.simDate,
      createdBy: ctx.world.actors.apClerk,
      currency: ctx.world.currency,
      memo: `Credit from ${vendor.name}`,
      lines: [{ accountId, description: `Return / rebate — ${category}`, amount: rng.money(200, Math.max(400, vendor.billMin)) }],
    });
    mark(ctx, "vendor_credit");
    return;
  }

  await createAndPostDocument(ctx.world, {
    kind: "vendor_bill",
    documentNumber: nextNumber(ctx, "BILL"),
    partyId: vendor.id,
    documentDate: ctx.simDate,
    dueDate: addDays(ctx.simDate, vendor.termDays),
    createdBy: ctx.world.actors.apClerk,
    currency: ctx.world.currency,
    memo: `${category} from ${vendor.name}`,
    lines: [{ accountId, description: `${category} purchase`, amount }],
  });
  mark(ctx, "vendor_bill");
}

/**
 * Pay run: settle every vendor bill whose due date is within a short horizon of
 * today, applying any open vendor credits first. One payment document per vendor.
 */
export async function runPayRun(ctx: SimContext): Promise<void> {
  const horizon = addDays(ctx.simDate, 7);
  for (const vendor of ctx.world.vendors) {
    const items = await collectibleOpenItems(ctx.world.orgId, vendor.id, "ap");
    const bills = items.filter((i) => i.kind === "vendor_bill" && (i.dueDate === null || i.dueDate <= horizon));
    if (bills.length === 0) continue;

    const allocations: AllocationInput[] = bills.map((b) => sameCurrencyAllocation(b.lineId, b.open));
    const payment = await createPaymentDocument({
      orgId: ctx.world.orgId,
      kind: "vendor_payment",
      createdBy: ctx.world.actors.apClerk,
      partyId: vendor.id,
      documentDate: ctx.simDate,
      currency: ctx.world.currency,
      memo: `Pay run ${ctx.simDate} — ${vendor.name}`,
    });
    await postPaymentWithApplications(payment.id, allocations, ctx.world.actors.apClerk);
    mark(ctx, "vendor_payment");
  }
}
