import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { receiveInventory } from "./movements.ts";
import {
  createTransferOrder,
  receiveTransferOrder,
  shipTransferOrder,
} from "./transfer-orders.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function makeAccount(
  orgId: string,
  opts: {
    number: string;
    name: string;
    type: string;
    isSummary?: boolean;
    isActive?: boolean;
    subsidiaryId?: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts
      (id, org_id, number, name, type, is_summary, is_active, eliminate,
       reconcilable, required_dimensions, custom, subsidiary_id, subsidiary_include_children)
    values
      (${id}, ${orgId}, ${opts.number}, ${opts.name}, ${opts.type},
       ${opts.isSummary ?? false}, ${opts.isActive ?? true}, false, false,
       '[]'::jsonb, '{}'::jsonb, ${opts.subsidiaryId ?? null}, true)`);
  return id;
}

async function makeTransit(orgId: string, locationId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${id}, ${orgId}, ${locationId}, ${"TRANSIT-" + id.slice(0, 8)}, 'transit', true)`);
  return id;
}

test("transfer orders refuse an unusable in-transit account at creation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = await makeTransit(org.orgId, org.locationId);
    const childSubsidiary = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${childSubsidiary}, ${org.orgId}, ${org.subsidiaryId}, 'Sub Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);

    const valid = await makeAccount(org.orgId, {
      number: "1390",
      name: "Goods in transit",
      type: "asset_current_other",
    });
    const cases: { name: string; accountId: string; match: RegExp }[] = [
      {
        name: "expense (P&L)",
        accountId: org.accounts.cogs,
        match: /profit-and-loss.*balance-sheet asset.*instead/,
      },
      {
        name: "income (P&L)",
        accountId: org.accounts.revenue,
        match: /profit-and-loss.*balance-sheet asset.*instead/,
      },
      {
        name: "cash",
        accountId: org.accounts.bank,
        match: /cash\/bank.*cannot hold goods in transit.*instead/,
      },
      {
        name: "receivable",
        accountId: org.accounts.ar,
        match: /receivable.*cannot hold goods in transit.*instead/,
      },
      {
        name: "liability",
        accountId: org.accounts.clearing,
        match: /not an asset account.*balance-sheet asset.*instead/,
      },
      {
        name: "the item's own asset account",
        accountId: org.accounts.invAsset,
        match: /distinct from the inventory asset account/,
      },
      {
        name: "summary",
        accountId: await makeAccount(org.orgId, {
          number: "1391",
          name: "Summary transit",
          type: "asset_current_other",
          isSummary: true,
        }),
        match: /active, non-summary/,
      },
      {
        name: "inactive",
        accountId: await makeAccount(org.orgId, {
          number: "1392",
          name: "Dormant transit",
          type: "asset_current_other",
          isActive: false,
        }),
        match: /active, non-summary/,
      },
      {
        name: "unknown",
        accountId: randomUUID(),
        match: /not a postable account in this organization/,
      },
      {
        name: "restricted to another legal entity",
        accountId: await makeAccount(org.orgId, {
          number: "1393",
          name: "Sibling transit",
          type: "asset_current_other",
          subsidiaryId: childSubsidiary,
        }),
        match: /restricted to another subsidiary/,
      },
    ];
    // Every refusal names a usable remedy the operator can act on.
    for (const refusal of cases) {
      await assert.rejects(
        createTransferOrder(org.orgId, actor, {
          fromStockLocationId: org.stockLocationId,
          toStockLocationId: org.stockLocationId2,
          transitStockLocationId: transitId,
          inTransitAccountId: refusal.accountId,
          subsidiaryId: org.subsidiaryId,
          orderedOn: org.date,
          lines: [{ itemId: org.items.fifo, quantity: "1" }],
        }),
        (error: unknown) => {
          assert.match(String(error), refusal.match, refusal.name);
          assert.match(
            String(error),
            /instead|choose|separate/,
            `${refusal.name} names a remedy`,
          );
          return true;
        },
      );
    }
    assert.equal(
      (
        (await db.execute<{ count: number }>(sql`
          select count(*)::int as count from transfer_orders where org_id = ${org.orgId}`))
      ).rows[0]!.count,
      0,
      "refused creations persist no drafts",
    );

    // A distinct balance-sheet asset account creates cleanly.
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId,
      inTransitAccountId: valid,
      subsidiaryId: org.subsidiaryId,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "1" }],
    });
    assert.ok(order.id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("transfer posting re-validates the in-transit account against its current state", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const transitId = await makeTransit(org.orgId, org.locationId);
    const inTransit = await makeAccount(org.orgId, {
      number: "1390",
      name: "Goods in transit",
      type: "asset_current_other",
    });
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "2",
      unitCost: "10",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      transitStockLocationId: transitId,
      inTransitAccountId: inTransit,
      subsidiaryId: org.subsidiaryId,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "2" }],
    });

    // Re-typing the account to P&L after creation refuses shipment.
    await db.execute(sql`update accounts set type = 'expense' where org_id = ${org.orgId} and id = ${inTransit}`);
    await assert.rejects(
      shipTransferOrder(org.orgId, actor, order.id, org.date),
      /profit-and-loss/,
    );
    assert.equal(
      ((await db.execute<{ status: string }>(sql`select status from transfer_orders where org_id = ${org.orgId} and id = ${order.id}`))).rows[0]!.status,
      "draft",
      "a refused shipment stays a draft",
    );

    // Restoring the type lets shipment post; deactivating before receipt
    // refuses the second leg instead.
    await db.execute(sql`update accounts set type = 'asset_current_other' where org_id = ${org.orgId} and id = ${inTransit}`);
    await shipTransferOrder(org.orgId, actor, order.id, org.date);
    await db.execute(sql`update accounts set is_active = false where org_id = ${org.orgId} and id = ${inTransit}`);
    await assert.rejects(
      receiveTransferOrder(org.orgId, actor, order.id, org.date),
      /active, non-summary/,
    );
    await db.execute(sql`update accounts set is_active = true where org_id = ${org.orgId} and id = ${inTransit}`);
    await receiveTransferOrder(org.orgId, actor, order.id, org.date);
    assert.equal(
      ((await db.execute<{ status: string }>(sql`select status from transfer_orders where org_id = ${org.orgId} and id = ${order.id}`))).rows[0]!.status,
      "received",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
