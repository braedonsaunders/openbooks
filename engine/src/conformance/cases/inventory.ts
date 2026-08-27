/**
 * Inventories — IAS 2 and ASC 330.
 *
 * The cost-formula cases run end to end: a real vendor bill receives stock
 * through the inventory subledger, a real customer invoice issues it, and the
 * general ledger is read back. Nothing is stubbed.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { fromUnits, toUnits } from "../../money.ts";
import {
  applyInventoryIssuesForInvoice,
  applyInventoryReceiptsForBill,
  getOnHand,
} from "../../inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "../../inventory-nrv.ts";
import { capture, deps, type DraftDocumentInput } from "../ledger-helpers.ts";
import { postDocument } from "../../posting.ts";
import type { CaseContext, ConformanceCase } from "../types.ts";

/** Receive stock the way the product does: an approved vendor bill, then the
 *  inventory subledger applying that bill's receipt. */
async function receiveViaBill(
  ctx: CaseContext,
  args: { number: string; itemId: string; quantity: string; unitCost: string; amount: string },
): Promise<void> {
  const ledger = ctx.ledger!;
  const documentId = await draftConformanceDocument(ledger, {
    kind: "vendor_bill",
    number: args.number,
    partyId: ledger.vendorId,
    lines: [
      {
        itemId: args.itemId,
        quantity: args.quantity,
        unitPrice: args.unitCost,
        amount: args.amount,
        stockLocationId: ledger.stockLocationId,
      },
    ],
  });
  const entryId = await postDocument(documentId, deps(ctx));
  await applyInventoryReceiptsForBill(
    ledger.orgId,
    ledger.actorId,
    documentId,
    entryId,
    ledger.date,
    ledger.subsidiaryId,
  );
}

/** Sell stock: an approved customer invoice, then the subledger issuing it. */
async function sellViaInvoice(
  ctx: CaseContext,
  args: { number: string; itemId: string; quantity: string; unitPrice: string; amount: string },
): Promise<void> {
  const ledger = ctx.ledger!;
  const documentId = await draftConformanceDocument(ledger, {
    kind: "customer_invoice",
    number: args.number,
    partyId: ledger.customerId,
    lines: [
      {
        itemId: args.itemId,
        accountId: ctx.roles.revenue,
        quantity: args.quantity,
        unitPrice: args.unitPrice,
        amount: args.amount,
        stockLocationId: ledger.stockLocationId,
      },
    ],
  });
  await postDocument(documentId, deps(ctx));
  await applyInventoryIssuesForInvoice(
    ledger.orgId,
    ledger.actorId,
    documentId,
    ledger.date,
    ledger.subsidiaryId,
  );
}

/**
 * Insert document lines while the source header is draft, then approve it for
 * the posting kernel. This preserves the document-line immutability boundary.
 */
async function draftConformanceDocument(
  ledger: NonNullable<CaseContext["ledger"]>,
  input: DraftDocumentInput,
): Promise<string> {
  const documentId = randomUUID();
  const date = input.date ?? ledger.date;
  const currency = input.currency ?? "CAD";
  const fxRate = input.fxRate ?? "1";
  const subtotal = fromUnits(input.lines.reduce((sum, line) => sum + toUnits(line.amount), 0n));

  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${documentId}, ${ledger.orgId}, ${input.kind}, ${input.number}, ${input.partyId ?? null},
            ${ledger.subsidiaryId}, ${date}, ${date}, ${currency}, ${fxRate}, 'draft',
            ${subtotal}, '0', ${subtotal}, false, '{}'::jsonb, '{}'::jsonb)`);

  for (const [index, line] of input.lines.entries()) {
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                  stock_location_id, custom, tax_overridden, extra_dims)
      values (${randomUUID()}, ${ledger.orgId}, ${documentId}, ${index + 1}, ${line.itemId ?? null},
              ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0',
              false, '0', '0', ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
  }

  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${ledger.orgId} and status = 'draft'`);
  return documentId;
}

export const INVENTORY_CASES: readonly ConformanceCase[] = [
  {
    id: "inv-fifo-cost-formula",
    title: "First-in, first-out assigns the earliest costs to the earliest sales",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.25",
        kind: "requirement",
        requirement:
          "The cost of inventories that are ordinarily interchangeable is assigned using the first-in first-out or weighted average cost formula.",
      },
      {
        standard: "IAS 2",
        reference: "IAS 2.34",
        kind: "requirement",
        requirement:
          "When inventories are sold, their carrying amount is recognised as an expense in the period in which the related revenue is recognised.",
      },
      {
        standard: "ASC 330",
        reference: "330-10-30-9",
        kind: "requirement",
        requirement:
          "Cost of inventory may be determined under a first-in first-out assumption about the flow of cost factors.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Cost of sales is charged with the oldest layer first at its actual cost, and the remaining inventory carries the newest costs — the property an auditor recomputes when testing inventory valuation under FIFO.",
    facts: [
      "Purchase one: 100 units at 2.00 each (200.00).",
      "Purchase two: 100 units at 3.00 each (300.00).",
      "Sale: 150 units at 10.00 each (1,500.00).",
      "Under FIFO the sale consumes 100 units at 2.00 and 50 units at 3.00, so cost of sales is 350.00.",
      "Fifty units remain, all from the second purchase, carried at 150.00.",
    ],
    expected: {
      entries: [
        {
          step: "purchases",
          lines: [
            { role: "inventory", amount: "500.0000" },
            { role: "ap", amount: "-500.0000" },
          ],
        },
        {
          step: "sale",
          lines: [
            { role: "ar", amount: "1500.0000" },
            { role: "revenue", amount: "-1500.0000" },
            { role: "cogs", amount: "350.0000" },
            { role: "inventory", amount: "-350.0000" },
          ],
        },
      ],
      values: { remainingQuantity: "50.0000", remainingValue: "150.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const item = ledger.items.fifo;

      const purchases = await capture(ctx, "purchases", async () => {
        await receiveViaBill(ctx, {
          number: "CONF-INV-F1",
          itemId: item,
          quantity: "100",
          unitCost: "2",
          amount: "200",
        });
        await receiveViaBill(ctx, {
          number: "CONF-INV-F2",
          itemId: item,
          quantity: "100",
          unitCost: "3",
          amount: "300",
        });
      });

      const sale = await capture(ctx, "sale", async () => {
        await sellViaInvoice(ctx, {
          number: "CONF-INV-F3",
          itemId: item,
          quantity: "150",
          unitPrice: "10",
          amount: "1500",
        });
      });

      const onHand = await getOnHand(ledger.orgId, item, ledger.stockLocationId);
      return {
        entries: [purchases, sale],
        values: { remainingQuantity: onHand.quantity, remainingValue: onHand.value },
      };
    },
  },

  {
    id: "inv-weighted-average-cost-formula",
    title: "Weighted average assigns a blended cost to each unit sold",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.25",
        kind: "requirement",
        requirement:
          "The cost of inventories that are ordinarily interchangeable is assigned using the first-in first-out or weighted average cost formula.",
      },
      {
        standard: "IAS 2",
        reference: "IAS 2.27",
        kind: "requirement",
        requirement:
          "Under the weighted average formula the cost of each item is the weighted average of the cost of similar items at the beginning of a period and those purchased during it.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Cost of sales uses the blended average of all units held rather than any particular purchase, and the remaining inventory is carried at that same average.",
    facts: [
      "Purchase one: 100 units at 2.00 each (200.00).",
      "Purchase two: 100 units at 3.00 each (300.00).",
      "The weighted average cost is 500.00 over 200 units, or 2.50 per unit.",
      "Sale: 150 units at 10.00 each, so cost of sales is 150 at 2.50 = 375.00.",
      "Fifty units remain at 2.50, carried at 125.00.",
    ],
    expected: {
      entries: [
        {
          step: "purchases",
          lines: [
            { role: "inventory", amount: "500.0000" },
            { role: "ap", amount: "-500.0000" },
          ],
        },
        {
          step: "sale",
          lines: [
            { role: "ar", amount: "1500.0000" },
            { role: "revenue", amount: "-1500.0000" },
            { role: "cogs", amount: "375.0000" },
            { role: "inventory", amount: "-375.0000" },
          ],
        },
      ],
      values: { remainingQuantity: "50.0000", remainingValue: "125.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const item = ledger.items.movingAvg;

      const purchases = await capture(ctx, "purchases", async () => {
        await receiveViaBill(ctx, {
          number: "CONF-INV-A1",
          itemId: item,
          quantity: "100",
          unitCost: "2",
          amount: "200",
        });
        await receiveViaBill(ctx, {
          number: "CONF-INV-A2",
          itemId: item,
          quantity: "100",
          unitCost: "3",
          amount: "300",
        });
      });

      const sale = await capture(ctx, "sale", async () => {
        await sellViaInvoice(ctx, {
          number: "CONF-INV-A3",
          itemId: item,
          quantity: "150",
          unitPrice: "10",
          amount: "1500",
        });
      });

      const onHand = await getOnHand(ledger.orgId, item, ledger.stockLocationId);
      return {
        entries: [purchases, sale],
        values: { remainingQuantity: onHand.quantity, remainingValue: onHand.value },
      };
    },
  },

  {
    id: "inv-cost-expensed-against-revenue",
    title: "Inventory cost becomes an expense in the period its revenue is recognised",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.34",
        kind: "requirement",
        requirement:
          "The carrying amount of inventories sold is recognised as an expense in the period in which the related revenue is recognised.",
      },
      {
        standard: "ASC 330",
        reference: "330-10-35-1B",
        kind: "requirement",
        requirement:
          "Inventory cost is charged against revenue in the period in which the inventory is sold.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "Revenue and its matching cost of sales are recognised in the same accounting period and neither can occur without the other — the matching property behind gross margin.",
    facts: [
      "100 units purchased at 2.00 (200.00), then 40 units sold at 9.00 (360.00).",
      "Cost of sales is 40 at 2.00 = 80.00, recognised with the sale.",
    ],
    expected: {
      entries: [
        {
          step: "sale with matched cost",
          lines: [
            { role: "ar", amount: "360.0000" },
            { role: "revenue", amount: "-360.0000" },
            { role: "cogs", amount: "80.0000" },
            { role: "inventory", amount: "-80.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const item = ctx.ledger!.items.fifo;
      await receiveViaBill(ctx, {
        number: "CONF-INV-M1",
        itemId: item,
        quantity: "100",
        unitCost: "2",
        amount: "200",
      });
      const sale = await capture(ctx, "sale with matched cost", async () => {
        await sellViaInvoice(ctx, {
          number: "CONF-INV-M2",
          itemId: item,
          quantity: "40",
          unitPrice: "9",
          amount: "360",
        });
      });
      return { entries: [sale] };
    },
  },

  {
    id: "inv-purchase-does-not-touch-profit",
    title: "Buying inventory is not an expense",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.9",
        kind: "requirement",
        requirement:
          "Inventories are measured at the lower of cost and net realisable value and are carried as an asset until sold.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "A purchase of stock capitalises into inventory and never touches profit or loss, so gross margin cannot be distorted by purchasing activity in the period.",
    facts: ["A vendor bill for 250 units at 4.00 each (1,000.00)."],
    expected: {
      entries: [
        {
          step: "purchase",
          lines: [
            { role: "inventory", amount: "1000.0000" },
            { role: "ap", amount: "-1000.0000" },
          ],
        },
      ],
    },
    run: async (ctx) => {
      const purchase = await capture(ctx, "purchase", async () => {
        await receiveViaBill(ctx, {
          number: "CONF-INV-P1",
          itemId: ctx.ledger!.items.fifo,
          quantity: "250",
          unitCost: "4",
          amount: "1000",
        });
      });
      return { entries: [purchase] };
    },
  },

  {
    id: "inv-lower-of-cost-and-nrv",
    title: "Inventory is written down to net realisable value when NRV falls below cost",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.9",
        kind: "requirement",
        requirement:
          "Inventories are measured at the lower of cost and net realisable value.",
      },
      {
        standard: "IAS 2",
        reference: "IAS 2.28",
        kind: "requirement",
        requirement:
          "Inventories are written down to net realisable value item by item when cost may not be recoverable.",
      },
      {
        standard: "ASC 330",
        reference: "330-10-35-1C",
        kind: "requirement",
        requirement:
          "Inventory measured using first-in first-out or average cost is measured at the lower of cost and net realisable value.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "When net realisable value falls below cost, the carrying amount of inventory is reduced to NRV through the cost layers themselves — the loss is recognised immediately, the on-hand QUANTITY is unchanged, and the inventory subledger stays in agreement with the general ledger.",
    facts: [
      "100 units on hand at a cost of 3.00 each, carried at 300.00.",
      "Net realisable value falls to 2.00 per unit, or 200.00 in total.",
      "A write-down of 100.00 is recognised as an expense; 100 units remain on hand at a carrying amount of 200.00.",
    ],
    expected: {
      entries: [
        {
          step: "write-down to net realisable value",
          lines: [
            { role: "inventoryAdjustment", amount: "100.0000" },
            { role: "inventory", amount: "-100.0000" },
          ],
        },
      ],
      values: { remainingQuantity: "100.0000", remainingValue: "200.0000" },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const item = ledger.items.fifo;
      await receiveViaBill(ctx, {
        number: "CONF-NRV-1",
        itemId: item,
        quantity: "100",
        unitCost: "3",
        amount: "300",
      });

      const writedown = await capture(ctx, "write-down to net realisable value", async () => {
        await writeDownInventoryToNrv(ledger.orgId, ledger.actorId, {
          itemId: item,
          stockLocationId: ledger.stockLocationId,
          subsidiaryId: ledger.subsidiaryId,
          date: ledger.date,
          nrvPerUnit: "2",
        });
      });

      const onHand = await getOnHand(ledger.orgId, item, ledger.stockLocationId);
      return {
        entries: [writedown],
        values: { remainingQuantity: onHand.quantity, remainingValue: onHand.value },
      };
    },
  },

  {
    id: "inv-writedown-reversal-policy-divergence",
    title: "Reversal of a write-down is required under IFRS and prohibited under US GAAP",
    citations: [
      {
        standard: "IAS 2",
        reference: "IAS 2.33",
        kind: "requirement",
        requirement:
          "When the circumstances that caused a write-down no longer exist, the write-down is reversed so the new carrying amount is the lower of cost and revised net realisable value.",
      },
      {
        standard: "ASC 330",
        reference: "330-10-35-14",
        kind: "requirement",
        requirement:
          "A write-down of inventory to the lower of cost and net realisable value creates a new cost basis that is not subsequently written back up.",
      },
    ],
    support: "supported",
    tier: "ledger",
    assertion:
      "The same recovery in net realisable value reverses the write-down under IFRS — capped so cumulative reversals never exceed the cumulative write-down — and is refused outright under US GAAP, where the written-down amount is the new cost basis. The answer comes from the organisation's configured reporting framework, not from which function was called.",
    facts: [
      "100 units at cost 3.00 written down to NRV 2.00, a write-down of 100.00.",
      "Net realisable value later recovers to 2.80 per unit.",
      "Under IFRS the carrying amount returns to 280.00, reversing 80.00 of the write-down.",
      "Under US GAAP the reversal is refused and the carrying amount stays at 200.00.",
    ],
    expected: {
      entries: [
        {
          step: "IFRS reversal to revised NRV",
          lines: [
            { role: "inventory", amount: "80.0000" },
            { role: "inventoryAdjustment", amount: "-80.0000" },
          ],
        },
      ],
      values: {
        ifrsCarryingAmount: "280.0000",
        usGaapReversalRefused: "true",
      },
    },
    run: async (ctx) => {
      const ledger = ctx.ledger!;
      const item = ledger.items.fifo;
      await receiveViaBill(ctx, {
        number: "CONF-NRV-2",
        itemId: item,
        quantity: "100",
        unitCost: "3",
        amount: "300",
      });

      const setFramework = (framework: "us_gaap" | "ifrs") =>
        db.execute(sql`
          update orgs set settings = settings || ${JSON.stringify({ reportingFramework: framework })}::jsonb
           where id = ${ledger.orgId}`);

      await setFramework("ifrs");
      await writeDownInventoryToNrv(ledger.orgId, ledger.actorId, {
        itemId: item,
        stockLocationId: ledger.stockLocationId,
        subsidiaryId: ledger.subsidiaryId,
        date: ledger.date,
        nrvPerUnit: "2",
      });

      const reversal = await capture(ctx, "IFRS reversal to revised NRV", async () => {
        await reverseInventoryWritedown(ledger.orgId, ledger.actorId, {
          itemId: item,
          stockLocationId: ledger.stockLocationId,
          subsidiaryId: ledger.subsidiaryId,
          date: ledger.date,
          nrvPerUnit: "2.80",
        });
      });
      const ifrsOnHand = await getOnHand(ledger.orgId, item, ledger.stockLocationId);

      // The identical recovery under US GAAP must be refused.
      await setFramework("us_gaap");
      let refused = false;
      try {
        await reverseInventoryWritedown(ledger.orgId, ledger.actorId, {
          itemId: item,
          stockLocationId: ledger.stockLocationId,
          subsidiaryId: ledger.subsidiaryId,
          date: ledger.date,
          nrvPerUnit: "3.00",
        });
      } catch {
        refused = true;
      }

      return {
        entries: [reversal],
        values: {
          ifrsCarryingAmount: ifrsOnHand.value,
          usGaapReversalRefused: String(refused),
        },
      };
    },
  },
];
