import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { receiveInventory } from "./inventory.ts";
import {
  postDocument,
  runPostDocumentEffects,
} from "./posting.ts";
import {
  claimPostingEffectsForDocument,
  MAX_POSTING_EFFECTS_ATTEMPTS,
  processDuePostingEffects,
  replayTerminalPostingEffect,
  type PostingEffectsRow,
} from "./posting-effects.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * documents.subsidiary_id null MEANS the org's root subsidiary (schema comment
 * on schema/src/documents.ts). The posting kernel resolves that null exactly
 * once — applySubsidiaries stamps every journal leg with ctx.rootId — but the
 * post-commit effect drain used to gate inventory effects on plain truthiness
 * (`if (doc.subsidiaryId)`), so a root-subsidiary document skipped its
 * inventory effects entirely and was still marked succeeded. These tests pin
 * the contract end to end through the real posting path: a meaning-bearing
 * null reaches posting, the subledger moves exactly once at the ROOT entity,
 * the per-entity GL corroborates the layers, replay is exactly-once, and a
 * failed effect can never masquerade as success.
 */

const deps = (org: ScratchOrg) => ({
  control: {
    ar: org.accounts.ar,
    ap: org.accounts.ap,
    bank: org.accounts.bank,
  },
});

/** Sum of posted journal lines on one account for ONE legal entity. */
async function glBalanceBySubsidiary(
  orgId: string,
  accountId: string,
  subsidiaryId: string,
): Promise<bigint> {
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as bal
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

/** Approved document whose header carries the defect's exact shape:
 *  subsidiary_id NULL — the encoding of "the org's root subsidiary". */
async function draftRootDocument(
  org: ScratchOrg,
  kind: "customer_invoice" | "vendor_bill",
  number: string,
  line: {
    partyId?: string | null;
    accountId?: string;
    itemId: string;
    quantity: string;
    unitPrice: string;
    amount: string;
    stockLocationId?: string;
  },
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, posting_date, currency, fx_rate, status,
       subtotal, tax_total, total, custom)
    values (${docId}, ${org.orgId}, ${kind}, ${number}, ${line.partyId ?? null},
            null, ${org.date}, ${org.date}, 'CAD', 1, 'approved',
            ${line.amount}, '0', ${line.amount}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, quantity,
       unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
       quantity_billed, stock_location_id, custom, tax_overridden)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, ${line.itemId},
            ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice},
            ${line.amount}, '0', false, '0', '0',
            ${line.stockLocationId ?? null}, '{}'::jsonb, false)`);
  // Guard the premise: the fixture really produced a null-subsidiary header.
  const [row] = (
    await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from documents where id = ${docId}`)
  ).rows;
  assert.equal(row?.subsidiary_id ?? null, null);
  return docId;
}

async function effectsStatus(documentId: string): Promise<string | null> {
  const r = (await db.execute<{ status: string | null }>(sql`
    select status from posting_effects where document_id = ${documentId}`));
  return r.rows[0]?.status ?? null;
}

async function firstLineId(documentId: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(sql`
      select id from document_lines
       where document_id = ${documentId}
       order by line_number limit 1`)
  ).rows[0]!.id;
}

interface MovementFacts {
  count: number;
  subsidiaryIds: string[];
}

async function movementFacts(
  orgId: string,
  documentLineId: string,
  kind: "issue" | "receipt",
): Promise<MovementFacts> {
  const r = (await db.execute<{ n: number; subsidiary_id: string | null }>(sql`
    select count(*)::int as n, min(subsidiary_id::text) as subsidiary_id
      from inventory_movements
     where org_id = ${orgId} and document_line_id = ${documentLineId}
       and kind = ${kind}`));
  return {
    count: r.rows[0]!.n,
    subsidiaryIds: r.rows[0]!.n > 0 ? [r.rows[0]!.subsidiary_id!] : [],
  };
}

/** Σ consumed quantity and value across the issue movements of one line. */
async function consumptionFacts(
  orgId: string,
  documentLineId: string,
): Promise<{ quantity: bigint; value: bigint }> {
  const r = (await db.execute<{ q: string; v: string }>(sql`
    select coalesce(sum(c.quantity), 0)::text as q,
           coalesce(sum(round(c.quantity * c.unit_cost, 4)), 0)::text as v
      from cost_layer_consumptions c
      join inventory_movements m on m.id = c.issue_movement_id
                                 and m.org_id = c.org_id
     where c.org_id = ${orgId} and m.document_line_id = ${documentLineId}`));
  return { quantity: toUnits(r.rows[0]!.q), value: toUnits(r.rows[0]!.v) };
}

test("a root-subsidiary customer invoice relieves stock once and the GL corroborates the layers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // The scratch org's single subsidiary is the root (parent_id null).
    const root = org.subsidiaryId;

    // Stock exists so the sale has something to relieve.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "2.00",
      subsidiaryId: root,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });

    const invoiceId = await draftRootDocument(
      org,
      "customer_invoice",
      "ROOT-INV-1",
      {
        partyId: org.customerId,
        accountId: org.accounts.revenue,
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "5",
        amount: "20",
        stockLocationId: org.stockLocationId,
      },
    );
    const lineId = await firstLineId(invoiceId);

    await postDocument(invoiceId, deps(org));

    // Exactly ONE issue movement, owned by the ROOT legal entity.
    const issues = await movementFacts(org.orgId, lineId, "issue");
    assert.equal(issues.count, 1, "the invoice must produce one issue movement");
    assert.deepEqual(issues.subsidiaryIds, [root]);

    // Exactly one layer effect behind that movement: 4 units at 2.00 = 8.00.
    const consumed = await consumptionFacts(org.orgId, lineId);
    assert.equal(consumed.quantity, toUnits("4"));
    assert.equal(consumed.value, toUnits("8"));

    // The effect drained through the durable outbox to success — not a
    // silent skip recorded as success with nothing behind it.
    assert.equal(await effectsStatus(invoiceId), "succeeded");

    // Per-entity GL corroborates the per-entity subledger.
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, root), toUnits("8"));
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, root),
      await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, root),
    );
    assert.equal(await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, root), toUnits("12"));
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.ar, root), toUnits("20"));
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.revenue, root), toUnits("-20"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a root-subsidiary vendor bill receives stock once and the GL corroborates the layers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const root = org.subsidiaryId;

    const billId = await draftRootDocument(org, "vendor_bill", "ROOT-BILL-1", {
      partyId: org.vendorId,
      itemId: org.items.fifo,
      quantity: "50",
      unitPrice: "2",
      amount: "100",
      stockLocationId: org.stockLocationId,
    });
    const lineId = await firstLineId(billId);

    await postDocument(billId, deps(org));

    // Exactly ONE receipt movement owned by the ROOT entity, and exactly one
    // cost layer born from it at the bill's unit cost.
    const receipts = await movementFacts(org.orgId, lineId, "receipt");
    assert.equal(receipts.count, 1, "the bill must produce one receipt movement");
    assert.deepEqual(receipts.subsidiaryIds, [root]);
    const layers = (await db.execute<{ n: number; unit_cost: string }>(sql`
      select count(*)::int as n, min(unit_cost)::text as unit_cost
        from cost_layers
       where org_id = ${org.orgId} and source_movement_id in (
         select id from inventory_movements
          where org_id = ${org.orgId} and document_line_id = ${lineId})`)).rows[0]!;
    assert.equal(layers.n, 1);
    assert.equal(toUnits(layers.unit_cost), toUnits("2"));

    assert.equal(await effectsStatus(billId), "succeeded");

    // Bill DR'd clearing 100, receipt credited it back; AP carries the debt;
    // inventory asset equals the layer value inside the root entity.
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.clearing, root), 0n);
    assert.equal(await glBalanceBySubsidiary(org.orgId, org.accounts.ap, root), toUnits("-100"));
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.invAsset, root),
      await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, root),
    );
    assert.equal(await layerValueBySubsidiary(org.orgId, org.items.fifo, org.stockLocationId, root), toUnits("100"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("replay of a root-subsidiary bill runs its inventory effect exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const billId = await draftRootDocument(org, "vendor_bill", "ROOT-BILL-R", {
      partyId: org.vendorId,
      itemId: org.items.fifo,
      quantity: "7",
      unitPrice: "3",
      amount: "21",
      stockLocationId: org.stockLocationId,
    });
    const lineId = await firstLineId(billId);

    // Post WITHOUT draining. The receipt commits atomically inside the bill's
    // posting transaction (bill GL + inventory are one accounting unit); the
    // durable outbox row is the exactly-once replay gate, not the applier.
    await postDocument(billId, deps(org), { deferEffects: true });
    assert.equal(await effectsStatus(billId), "pending");
    assert.equal(
      (await movementFacts(org.orgId, lineId, "receipt")).count,
      1,
      "the receipt must commit atomically with the bill's posting transaction",
    );

    // First drain re-runs the per-line-idempotent effect and marks the
    // durable row succeeded without duplicating the receipt.
    await runPostDocumentEffects(billId);
    assert.equal(await effectsStatus(billId), "succeeded");
    const afterFirst = await movementFacts(org.orgId, lineId, "receipt");
    assert.equal(afterFirst.count, 1);
    assert.deepEqual(afterFirst.subsidiaryIds, [org.subsidiaryId]);

    // A replay that goes back through the claim gate observes terminal
    // success and performs nothing further.
    assert.equal(await claimPostingEffectsForDocument(billId), "succeeded");

    // A forced re-execution past the gate (operator replay of an already-
    // succeeded row) is absorbed by the per-line storage idempotency key.
    const forced = (await db.execute<PostingEffectsRow>(sql`
      select id, org_id, document_id, kind, entry_id,
             posting_date::text as posting_date, actor_id, attempt_count,
             lease_token
        from posting_effects where document_id = ${billId}`)).rows[0]!;
    await runPostDocumentEffects(billId, "approved", {
      alreadyClaimed: forced,
    });

    const afterReplay = await movementFacts(org.orgId, lineId, "receipt");
    assert.equal(afterReplay.count, 1, "replay must not duplicate the movement");
    assert.deepEqual(afterReplay.subsidiaryIds, [org.subsidiaryId]);
    const layers = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from cost_layers
       where org_id = ${org.orgId} and source_movement_id in (
         select id from inventory_movements
          where org_id = ${org.orgId} and document_line_id = ${lineId})`)).rows[0]!;
    assert.equal(layers.n, 1, "replay must not duplicate the layer");
    assert.equal(await effectsStatus(billId), "succeeded");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failed root-subsidiary effect retries through the outbox and can never be recorded as succeeded", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // No stock seeded: the COGS issue cannot possibly succeed.
    const invoiceId = await draftRootDocument(
      org,
      "customer_invoice",
      "ROOT-INV-F",
      {
        partyId: org.customerId,
        accountId: org.accounts.revenue,
        itemId: org.items.fifo,
        quantity: "4",
        unitPrice: "5",
        amount: "20",
        stockLocationId: org.stockLocationId,
      },
    );
    const lineId = await firstLineId(invoiceId);

    await postDocument(invoiceId, deps(org), { deferEffects: true });

    // The synchronous drain fails loudly instead of skipping silently, and
    // its own catch path records the failure (never success).
    await assert.rejects(
      () => runPostDocumentEffects(invoiceId),
      /insufficient stock/i,
    );
    let status = await effectsStatus(invoiceId);
    assert.equal(status, "failed");

    // Drain to the attempt ceiling through the REAL outbox worker: every
    // retry fails again, every intermediate state stays retryable-'failed',
    // and the ceiling makes an explicit one-way transition to terminal.
    for (let attempt = 2; attempt <= MAX_POSTING_EFFECTS_ATTEMPTS; attempt++) {
      const now = new Date(Date.now() + attempt * 24 * 3600_000);
      const outcome = await processDuePostingEffects(now, 50);
      assert.equal(outcome.succeeded, 0);
      assert.equal(outcome.fenced, 0);
      assert.ok(outcome.processed >= 1, `attempt ${attempt} must run`);
      status = await effectsStatus(invoiceId);
      assert.equal(
        status,
        attempt < MAX_POSTING_EFFECTS_ATTEMPTS ? "failed" : "terminal_failed",
      );
    }

    // Nothing was ever recorded as succeeded, and no partial effect leaked.
    assert.notEqual(await effectsStatus(invoiceId), "succeeded");
    assert.equal((await movementFacts(org.orgId, lineId, "issue")).count, 0);
    assert.equal(
      await glBalanceBySubsidiary(org.orgId, org.accounts.cogs, org.subsidiaryId),
      0n,
    );

    // Authorized operator replay resets the terminal row, and repairing the
    // underlying stock lets a fresh worker drain genuinely succeed.
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "2.00",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const operator = await createScratchUser(org.orgId, "Operator", "admin");
    const effectId = (await db.execute<{ id: string }>(sql`
      select id from posting_effects where document_id = ${invoiceId}`)).rows[0]!.id;
    await replayTerminalPostingEffect({
      orgId: org.orgId,
      id: effectId,
      actorId: operator,
      reason: "stock received after the original shortage; replay the issue",
    });
    await processDuePostingEffects(new Date(Date.now() + 48 * 3600_000), 50);

    assert.equal(await effectsStatus(invoiceId), "succeeded");
    const repaired = await movementFacts(org.orgId, lineId, "issue");
    assert.equal(repaired.count, 1, "the repaired drain issues exactly once");
    assert.deepEqual(repaired.subsidiaryIds, [org.subsidiaryId]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a purchase order converted into a vendor bill receives its inventory at the root entity", { skip: !DB }, async () => {
  // convertOrder lives behind 'server-only', so the conversion runs in a child
  // process under the react-server export condition (house pattern from
  // web/lib/project-dimension-inheritance.integration.test.ts), against the
  // same database this suite already holds.
  const source = `
    import assert from "node:assert/strict";
    import { randomUUID } from "node:crypto";
    import { sql } from "drizzle-orm";
    import { db, withOrg } from "./engine/src/db.ts";
    import { installTrustedTestDatabaseBypass } from "./engine/src/test-database-bypass.ts";
    import {
      createScratchOrg,
      createScratchUser,
      dropScratchOrg,
    } from "./engine/src/test-fixtures.ts";
    import { postDocument } from "./engine/src/posting.ts";
    import { toUnits } from "./engine/src/money.ts";
    import {
      inventoryPostingEffectKey,
      receiveInventory,
    } from "./engine/src/inventory.ts";
    import { convertOrder, createOrderDraft } from "./web/lib/order-cycle.ts";

    // Web modules install the normal request resolver during evaluation.
    // Re-establish the explicit test-only trusted boundary afterwards.
    installTrustedTestDatabaseBypass();

    const org = await createScratchOrg();
    try {
      const root = org.subsidiaryId;
      const userId = await createScratchUser(org.orgId, "Order Clerk", "admin");

      // createOrderDraft inserts NO subsidiary — the exact origin of the
      // converted bill the audit pinned.
      const po = await withOrg(org.orgId, () =>
        createOrderDraft(org.orgId, userId, "purchase_order"),
      );
      const poLineId = randomUUID();
      await db.execute(sql\`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, quantity, unit,
           unit_price, amount, tax_amount, is_billable, quantity_fulfilled,
           quantity_billed, stock_location_id, custom)
        values (\${poLineId}, \${org.orgId}, \${po.id}, 1, \${org.items.fifo},
                '50', 'ea', '2', '100', '0', false, '0', '0',
                \${org.stockLocationId}, '{}'::jsonb)\`);
      // Issue the order (draft orders are not convertible) and name the
      // vendor the way every real purchase order does — convertOrder copies
      // the party onto the bill and the AP line must carry it. Keep the
      // commercial date inside the fixture's open accounting period;
      // conversion preserves the source date by contract.
      await db.execute(sql\`
        update documents
           set status='approved', subtotal='100', total='100',
               party_id = \${org.vendorId}, document_date = \${org.date}
         where id = \${po.id} and org_id = \${org.orgId}\`);

      // The shared three-way PO match refuses to bill stock that has not been
      // received, so record the receipt BEFORE converting: the real production
      // receipt kernel posts the physical receipt against the purchase-order
      // line (DR inventory / CR received-not-billed), and the line's received
      // quantity advances under the same guarded ceiling every fulfillment
      // writer uses. Conversion still reads this receipt evidence through the
      // matcher — an unreceived line bills nothing.
      const receipt = await receiveInventory(org.orgId, userId, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "50",
        unitCost: "2",
        subsidiaryId: root,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
        documentLineId: poLineId,
        idempotencyKey: inventoryPostingEffectKey(poLineId, "receipt"),
        memo: "Purchase order receipt",
      });
      assert.ok(receipt.movementId);
      const received = (await db.execute(sql\`
        update document_lines
           set quantity_fulfilled = quantity_fulfilled + '50'
         where id = \${poLineId} and org_id = \${org.orgId}
           and quantity_fulfilled + '50' <= quantity
        returning id\`)).rows[0];
      assert.ok(received, "the receipt must fit inside the ordered quantity");

      const bill = await withOrg(org.orgId, () =>
        convertOrder(org.orgId, userId, po.id, "vendor_bill"),
      );

      // The conversion copied the order's shape: null subsidiary pulled
      // forward, the source line advanced, and a link edge recorded.
      // (Plain JS only here: tsx does not transform -e eval sources.)
      const copied = (await db.execute(sql\`
        select d.subsidiary_id, l.quantity_billed::text as quantity_billed
          from documents d
          join document_lines l on l.document_id = d.id
                              and l.org_id = d.org_id
         where d.id = \${po.id}\`)).rows[0];
      assert.equal(copied.subsidiary_id, null);
      assert.equal(toUnits(copied.quantity_billed), toUnits("50"));
      const link = (await db.execute(sql\`
        select count(*)::int as n from document_links
         where org_id = \${org.orgId}
           and from_document_id = \${po.id}
           and to_document_id = \${bill.id}
           and link_type = 'bills'\`)).rows[0];
      assert.equal(link.n, 1);

      // Converted bills start as drafts; complete the same approval step
      // every bill passes before the engine will post it.
      await db.execute(sql\`
        update documents set status='approved'
         where id = \${bill.id} and org_id = \${org.orgId}\`);

      const entryId = await postDocument(bill.id, {
        control: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
        },
      });
      assert.ok(entryId);

      const facts = (await db.execute(sql\`
        with line as (
          select id from document_lines
           where document_id = \${bill.id} order by line_number limit 1
        ), moves as (
          select m.* from inventory_movements m, line
           where m.org_id = \${org.orgId}
             and m.document_line_id = line.id and m.kind = 'receipt'
        )
        select
          (select id from line) as line_id,
          (select count(*)::int from moves) as receipts,
          (select min(subsidiary_id::text) from moves) as receipt_sub,
          (select count(*)::int from cost_layers
            where org_id = \${org.orgId} and source_movement_id in (select id from moves)) as layers,
          (select coalesce(sum(round(original_quantity * unit_cost, 4)), 0)::text from cost_layers
            where org_id = \${org.orgId} and source_movement_id in (select id from moves)) as layer_value,
          (select coalesce(sum(round(original_quantity * unit_cost, 4)), 0)::text from cost_layers
            where org_id = \${org.orgId} and item_id = \${org.items.fifo}
              and stock_location_id = \${org.stockLocationId}
              and subsidiary_id = \${root}) as total_layer_value,
          (select coalesce(sum(l.amount), 0)::text from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = \${org.orgId} and e.subsidiary_id = \${root}
             and l.account_id = \${org.accounts.invAsset}) as inv_gl,
          (select coalesce(sum(l.amount), 0)::text from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = \${org.orgId} and e.subsidiary_id = \${root}
             and l.account_id = \${org.accounts.ap}) as ap_gl,
          (select coalesce(sum(l.amount), 0)::text from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = \${org.orgId} and e.subsidiary_id = \${root}
             and l.account_id = \${org.accounts.clearing}) as clearing_gl\`)).rows[0];

      // The converted bill's own receipt: exactly ONE receipt movement on its
      // line, owned by the ROOT entity, and exactly one cost layer born from
      // it at the bill's unit cost.
      assert.equal(facts.receipts, 1);
      assert.equal(facts.receipt_sub, root);
      assert.equal(facts.layers, 1);
      assert.equal(toUnits(facts.layer_value), toUnits("100"));

      // Root-entity GL. The seeded purchase-order receipt contributed DR
      // inventory 100 / CR received-not-billed 100; the bill's own receipt
      // adds its 100 of inventory, the bill debits received-not-billed 100,
      // and its receipt credit leaves the accrual at −100 while AP carries
      // the debt. The inventory asset corroborates the entity's total layer
      // value exactly.
      assert.equal(toUnits(facts.inv_gl), toUnits("200"));
      assert.equal(toUnits(facts.inv_gl), toUnits(facts.total_layer_value));
      assert.equal(toUnits(facts.ap_gl), toUnits("-100"));
      assert.equal(toUnits(facts.clearing_gl), toUnits("-100"));

      const effects = (await db.execute(sql\`
        select status from posting_effects where document_id = \${bill.id}\`)).rows[0];
      assert.equal(effects.status, "succeeded");

      console.log("CONVERTED-BILL-RECEIVED-ONCE");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--import",
      "./engine/src/test-database-bypass.ts",
      "--input-type=module",
      "-e",
      source,
    ],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /CONVERTED-BILL-RECEIVED-ONCE/);
});
