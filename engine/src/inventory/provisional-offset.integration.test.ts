import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { issueInventory } from "./movement-issue.ts";
import { receiveInventory } from "./movement-receive.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a negative-stock receipt trues up each shortfall on the account its issue charged", { skip: !DB }, async () => {
  // Two shortfalls at a provisional 2.50: one sold (charged to COGS) and one
  // written off to the adjustment account. The receipt at 3.00 corrects
  // each by 0.50 per unit on the account that carried its provisional cost,
  // never moving the write-off's correction into cost of goods sold.
  const org = await createScratchOrg();
  try {
    const position = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date };
    await db.execute(sql`
      update item_inventory_profiles set allow_negative_inventory=true,
             negative_cost_basis='configured', provisional_unit_cost='2.5000'
       where org_id=${org.orgId} and item_id=${org.items.fifo}`);
    await issueInventory(org.orgId, null, { ...position, quantity: "4" });
    await issueInventory(org.orgId, null, { ...position, quantity: "6", offsetAccountId: org.accounts.adjustment });
    const offsets = (await db.execute<{ offset_account_id: string | null }>(sql`
      select offset_account_id from inventory_provisional_costs
       where org_id=${org.orgId} and item_id=${org.items.fifo} order by created_at,id`)).rows.map((row) => row.offset_account_id);
    assert.deepEqual(offsets, [org.accounts.cogs, org.accounts.adjustment]);

    const receipt = await receiveInventory(org.orgId, null, {
      ...position, quantity: "10", unitCost: "3.00", offsetAccountId: org.accounts.clearing,
    });
    const trueUps = new Map((await db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, sum(amount)::text as amount from journal_lines
       where org_id=${org.orgId} and entry_id=${receipt.entryId} and memo='Negative inventory receipt cost true-up'
       group by account_id`)).rows.map((row) => [row.account_id, row.amount]));
    assert.deepEqual(trueUps, new Map([[org.accounts.cogs, "2.0000"], [org.accounts.adjustment, "3.0000"]]));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a receipt refuses to settle a shortfall whose charged account was never recorded", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const position = { itemId: org.items.fifo, stockLocationId: org.stockLocationId, subsidiaryId: org.subsidiaryId, date: org.date };
    await db.execute(sql`
      update item_inventory_profiles set allow_negative_inventory=true,
             negative_cost_basis='configured', provisional_unit_cost='2.5000'
       where org_id=${org.orgId} and item_id=${org.items.fifo}`);
    await issueInventory(org.orgId, null, { ...position, quantity: "4" });
    await db.execute(sql`update inventory_provisional_costs set offset_account_id=null where org_id=${org.orgId}`);
    await assert.rejects(receiveInventory(org.orgId, null, {
      ...position, quantity: "4", unitCost: "3.00", offsetAccountId: org.accounts.clearing,
    }), /negative stock issued on .* without a recorded charge account/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
