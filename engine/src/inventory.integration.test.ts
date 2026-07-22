import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  adjustInventory,
  allocateLandedCost,
  buildAssembly,
  getOnHand,
  issueInventory,
  receiveInventory,
  transferInventory,
} from "./inventory.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Sum of posted journal_lines on an account (the GL balance). */
async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = (await db.execute(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`)) as unknown as {
    rows: { bal: string }[];
  };
  return r.rows[0].bal;
}

/** Σ (remaining_quantity × unit_cost) across every cost layer in the org. */
async function totalLayerValue(orgId: string): Promise<string> {
  const r = (await db.execute(sql`
    select (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers where org_id=${orgId}),0)
            - coalesce((select sum(round(remaining_quantity * provisional_unit_cost,4)) from inventory_provisional_costs where org_id=${orgId}),0))::text as v`)) as unknown as {
    rows: { v: string }[];
  };
  return r.rows[0].v;
}

/** Assert every posted journal entry in the org balances to zero. */
async function assertAllEntriesBalance(orgId: string): Promise<void> {
  const r = (await db.execute(sql`
    select entry_id, sum(amount) as bal from journal_lines where org_id = ${orgId} group by entry_id having sum(amount) <> 0`)) as unknown as {
    rows: { entry_id: string; bal: string }[];
  };
  assert.equal(r.rows.length, 0, `unbalanced entries: ${JSON.stringify(r.rows)}`);
}

/** The inventory GL balance must always equal the sum of cost-layer value. */
async function assertInvariant(org: ScratchOrg): Promise<void> {
  const gl = await glBalance(org.orgId, org.accounts.invAsset);
  const layers = await totalLayerValue(org.orgId);
  assert.equal(toUnits(gl), toUnits(layers), `inventory GL ${gl} != Σ layer value ${layers}`);
  await assertAllEntriesBalance(org.orgId);
}

test("inventory subledger posts, costs, and keeps GL = Σ layer value", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sub = org.subsidiaryId;
    const loc = org.stockLocationId;

    // -- FIFO: two receipts then an issue spanning layers --------------------
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "100", unitCost: "2.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "100", unitCost: "3.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    let onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.quantity), toUnits("200"));
    assert.equal(toUnits(onHand.value), toUnits("500"));
    await assertInvariant(org);

    // Issue 150 → 100×2 + 50×3 = 350 COGS; 50 @ 3.00 remain.
    const issue = await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "150", subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits(issue.value), toUnits("-350"));
    onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.quantity), toUnits("50"));
    assert.equal(toUnits(onHand.value), toUnits("150"));
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.cogs)), toUnits("350"));
    await assertInvariant(org);

    // Over-issue is blocked.
    await assert.rejects(
      issueInventory(org.orgId, null, { itemId: org.items.fifo, stockLocationId: loc, quantity: "9999", subsidiaryId: sub, date: org.date }),
      /insufficient stock/,
    );

    // -- Moving average ------------------------------------------------------
    await receiveInventory(org.orgId, null, {
      itemId: org.items.movingAvg, stockLocationId: loc, quantity: "10", unitCost: "2.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.movingAvg, stockLocationId: loc, quantity: "10", unitCost: "4.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const avgIssue = await issueInventory(org.orgId, null, {
      itemId: org.items.movingAvg, stockLocationId: loc, quantity: "5", subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits(avgIssue.value), toUnits("-15")); // 5 × (60/20)
    await assertInvariant(org);

    // -- Standard cost: receipt books variance -------------------------------
    await receiveInventory(org.orgId, null, {
      itemId: org.items.standard, stockLocationId: loc, quantity: "10", unitCost: "2.20",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    // inventory at standard 10×2.00 = 20; variance 10×0.20 = 2 to the adjustment (variance) account.
    const stdOnHand = await getOnHand(org.orgId, org.items.standard, loc);
    assert.equal(toUnits(stdOnHand.value), toUnits("20"));
    await assertInvariant(org);

    // -- Adjust (write-down) -------------------------------------------------
    await adjustInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantityDelta: "-10", subsidiaryId: sub, date: org.date,
    });
    onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.quantity), toUnits("40"));
    await assertInvariant(org);

    // -- Transfer between locations ------------------------------------------
    await transferInventory(org.orgId, null, {
      itemId: org.items.fifo, fromStockLocationId: loc, toStockLocationId: org.stockLocationId2,
      quantity: "20", subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, loc)).quantity), toUnits("20"));
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2)).quantity), toUnits("20"));
    await assertInvariant(org);

    // -- Landed cost: capitalize freight onto FIFO layers --------------------
    const glBefore = await glBalance(org.orgId, org.accounts.invAsset);
    await allocateLandedCost(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, amount: "30", basis: "value",
      freightAccountId: org.accounts.freight, subsidiaryId: sub, date: org.date,
    });
    const glAfter = await glBalance(org.orgId, org.accounts.invAsset);
    assert.equal(toUnits(glAfter) - toUnits(glBefore), toUnits("30")); // +30 capitalized
    await assertInvariant(org);

    // -- Assembly build ------------------------------------------------------
    await receiveInventory(org.orgId, null, {
      itemId: org.items.component, stockLocationId: loc, quantity: "100", unitCost: "1.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    // Build 10 assemblies → consumes 20 components @ 1.00 = 20; assembly @ 2.00.
    const build = await buildAssembly(org.orgId, null, {
      assemblyItemId: org.items.assembly, quantity: "10", stockLocationId: loc, subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits(build.value), toUnits("20"));
    const asmOnHand = await getOnHand(org.orgId, org.items.assembly, loc);
    assert.equal(toUnits(asmOnHand.quantity), toUnits("10"));
    assert.equal(toUnits(asmOnHand.value), toUnits("20"));
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.component, loc)).quantity), toUnits("80"));
    await assertInvariant(org);

    // -- Opt-in negative inventory: provisional cost then receipt true-up ----
    await db.execute(sql`
      update item_inventory_profiles set allow_negative_inventory=true,
             negative_cost_basis='configured', provisional_unit_cost='2.5000'
       where org_id=${org.orgId} and item_id=${org.items.fifo}
    `);
    const available = await getOnHand(org.orgId, org.items.fifo, loc);
    const overIssueQty = (toUnits(available.quantity) + toUnits("10"));
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: fromUnits(overIssueQty),
      subsidiaryId: sub, date: org.date,
    });
    let negative = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(negative.quantity), toUnits("-10"));
    assert.equal(toUnits(negative.value), toUnits("-25"));
    await assertInvariant(org);
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "10", unitCost: "3.00",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    negative = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(negative.quantity), 0n);
    assert.equal(toUnits(negative.value), 0n);
    const evidence = (await db.execute(sql`
      select quantity,provisional_unit_cost,receipt_unit_cost,correction_amount
        from inventory_provisional_settlements where org_id=${org.orgId}
    `)) as unknown as { rows: { quantity: string; provisional_unit_cost: string; receipt_unit_cost: string; correction_amount: string }[] };
    assert.equal(evidence.rows.length, 1);
    assert.equal(toUnits(evidence.rows[0]!.correction_amount), toUnits("5"));
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
