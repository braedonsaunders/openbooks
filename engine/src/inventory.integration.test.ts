import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  adjustInventory,
  buildAssembly,
  createTransferOrder,
  ensureLot,
  ensureSerial,
  getOnHand,
  issueInventory,
  postLandedCostVoucher,
  queryLotRecall,
  receiveInventory,
  reverseAssemblyBuild,
  receiveTransferOrder,
  reverseInventoryMovement,
  reverseLandedCostVoucher,
  shipTransferOrder,
  transferInventory,
} from "./inventory.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Sum of posted journal_lines on an account (the GL balance). */
async function glBalance(orgId: string, accountId: string): Promise<string> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines where org_id = ${orgId} and account_id = ${accountId}`));
  return r.rows[0]!.bal;
}

/** Σ (remaining_quantity × unit_cost) across every cost layer in the org. */
async function totalLayerValue(orgId: string): Promise<string> {
  const r = (await db.execute<{ v: string }>(sql`
    select (coalesce((select sum(round(remaining_quantity * unit_cost,4)) from cost_layers where org_id=${orgId}),0)
            - coalesce((select sum(round(remaining_quantity * provisional_unit_cost,4)) from inventory_provisional_costs where org_id=${orgId}),0))::text as v`));
  return r.rows[0]!.v;
}

/** Assert every posted journal entry in the org balances to zero. */
async function assertAllEntriesBalance(orgId: string): Promise<void> {
  const r = (await db.execute<{ entry_id: string; bal: string }>(sql`
    select entry_id, sum(amount) as bal from journal_lines where org_id = ${orgId} group by entry_id having sum(amount) <> 0`));
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
    await postLandedCostVoucher(org.orgId, null, {
      amount: "30", basis: "value", freightAccountId: org.accounts.freight,
      subsidiaryId: sub, voucherDate: org.date,
      targets: [{ itemId: org.items.fifo, stockLocationId: loc }],
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
    const evidence = (await db.execute<{ quantity: string; provisional_unit_cost: string; receipt_unit_cost: string; correction_amount: string }>(sql`
      select quantity,provisional_unit_cost,receipt_unit_cost,correction_amount
        from inventory_provisional_settlements where org_id=${org.orgId}
    `));
    assert.equal(evidence.rows.length, 1);
    assert.equal(toUnits(evidence.rows[0]!.correction_amount), toUnits("5"));
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory reversals append exact lineage, restore layers, and are concurrency-idempotent", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const receipt = await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "7.25",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
      memo: "Reversal lineage receipt",
    });
    const issue = await issueInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "3",
      subsidiaryId: org.subsidiaryId,
      date: org.date,
      memo: "Reversal lineage issue",
    });
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity), toUnits("7"));

    const issueReversal = await reverseInventoryMovement(org.orgId, actor, {
      movementId: issue.movementId,
      reversalDate: org.date,
      reason: "Correct an erroneous inventory issue",
    });
    assert.equal(issueReversal.alreadyReversed, false);
    assert.equal(issueReversal.movementIds.length, 1);
    assert.ok(issueReversal.entryId);
    assert.equal(toUnits((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).quantity), toUnits("10"));
    await assertInvariant(org);

    const issueRetry = await reverseInventoryMovement(org.orgId, actor, {
      movementId: issue.movementId,
      reversalDate: org.date,
      reason: "Correct an erroneous inventory issue",
    });
    assert.equal(issueRetry.alreadyReversed, true);
    assert.deepEqual(issueRetry.movementIds, issueReversal.movementIds);

    const receiptReversal = await reverseInventoryMovement(org.orgId, actor, {
      movementId: receipt.movementId,
      reversalDate: org.date,
      reason: "Correct an erroneous inventory receipt",
    });
    assert.equal(receiptReversal.alreadyReversed, false);
    const empty = await getOnHand(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(toUnits(empty.quantity), 0n);
    assert.equal(toUnits(empty.value), 0n);
    await assertInvariant(org);

    const transferReceipt = await receiveInventory(org.orgId, actor, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "8",
      unitCost: "1.125",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    assert.ok(transferReceipt.movementId);
    const transfer = await transferInventory(org.orgId, actor, {
      itemId: org.items.component,
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      quantity: "3",
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    const raced = await Promise.all([
      reverseInventoryMovement(org.orgId, actor, {
        movementId: transfer.fromMovementId,
        reversalDate: org.date,
        reason: "Cancel a warehouse transfer entered in error",
      }),
      reverseInventoryMovement(org.orgId, actor, {
        movementId: transfer.fromMovementId,
        reversalDate: org.date,
        reason: "Cancel a warehouse transfer entered in error",
      }),
    ]);
    assert.equal(raced.filter((result) => !result.alreadyReversed).length, 1);
    assert.equal(raced.filter((result) => result.alreadyReversed).length, 1);
    assert.equal(raced[0]!.movementIds.length, 2);
    assert.deepEqual(raced[0]!.movementIds, raced[1]!.movementIds);
    assert.equal(
      toUnits((await getOnHand(org.orgId, org.items.component, org.stockLocationId)).quantity),
      toUnits("8"),
    );
    assert.equal(
      toUnits((await getOnHand(org.orgId, org.items.component, org.stockLocationId2)).quantity),
      0n,
    );
    await assertInvariant(org);

    const evidence = (await db.execute<{
        reverses_movement_id: string;
        reversal_reason: string;
        created_by: string;
        action: string;
        actor_id: string;
        source_entry_status: string | null;
        reversal_entry_status: string | null;
        reverses_entry_id: string | null;
      }>(sql`
      select m.reverses_movement_id, m.reversal_reason, m.created_by,
             a.action, a.actor_id,
             source.status as source_entry_status,
             reversal.status as reversal_entry_status,
             reversal.reverses_entry_id
        from inventory_movements m
        join audit_log a
          on a.org_id = m.org_id
         and a.table_name = 'inventory_movements'
         and a.row_id = m.reverses_movement_id
        left join journal_entries reversal on reversal.id = m.journal_entry_id
        left join journal_entries source on source.id = reversal.reverses_entry_id
       where m.org_id = ${org.orgId}
         and m.reverses_movement_id is not null
       order by m.created_at, m.id
    `));
    assert.equal(evidence.rows.length, 4);
    for (const row of evidence.rows) {
      assert.ok(row.reverses_movement_id);
      assert.ok(row.reversal_reason.length >= 5);
      assert.equal(row.created_by, actor);
      assert.equal(row.action, "void");
      assert.equal(row.actor_id, actor);
      if (row.reverses_entry_id) {
        assert.equal(row.source_entry_status, "reversed");
        assert.equal(row.reversal_entry_status, "posted");
      }
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("landed costs preserve the GL-to-layer invariant to the smallest ledger unit across every basis", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "3",
      unitCost: "1",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "7",
      unitCost: "2",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });

    await postLandedCostVoucher(org.orgId, actor, {
      amount: "0.0001",
      basis: "quantity",
      freightAccountId: org.accounts.freight,
      subsidiaryId: org.subsidiaryId,
      voucherDate: org.date,
      memo: "Minimum-unit landed cost",
      targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
    });
    await assertInvariant(org);

    const targets = [
      {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
      },
      {
        itemId: org.items.component,
        stockLocationId: org.stockLocationId,
      },
    ];
    await postLandedCostVoucher(org.orgId, actor, {
      amount: "0.0003",
      basis: "manual",
      freightAccountId: org.accounts.freight,
      subsidiaryId: org.subsidiaryId,
      voucherDate: org.date,
      targets: [
        { ...targets[0]!, manualAmount: "0.0001" },
        { ...targets[1]!, manualAmount: "0.0002" },
      ],
    });
    await assertInvariant(org);
    for (const basis of ["value", "quantity"] as const) {
      await postLandedCostVoucher(org.orgId, actor, {
        amount: "0.0001",
        basis,
        freightAccountId: org.accounts.freight,
        subsidiaryId: org.subsidiaryId,
        voucherDate: org.date,
        targets,
      });
      await assertInvariant(org);
    }

    const openLayers = (await db.execute<{ id: string }>(sql`
      select id
        from cost_layers
       where org_id = ${org.orgId} and remaining_quantity > 0
    `));
    for (const layer of openLayers.rows) {
      await db.execute(sql`
        insert into cost_layer_weights (org_id, cost_layer_id, weight, created_by, updated_by)
        values (${org.orgId}, ${layer.id}, '1', ${actor}, ${actor})
      `);
    }
    const weightVoucher = await postLandedCostVoucher(org.orgId, actor, {
      amount: "0.0001",
      basis: "weight",
      freightAccountId: org.accounts.freight,
      subsidiaryId: org.subsidiaryId,
      voucherDate: org.date,
      targets,
    });
    await assertInvariant(org);
    const reversal = await reverseLandedCostVoucher(org.orgId, actor, {
      voucherId: weightVoucher.id,
      reversalDate: org.date,
      reason: "Controlled reversal of weight-basis landed cost",
    });
    assert.equal(reversal.alreadyReversed, false);
    assert.ok(reversal.reversedAllocations > 0);
    const retry = await reverseLandedCostVoucher(org.orgId, actor, {
      voucherId: weightVoucher.id,
      reversalDate: org.date,
      reason: "Controlled reversal of weight-basis landed cost",
    });
    assert.deepEqual(retry, { ...reversal, alreadyReversed: true });
    await assertInvariant(org);
    await assert.rejects(db.execute(sql`
      update landed_cost_vouchers set amount = amount + 1
       where id = ${weightVoucher.id}
    `));
    await assert.rejects(db.execute(sql`
      delete from landed_cost_allocations
       where voucher_id = ${weightVoucher.id}
         and reverses_allocation_id is null
    `));

    const evidence = (await db.execute<{
        allocated: string;
        allocation_rows: number;
        unlinked: number;
        vouchers: number;
        void_vouchers: number;
      }>(sql`
      select coalesce(sum(amount), 0)::text as allocated,
             count(*)::int as allocation_rows,
             count(*) filter (where journal_entry_id is null)::int as unlinked,
             (select count(*)::int
                from landed_cost_vouchers
               where org_id = ${org.orgId} and status = 'posted') as vouchers,
             (select count(*)::int
                from landed_cost_vouchers
               where org_id = ${org.orgId} and status = 'void') as void_vouchers
        from landed_cost_allocations
       where org_id = ${org.orgId}
    `));
    assert.equal(toUnits(evidence.rows[0]!.allocated), toUnits("0.0006"));
    assert.ok(evidence.rows[0]!.allocation_rows >= 6);
    assert.equal(evidence.rows[0]!.unlinked, 0);
    // quantity + manual + value + quantity remain posted; the weight voucher
    // is the independently preserved void below.
    assert.equal(evidence.rows[0]!.vouchers, 4);
    assert.equal(evidence.rows[0]!.void_vouchers, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory locks prevent oversell and transfer-order failures roll back every movement and GL line", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "5",
      unitCost: "4",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const transferRace = await Promise.allSettled([
      transferInventory(org.orgId, actor, {
        itemId: org.items.fifo,
        fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2,
        quantity: "4",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      transferInventory(org.orgId, actor, {
        itemId: org.items.fifo,
        fromStockLocationId: org.stockLocationId,
        toStockLocationId: org.stockLocationId2,
        quantity: "4",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
    ]);
    assert.equal(
      transferRace.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      transferRace.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.equal(
      toUnits(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId))
          .quantity,
      ),
      toUnits("1"),
    );
    await assertInvariant(org);

    await receiveInventory(org.orgId, actor, {
      itemId: org.items.component,
      stockLocationId: org.stockLocationId,
      quantity: "6",
      unitCost: "1",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const buildRace = await Promise.allSettled([
      buildAssembly(org.orgId, actor, {
        assemblyItemId: org.items.assembly,
        quantity: "2",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      buildAssembly(org.orgId, actor, {
        assemblyItemId: org.items.assembly,
        quantity: "2",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
    ]);
    assert.equal(
      buildRace.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      buildRace.filter((result) => result.status === "rejected").length,
      1,
    );
    const built = buildRace.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof buildAssembly>>> =>
        result.status === "fulfilled",
    )!.value;
    const buildReversal = await reverseAssemblyBuild(org.orgId, actor, {
      movementId: built.movementId,
      reversalDate: org.date,
      reason: "Controlled reversal of concurrency build",
    });
    assert.equal(buildReversal.alreadyReversed, false);
    assert.equal(
      buildReversal.movementIds.length,
      2,
      "one finished-good and one component movement must reverse together",
    );
    const buildRetry = await reverseAssemblyBuild(org.orgId, actor, {
      movementId: built.movementId,
      reversalDate: org.date,
      reason: "Controlled reversal of concurrency build",
    });
    assert.equal(buildRetry.alreadyReversed, true);
    assert.deepEqual(buildRetry.movementIds, buildReversal.movementIds);
    assert.equal(
      toUnits(
        (await getOnHand(
          org.orgId,
          org.items.component,
          org.stockLocationId,
        )).quantity,
      ),
      toUnits("6"),
    );
    assert.equal(
      toUnits(
        (await getOnHand(
          org.orgId,
          org.items.assembly,
          org.stockLocationId,
        )).quantity,
      ),
      0n,
    );
    await assertInvariant(org);

    const transitLocationId = randomUUID();
    await db.execute(sql`
      insert into stock_locations
        (id, org_id, location_id, code, kind, is_active)
      values
        (${transitLocationId}, ${org.orgId}, ${org.locationId},
         'TRANSIT', 'transit', true)
    `);
    const summaryAccountId = randomUUID();
    await db.execute(sql`
      insert into accounts
        (id, org_id, number, name, type, is_summary, is_active, eliminate,
         reconcilable, required_dimensions, custom, subsidiary_include_children)
      values
        (${summaryAccountId}, ${org.orgId}, '9998', 'Invalid summary transit',
         'asset_current_other', true, true, false, false, '[]'::jsonb,
         '{}'::jsonb, true)
    `);
    const order = await createTransferOrder(org.orgId, actor, {
      fromStockLocationId: org.stockLocationId2,
      toStockLocationId: org.stockLocationId,
      transitStockLocationId: transitLocationId,
      inTransitAccountId: summaryAccountId,
      subsidiaryId: org.subsidiaryId,
      orderedOn: org.date,
      lines: [{ itemId: org.items.fifo, quantity: "1" }],
    });
    const beforeSource = await getOnHand(
      org.orgId,
      org.items.fifo,
      org.stockLocationId2,
    );
    await assert.rejects(
      shipTransferOrder(org.orgId, actor, order.id, org.date),
    );
    assert.equal(
      toUnits(
        (await getOnHand(org.orgId, org.items.fifo, org.stockLocationId2))
          .quantity,
      ),
      toUnits(beforeSource.quantity),
    );
    assert.equal(
      toUnits(
        (await getOnHand(org.orgId, org.items.fifo, transitLocationId))
          .quantity,
      ),
      0n,
    );
    const orderState = (await db.execute<{ status: string; ship_movement_id: string | null }>(sql`
      select o.status, l.ship_movement_id
        from transfer_orders o
        join transfer_order_lines l on l.transfer_order_id = o.id
       where o.id = ${order.id} and o.org_id = ${org.orgId}
    `));
    assert.deepEqual(orderState.rows[0], {
      status: "draft",
      ship_movement_id: null,
    });
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("lot and serial selection is tenant-bound, exact, and lifecycle controlled", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const otherActor = (await seedFlowActors(other.orgId)).adminId;
    await db.execute(sql`
      update item_inventory_profiles
         set tracking = 'lot'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}
    `);
    const lotA = await ensureLot(
      org.orgId,
      org.items.fifo,
      "LOT-A",
      "2027-12-31",
      actor,
    );
    const lotB = await ensureLot(
      org.orgId,
      org.items.fifo,
      "LOT-B",
      null,
      actor,
    );
    const foreignLot = await ensureLot(
      other.orgId,
      other.items.fifo,
      "LOT-FOREIGN",
      null,
      otherActor,
    );
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "2",
      unitCost: "1",
      lotId: lotA,
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "3",
      unitCost: "2",
      lotId: lotB,
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await assert.rejects(
      issueInventory(org.orgId, actor, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "1",
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      /requires a lot/,
    );
    await assert.rejects(
      issueInventory(org.orgId, actor, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "3",
        lotId: lotA,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      }),
      /insufficient stock/,
    );
    await assert.rejects(
      receiveInventory(org.orgId, actor, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "1",
        unitCost: "1",
        lotId: foreignLot,
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
      /lot must belong/,
    );
    await issueInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "1",
      lotId: lotA,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    const recall = await queryLotRecall(org.orgId, { lotId: lotA });
    assert.equal(recall.length, 2);

    await db.execute(sql`
      update item_inventory_profiles
         set tracking = 'serial'
       where org_id = ${org.orgId} and item_id = ${org.items.standard}
    `);
    const serialId = await ensureSerial(
      org.orgId,
      org.items.standard,
      "SER-001",
      org.stockLocationId,
      actor,
    );
    const registered = (await db.execute<{ status: string; current_stock_location_id: string | null }>(sql`
      select status, current_stock_location_id
        from serials
       where id = ${serialId}
    `));
    assert.deepEqual(registered.rows[0], {
      status: "registered",
      current_stock_location_id: null,
    });
    const receipt = await receiveInventory(org.orgId, actor, {
      itemId: org.items.standard,
      stockLocationId: org.stockLocationId,
      quantity: "1",
      unitCost: "2.2",
      serialId,
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    assert.ok(receipt.entryId);
    await assert.rejects(
      db.execute(sql`
        update serials
           set status = 'shipped', current_stock_location_id = null
         where id = ${serialId}
      `),
    );
    await assert.rejects(
      db.execute(sql`
        update serials
           set current_stock_location_id = ${org.stockLocationId2}
         where id = ${serialId}
      `),
    );
    await assert.rejects(
      db.execute(sql`
        update lots set expires_on = '2028-01-01' where id = ${lotA}
      `),
    );
    await assert.rejects(
      receiveInventory(org.orgId, actor, {
        itemId: org.items.standard,
        stockLocationId: org.stockLocationId,
        quantity: "1",
        unitCost: "2.2",
        serialId,
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
      /already has posted inventory movement history/,
    );
    await transferInventory(org.orgId, actor, {
      itemId: org.items.standard,
      fromStockLocationId: org.stockLocationId,
      toStockLocationId: org.stockLocationId2,
      quantity: "1",
      serialId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    const issue = await issueInventory(org.orgId, actor, {
      itemId: org.items.standard,
      stockLocationId: org.stockLocationId2,
      quantity: "1",
      serialId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    let serial = (await db.execute<{ status: string; current_stock_location_id: string | null }>(sql`
      select status, current_stock_location_id
        from serials
       where id = ${serialId}
    `));
    assert.deepEqual(serial.rows[0], {
      status: "shipped",
      current_stock_location_id: null,
    });
    await reverseInventoryMovement(org.orgId, actor, {
      movementId: issue.movementId,
      reversalDate: org.date,
      reason: "Customer shipment was entered in error",
    });
    serial = (await db.execute<{ status: string; current_stock_location_id: string | null }>(sql`
      select status, current_stock_location_id
        from serials
       where id = ${serialId}
    `));
    assert.deepEqual(serial.rows[0], {
      status: "in_stock",
      current_stock_location_id: org.stockLocationId2,
    });
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(other.orgId);
    await dropScratchOrg(org.orgId);
  }
});
