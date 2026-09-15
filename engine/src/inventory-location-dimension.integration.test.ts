import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  adjustInventory,
  buildAssembly,
  issueInventory,
  postLandedCostVoucher,
  receiveInventory,
  reverseAssemblyBuild,
  transferInventory,
} from "./inventory.ts";
import { reverseInventoryWritedown, writeDownInventoryToNrv } from "./inventory-nrv.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Business (GL-dimension) location behind each scratch stock location. */
async function businessLocations(org: ScratchOrg): Promise<{ loc1: string; biz1: string; loc2: string; biz2: string }> {
  const loc1 = org.stockLocationId;
  // The fixture's second warehouse may share the first business location; the
  // tie-out needs two DISTINCT business locations, so provision one.
  const biz2 = randomUUID();
  await db.execute(sql`insert into locations (id, org_id, name, is_active, custom, subsidiary_id, subsidiary_include_children)
    values (${biz2}, ${org.orgId}, 'W3 site two', true, '{}'::jsonb, null, true)`);
  const loc2 = randomUUID();
  const src = (await db.execute<{ location_id: string; code: string; kind: string }>(sql`
    select location_id, code, kind from stock_locations where id = ${org.stockLocationId2} and org_id = ${org.orgId}`)).rows[0]!;
  await db.execute(sql`insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${loc2}, ${org.orgId}, ${biz2}, ${`${src.code}-W3B`}, ${src.kind}, true)`);
  const biz1 = (await db.execute<{ location_id: string }>(sql`
    select location_id from stock_locations where id = ${loc1} and org_id = ${org.orgId}`)).rows[0]!.location_id;
  return { loc1, biz1, loc2, biz2 };
}

/** Σ layer value at the stock locations mapped to one business location. */
async function layerValueAt(orgId: string, bizLocationId: string): Promise<bigint> {
  const r = await db.execute<{ v: string }>(sql`
    select coalesce(sum(round(cl.remaining_quantity * cl.unit_cost, 4)), 0)::text as v
      from cost_layers cl join stock_locations sl on sl.id = cl.stock_location_id and sl.org_id = cl.org_id
     where cl.org_id = ${orgId} and sl.location_id = ${bizLocationId}`);
  return toUnits(r.rows[0]!.v);
}

/** Posted+reversed inventory-asset GL sliced by the line location dimension. */
async function glAt(orgId: string, accountId: string, bizLocationId: string, asOf: string): Promise<bigint> {
  const r = await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0) as bal
      from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = ${orgId}
     where l.org_id = ${orgId} and l.account_id = ${accountId}
       and e.status in ('posted', 'reversed') and e.posting_date <= ${asOf}
       and l.location_id = ${bizLocationId}`);
  return toUnits(r.rows[0]!.bal);
}

test(
  "inventory GL legs carry the stock location's business location so per-location GL ties to layers",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const sub = org.subsidiaryId;
      const { loc1, biz1, loc2, biz2 } = await businessLocations(org);

      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: loc1, quantity: "100", unitCost: "2.00",
        subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: loc1, quantity: "100", unitCost: "3.00",
        subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      await issueInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: loc1, quantity: "150", subsidiaryId: sub, date: org.date,
      });
      await transferInventory(org.orgId, null, {
        itemId: org.items.fifo, fromStockLocationId: loc1, toStockLocationId: loc2,
        quantity: "20", subsidiaryId: sub, date: org.date,
      });
      await adjustInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: loc1, quantityDelta: "-5", subsidiaryId: sub, date: org.date,
      });
      await postLandedCostVoucher(org.orgId, null, {
        amount: "30", basis: "value", freightAccountId: org.accounts.freight,
        subsidiaryId: sub, voucherDate: org.date,
        targets: [{ itemId: org.items.fifo, stockLocationId: loc1 }],
      });
      await receiveInventory(org.orgId, null, {
        itemId: org.items.component, stockLocationId: loc1, quantity: "100", unitCost: "1.00",
        subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      const build = await buildAssembly(org.orgId, null, {
        assemblyItemId: org.items.assembly, quantity: "10", stockLocationId: loc1, subsidiaryId: sub, date: org.date,
      });
      await reverseAssemblyBuild(org.orgId, actor, {
        movementId: build.movementId, reversalDate: org.date, reason: "w3 tie-out probe reversal",
      });

      // NRV write-down and recovery at location one (IFRS framework).
      await db.execute(sql`update orgs set settings = settings || '{"reportingFramework":"ifrs"}'::jsonb where id = ${org.orgId}`);
      await receiveInventory(org.orgId, null, {
        itemId: org.items.movingAvg, stockLocationId: loc1, quantity: "2", unitCost: "100",
        subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
      });
      await writeDownInventoryToNrv(org.orgId, null, {
        itemId: org.items.movingAvg, stockLocationId: loc1, subsidiaryId: sub, date: org.date, nrvPerUnit: "50",
      });
      await reverseInventoryWritedown(org.orgId, null, {
        itemId: org.items.movingAvg, stockLocationId: loc1, subsidiaryId: sub, date: org.date, nrvPerUnit: "100",
      });

      // Every inventory-originated leg is stamped with its movement's business location.
      const unstamped = await db.execute<{ n: string }>(sql`
        select count(*)::text as n
          from journal_lines l join journal_entries e on e.id = l.entry_id and e.org_id = ${org.orgId}
         where l.org_id = ${org.orgId} and e.origin = 'inventory'
           and e.status in ('posted', 'reversed') and l.location_id is null`);
      assert.equal(unstamped.rows[0]!.n, "0", "inventory legs must carry the location dimension");

      // Per-location GL ties to per-location layers, at an as-of and now.
      for (const asOf of [org.date, "2026-07-31"]) {
        assert.equal(
          await glAt(org.orgId, org.accounts.invAsset, biz1, asOf),
          await layerValueAt(org.orgId, biz1),
          `location-one inventory GL must equal its layers as of ${asOf}`,
        );
        assert.equal(
          await glAt(org.orgId, org.accounts.invAsset, biz2, asOf),
          await layerValueAt(org.orgId, biz2),
          `location-two inventory GL must equal its layers as of ${asOf}`,
        );
      }

      // Org total still ties (no double-count from the new dimension).
      const total = await db.execute<{ bal: string }>(sql`
        select coalesce(sum(l.amount), 0) as bal from journal_lines l
        where l.org_id = ${org.orgId} and l.account_id = ${org.accounts.invAsset}`);
      const layers = await db.execute<{ v: string }>(sql`
        select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as v
          from cost_layers where org_id = ${org.orgId}`);
      assert.equal(toUnits(total.rows[0]!.bal), toUnits(layers.rows[0]!.v), "org-total inventory GL must equal layers");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
