import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  applyInventoryReturnsForVendorCredit,
  ensureLot,
  ensureSerial,
  getOnHand,
  issueInventory,
  parseVendorCreditInventoryReturnSelection,
  receiveInventory,
} from "./inventory.ts";
import { toUnits } from "./money.ts";
import { postDocument, PostingError } from "./posting.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const docsSource = readFileSync(
  new URL("../../web/lib/docs/articles/daily-workflows.ts", import.meta.url),
  "utf8",
);

const depsFor = (org: ScratchOrg) => ({
  control: {
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    bank: org.accounts.bank,
  },
});

async function glBalance(orgId: string, accountId: string): Promise<string> {
  return (await db.execute<{ balance: string }>(sql`
    select coalesce(sum(amount), 0)::text as balance
      from journal_lines
     where org_id = ${orgId} and account_id = ${accountId}
  `)).rows[0]!.balance;
}

async function layerValue(orgId: string, itemId: string): Promise<string> {
  return (await db.execute<{ value: string }>(sql`
    select coalesce(sum(round(remaining_quantity * unit_cost, 4)), 0)::text as value
      from cost_layers
     where org_id = ${orgId} and item_id = ${itemId}
  `)).rows[0]!.value;
}

async function createApprovedVendorReturn(
  org: ScratchOrg,
  input: {
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    sourceReceiptMovementId: string;
    lotId?: string | null;
    serialId?: string | null;
  },
): Promise<{ documentId: string; lineId: string }> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values
      (${documentId}, ${org.orgId}, 'vendor_credit',
       ${`VC-RETURN-${documentId.slice(0, 8)}`}, ${org.vendorId}, null,
       ${org.date}, ${org.date}, 'CAD', 1, 'draft', ${input.amount}, '0',
       ${input.amount}, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id,
       quantity, unit_price, amount, tax_amount, is_billable,
       quantity_fulfilled, quantity_billed, stock_location_id, custom,
       tax_overridden)
    values
      (${lineId}, ${org.orgId}, ${documentId}, 1, ${input.itemId},
       ${org.accounts.adjustment}, ${input.quantity}, ${input.unitPrice},
       ${input.amount}, '0', false, '0', '0', ${org.stockLocationId},
       ${JSON.stringify({
         inventoryReturn: {
           sourceReceiptMovementId: input.sourceReceiptMovementId,
           ...(input.lotId ? { lotId: input.lotId } : {}),
           ...(input.serialId ? { serialId: input.serialId } : {}),
         },
       })}::jsonb,
       false)
  `);
  // Lines are source facts and may only be inserted while their document is
  // draft. Promote the fully seeded fixture afterward for posting coverage.
  await db.execute(sql`
    update documents set status = 'approved'
     where id = ${documentId} and org_id = ${org.orgId}
  `);
  return { documentId, lineId };
}

async function creditResidue(
  orgId: string,
  documentId: string,
): Promise<{
  status: string;
  sourceEntries: number;
  returns: number;
  effects: number;
}> {
  return (await db.execute<{
    status: string;
    source_entries: number;
    returns: number;
    effects: number;
  }>(sql`
    select document.status,
           (select count(*)::int from journal_entries entry
             where entry.org_id = document.org_id
               and entry.source_document_id = document.id) as source_entries,
           (select count(*)::int
              from inventory_movements movement
              join document_lines line on line.id = movement.document_line_id
             where movement.org_id = document.org_id
               and line.document_id = document.id
               and movement.kind = 'return') as returns,
           (select count(*)::int from posting_effects effect
             where effect.org_id = document.org_id
               and effect.document_id = document.id) as effects
      from documents document
     where document.org_id = ${orgId} and document.id = ${documentId}
  `)).rows.map((row) => ({
    status: row.status,
    sourceEntries: row.source_entries,
    returns: row.returns,
    effects: row.effects,
  }))[0]!;
}

test("vendor-return evidence is strict and the documented workflow names its accounting boundary", () => {
  const sourceReceiptMovementId = "018f0f52-9800-7000-8000-000000000001";
  const lotId = "018f0f52-9800-7000-8000-000000000002";
  assert.deepEqual(
    parseVendorCreditInventoryReturnSelection({
      inventoryReturn: { sourceReceiptMovementId, lotId },
    }),
    { sourceReceiptMovementId, lotId, serialId: null },
  );
  assert.throws(
    () => parseVendorCreditInventoryReturnSelection({}),
    /requires custom\.inventoryReturn evidence/,
  );
  assert.match(docsSource, /select the\noriginating posted receipt/i);
  assert.match(docsSource, /relieves only the selected on-hand\ncost layers at carried cost/i);
  assert.match(docsSource, /price-only adjustment that does not move stock/i);
});

test(
  "vendor credit returns a selected lot at carried cost and replays exactly once",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update item_inventory_profiles
           set tracking = 'lot'
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}
      `);
      const lotId = await ensureLot(
        org.orgId,
        org.items.fifo,
        "RETURN-LOT-1",
        null,
        null,
      );
      const receipt = await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
        lotId,
      });

      // Invalid receipt evidence must leave no half-posted AP, stock, entry,
      // or effect. Approved source lines are immutable, so repair is modeled
      // by a replacement credit carrying the corrected receipt evidence.
      const invalidCredit = await createApprovedVendorReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "2.5",
        amount: "10",
        sourceReceiptMovementId: randomUUID(),
        lotId,
      });
      await assert.rejects(
        () => postDocument(invalidCredit.documentId, depsFor(org)),
        (error: unknown) =>
          error instanceof PostingError && /posted receipt movement/.test(error.message),
      );
      assert.deepEqual(await creditResidue(org.orgId, invalidCredit.documentId), {
        status: "approved",
        sourceEntries: 0,
        returns: 0,
        effects: 0,
      });
      const credit = await createApprovedVendorReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "2.5",
        amount: "10",
        sourceReceiptMovementId: receipt.movementId,
        lotId,
      });
      await postDocument(credit.documentId, depsFor(org));

      const onHand = await getOnHand(
        org.orgId,
        org.items.fifo,
        org.stockLocationId,
      );
      assert.equal(toUnits(onHand.quantity), toUnits("6"));
      assert.equal(toUnits(onHand.value), toUnits("12"));
      const provenance = (await db.execute<{
        quantity: string;
        total_value: string;
        lot_id: string | null;
        consumed_quantity: string;
        source_movement_id: string;
      }>(sql`
        select returned.quantity::text, returned.total_value::text,
               returned.lot_id, consumption.quantity::text as consumed_quantity,
               layer.source_movement_id
          from inventory_movements returned
          join cost_layer_consumptions consumption
            on consumption.org_id = returned.org_id
           and consumption.issue_movement_id = returned.id
          join cost_layers layer
            on layer.org_id = consumption.org_id
           and layer.id = consumption.cost_layer_id
         where returned.org_id = ${org.orgId}
           and returned.document_line_id = ${credit.lineId}
           and returned.kind = 'return'
      `)).rows[0]!;
      assert.equal(toUnits(provenance.quantity), toUnits("-4"));
      assert.equal(toUnits(provenance.total_value), toUnits("-8"));
      assert.equal(toUnits(provenance.consumed_quantity), toUnits("4"));
      assert.equal(provenance.lot_id, lotId);
      assert.equal(provenance.source_movement_id, receipt.movementId);
      assert.equal(
        toUnits(await glBalance(org.orgId, org.accounts.ap)),
        toUnits("10"),
      );
      assert.equal(
        toUnits(await glBalance(org.orgId, org.accounts.invAsset)),
        toUnits(await layerValue(org.orgId, org.items.fifo)),
      );
      assert.equal(
        toUnits(await glBalance(org.orgId, org.accounts.adjustment)),
        toUnits("-2"),
      );
      assert.equal(
        await applyInventoryReturnsForVendorCredit(
          org.orgId,
          null,
          credit.documentId,
          org.date,
          org.subsidiaryId,
        ),
        0,
      );
      assert.equal(
        (await creditResidue(org.orgId, credit.documentId)).returns,
        1,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "vendor credit returns the selected serial and marks it returned",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update item_inventory_profiles
           set tracking = 'serial'
         where org_id = ${org.orgId} and item_id = ${org.items.component}
      `);
      const serialId = await ensureSerial(
        org.orgId,
        org.items.component,
        "RETURN-SERIAL-1",
        null,
        null,
      );
      const receipt = await receiveInventory(org.orgId, null, {
        itemId: org.items.component,
        stockLocationId: org.stockLocationId,
        quantity: "1",
        unitCost: "4",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
        serialId,
      });
      const credit = await createApprovedVendorReturn(org, {
        itemId: org.items.component,
        quantity: "1",
        unitPrice: "4",
        amount: "4",
        sourceReceiptMovementId: receipt.movementId,
        serialId,
      });
      await postDocument(credit.documentId, depsFor(org));
      const serial = (await db.execute<{
        status: string;
        current_stock_location_id: string | null;
      }>(sql`
        select status, current_stock_location_id
          from serials
         where org_id = ${org.orgId} and id = ${serialId}
      `)).rows[0]!;
      assert.deepEqual(serial, {
        status: "returned",
        current_stock_location_id: null,
      });
      assert.equal(
        toUnits((await getOnHand(org.orgId, org.items.component, org.stockLocationId)).quantity),
        0n,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a concurrent vendor return and issue cannot overconsume one receipt layer",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const receipt = await receiveInventory(org.orgId, null, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const credit = await createApprovedVendorReturn(org, {
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "2",
        amount: "8",
        sourceReceiptMovementId: receipt.movementId,
      });
      const results = await Promise.allSettled([
        postDocument(credit.documentId, depsFor(org)),
        issueInventory(org.orgId, null, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          quantity: "7",
          subsidiaryId: org.subsidiaryId,
          date: org.date,
        }),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        1,
      );
      const movements = (await db.execute<{
        returns: number;
        issues: number;
      }>(sql`
        select count(*) filter (where kind = 'return')::int as returns,
               count(*) filter (where kind = 'issue')::int as issues
          from inventory_movements
         where org_id = ${org.orgId} and item_id = ${org.items.fifo}
      `)).rows[0]!;
      assert.equal(movements.returns + movements.issues, 1);
      const onHand = await getOnHand(
        org.orgId,
        org.items.fifo,
        org.stockLocationId,
      );
      assert.ok(
        toUnits(onHand.quantity) === toUnits("6") ||
          toUnits(onHand.quantity) === toUnits("3"),
      );
      assert.ok(toUnits(onHand.quantity) >= 0n);
      assert.equal(
        toUnits(await glBalance(org.orgId, org.accounts.invAsset)),
        toUnits(await layerValue(org.orgId, org.items.fifo)),
      );
      const residue = await creditResidue(org.orgId, credit.documentId);
      assert.ok(
        (residue.status === "posted" &&
          residue.sourceEntries === 1 &&
          residue.returns === 1 &&
          residue.effects === 1) ||
          (residue.status === "approved" &&
            residue.sourceEntries === 0 &&
            residue.returns === 0 &&
            residue.effects === 0),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
