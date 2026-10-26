import { executeIdempotentInventoryAction } from "./action-idempotency.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { issueInventory, receiveInventory } from "./movements.ts";
import {
  createScratchOrg,
  seedFlowActors,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Negative-stock deficits belong to the legal entity whose issue created
 * them. The settlement query used to filter org + item + location only, so
 * Sub B's receipt consumed Sub A's deficit: B got no cost layer while booking
 * DR Inventory 50 + DR COGS 10 for stock it holds, and A's inventory GL
 * stayed -50 with no layers behind it. Deficits now settle only within the
 * receiving subsidiary.
 */

async function createSecondSubsidiary(org: ScratchOrg): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'Sub Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

async function allowConfiguredNegative(org: ScratchOrg): Promise<void> {
  await db.execute(sql`
    update item_inventory_profiles
       set allow_negative_inventory = true,
           negative_cost_basis = 'configured',
           provisional_unit_cost = '10'
     where org_id = ${org.orgId} and item_id = ${org.items.fifo}`);
}

async function glBalanceBySubsidiary(
  orgId: string,
  accountId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = await db.execute<{ bal: string }>(
    sql`
    select coalesce(sum(l.amount), 0)::text as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId} and l.account_id = ${accountId}
       and e.subsidiary_id = ${subsidiaryId} and e.status = 'posted'`,
    "objects",
  );
  return toUnits(r[0]!.bal);
}

async function layerRemaining(
  orgId: string,
  itemId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = await db.execute<{ q: string }>(
    sql`
    select coalesce(sum(remaining_quantity), 0)::text as q from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
       and subsidiary_id = ${subsidiaryId}`,
    "objects",
  );
  return toUnits(r[0]!.q);
}

test("a receipt settles only its own subsidiary's deficit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    const subB = await createSecondSubsidiary(org);
    await allowConfiguredNegative(org);

    // Sub A issues 5 short at the $10 provisional cost: a deficit owned by A.
    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      subsidiaryId: subA,
      date: org.date,
    });
    const deficit = (
      await db.execute<{ subsidiary_id: string; remaining_quantity: string }>(
        sql`
      select subsidiary_id::text, remaining_quantity::text from inventory_provisional_costs
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`,
        "objects",
      )
    )[0]!;
    assert.equal(deficit.subsidiary_id, subA, "the deficit is owned by the issuing subsidiary");
    assert.equal(toUnits(deficit.remaining_quantity), toUnits("5"));

    // Sub B receives 5 at $12 into the same warehouse. B must not touch A's
    // shortfall: B books a full layer at its own cost.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      unitCost: "12",
      subsidiaryId: subB,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });

    // A's deficit is untouched and still owned by A.
    const after = (
      await db.execute<{ remaining_quantity: string }>(
        sql`
      select remaining_quantity::text from inventory_provisional_costs
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`,
        "objects",
      )
    )[0]!;
    assert.equal(
      toUnits(after.remaining_quantity),
      toUnits("5"),
      "another subsidiary's receipt settles nothing",
    );

    // B holds a full layer at its own cost; A holds none.
    assert.equal(await layerRemaining(org.orgId, org.items.fifo, subB), toUnits("5"));
    assert.equal(await layerRemaining(org.orgId, org.items.fifo, subA), toUnits("0"));

    // Each entity's GL corroborates its own subledger: A is short 5 @ 10
    // (DR COGS 50 / CR inventory 50), B received 5 @ 12 (DR inventory 60).
    // Before the fix B booked DR inventory 50 + DR COGS 10 with no layer.
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subA),
      toUnits("-50"),
    );
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, subA), toUnits("50"));
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subB),
      toUnits("60"),
    );
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, subB), toUnits("0"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a receipt still settles its own subsidiary's deficit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subA = org.subsidiaryId;
    await allowConfiguredNegative(org);

    await issueInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      subsidiaryId: subA,
      date: org.date,
    });
    // Same-entity receipt at $12 trues up the $10 provisional: the 5 units
    // net the -5 on hand to zero (no layer remains), the asset returns to
    // zero, and the $10 correction lands in COGS.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      unitCost: "12",
      subsidiaryId: subA,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const remaining = (
      await db.execute<{ q: string }>(
        sql`
      select coalesce(sum(remaining_quantity), 0)::text as q from inventory_provisional_costs
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}`,
        "objects",
      )
    )[0]!.q;
    assert.equal(toUnits(remaining), toUnits("0"), "own-entity deficits still settle");
    assert.equal(
      await layerRemaining(org.orgId, org.items.fifo, subA),
      toUnits("0"),
      "settled units net the shortfall, leaving no layer",
    );
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, subA), toUnits("0"));
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, subA), toUnits("60"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

for (const method of ["fifo", "movingAvg"] as const) {
  for (const example of [
    { deficit: "3.0000", quantity: "3.0000", value: "31.0000", remaining: "0.0000" },
    { deficit: "2.9999", quantity: "3.0000", value: "0.0002", remaining: "0.0001" },
    { deficit: "1.0000", quantity: "3.0000", value: "31.0000", remaining: "2.0000" },
  ]) {
    test(
      `authoritative ${method} receipt ${example.value} settles ${example.deficit} without stranded value`,
      { skip: !DB },
      async () => {
        const org = await createScratchOrg();
        try {
          const itemId = org.items[method];
          await db.execute(sql`update item_inventory_profiles set allow_negative_inventory=true,
          negative_cost_basis='configured',provisional_unit_cost='10'
          where org_id=${org.orgId} and item_id=${itemId}`);
          await issueInventory(org.orgId, null, {
            itemId,
            stockLocationId: org.stockLocationId,
            quantity: example.deficit,
            subsidiaryId: org.subsidiaryId,
            date: org.date,
          });
          const input = {
            itemId,
            stockLocationId: org.stockLocationId,
            quantity: example.quantity,
            totalValue: example.value,
            subsidiaryId: org.subsidiaryId,
            offsetAccountId: org.accounts.clearing,
            date: org.date,
            idempotencyKey: randomUUID(),
          };
          const actorId = (await seedFlowActors(org.orgId)).adminId;
          const receive = () =>
            executeIdempotentInventoryAction(org.orgId, actorId, {
              operation: "inventory.receive",
              idempotencyKey: input.idempotencyKey,
              request: input,
              execute: () => receiveInventory(org.orgId, actorId, input),
            });
          const first = await receive();
          assert.equal(first.replayed, false);
          const replay = await receive();
          assert.equal(replay.replayed, true);
          assert.deepEqual(replay.value, first.value);
          const layers = await db.execute<{ q: string; v: string }>(
            sql`
          select remaining_quantity::text q,unit_cost::text v from cost_layers
          where org_id=${org.orgId} and item_id=${itemId}`,
            "objects",
          );
          const { extendCost } = await import("./costing.ts");
          assert.equal(
            layers.reduce((n, l) => n + toUnits(l.q), 0n),
            toUnits(example.remaining),
          );
          const layerValue = layers.reduce((n, l) => n + toUnits(extendCost(l.q, l.v)), 0n);
          assert.equal(
            await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, org.subsidiaryId),
            layerValue,
          );
          assert.equal(
            (await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, org.subsidiaryId)) +
              layerValue,
            toUnits(example.value),
          );
          if (example.remaining === "0.0000") assert.equal(layerValue, 0n);
        } finally {
          await dropScratchOrg(org.orgId);
        }
      },
    );
  }
}
