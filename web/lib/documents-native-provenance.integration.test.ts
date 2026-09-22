import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Native line provenance: conversion evidence (purchaseOrderLineId,
// convertedFrom) and AP-capture evidence used to be stripped by every
// description-only save (tenant validation drops keys outside its
// definitions), so posting received the stock a second time. These tests run
// receive -> convert -> edit -> post for real and assert the stock posts
// exactly once. Direct async style (no spawned children): the canonical
// runner owns lifecycle and typecheck covers this file.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db, withBypassContext, withOrg, withOrgContext } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { loadDocument, loadDocumentEditCurrent } = await import(
  "@openbooks/engine/src/ledger/document-service.ts"
);
const { applyDocumentEdit, createPostedCorrectionDraft } = await import("./documents.ts");
const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
const { toUnits } = await import("@openbooks/engine/src/money/money.ts");
const { convertOrder, createOrderDraft, receivePurchaseOrder } = await import("./order-cycle.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
import type { DocumentLineInput } from "@openbooks/engine/src/ledger/document-input.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Fixture = {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  userId: string;
};

async function newFixture(displayName: string, role: string): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const userId = await createScratchUser(org.orgId, displayName, role);
    return { org, userId };
  });
}

async function dropFixture(orgId: string): Promise<void> {
  await withBypassContext(() => dropScratchOrg(orgId));
}

type POLineSpec = {
  desc: string;
  qty: string;
  unit: string;
  price: string;
  amount: string;
};

async function setupReceivedOrder(
  fx: Fixture,
  lines: POLineSpec[],
  total: string,
): Promise<{ orderId: string; sourceIds: string[] }> {
  const { org, userId } = fx;
  const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order"));
  const sourceIds: string[] = [];
  await withBypassContext(async () => {
    let n = 0;
    for (const line of lines) {
      n += 1;
      const id = randomUUID();
      sourceIds.push(id);
      await db.execute(sql`
        insert into document_lines
          (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit,
           unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed, stock_location_id, custom)
        values
          (${id}, ${org.orgId}, ${order.id}, ${n}, ${org.items.fifo}, ${org.accounts.invAsset},
           ${line.desc}, ${line.qty}, ${line.unit}, ${line.price}, ${line.amount}, '0', '0', '0',
           ${org.stockLocationId}, '{}'::jsonb)
      `);
    }
    await db.execute(sql`
      update documents
         set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
             document_date = ${org.date}, subtotal = ${total}, total = ${total}
       where id = ${order.id} and org_id = ${org.orgId}
    `);
  });
  return { orderId: order.id, sourceIds };
}

async function receiveAll(
  fx: Fixture,
  orderId: string,
  key: string,
  receipts: { sourceId: string; qty: string }[],
): Promise<void> {
  const { org, userId } = fx;
  await withOrg(org.orgId, () =>
    receivePurchaseOrder(org.orgId, userId, orderId, {
      receiptDate: org.date,
      idempotencyKey: key,
      lines: receipts.map((r) => ({ sourceLineId: r.sourceId, quantity: r.qty })),
    }),
  );
}

async function convertToBill(fx: Fixture, orderId: string): Promise<string> {
  const { org, userId } = fx;
  const bill = await withOrg(org.orgId, () => convertOrder(org.orgId, userId, orderId, "vendor_bill"));
  return bill.id;
}

async function approveDocument(fx: Fixture, docId: string): Promise<void> {
  const { org } = fx;
  await withBypassContext(
    () => db.execute(sql`update documents set status = 'approved' where id = ${docId} and org_id = ${org.orgId}`),
  );
}

async function postBill(fx: Fixture, billId: string): Promise<void> {
  const { org } = fx;
  await withOrgContext(org.orgId, () =>
    postDocument(billId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
}

type Balances = {
  onHand: string;
  invAsset: string;
  clearing: string;
  ap: string;
  adjustment: string;
};

async function billBalances(fx: Fixture): Promise<Balances> {
  const { org } = fx;
  return withOrgContext(org.orgId, async () => {
    const onHand = (
      await db.execute<{ quantity: string }>(sql`
        select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
         where org_id = ${org.orgId} and item_id = ${org.items.fifo} and status = 'posted'
      `)
    ).rows[0]!.quantity;
    const balanceOf = async (accountId: string): Promise<string> =>
      (
        await db.execute<{ amount: string }>(sql`
          select coalesce(sum(l.amount), 0)::text as amount from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
           where l.org_id = ${org.orgId} and l.account_id = ${accountId} and e.status = 'posted'
        `)
      ).rows[0]!.amount;
    return {
      onHand,
      invAsset: await balanceOf(org.accounts.invAsset),
      clearing: await balanceOf(org.accounts.clearing),
      ap: await balanceOf(org.accounts.ap),
      adjustment: await balanceOf(org.accounts.adjustment),
    };
  });
}

type StoredBillLine = {
  id: string;
  description: string | null;
  quantity: string | null;
  custom: unknown;
};

async function storedBillLines(fx: Fixture, billId: string): Promise<StoredBillLine[]> {
  const { org } = fx;
  return (
    await withOrgContext(
      org.orgId,
      () => db.execute<StoredBillLine>(sql`
        select id, description, quantity::text as "quantity", custom from document_lines
         where org_id = ${org.orgId} and document_id = ${billId}
         order by line_number
      `),
    )
  ).rows;
}

/** Drawer-shaped line input: stable identity, tenant custom only, native
 * custom never sent — exactly what DocumentDrawer toRow/save produce. */
function drawerLine(
  l: Record<string, unknown>,
  overrides: Partial<DocumentLineInput> = {},
): DocumentLineInput {
  const text = (v: unknown): string | null =>
    typeof v === "string" ? v : v == null ? null : String(v);
  return {
    lineId: typeof l.id === "string" ? l.id : null,
    accountId: text(l.account_id) ?? "",
    itemId: text(l.item_id),
    description: text(l.description),
    quantity: l.quantity == null ? null : String(l.quantity),
    unit: text(l.unit),
    unitPrice: l.unit_price == null ? null : String(l.unit_price),
    amount: String(l.amount),
    taxCodeId: text(l.tax_code_id),
    taxGroupId: text(l.tax_group_id),
    departmentId: text(l.department_id),
    projectId: text(l.project_id),
    locationId: text(l.location_id),
    classId: text(l.class_id),
    stockLocationId: text(l.stock_location_id),
    extraDims: (l.extra_dims ?? {}) as Record<string, string | null>,
    custom: {},
    ...overrides,
  };
}

async function loadedLines(fx: Fixture, billId: string): Promise<Record<string, unknown>[]> {
  const { org } = fx;
  const loaded = await withOrgContext(org.orgId, () => loadDocument(billId, org.orgId));
  assert.ok(loaded);
  return loaded.lines;
}

type EditError = { status?: number; message: string } | null;

async function attemptEdit(
  fx: Fixture,
  docId: string,
  lines: DocumentLineInput[],
  source: "ui" | "api" = "ui",
): Promise<EditError> {
  const { org, userId } = fx;
  const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(docId, org.orgId));
  assert.ok(current);
  try {
    await withOrg(org.orgId, () =>
      applyDocumentEdit(
        docId,
        current,
        { expectedUpdatedAt: current.updatedAt, lines },
        { orgId: org.orgId, userId, source, runFlows: false },
      ),
    );
    return null;
  } catch (error) {
    return error as { status?: number; message: string };
  }
}

function nativeCustomOf(row: StoredBillLine): Record<string, unknown> {
  return (row.custom ?? {}) as Record<string, unknown>;
}

test("description-only edit keeps native provenance and posts once", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { org } = fx;
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);
    const converted = (await storedBillLines(fx, billId))[0]!;
    assert.equal(nativeCustomOf(converted).purchaseOrderLineId, sourceIds[0]);

    // First save: description only, drawer-shaped (identity, no native custom).
    const firstLines = (await loadedLines(fx, billId)).map((l) => drawerLine(l));
    firstLines[0]!.description = "Edited supplier note";
    assert.equal(await attemptEdit(fx, billId, firstLines), null);
    const afterFirst = (await storedBillLines(fx, billId))[0]!;
    assert.equal(afterFirst.description, "Edited supplier note", "a legitimate description edit is preserved");
    assert.notEqual(afterFirst.id, converted.id, "replacement lines mint new identities");
    assert.equal(nativeCustomOf(afterFirst).purchaseOrderLineId, sourceIds[0]);
    const convertedFrom = nativeCustomOf(afterFirst).convertedFrom as Record<string, unknown>;
    assert.equal(convertedFrom.lineId, sourceIds[0]);
    assert.equal(toUnits(String(convertedFrom.quantity)), toUnits("4"));

    // Second save with the REPLACEMENT identities: proves redraw adoption.
    const secondLines = (await loadedLines(fx, billId)).map((l) => drawerLine(l));
    secondLines[0]!.description = "Second note";
    assert.equal(await attemptEdit(fx, billId, secondLines), null);
    const afterSecond = (await storedBillLines(fx, billId))[0]!;
    assert.equal(afterSecond.description, "Second note");
    assert.equal(nativeCustomOf(afterSecond).purchaseOrderLineId, sourceIds[0]);

    // Movement counts query the CURRENT line ids (a stale pre-edit id would
    // silently assert nothing).
    await approveDocument(fx, billId);
    await postBill(fx, billId);
    const ids = (await storedBillLines(fx, billId)).map((r) => r.id);
    assert.ok(ids.length === 1 && ids[0] !== converted.id);
    const idArr = `{${ids.join(",")}}`;
    const receipts = (
      await withOrgContext(
        org.orgId,
        () => db.execute<{ count: number }>(sql`
          select count(*)::int as count from inventory_movements
           where org_id = ${org.orgId} and document_line_id = any(${idArr}::uuid[]) and kind = 'receipt'
        `),
      )
    ).rows[0]!.count;
    assert.equal(receipts, 0, "billing received stock must not receive it again");
    const balances = await billBalances(fx);
    assert.equal(toUnits(balances.onHand), toUnits("4"), "stock stays at the received four");
    assert.equal(toUnits(balances.invAsset), toUnits("8"), "inventory stays at receipt cost");
    assert.equal(toUnits(balances.clearing), toUnits("0"), "the bill clears received-not-billed");
    assert.equal(toUnits(balances.ap), toUnits("-8"));
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("legacy identity-less edit is refused with zero changes; the bill still posts once", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { org } = fx;
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);

    // Legacy shape: no identities, stored custom echoed back (an API echo
    // resends the evidence; it must be refused, never trusted positionally).
    const legacyLines = (await loadedLines(fx, billId)).map((l) => ({
      ...drawerLine(l),
      lineId: undefined,
      description: "Legacy note",
      custom: (l.custom ?? {}) as Record<string, unknown>,
    }));
    const refused = await attemptEdit(fx, billId, legacyLines, "api");
    assert.ok(refused, "an identity-less save over source-backed lines must be refused");
    assert.match(refused.message, /stable identities/);

    // Zero changes: description, evidence, and the billed cover are intact.
    const facts = (
      await withOrgContext(
        org.orgId,
        () => db.execute<{ description: string | null; custom: unknown; billed: string }>(sql`
          select bl.description, bl.custom,
                 (select quantity_billed::text from document_lines where id = ${sourceIds[0]!}) as billed
            from document_lines bl where bl.org_id = ${org.orgId} and bl.document_id = ${billId}
        `),
      )
    ).rows[0]!;
    assert.notEqual(facts.description, "Legacy note");
    assert.equal((facts.custom as Record<string, unknown>).purchaseOrderLineId, sourceIds[0]);
    assert.equal(toUnits(facts.billed), toUnits("4"));

    // The refused bill is still healthy and posts exactly once.
    await approveDocument(fx, billId);
    await postBill(fx, billId);
    const balances = await billBalances(fx);
    assert.equal(toUnits(balances.onHand), toUnits("4"));
    assert.equal(toUnits(balances.clearing), toUnits("0"));
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("spoofed native custom is ignored; persisted truth posts once", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);
    const forgedLine = randomUUID();
    const spoofed = (await loadedLines(fx, billId)).map((l) => ({
      ...drawerLine(l),
      custom: {
        purchaseOrderLineId: forgedLine,
        convertedFrom: { documentId: orderId, lineId: forgedLine, quantity: "999" },
        apCaptureEvidence: { purchaseOrderLineId: forgedLine },
      },
    }));
    assert.equal(await attemptEdit(fx, billId, spoofed, "api"), null);

    // The forgery had no effect: persisted evidence is the conversion truth.
    const stored = (await storedBillLines(fx, billId))[0]!;
    const custom = nativeCustomOf(stored);
    assert.equal(custom.purchaseOrderLineId, sourceIds[0]);
    assert.equal((custom.convertedFrom as Record<string, unknown>).lineId, sourceIds[0]);
    assert.equal(
      toUnits(String((custom.convertedFrom as Record<string, unknown>).quantity)),
      toUnits("4"),
    );
    assert.equal(custom.apCaptureEvidence, undefined);

    await approveDocument(fx, billId);
    await postBill(fx, billId);
    const balances = await billBalances(fx);
    assert.equal(toUnits(balances.onHand), toUnits("4"));
    assert.equal(toUnits(balances.clearing), toUnits("0"));
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("foreign, duplicate, and uppercase line identities", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);
    const base = drawerLine((await loadedLines(fx, billId))[0]!);
    const billLineId = (await storedBillLines(fx, billId))[0]!.id;

    // A foreign identity is a tenant-opaque 404, not a silent new line.
    const foreign = await attemptEdit(fx, billId, [{ ...base, lineId: randomUUID() }], "api");
    assert.ok(foreign, "a foreign line identity must be refused");
    assert.equal(foreign.status, 404);
    assert.match(foreign.message, /not found in this document/);

    // The same identity twice (mixed case) is one line claimed twice.
    const duplicate = await attemptEdit(
      fx,
      billId,
      [
        { ...base, lineId: billLineId },
        { ...base, lineId: billLineId.toUpperCase() },
      ],
      "api",
    );
    assert.ok(duplicate, "a duplicated line identity must be refused");
    assert.equal(duplicate.status, 422);
    assert.match(duplicate.message, /duplicate line identity/);

    // Uppercase is case-equivalent: a valid identity in any case matches.
    const upper = await attemptEdit(
      fx,
      billId,
      [{ ...base, lineId: billLineId.toUpperCase(), description: "Uppercase note" }],
      "api",
    );
    assert.equal(upper, null, "an uppercase identity must match its persisted line");
    const stored = (await storedBillLines(fx, billId))[0]!;
    assert.equal(stored.description, "Uppercase note");
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("reordered lines keep provenance by identity and post once", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [
        { desc: "Widget A", qty: "10", unit: "ea", price: "2", amount: "20" },
        { desc: "Widget B", qty: "10", unit: "ea", price: "3", amount: "30" },
      ],
      "50",
    );
    await receiveAll(fx, orderId, "receipt-two-lines", [
      { sourceId: sourceIds[0]!, qty: "4" },
      { sourceId: sourceIds[1]!, qty: "6" },
    ]);
    const billId = await convertToBill(fx, orderId);

    // Swap the two lines and edit both descriptions: provenance must follow
    // each identity, never the position.
    const rows = await loadedLines(fx, billId);
    assert.equal(rows.length, 2);
    const rowA = drawerLine(rows.find((l) => l.description === "Widget A")!);
    const rowB = drawerLine(rows.find((l) => l.description === "Widget B")!);
    rowA.description = "A billed";
    rowB.description = "B billed";
    assert.equal(await attemptEdit(fx, billId, [rowB, rowA]), null);

    const stored = await storedBillLines(fx, billId);
    assert.equal(stored[0]!.description, "B billed");
    assert.equal(
      nativeCustomOf(stored[0]!).purchaseOrderLineId,
      sourceIds[1],
      "provenance follows the identity, not the position",
    );
    assert.equal(
      toUnits(String((nativeCustomOf(stored[0]!).convertedFrom as Record<string, unknown>).quantity)),
      toUnits("6"),
    );
    assert.equal(stored[1]!.description, "A billed");
    assert.equal(nativeCustomOf(stored[1]!).purchaseOrderLineId, sourceIds[0]);
    assert.equal(
      toUnits(String((nativeCustomOf(stored[1]!).convertedFrom as Record<string, unknown>).quantity)),
      toUnits("4"),
    );

    await approveDocument(fx, billId);
    await postBill(fx, billId);
    const balances = await billBalances(fx);
    assert.equal(toUnits(balances.onHand), toUnits("10"), "a reordered bill receives nothing again");
    assert.equal(toUnits(balances.clearing), toUnits("0"));
    assert.equal(toUnits(balances.ap), toUnits("-26"));
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("quantity change and line removal are refused; delete and reconvert is the remedy", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { org, userId } = fx;
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);
    const base = drawerLine((await loadedLines(fx, billId))[0]!);

    // Billing five when four were received would misread the receipt: the
    // refusal names the converted quantity first.
    const qtyRefusal = await attemptEdit(fx, billId, [{ ...base, quantity: "5", amount: "10" }]);
    assert.ok(qtyRefusal, "a quantity change on a converted line must be refused");
    assert.equal(qtyRefusal.status, 422);
    assert.match(qtyRefusal.message, /keep the converted quantity/);

    // Removing the line would strand its billed cover: refused, nothing changes.
    const removalRefusal = await attemptEdit(fx, billId, []);
    assert.ok(removalRefusal, "removing a converted line must be refused");
    assert.equal(removalRefusal.status, 422);
    assert.match(removalRefusal.message, /removing a line converted from/);
    const intact = (await storedBillLines(fx, billId))[0]!;
    assert.equal(toUnits(intact.quantity ?? ""), toUnits("4"));
    assert.equal(nativeCustomOf(intact).purchaseOrderLineId, sourceIds[0]);
    const billed = (
      await withOrgContext(
        org.orgId,
        () => db.execute<{ billed: string }>(sql`
          select quantity_billed::text as billed from document_lines where id = ${sourceIds[0]!}
        `),
      )
    ).rows[0]!.billed;
    assert.equal(toUnits(billed), toUnits("4"));

    // The named remedy exists: deleting the draft releases the cover, and
    // the order converts again at the received quantity.
    await withOrg(org.orgId, () =>
      deleteDocument(billId, userId, org.orgId, {
        reason: "rebill at the received quantity",
        source: "ui",
      }),
    );
    const released = (
      await withOrgContext(
        org.orgId,
        () => db.execute<{ billed: string }>(sql`
          select quantity_billed::text as billed from document_lines where id = ${sourceIds[0]!}
        `),
      )
    ).rows[0]!.billed;
    assert.equal(toUnits(released), toUnits("0"), "draft delete releases the billed cover");
    const rebillId = await convertToBill(fx, orderId);
    const rebilled = (await storedBillLines(fx, rebillId))[0]!;
    assert.equal(toUnits(rebilled.quantity ?? ""), toUnits("4"));
    assert.equal(nativeCustomOf(rebilled).purchaseOrderLineId, sourceIds[0]);
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("a repriced bill posts purchase price variance, not stock", { skip: !DB }, async () => {
  const fx = await newFixture("Receiving Clerk", "admin");
  try {
    const { orderId, sourceIds } = await setupReceivedOrder(
      fx,
      [{ desc: "Widget", qty: "10", unit: "ea", price: "2", amount: "20" }],
      "20",
    );
    await receiveAll(fx, orderId, "receipt-four", [{ sourceId: sourceIds[0]!, qty: "4" }]);
    const billId = await convertToBill(fx, orderId);

    // The supplier invoices 2.50 a unit against an order at 2.00. Same
    // quantity and item, new price: supported repricing, not an identity
    // change — the difference must land in purchase price variance.
    const repriced = {
      ...drawerLine((await loadedLines(fx, billId))[0]!),
      unitPrice: "2.5",
      amount: "10",
    };
    assert.equal(await attemptEdit(fx, billId, [repriced]), null);

    await approveDocument(fx, billId);
    await postBill(fx, billId);
    const balances = await billBalances(fx);
    assert.equal(toUnits(balances.onHand), toUnits("4"), "the repriced bill receives nothing");
    assert.equal(toUnits(balances.clearing), toUnits("0"));
    assert.equal(toUnits(balances.adjustment), toUnits("2"), "4 x (2.50 - 2.00) variance");
    assert.equal(toUnits(balances.invAsset), toUnits("8"), "inventory stays at receipt cost");
    assert.equal(toUnits(balances.ap), toUnits("-10"));
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("ordinary drafts keep the legacy identity-less path, with identity validation", { skip: !DB }, async () => {
  const fx = await newFixture("Bookkeeper", "bookkeeper");
  try {
    const { org } = fx;
    const draftId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, subtotal, tax_total, total, created_by)
        values
          (${draftId}, ${org.orgId}, 'vendor_bill', 'draft', 'ORDINARY-1', ${org.subsidiaryId},
           ${org.vendorId}, ${org.date}, 'CAD', '10', '0', '10', ${fx.userId})
      `);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, description, quantity, amount, custom)
        values
          (${org.orgId}, ${draftId}, 1, ${org.accounts.cogs}, 'Paper', '1', '10', '{}'::jsonb)
      `);
    });

    // No provenance, no identities: the legacy path still saves.
    assert.equal(
      await attemptEdit(fx, draftId, [{ accountId: org.accounts.cogs, amount: "10", description: "Paper clips" }]),
      null,
      "ordinary drafts keep the identity-less path",
    );
    const saved = (await storedBillLines(fx, draftId))[0]!;
    assert.equal(saved.description, "Paper clips");

    // But a supplied identity is still validated, even without provenance:
    // a foreign id is a 404, never a silently ignored line.
    const foreign = await attemptEdit(fx, draftId, [
      { lineId: randomUUID(), accountId: org.accounts.cogs, amount: "10", description: "Sneaky" },
    ]);
    assert.ok(foreign, "a foreign identity on an ordinary draft must be refused");
    assert.equal(foreign.status, 404);
    assert.match(foreign.message, /not found in this document/);
    assert.equal((await storedBillLines(fx, draftId))[0]!.description, "Paper clips");
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("capture evidence without a PO reference stays editable audit metadata", { skip: !DB }, async () => {
  const fx = await newFixture("Bookkeeper", "bookkeeper");
  try {
    const { org } = fx;
    const draftId = randomUUID();
    const captureItemId = randomUUID();
    // materializeCapture writes apCaptureEvidence on EVERY line, including
    // lines with no PO cover ({ captureItemId, purchaseOrderLineId: null }).
    // Those carry no reservation: the canonical unwind ignores them, so the
    // editor preserves the evidence by identity without freezing the line
    // behind source-bound guards. No PO is invented for this control.
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, subtotal, tax_total, total, created_by)
        values
          (${draftId}, ${org.orgId}, 'vendor_bill', 'draft', 'CAPTURE-1', ${org.subsidiaryId},
           ${org.vendorId}, ${org.date}, 'CAD', '10', '0', '10', ${fx.userId})
      `);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, description, quantity, amount, custom)
        values
          (${org.orgId}, ${draftId}, 1, ${org.accounts.cogs}, 'Captured', '1', '10',
           ${JSON.stringify({ apCaptureEvidence: { captureItemId, purchaseOrderLineId: null } })}::jsonb)
      `);
    });
    const lineId = (await storedBillLines(fx, draftId))[0]!.id;
    const base: DocumentLineInput = {
      lineId,
      accountId: org.accounts.cogs,
      description: "Captured",
      quantity: "1",
      amount: "10",
      custom: {},
    };

    // Description edit: evidence preserved, line not frozen.
    assert.equal(await attemptEdit(fx, draftId, [{ ...base, description: "Captured corrected" }]), null);
    const kept = (await storedBillLines(fx, draftId))[0]!;
    assert.equal(kept.description, "Captured corrected");
    const keptEvidence = nativeCustomOf(kept).apCaptureEvidence as Record<string, unknown>;
    assert.equal(keptEvidence.captureItemId, captureItemId);
    assert.equal(keptEvidence.purchaseOrderLineId, null);

    // Quantity change on a sourceless capture line: allowed, not refused.
    // (Reload the replacement identity first: the prior save minted new rows.)
    const currentId = (await storedBillLines(fx, draftId))[0]!.id;
    assert.equal(
      await attemptEdit(
        fx,
        draftId,
        [{ ...base, lineId: currentId, description: "Captured corrected", quantity: "2", amount: "20" }],
      ),
      null,
    );

    // Removal strands no cover: allowed.
    assert.equal(await attemptEdit(fx, draftId, []), null);
    assert.equal((await storedBillLines(fx, draftId)).length, 0);

    // Malformed reservation evidence fails closed instead.
    await withBypassContext(
      () => db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, description, quantity, amount, custom)
        values
          (${org.orgId}, ${draftId}, 1, ${org.accounts.cogs}, 'Broken', '1', '10',
           ${JSON.stringify({ convertedFrom: { documentId: randomUUID(), lineId: "not-a-uuid", quantity: "1" } })}::jsonb)
      `),
    );
    const brokenId = (await storedBillLines(fx, draftId))[0]!.id;
    const malformed = await attemptEdit(fx, draftId, [
      {
        lineId: brokenId,
        accountId: org.accounts.cogs,
        description: "Broken",
        quantity: "1",
        amount: "10",
        custom: {},
      },
    ]);
    assert.ok(malformed, "unreadable reservation evidence must be refused");
    assert.equal(malformed.status, 422);
    assert.match(malformed.message, /unreadable billing provenance/);
  } finally {
    await dropFixture(fx.org.orgId);
  }
});

test("posted correction copies source line identities as new replacement lines", { skip: !DB }, async () => {
  const fx = await newFixture("Bookkeeper", "bookkeeper");
  try {
    const { org, userId } = fx;
    const invoiceId = randomUUID();
    // Ordinary posted invoice: no inventory, no provenance.
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
           currency, subtotal, tax_total, total, created_by)
        values
          (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'ORDINARY-INV-1', ${org.subsidiaryId},
           ${org.customerId}, ${org.date}, 'CAD', '100', '0', '100', ${userId})
      `);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, description, quantity, amount, custom)
        values
          (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, 'Services', '1', '100', '{}'::jsonb)
      `);
    });
    await approveDocument(fx, invoiceId);
    await withOrgContext(org.orgId, () =>
      postDocument(invoiceId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      }),
    );

    // The drawer copies the posted SOURCE rows — identities included — into
    // the correction body. The copy boundary treats them as new replacement
    // lines; without that, always-on ownership rejects them as foreign.
    const sourceRows = await loadedLines(fx, invoiceId);
    const sourceLineId = sourceRows[0]!.id;
    assert.ok(typeof sourceLineId === "string");
    const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(invoiceId, org.orgId));
    assert.ok(current);
    const created = await withOrg(org.orgId, () =>
      createPostedCorrectionDraft(
        invoiceId,
        {
          expectedUpdatedAt: current.updatedAt,
          amendmentReason: "Correct the billed memo text",
          memo: "corrected memo",
          lines: [
            {
              lineId: sourceLineId as string,
              accountId: sourceRows[0]!.account_id as string,
              description: "Services corrected",
              quantity: String(sourceRows[0]!.quantity),
              amount: String(sourceRows[0]!.amount),
              custom: {},
            },
          ],
        },
        { orgId: org.orgId, userId, source: "ui" },
      ),
    );
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    const replacement = (
      await withOrgContext(
        org.orgId,
        () => db.execute<{ memo: string | null; custom: unknown }>(sql`
          select memo, custom from documents where id = ${created.id} and org_id = ${org.orgId}
        `),
      )
    ).rows[0]!;
    assert.equal(replacement.memo, "corrected memo");
    assert.equal((replacement.custom as Record<string, unknown>).correctionOf, invoiceId);
    const replacementLines = await storedBillLines(fx, created.id);
    assert.equal(replacementLines.length, 1);
    assert.equal(replacementLines[0]!.description, "Services corrected");
    assert.notEqual(replacementLines[0]!.id, sourceLineId, "copied identities become new replacement lines");
  } finally {
    await dropFixture(fx.org.orgId);
  }
});
