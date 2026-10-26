import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { InventoryError } from "./contracts.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import { getOnHand } from "./position.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

/**
 * The scratch fixture opens only the July 2026 period. Backdated scenarios
 * need March, so seed it from the fixture's own fiscal calendar.
 */
async function openMarch2026(orgId: string, periodId: string): Promise<void> {
  await db.execute(sql`
    insert into accounting_periods (org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select org_id, 2026, 3, '2026-03', '2026-03-01', '2026-03-31', false, fiscal_calendar_id
      from accounting_periods where org_id = ${orgId} and id = ${periodId}`);
}

test("a backdated issue must be covered by stock on hand on its own date", enabled, async () => {
  const org = await createScratchOrg();
  try {
    await openMarch2026(org.orgId, org.periodId);
    const item = org.items.fifo;
    const loc = org.stockLocationId;
    const sub = org.subsidiaryId;
    await receiveInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "10",
      unitCost: "2.00",
      subsidiaryId: sub,
      offsetAccountId: org.accounts.clearing,
      date: "2026-03-10",
    });

    // Ten units are on hand today, but none had arrived on 2026-03-01.
    await assert.rejects(
      issueInventory(org.orgId, null, {
        itemId: item,
        stockLocationId: loc,
        quantity: "5",
        subsidiaryId: sub,
        date: "2026-03-01",
      }),
      (error: unknown) =>
        error instanceof InventoryError &&
        /had 0(?:\.0+)? on hand on 2026-03-01 but the issue needs 5(?:\.0+)?/.test(error.message),
      "a backdated issue before the receipt must refuse",
    );
    assert.equal(
      toUnits((await getOnHand(org.orgId, item, loc)).quantity),
      toUnits("10"),
      "a refused issue moves no stock",
    );

    await issueInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "5",
      subsidiaryId: sub,
      date: "2026-03-12",
    });
    assert.equal(toUnits((await getOnHand(org.orgId, item, loc)).quantity), toUnits("5"));

    // Dated between the receipt and the last movement, the ten received on
    // 2026-03-10 still cover three units on 2026-03-11.
    await issueInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "3",
      subsidiaryId: sub,
      date: "2026-03-11",
    });
    assert.equal(toUnits((await getOnHand(org.orgId, item, loc)).quantity), toUnits("2"));

    // An issue dated after every posted movement needs only today's stock.
    await issueInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "2",
      subsidiaryId: sub,
      date: org.date,
    });
    assert.equal(toUnits((await getOnHand(org.orgId, item, loc)).quantity), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "stock received after an issue date does not cover that issue even when current stock does",
  enabled,
  async () => {
    const org = await createScratchOrg();
    try {
      await openMarch2026(org.orgId, org.periodId);
      const item = org.items.fifo;
      const loc = org.stockLocationId;
      const sub = org.subsidiaryId;
      await receiveInventory(org.orgId, null, {
        itemId: item,
        stockLocationId: loc,
        quantity: "10",
        unitCost: "2.00",
        subsidiaryId: sub,
        offsetAccountId: org.accounts.clearing,
        date: "2026-03-10",
      });
      await receiveInventory(org.orgId, null, {
        itemId: item,
        stockLocationId: loc,
        quantity: "10",
        unitCost: "2.00",
        subsidiaryId: sub,
        offsetAccountId: org.accounts.clearing,
        date: "2026-03-20",
      });
      // Twenty units are on hand today, but nothing had been received by
      // 2026-03-05, so the issue has no stock on its own date.
      await assert.rejects(
        issueInventory(org.orgId, null, {
          itemId: item,
          stockLocationId: loc,
          quantity: "12",
          subsidiaryId: sub,
          date: "2026-03-05",
        }),
        (error: unknown) =>
          error instanceof InventoryError &&
          /had 0(?:\.0+)? on hand on 2026-03-05 but the issue needs 12(?:\.0+)?/.test(
            error.message,
          ),
        "current stock must not stand in for stock on the issue date",
      );
      await issueInventory(org.orgId, null, {
        itemId: item,
        stockLocationId: loc,
        quantity: "10",
        subsidiaryId: sub,
        date: "2026-03-10",
      });
      assert.equal(toUnits((await getOnHand(org.orgId, item, loc)).quantity), toUnits("10"));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("explicitly permitted negative stock keeps allowing backdated issues", enabled, async () => {
  const org = await createScratchOrg();
  try {
    await openMarch2026(org.orgId, org.periodId);
    const item = org.items.component;
    const loc = org.stockLocationId;
    const sub = org.subsidiaryId;
    await db.execute(sql`
      update item_inventory_profiles set allow_negative_inventory = true,
             negative_cost_basis = 'configured', provisional_unit_cost = '2.5000'
       where org_id = ${org.orgId} and item_id = ${item}`);
    await receiveInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "10",
      unitCost: "2.00",
      subsidiaryId: sub,
      offsetAccountId: org.accounts.clearing,
      date: "2026-03-10",
    });
    await issueInventory(org.orgId, null, {
      itemId: item,
      stockLocationId: loc,
      quantity: "15",
      subsidiaryId: sub,
      date: "2026-03-01",
    });
    assert.equal(toUnits((await getOnHand(org.orgId, item, loc)).quantity), toUnits("-5"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
