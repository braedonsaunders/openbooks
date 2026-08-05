import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { getOnHand, receiveInventory, issueInventory } from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const r = (await db.execute(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`)) as unknown as {
    rows: { bal: string }[];
  };
  return toUnits(r.rows[0]!.bal);
}

async function setFramework(orgId: string, framework: "us_gaap" | "ifrs"): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({ reportingFramework: framework })}::jsonb
     where id = ${orgId}`);
}

test("NRV write-down remeasures value only, keeps subledger = GL, and new basis flows to COGS", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "100",
      unitCost: "3",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.ap,
      date: org.date,
    });

    const result = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2",
    });
    assert.equal(result.amount, "100.0000");
    assert.equal(result.previousValue, "300.0000");
    assert.equal(result.newValue, "200.0000");

    // Quantity unchanged; value = NRV; subledger agrees with the GL.
    const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.quantity), toUnits("100"));
    assert.equal(toUnits(onHand.value), toUnits("200"));
    assert.equal(await glBalance(org.orgId, org.accounts.invAsset), toUnits("200"));
    assert.equal(await glBalance(org.orgId, org.accounts.adjustment), toUnits("100"));

    // The written-down cost is the basis future issues consume (IAS 2.34).
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.cogs,
      date: org.date,
    });
    const after = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(after.quantity), toUnits("90"));
    assert.equal(toUnits(after.value), toUnits("180")); // 90 × 2.00
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("NRV reversal: IFRS capped at the write-down, US GAAP refused, over-reversal impossible", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await setFramework(org.orgId, "ifrs");
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "100",
      unitCost: "3",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.ap,
      date: org.date,
    });
    await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2",
    });

    // NRV recovers to 3.50 — ABOVE original cost. The reversal must stop at
    // cost (release only the 100.00 written down), never above it (IAS 2.33).
    const reversal = await reverseInventoryWritedown(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "3.50",
    });
    assert.equal(reversal.amount, "100.0000");
    const onHand = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(onHand.value), toUnits("300")); // back to cost, not 350

    // Nothing left to reverse.
    await assert.rejects(
      reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        nrvPerUnit: "3.50",
      }),
      /no unreversed write-down/,
    );

    // The same recovery under US GAAP is refused outright.
    await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "2.50",
    });
    await setFramework(org.orgId, "us_gaap");
    await assert.rejects(
      reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
        nrvPerUnit: "3.00",
      }),
      /prohibited under US GAAP/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("NRV write-down distributes exactly across uneven layers — no lost cent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Three layers whose values do not divide evenly: 7 @ 1.13, 11 @ 2.07, 3 @ 5.55.
    for (const [quantity, unitCost] of [
      ["7", "1.13"],
      ["11", "2.07"],
      ["3", "5.55"],
    ] as const) {
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity,
        unitCost,
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.ap,
        date: org.date,
      });
    }
    const before = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    // 7.91 + 22.77 + 16.65 = 47.33 over 21 units.
    assert.equal(toUnits(before.value), toUnits("47.33"));

    // NRV 1.37/unit → target 21 × 1.37 = 28.77; write-down 18.56.
    const result = await writeDownInventoryToNrv(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      nrvPerUnit: "1.37",
    });
    assert.equal(result.amount, "18.5600");

    const after = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(after.value), toUnits("28.77")); // exact to the hundredth of a cent
    assert.equal(toUnits(after.quantity), toUnits("21"));
    // Subledger and GL agree exactly after the layer arithmetic.
    assert.equal(await glBalance(org.orgId, org.accounts.invAsset), toUnits("28.77"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
