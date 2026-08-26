import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import { db, env } from "./db.ts";
import { fromUnits, toUnits } from "./money.ts";
import {
  adjustInventory,
  assertCostingPolicyChangeAllowed,
  buildAssembly,
  CostingPolicyChangeBlockedError,
  createTransferOrder,
  ensureLot,
  ensureSerial,
  executeIdempotentInventoryAction,
  getOnHand,
  InventoryIdempotencyConflictError,
  issueInventory,
  lockItemInventoryProfile,
  parseCostingMethod,
  parseTrackingMode,
  postLandedCostVoucher,
  queryLotRecall,
  receiveInventory,
  reverseAssemblyBuild,
  receiveTransferOrder,
  reverseInventoryMovement,
  reverseLandedCostVoucher,
  revalueOpenLayersToStandardCost,
  shipTransferOrder,
  transferInventory,
} from "./inventory.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";
import { postDocument } from "./posting.ts";

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

async function draftApprovedInventoryBill(
  org: ScratchOrg,
  lines: Array<{
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    stockLocationId?: string;
  }>,
): Promise<string> {
  const documentId = randomUUID();
  const total = fromUnits(
    lines.reduce((sum, line) => sum + toUnits(line.amount), 0n),
  );
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values (${documentId}, ${org.orgId}, 'vendor_bill', 'BILL-RECEIPT-ATOMIC',
            ${org.vendorId}, null, ${org.date}, ${org.date}, 'CAD', 1,
            'approved', ${total}, '0', ${total}, '{}'::jsonb)`);
  for (const [index, line] of lines.entries()) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id, quantity,
         unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
         quantity_billed, stock_location_id, custom, tax_overridden)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, ${index + 1},
              ${line.itemId}, null, ${line.quantity}, ${line.unitPrice},
              ${line.amount}, '0', false, '0', '0',
              ${line.stockLocationId ?? org.stockLocationId}, '{}'::jsonb,
              false)`);
  }
  return documentId;
}

async function createSubsidiaryRestrictedStockLocation(
  org: ScratchOrg,
): Promise<string> {
  const subsidiaryId = randomUUID();
  const locationId = randomUUID();
  const stockLocationId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries
      (id, org_id, parent_id, name, base_currency, country, tax_ids,
       is_elimination, is_active, custom)
    values (${subsidiaryId}, ${org.orgId}, ${org.subsidiaryId},
            'Receipt Failure Subsidiary', 'CAD', 'CA', '{}'::jsonb,
            false, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into locations
      (id, org_id, code, name, is_active, custom,
       subsidiary_include_children, subsidiary_id)
    values (${locationId}, ${org.orgId}, 'FAIL-RECEIPT',
            'Receipt Failure Warehouse', true, '{}'::jsonb, true,
            ${subsidiaryId})`);
  await db.execute(sql`
    insert into stock_locations
      (id, org_id, location_id, code, kind, is_active)
    values (${stockLocationId}, ${org.orgId}, ${locationId}, 'RESTRICTED',
            'warehouse', true)`);
  return stockLocationId;
}

async function billInventoryResidue(
  orgId: string,
  documentId: string,
): Promise<{
  status: string;
  movements: number;
  layers: number;
  sourceEntries: number;
  effectRows: number;
}> {
  const result = (await db.execute<{
    status: string;
    movements: number;
    layers: number;
    source_entries: number;
    effect_rows: number;
  }>(sql`
    select d.status,
           (select count(*)::int
              from inventory_movements m
              join document_lines dl on dl.id = m.document_line_id
             where dl.document_id = d.id and m.org_id = d.org_id) as movements,
           (select count(*)::int
              from cost_layers cl
              join inventory_movements m on m.id = cl.source_movement_id
              join document_lines dl on dl.id = m.document_line_id
             where dl.document_id = d.id and cl.org_id = d.org_id) as layers,
           (select count(*)::int from journal_entries e
             where e.org_id = d.org_id and e.source_document_id = d.id) as source_entries,
           (select count(*)::int from posting_effects pe
             where pe.org_id = d.org_id and pe.document_id = d.id) as effect_rows
      from documents d
     where d.org_id = ${orgId} and d.id = ${documentId}`));
  const row = result.rows[0]!;
  return {
    status: row.status,
    movements: row.movements,
    layers: row.layers,
    sourceEntries: row.source_entries,
    effectRows: row.effect_rows,
  };
}

test("vendor-bill receipt lines post atomically and a repaired bill retries cleanly", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const restrictedLocationId =
      await createSubsidiaryRestrictedStockLocation(org);
    const billId = await draftApprovedInventoryBill(org, [
      {
        itemId: org.items.fifo,
        quantity: "10",
        unitPrice: "2",
        amount: "20",
      },
      {
        itemId: org.items.movingAvg,
        quantity: "5",
        unitPrice: "3",
        amount: "15",
        stockLocationId: restrictedLocationId,
      },
    ]);
    const deps = {
      control: {
        ar: org.accounts.ar,
        ap: org.accounts.ap,
        bank: org.accounts.bank,
      },
    };

    // The second line fails only after the first receipt has executed. The
    // bill, every receipt/layer, its GL, and its durable effect must roll back.
    await assert.rejects(() => postDocument(billId, deps), /restricted/i);
    assert.deepEqual(await billInventoryResidue(org.orgId, billId), {
      status: "approved",
      movements: 0,
      layers: 0,
      sourceEntries: 0,
      effectRows: 0,
    });
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.ap)), 0n);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.invAsset)), 0n);
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.clearing)), 0n);

    await db.execute(sql`
      update locations
         set subsidiary_id = null
       where org_id = ${org.orgId}
         and id = (
           select location_id from stock_locations
            where org_id = ${org.orgId} and id = ${restrictedLocationId}
         )`);
    assert.ok(await postDocument(billId, deps));

    assert.deepEqual(await billInventoryResidue(org.orgId, billId), {
      status: "posted",
      movements: 2,
      layers: 2,
      sourceEntries: 1,
      effectRows: 1,
    });
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.ap)),
      toUnits("-35"),
    );
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.invAsset)),
      toUnits("35"),
    );
    assert.equal(toUnits(await glBalance(org.orgId, org.accounts.clearing)), 0n);
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

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

    const legacyRecallLimit = 500;
    await db.execute(sql`
      insert into inventory_movements
        (org_id, item_id, kind, moved_at, stock_location_id, lot_id,
         quantity, unit_cost, total_value, status, created_by, updated_by)
      select ${org.orgId}, ${org.items.fifo}, 'receipt',
             ${org.date}::date + generated.n * interval '1 second',
             ${org.stockLocationId}, ${lotA}, 1, 1, 1, 'posted',
             ${actor}, ${actor}
        from generate_series(1, ${legacyRecallLimit - 1}) as generated(n)
    `);
    const completeRecall = await queryLotRecall(org.orgId, { lotId: lotA });
    assert.equal(completeRecall.length, legacyRecallLimit + 1);
    assert.equal(
      new Set(completeRecall.map((movement) => movement.movementId)).size,
      legacyRecallLimit + 1,
    );

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

// ---------------------------------------------------------------------------
// Positive adjustment default cost must be read under the position lock
// ---------------------------------------------------------------------------

/** The engine's advisory key split into the (classid, objid) halves pg_locks shows. */
async function positionLockHalves(key: string): Promise<{ classid: bigint; objid: bigint }> {
  const r = (await db.execute<{ key: string }>(sql`
    select hashtextextended(${key}, 0)::text as key`));
  const wide = BigInt.asUintN(64, BigInt(r.rows[0]!.key));
  return { classid: wide >> 32n, objid: wide & 0xffffffffn };
}

test("positive adjustment values stock at the average prevailing under the position lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sub = org.subsidiaryId;
    const loc = org.stockLocationId;

    // Seed the moving-average position: 10 units @ 10.00 → average 10.00.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.movingAvg,
      stockLocationId: loc,
      quantity: "10",
      unitCost: "10.00",
      subsidiaryId: sub,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    await assertInvariant(org);

    // A competing writer holds the position lock while an adjustment is in
    // flight, and commits a re-blend of the average to 20.00 inside that
    // window. The mutation is direct SQL so the interleaving stays
    // deterministic — a second receiveInventory call would queue on the same
    // advisory key behind this holder. The GL legs book exactly what a real
    // receipt blending the layer to 20.00 would leave behind (+100 asset),
    // keeping GL = Σ layer value intact for the invariant below.
    const competitor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    await competitor.connect();
    let committed = false;
    let adjustment: ReturnType<typeof adjustInventory> | undefined;
    try {
      await competitor.query("begin");
      await competitor.query(
        "select set_config('app.bypass_rls', 'on', true)",
      );
      const lockKey = `inventory:${org.items.movingAvg}:${loc}`;
      await competitor.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [lockKey],
      );

      // Fire the write-up with no explicit unit cost. adjustInventory reads
      // its default cost from on-hand BEFORE receiveInventory requests the
      // position lock, so once this promise is queued on the advisory key
      // that pre-lock read is already done and holds the stale average.
      const pending = adjustInventory(org.orgId, null, {
        itemId: org.items.movingAvg,
        stockLocationId: loc,
        quantityDelta: "10",
        subsidiaryId: sub,
        date: org.date,
      });
      adjustment = pending;

      // Deterministic rendezvous: block until the adjustment is queued on the
      // position lock — proof its default-cost read has already executed.
      const halves = await positionLockHalves(lockKey);
      let queued = false;
      for (let waited = 0; waited < 10_000 && !queued; waited += 25) {
        const waiter = (await db.execute(sql`
          select 1 from pg_locks
           where locktype = 'advisory' and granted = false
             and classid::bigint = ${halves.classid}
             and objid::bigint = ${halves.objid}`));
        queued = waiter.rows.length > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(queued, true, "adjustment never queued on the inventory position lock");

      // The committed re-blend lands AFTER the adjustment's cost read but
      // BEFORE its locked posting: exactly the staleness window.
      await competitor.query(
        `update cost_layers set unit_cost = '20' where org_id = $1 and item_id = $2 and stock_location_id = $3`,
        [org.orgId, org.items.movingAvg, loc],
      );
      const entry = await competitor.query<{ id: string }>(
        `insert into journal_entries
           (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'Competing receipt re-blend', 'draft', 'inventory', null, null)
         returning id`,
        [
          org.orgId,
          org.bookId,
          sub,
          `INV-RCPT-${org.date}-${loc.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
          org.date,
          org.periodId,
        ],
      );
      const entryId = entry.rows[0]!.id;
      for (const [lineNumber, accountId, amount] of [
        [1, org.accounts.invAsset, "100.0000"],
        [2, org.accounts.clearing, "-100.0000"],
      ] as const) {
        await competitor.query(
          `insert into journal_lines
             (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
           values ($1, $2, $3, $4, $5, $6, 'CAD', $6, 1)`,
          [org.orgId, entryId, lineNumber, accountId, sub, amount],
        );
      }
      await competitor.query(
        `update journal_entries set status = 'posted', posted_at = now() where id = $1 and org_id = $2`,
        [entryId, org.orgId],
      );
      await competitor.query("commit");
      committed = true;

      await pending;

      // The write-up must value its 10 units at the locked-in current
      // average of 20.00 — not the stale 10.00 it observed before parking:
      // 10 @ 20 carried + 10 @ 20 written up = 400 over 20 units.
      const onHand = await getOnHand(org.orgId, org.items.movingAvg, loc);
      assert.equal(toUnits(onHand.quantity), toUnits("20"));
      assert.equal(toUnits(onHand.value), toUnits("400"));
      assert.equal(toUnits(onHand.unitCost), toUnits("20"));
      const movement = (await db.execute<{ unit_cost: string; total_value: string }>(sql`
        select unit_cost, total_value from inventory_movements
         where org_id = ${org.orgId} and item_id = ${org.items.movingAvg}
           and stock_location_id = ${loc} and kind = 'receipt'
         order by created_at desc, id desc limit 1`));
      assert.equal(toUnits(movement.rows[0]!.unit_cost), toUnits("20"));
      assert.equal(toUnits(movement.rows[0]!.total_value), toUnits("200"));
      await assertInvariant(org);
    } finally {
      if (!committed) {
        await competitor.query("rollback").catch(() => {});
        await adjustment?.catch(() => {});
      }
      await competitor.end();
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

// ---------------------------------------------------------------------------
// Costing policy changes are controlled, and flipped multi-layer positions
// degrade safely instead of violating cost_layers_remaining
// ---------------------------------------------------------------------------

test("costing method and tracking flips are guarded, revalued under standard, and multi-layer moving average stays consumable", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const sub = org.subsidiaryId;
    const loc = org.stockLocationId;

    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "10", unitCost: "5",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "10", unitCost: "7",
      subsidiaryId: sub, offsetAccountId: org.accounts.clearing, date: org.date,
    });
    const current = await lockItemInventoryProfile(db, org.orgId, org.items.fifo);
    assert.equal(current?.costing_method, "fifo");
    const flip = { costingMethod: "moving_average" as const, tracking: "none" as const };

    await assert.rejects(
      assertCostingPolicyChangeAllowed(db, org.orgId, org.items.fifo, current, flip, null),
      CostingPolicyChangeBlockedError,
    );
    await assert.rejects(
      assertCostingPolicyChangeAllowed(db, org.orgId, org.items.fifo, current, flip, "no"),
      CostingPolicyChangeBlockedError,
    );
    const unchanged = await lockItemInventoryProfile(db, org.orgId, org.items.fifo);
    assert.equal(unchanged?.costing_method, "fifo");

    assert.deepEqual(
      await assertCostingPolicyChangeAllowed(
        db, org.orgId, org.items.fifo, current, flip,
        "Adopt blended costing for the legacy strata per controller approval",
      ),
      { changed: true, historyExisted: true },
    );
    await db.execute(sql`
      update item_inventory_profiles set costing_method = 'moving_average'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}
    `);

    // The reported reproduction: issue 15 across two strata under moving
    // average. It must price across layers exactly instead of charging all 15
    // to layers[0] (which drove it to -5 and tripped check constraint 23514).
    const degradedIssue = await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "15",
      subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits(degradedIssue.value), toUnits("-85")); // 10x5 + 5x7
    let onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.quantity), toUnits("5"));
    assert.equal(toUnits(onHand.value), toUnits("35"));
    await assertInvariant(org);

    // A controlled switch to standard revalues open layers onto the standard
    // cost through one balanced variance entry.
    const calendar = (await db.execute<{ id: string }>(sql`
      select id from fiscal_calendars where org_id = ${org.orgId} limit 1`));
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId},
             extract(year from current_date)::int,
             extract(month from current_date)::int,
             to_char(current_date, 'YYYY-MM'),
             date_trunc('month', current_date)::date,
             (date_trunc('month', current_date) + interval '1 month - 1 day')::date,
             false, ${calendar.rows[0]!.id}
    `);
    await db.execute(sql`
      update item_inventory_profiles set standard_cost = '10'
       where org_id = ${org.orgId} and item_id = ${org.items.fifo}
    `);
    const assetBefore = await glBalance(org.orgId, org.accounts.invAsset);
    const varianceBefore = await glBalance(org.orgId, org.accounts.adjustment);
    const revaluationEntryId = await db.transaction((tx) =>
      revalueOpenLayersToStandardCost(tx, org.orgId, null, org.items.fifo, {
        standardCost: "10",
        assetAccountId: org.accounts.invAsset,
        varianceAccountId: org.accounts.adjustment,
      }));
    assert.ok(revaluationEntryId);
    onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.value), toUnits("50"));
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.invAsset)) - toUnits(assetBefore),
      toUnits("15"),
    );
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.adjustment)) - toUnits(varianceBefore),
      toUnits("-15"),
    );
    await assertInvariant(org);

    // Standard issues now relieve layers exactly at standard.
    const stdIssue = await issueInventory(org.orgId, null, {
      itemId: org.items.fifo, stockLocationId: loc, quantity: "5",
      subsidiaryId: sub, date: org.date,
    });
    assert.equal(toUnits(stdIssue.value), toUnits("-50"));
    onHand = await getOnHand(org.orgId, org.items.fifo, loc);
    assert.equal(toUnits(onHand.quantity), 0n);
    assert.equal(toUnits(onHand.value), 0n);
    await assertInvariant(org);

    await assert.rejects(
      assertCostingPolicyChangeAllowed(
        db, org.orgId, org.items.fifo,
        await lockItemInventoryProfile(db, org.orgId, org.items.fifo),
        { costingMethod: "moving_average", tracking: "lot" },
        "authorize despite incompatibility",
      ),
      /incompatible/,
    );

    assert.equal(parseCostingMethod(undefined), null);
    assert.equal(parseCostingMethod(null), null);
    assert.equal(parseCostingMethod(""), null);
    assert.equal(parseCostingMethod("FIFO"), null);
    assert.equal(parseCostingMethod(true), null);
    assert.equal(parseTrackingMode("serial"), "serial");
    assert.equal(parseTrackingMode("lot"), "lot");
    assert.equal(parseTrackingMode("none"), "none");
    assert.equal(parseTrackingMode(undefined), null);
    assert.equal(parseTrackingMode("unknown"), null);
    assert.equal(await lockItemInventoryProfile(db, org.orgId, org.items.service), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the costing route requires explicit costing policies and maps blocked flips to 409", () => {
  const route = readFileSync(
    new URL("../../web/app/api/items/[id]/costing/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /parseCostingMethod\(body\.costingMethod\)/);
  assert.match(route, /parseTrackingMode\(body\.tracking\)/);
  assert.match(route, /costingMethod must be one of fifo, moving_average, or standard/);
  assert.doesNotMatch(route, /\?\s*'moving_average'/);
  assert.doesNotMatch(route, /:\s*'moving_average'/);
  assert.doesNotMatch(route, /\?\s*'none'/);
  assert.match(route, /status: 422/);
  assert.match(route, /CostingPolicyChangeBlockedError/);
  assert.match(route, /status: 409/);
  assert.match(route, /recostingAuthorization/);
  assert.match(route, /before: before \?\? null/);
  assert.match(route, /revalueOpenLayersToStandardCost/);
});

// ---------------------------------------------------------------------------
// Direct HTTP inventory actions replay through the canonical idempotency
// boundary — one client key, one accounting unit, serially and concurrently
// ---------------------------------------------------------------------------

test("direct inventory action retries replay the stored result without duplicating accounting units", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const receiveOnce = (idempotencyKey: string, quantity = "10") => {
      const input = {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity,
        unitCost: "2.50",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
        memo: "HTTP retry identity",
      };
      return executeIdempotentInventoryAction(org.orgId, actor, {
        operation: "inventory.receive",
        idempotencyKey,
        request: input,
        execute: () => receiveInventory(org.orgId, actor, input),
      });
    };
    const receiptCount = async () =>
      (
        await db.execute<{ n: string }>(sql`
          select count(*)::text as n from inventory_movements
           where org_id = ${org.orgId} and item_id = ${org.items.fifo}
             and stock_location_id = ${org.stockLocationId}
             and kind = 'receipt'`)
      ).rows[0]!.n;

    // Representative concurrent replay: three racing resends of ONE lost
    // request. Exactly one accounting unit posts; the losers replay its
    // committed result.
    const glBefore = await glBalance(org.orgId, org.accounts.invAsset);
    const key = `http-retry-${randomUUID()}`;
    const raced = await Promise.all([receiveOnce(key), receiveOnce(key), receiveOnce(key)]);
    assert.equal(
      new Set(raced.map((r) => r.value.movementId)).size,
      1,
      "a retried key must not duplicate the movement",
    );
    assert.deepEqual(
      raced.map((r) => r.value.value),
      [raced[0]!.value.value, raced[0]!.value.value, raced[0]!.value.value],
    );
    assert.equal(raced.filter((r) => !r.replayed).length, 1);
    assert.equal(await receiptCount(), "1");
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.invAsset)) -
        toUnits(glBefore),
      toUnits("25"),
      "10 × 2.50 must hit the inventory GL exactly once",
    );

    // A later serial resend of the same lost response replays the committed
    // evidence (the crash-after-commit case) instead of posting again.
    const serialReplay = await receiveOnce(key);
    assert.equal(serialReplay.replayed, true);
    assert.deepEqual(serialReplay.value, raced[0]!.value);
    assert.equal(await receiptCount(), "1");

    // Same key with different input is a conflict and never a second posting.
    await assert.rejects(receiveOnce(key, "11"), InventoryIdempotencyConflictError);
    assert.equal(await receiptCount(), "1");

    // Distinct-key happy control: a NEW key creates a NEW action.
    const glBetween = await glBalance(org.orgId, org.accounts.invAsset);
    const fresh = await receiveOnce(`http-retry-${randomUUID()}`);
    assert.equal(fresh.replayed, false);
    assert.notEqual(fresh.value.movementId, raced[0]!.value.movementId);
    assert.equal(
      toUnits(await glBalance(org.orgId, org.accounts.invAsset)) -
        toUnits(glBetween),
      toUnits("25"),
    );
    assert.equal(await receiptCount(), "2");

    // A rolled-back attempt never burns its key: the failed claim shares the
    // command's transaction, so the same key completes a fresh action after.
    const burned = `rolled-back-${randomUUID()}`;
    const overIssue = {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "9999",
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    };
    await assert.rejects(
      executeIdempotentInventoryAction(org.orgId, actor, {
        operation: "inventory.issue",
        idempotencyKey: burned,
        request: overIssue,
        execute: () => issueInventory(org.orgId, actor, overIssue),
      }),
      /insufficient stock/,
    );
    const recovered = await executeIdempotentInventoryAction(org.orgId, actor, {
      operation: "inventory.issue",
      idempotencyKey: burned,
      request: { ...overIssue, quantity: "2" },
      execute: () =>
        issueInventory(org.orgId, actor, { ...overIssue, quantity: "2" }),
    });
    assert.equal(recovered.replayed, false);

    // Fail closed: no key, no ledger touch — the boundary owns the contract.
    await assert.rejects(
      executeIdempotentInventoryAction(org.orgId, actor, {
        operation: "inventory.receive",
        idempotencyKey: undefined,
        request: {},
        execute: () => Promise.resolve({ movementId: "nope", entryId: null, value: "0" }),
      }),
      /idempotencyKey/,
    );
    await assertInvariant(org);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("both inventory HTTP routes thread every monetary action through the idempotency boundary", () => {
  const actionsRoute = readFileSync(
    new URL("../../web/app/api/inventory/actions/route.ts", import.meta.url),
    "utf8",
  );
  for (const operation of [
    "inventory.receive",
    "inventory.issue",
    "inventory.adjust",
    "inventory.transfer",
    "inventory.build",
    "inventory.landed",
    "inventory.reverse",
  ]) {
    assert.match(actionsRoute, new RegExp(`operation: '${operation}'`));
  }
  assert.match(actionsRoute, /executeIdempotentInventoryAction/);
  assert.match(actionsRoute, /idempotencyKey: body\.idempotencyKey/);
  // Key reuse with different input maps to 409, ahead of InventoryError's 422.
  assert.match(actionsRoute, /instanceof InventoryIdempotencyConflictError[\s\S]*?\? 409/);

  const advancedRoute = readFileSync(
    new URL("../../web/app/api/inventory/advanced/route.ts", import.meta.url),
    "utf8",
  );
  for (const operation of [
    "inventory.transfer-order.create",
    "inventory.transfer-order.ship",
    "inventory.transfer-order.receive",
    "inventory.landed-voucher.post",
  ]) {
    assert.match(advancedRoute, new RegExp(`"${operation}"`));
  }
  assert.match(advancedRoute, /executeIdempotentInventoryAction/);
  assert.match(advancedRoute, /instanceof InventoryIdempotencyConflictError[\s\S]*?\? 409/);
  // Catalog-only ensures mint identifiers and stay OUTSIDE the replay boundary.
  assert.match(advancedRoute, /await ensureLot\(orgId/);
  assert.match(advancedRoute, /await ensureSerial\(orgId/);
});
