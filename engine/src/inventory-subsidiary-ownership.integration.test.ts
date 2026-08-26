import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import {
  InventoryOwnershipError,
  issueInventory,
  receiveInventory,
  reverseInventoryMovement,
  transferInventory,
} from "./inventory.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Storage refusals surface as drizzle-wrapped PostgreSQL errors; the
 * constraint identity lives on the underlying cause.
 */
async function rejectsStorageViolation(work: () => Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    const cause = (error as { cause?: Error }).cause;
    assert.ok(
      cause instanceof Error &&
        cause.message.includes(`violates foreign key constraint "${constraint}"`),
      `expected ${constraint}, got: ${String(cause ?? error)}`,
    );
    return true;
  });
}

/**
 * Legal-entity ownership of the inventory subledger.
 *
 * Stock positions used to key on org + item + location only, so one
 * subsidiary could consume another's cost layers — even at the other's
 * restricted warehouse — while booking the credit to itself. These tests pin
 * the fix at every layer: the engine refuses cross-entity operations as
 * authorization failures (HTTP 403 upstream), PostgreSQL makes cross-entity
 * facts unrepresentable via composite foreign keys, concurrent per-entity
 * issues stay isolated with per-entity GL exactly corroborating per-entity
 * layers, and a mid-posting failure rolls the whole operation back.
 */

/** The org's root subsidiary plus one child legal entity beneath it. */
async function createSecondSubsidiary(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Sub Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

/** A warehouse whose underlying location dimension is restricted to `sub`. */
async function createRestrictedStockLocation(
  org: ScratchOrg,
  sub: string,
): Promise<string> {
  const dimensionId = randomUUID();
  await db.execute(sql`
    insert into locations (id, org_id, name, is_active, custom, subsidiary_id, subsidiary_include_children)
    values (${dimensionId}, ${org.orgId}, ${"Site " + sub.slice(0, 8)}, true, '{}'::jsonb, ${sub}, true)`);
  const stockLocationId = randomUUID();
  await db.execute(sql`
    insert into stock_locations (id, org_id, location_id, code, kind, is_active)
    values (${stockLocationId}, ${org.orgId}, ${dimensionId}, ${"WH-" + sub.slice(0, 8)}, 'warehouse', true)`);
  return stockLocationId;
}

/** Sum of posted journal lines on an account for ONE legal entity. */
async function glBalanceBySubsidiary(
  orgId: string,
  accountId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${accountId}
       and e.subsidiary_id = ${subsidiaryId}`));
  return toUnits(r.rows[0]!.bal);
}

/** Σ (remaining × unit_cost) across one entity's layers at a position. */
async function layerValueBySubsidiary(
  orgId: string,
  itemId: string,
  stockLocationId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = (await db.execute<{ v: string }>(sql`
    select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as v
      from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
       and stock_location_id = ${stockLocationId}
       and subsidiary_id = ${subsidiaryId}`));
  return toUnits(r.rows[0]!.v);
}

/** Everything a cross-entity attempt must leave byte-identical. */
async function mutationSnapshot(orgId: string) {
  const r = (await db.execute<{
    movements: number;
    layers: number;
    consumptions: number;
    entries: number;
    layer_value: string;
  }>(sql`
    select (select count(*) from inventory_movements where org_id = ${orgId})::int as movements,
           (select count(*) from cost_layers where org_id = ${orgId})::int as layers,
           (select count(*) from cost_layer_consumptions where org_id = ${orgId})::int as consumptions,
           (select count(*) from journal_entries where org_id = ${orgId})::int as entries,
           (select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text from cost_layers where org_id = ${orgId}) as layer_value`));
  return r.rows[0]!;
}

/** Every posted entry must balance WITHIN each legal entity. */
async function assertPerSubsidiaryLedgerBalances(orgId: string): Promise<void> {
  const r = (await db.execute(sql`
    select e.subsidiary_id, l.entry_id, sum(l.amount) as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId}
     group by e.subsidiary_id, l.entry_id
    having sum(l.amount) <> 0`));
  assert.equal(r.rows.length, 0, "an entry is unbalanced inside a subsidiary");
}

test("cross-entity inventory access is refused with zero mutation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    const subB = await createSecondSubsidiary(org);
    const bWarehouse = await createRestrictedStockLocation(org, subB);

    // B holds stock in its own restricted warehouse.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: bWarehouse, quantity: "10", unitCost: "2.00",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    // And in the SHARED, unrestricted warehouse.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "3.00",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    const before = await mutationSnapshot(org.orgId);

    // A issuing from B's restricted warehouse: refused as a cross-entity call.
    await assert.rejects(
      issueInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: bWarehouse, quantity: "5",
        subsidiaryId: subA, date: org.date,
      }),
      InventoryOwnershipError,
    );
    // A receiving into B's restricted warehouse: same refusal.
    await assert.rejects(
      receiveInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: bWarehouse, quantity: "5", unitCost: "1.00",
        subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
      }),
      InventoryOwnershipError,
    );
    // A transferring out of the shared warehouse whose only stock is B's:
    // availability alone must not leak or consume another entity's goods.
    await assert.rejects(
      transferInventory(org.orgId, null, {
        itemId: org.items.fifo, fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2, quantity: "1",
        subsidiaryId: subA, date: org.date,
      }),
      InventoryOwnershipError,
    );

    // Zero mutation across every touched table.
    const after = await mutationSnapshot(org.orgId);
    assert.deepEqual(after, before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("storage makes cross-entity inventory facts unrepresentable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    const subB = await createSecondSubsidiary(org);

    const aReceipt = await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "4", unitCost: "1.00",
      subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const bReceipt = await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2.00",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    // The composite foreign keys pair (entity, layer) and (entity, issue),
    // so any mismatch on either side violates storage.
    const bLayer = (await db.execute<{ id: string }>(sql`
      select id from cost_layers
       where org_id = ${org.orgId} and source_movement_id = ${bReceipt.movementId}`)).rows[0]!.id;

    await rejectsStorageViolation(
      () =>
        db.execute(sql`
          insert into cost_layer_consumptions
            (org_id, subsidiary_id, cost_layer_id, issue_movement_id, quantity, unit_cost)
          values (${org.orgId}, ${subA}, ${bLayer}, ${aReceipt.movementId}, '1', '2')`),
      "layer_consumptions_layer_entity_fk",
    );
    // Right entity for the LAYER, wrong entity for the ISSUE movement: the
    // issue-side foreign key is what refuses it.
    await rejectsStorageViolation(
      () =>
        db.execute(sql`
          insert into cost_layer_consumptions
            (org_id, subsidiary_id, cost_layer_id, issue_movement_id, quantity, unit_cost)
          values (${org.orgId}, ${subB}, ${bLayer}, ${aReceipt.movementId}, '1', '1')`),
      "layer_consumptions_issue_entity_fk",
    );
    // A layer cannot claim a receipt movement owned by another entity.
    await rejectsStorageViolation(
      () =>
        db.execute(sql`
          insert into cost_layers
            (org_id, subsidiary_id, item_id, stock_location_id, source_movement_id,
             received_at, original_quantity, remaining_quantity, unit_cost)
          values (${org.orgId}, ${subA}, ${org.items.fifo}, ${org.stockLocationId},
                  ${bReceipt.movementId}, ${org.date}, '1', '1', '2')`),
      "cost_layers_source_movement_entity_fk",
    );
    // A movement cannot cite a journal entry that posts under another entity.
    await rejectsStorageViolation(
      () =>
        db.execute(sql`
          insert into inventory_movements
            (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, quantity, status, journal_entry_id)
          values (${org.orgId}, ${subB}, ${org.items.fifo}, 'adjustment', ${org.date},
                  ${org.stockLocationId}, '1', 'pending', ${aReceipt.entryId})`),
      "inv_moves_entry_same_entity_fk",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("concurrent issues isolate per legal entity and the GL corroborates each subledger", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    const subB = await createSecondSubsidiary(org);

    // Both entities stock the SAME item in the SAME shared warehouse.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "1.00",
      subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2.00",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    const [issueA, issueB] = await Promise.all([
      issueInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "6",
        subsidiaryId: subA, date: org.date,
      }),
      issueInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "6",
        subsidiaryId: subB, date: org.date,
      }),
    ]);
    assert.notEqual(issueA.movementId, issueB.movementId);

    // Each consumed ONLY its own entity's layers: A at 1.00 (COGS 6), B at
    // 2.00 (COGS 12) — never blended, never crossed.
    assert.equal(toUnits(issueA.value), toUnits("-6"));
    assert.equal(toUnits(issueB.value), toUnits("-12"));
    const consumers = (await db.execute<{ issue_sub: string; layer_sub: string }>(sql`
      select im.subsidiary_id::text as "issue_sub", cl.subsidiary_id::text as "layer_sub"
        from cost_layer_consumptions c
        join inventory_movements im on im.id = c.issue_movement_id and im.org_id = c.org_id
        join cost_layers cl on cl.id = c.cost_layer_id and cl.org_id = c.org_id
       where c.org_id = ${org.orgId}`));
    for (const row of consumers.rows) {
      assert.equal(row.issue_sub, row.layer_sub, "a consumption crossed legal entities");
    }

    // Per-entity GL exactly equals per-entity layer value — the subledger and
    // the ledger corroborate one another INSIDE each legal entity.
    const cases: [bigint, bigint][] = [
      [await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, subA), toUnits("6")],
      [await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, subB), toUnits("12")],
    ];
    for (const [actual, expected] of cases) assert.equal(actual, expected);
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subA),
      await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, subA),
    );
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subB),
      await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, subB),
    );
    await assertPerSubsidiaryLedgerBalances(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a forced journal failure rolls the whole inventory operation back", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2.00",
      subsidiaryId: subA, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const before = await mutationSnapshot(org.orgId);

    // The issue plans layers and posts its journal inside ONE transaction;
    // an unwritable offset account detonates the posting leg, and the whole
    // operation — entry, movement, consumptions, draw-downs — must vanish.
    await assert.rejects(
      issueInventory(org.orgId, null, {
        itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "3",
        subsidiaryId: subA, offsetAccountId: randomUUID(), date: org.date,
      }),
      (error: unknown) =>
        error instanceof Error && /journal_lines|foreign key|account/i.test(error.message),
    );

    const after = await mutationSnapshot(org.orgId);
    assert.deepEqual(after, before);
    await assertPerSubsidiaryLedgerBalances(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reversal lineage keeps the owning legal entity", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subB = await createSecondSubsidiary(org);
    // Reversal evidence carries its author in an append-only audit column.
    const actor = await createScratchUser(org.orgId, "Reverser", "admin");

    const receipt = await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "4.00",
      subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
    });

    const res = await reverseInventoryMovement(org.orgId, actor, {
      movementId: receipt.movementId,
      reversalDate: org.date,
      reason: "duplicate receipt correction",
    });
    assert.equal(res.alreadyReversed, false);
    const reversals = (await db.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id::text as "subsidiary_id"
        from inventory_movements
       where org_id = ${org.orgId} and reverses_movement_id = ${receipt.movementId}`));
    assert.equal(reversals.rows.length, 1);
    assert.equal(reversals.rows[0]!.subsidiary_id, subB);
    // B's books are exactly restored: no layer value, no net GL.
    assert.equal(
      await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, subB),
      0n,
    );
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subB), 0n);
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.clearing, subB), 0n);
    await assertPerSubsidiaryLedgerBalances(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
