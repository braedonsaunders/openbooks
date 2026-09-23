import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { buildAssembly } from "./assembly.ts";
import { InventoryError } from "./contracts.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * IN3: a component extension that rounds to zero must refuse by name. A
 * valid BOM quantity-per of 0.0001 with a build quantity of 0.0001 extends
 * to 0.00000001, which extendCost rounds to 0.0000; posting that zero consume
 * died on the inv_moves_qty_nonzero CHECK as a raw driver error (HTTP 500).
 */

test("a zero-rounded component extension is refused by name with nothing written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "1",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await db.execute(sql`
      update bom_components set quantity_per = '0.0001', updated_at = now()
       where org_id = ${org.orgId} and assembly_item_id = ${org.items.assembly}`);
    const before = (await db.execute<{ movements: number; entries: number; layers: number }>(sql`
      select (select count(*)::int from inventory_movements where org_id = ${org.orgId}) as movements,
             (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
             (select count(*)::int from cost_layers where org_id = ${org.orgId}) as layers
    `)).rows[0]!;
    const componentBefore = await getOnHand(org.orgId, org.items.component, org.stockLocationId);
    await assert.rejects(
      buildAssembly(org.orgId, null, {
        assemblyItemId: org.items.assembly,
        quantity: "0.0001",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      (e: unknown) => {
        assert.ok(e instanceof InventoryError, "a zero extension must refuse as InventoryError (HTTP 422), never a raw CHECK error");
        assert.match((e as Error).message, /Component/, "the refusal must name the component");
        assert.match((e as Error).message, /0\.00000001/, "the refusal must state the exact requirement");
        assert.match((e as Error).message, /below the 0\.0001 unit precision/, "the refusal must name the precision floor");
        assert.match((e as Error).message, /build a larger quantity or adjust the recipe/, "the refusal must name the remedy");
        return true;
      },
    );
    assert.deepEqual(
      (await db.execute<{ movements: number; entries: number; layers: number }>(sql`
        select (select count(*)::int from inventory_movements where org_id = ${org.orgId}) as movements,
               (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
               (select count(*)::int from cost_layers where org_id = ${org.orgId}) as layers
      `)).rows[0]!,
      before,
      "zero stock or GL change: no movement, journal, or layer may be written",
    );
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "components must not be consumed",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
