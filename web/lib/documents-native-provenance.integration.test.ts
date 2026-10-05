import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { isUuid } from "@/lib/list-params";

// Native line provenance: conversion evidence (purchaseOrderLineId,
// convertedFrom) and AP-capture evidence used to be stripped by every
// description-only save (tenant validation drops keys outside its
// definitions), so posting received the stock a second time. These tests run
// receive -> convert -> edit -> post for real and assert the stock posts
// exactly once. Direct async style (no spawned children): the canonical
// runner owns lifecycle and typecheck covers this file.
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

async function newFixture(displayName: string, role: string, permissions: readonly string[] = []): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const userId = await createScratchUser(org.orgId, displayName, role);
    if (permissions.length) await db.execute(sql`
      update app_roles set permissions = ${JSON.stringify(permissions)}::jsonb
       where org_id = ${org.orgId} and key = ${role}`);
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
  const order = await withOrg(org.orgId, () => createOrderDraft(org.orgId, userId, "purchase_order", randomUUID(), null));
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
        allowedSubsidiaryIds: null,
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
  const fx = await newFixture("Correction controller", "correction_controller", ["ar.create", "ar.post"]);
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
    assert.ok(isUuid(created.id), "expected a real UUID document id");
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


const consolidatedRows = [
  { label: "documents entry allocations", register: async () => {
        // applyDocumentEdit is server-only code exercised through the same module
        // hooks as the neighbouring documents suites.
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );
        const { applyDocumentEdit } = await import("./documents.ts"), { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts"), { loadDocument, loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { submitAndReleaseIfUngated } = await import("@openbooks/engine/src/flows/submit.ts");

        const DB = !!process.env.OPENBOOKS_DB_URL;

        // The allocations/allocationsAtEntry switchboard keys are owned by the
        // platform slice (A10) and registered in the feature registry; the fixture
        // below only flips the org's own toggles on.
        async function enableEntryAllocations(orgId: string): Promise<void> {
          await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',
            coalesce(settings->'features','{}'::jsonb)||'{"allocations":true,"allocationsAtEntry":true}'::jsonb)
            where id=${orgId}`);
        }

        interface Fixture {
          org: Awaited<ReturnType<typeof createScratchOrg>>;
          actor: string;
          expenseAccount: string;
          deptSource: string;
          deptA: string;
          deptB: string;
          ruleId: string;
          versionId: string;
        }

        // Callers run fixture() under withBypassContext: importing ./documents.ts
        // pulls in the web request-org resolver, which denies every unscoped query
        // under pooled RLS (bare setup dies with 42501).
        async function fixture(): Promise<Fixture> {
          const org = await createScratchOrg();
          const actor = await createScratchUser(org.orgId, "Entry allocation keeper", "entry_alloc_keeper");
          await enableEntryAllocations(org.orgId);
          const expenseAccount = randomUUID();
          await db.execute(sql`insert into accounts
            (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, monetary,
             required_dimensions, custom, subsidiary_include_children)
            values (${expenseAccount}, ${org.orgId}, '6100', 'Entry allocation expense', 'expense',
              false, true, false, false, true, '[]'::jsonb, '{}'::jsonb, true)`);
          const deptSource = randomUUID();
          const deptA = randomUUID();
          const deptB = randomUUID();
          await db.execute(sql`insert into departments(id,org_id,name)
            values (${deptSource},${org.orgId},'Overhead pool'),
                   (${deptA},${org.orgId},'Operations A'),
                   (${deptB},${org.orgId},'Operations B')`);
          const ruleId = randomUUID();
          const versionId = randomUUID();
          // The head→version FK is deferrable but each statement commits on its own,
          // so the head goes in first with a null pointer and claims its version after.
          await db.execute(sql`insert into allocation_rules
            (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
            values (${ruleId}, ${org.orgId}, 'overhead-split', 'Overhead split', 'entry', 100, true, false, '{}'::jsonb)`);
          // Targets are immutable once published (target guard trigger), so the
          // version is seeded draft, loaded with targets, then published — the same
          // order the rule service uses.
          await db.execute(sql`insert into allocation_rule_versions
            (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
             document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
             basis_config, target_kind, dynamic_target, impact, residual_policy, solve_method, run_policy,
             run_offset_days, custom)
            values (${versionId}, ${org.orgId}, ${ruleId}, 1, 'draft', '2026-01-01', null, 'primary', '[]'::jsonb,
             '["vendor_bill"]'::jsonb, '{"kind":"any"}'::jsonb,
             ${JSON.stringify({ departmentIds: [deptSource] })}::jsonb, 'automatic', 'period_activity', 'fixed_percent',
             '{}'::jsonb, 'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential', 'manual',
             0, '{}'::jsonb)`);
          await db.execute(sql`insert into allocation_rule_targets
            (id, org_id, version_id, sequence, department_id, fixed_percent, extra_dims, is_remainder, custom)
            values (${randomUUID()}, ${org.orgId}, ${versionId}, 0, ${deptA}, '50', '{}'::jsonb, false, '{}'::jsonb),
                   (${randomUUID()}, ${org.orgId}, ${versionId}, 1, ${deptB}, '50', '{}'::jsonb, false, '{}'::jsonb)`);
          await db.execute(sql`update allocation_rule_versions set status = 'published', definition_hash = 'entry-test-hash'
            where id = ${versionId} and org_id = ${org.orgId}`);
          await db.execute(sql`update allocation_rules set current_version_id = ${versionId}
            where id = ${ruleId} and org_id = ${org.orgId}`);
          return { org, actor, expenseAccount, deptSource, deptA, deptB, ruleId, versionId };
        }

        // These helpers run in the scratch org's scope: the edit service and its
        // readers issue bare queries with explicit org predicates, which pooled RLS
        // denies outside an explicit scope (reads see zero rows).
        async function draftBill(f: Fixture, number: string): Promise<string> {
          return withOrgContext(f.org.orgId, async () => {
            const id = randomUUID();
            await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
              values (${id},${f.org.orgId},'vendor_bill','draft',${number},${f.org.subsidiaryId},${f.org.vendorId},${f.org.date},'CAD','0','0','0',${f.actor})`);
            return id;
          });
        }

        async function edit(f: Fixture, id: string, patch: Parameters<typeof applyDocumentEdit>[2]): Promise<void> {
          await withOrgContext(f.org.orgId, async () => {
            const current = await loadDocumentEditCurrent(id, f.org.orgId);
            assert.ok(current);
            await applyDocumentEdit(
              id,
              current,
              { ...patch, expectedUpdatedAt: current.updatedAt },
              { orgId: f.org.orgId, userId: f.actor, source: "api" },
            );
          });
        }

        async function storedLines(f: Fixture, id: string) {
          return withOrgContext(f.org.orgId, async () => (
            await db.execute<{
              id: string;
              lineNumber: number;
              accountId: string;
              amount: string;
              departmentId: string | null;
              groupId: string | null;
              ruleId: string | null;
              versionId: string | null;
              locked: boolean;
            }>(sql`
              select id, line_number as "lineNumber", account_id as "accountId", amount::text as amount,
                     department_id as "departmentId", distribution_group_id as "groupId",
                     distribution_rule_id as "ruleId", distribution_version_id as "versionId",
                     distribution_locked as "locked"
                from document_lines where document_id = ${id} and org_id = ${f.org.orgId}
               order by line_number
            `)
          ).rows);
        }

        function sumAmounts(amounts: string[]): bigint {
          let total = 0n;
          for (const amount of amounts) {
            const negative = amount.startsWith("-");
            const [whole = "0", frac = ""] = amount.replace("-", "").split(".");
            const units = BigInt(whole) * 10000n + BigInt((frac + "0000").slice(0, 4));
            total += negative ? -units : units;
          }
          return total;
        }

        test("a bill line coded to a matching department explodes on save with exact children", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          try {
            const id = await draftBill(f, "ENTRY-AUTO-1");
            await edit(f, id, {
              lines: [
                { accountId: f.expenseAccount, amount: "100.0000", description: "pool cost", departmentId: f.deptSource },
                { accountId: f.expenseAccount, amount: "25.0000", description: "direct cost" },
              ],
            });
            const lines = await storedLines(f, id);
            assert.equal(lines.length, 3);
            const children = lines.filter((l) => l.groupId !== null);
            assert.equal(children.length, 2);
            assert.equal(children[0]!.groupId, children[1]!.groupId);
            assert.deepEqual(
              children.map((l) => l.amount).sort(),
              ["50.0000", "50.0000"],
            );
            assert.equal(sumAmounts(children.map((l) => l.amount)), sumAmounts(["100.0000"]));
            assert.deepEqual(
              children.map((l) => l.departmentId).sort(),
              [f.deptA, f.deptB].sort(),
            );
            for (const child of children) {
              assert.equal(child.ruleId, f.ruleId);
              assert.equal(child.versionId, f.versionId);
              assert.equal(child.locked, false);
            }
            const plain = lines.find((l) => l.groupId === null)!;
            assert.equal(plain.amount, "25.0000");
            const { doc, lineage } = await withOrgContext(f.org.orgId, async () => {
              const doc = await db.execute<{ total: string }>(
                sql`select total::text as total from documents where id = ${id} and org_id = ${f.org.orgId}`,
              );
              const lineage = (
                await db.execute<{ ruleId: string; amount: string; targetId: string | null; sourceId: string | null }>(sql`
                  select rule_id as "ruleId", amount::text as amount,
                         target_document_line_id as "targetId", source_document_line_id as "sourceId"
                    from allocation_lineage where org_id = ${f.org.orgId} and document_id = ${id}
                `)
              ).rows;
              return { doc, lineage };
            });
            assert.equal(doc.rows[0]?.total, "125.0000");
            assert.equal(lineage.length, 2);
            for (const row of lineage) {
              assert.equal(row.ruleId, f.ruleId);
              assert.ok(children.some((l) => l.id === row.targetId));
              assert.equal(row.sourceId, null);
            }
            // The drawer payload round-trips the stamps plus the rule name.
            const loaded = await withOrgContext(f.org.orgId, () => loadDocument(id, f.org.orgId));
            const childRows = (loaded?.lines as Record<string, unknown>[]).filter((l) => l.distribution_group_id !== null);
            assert.equal(childRows.length, 2);
            for (const row of childRows) {
              assert.equal(row.distribution_rule_name, "Overhead split");
              assert.equal(row.distribution_locked, false);
            }
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("header-default dims drive the automatic match when the line leaves them blank", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          try {
            const id = await draftBill(f, "ENTRY-HEADER-1");
            await edit(f, id, {
              departmentId: f.deptSource,
              lines: [{ accountId: f.expenseAccount, amount: "80.0000", description: "blank line" }],
            });
            const lines = await storedLines(f, id);
            assert.equal(lines.length, 2);
            assert.ok(lines.every((l) => l.groupId !== null));
            assert.equal(sumAmounts(lines.map((l) => l.amount)), sumAmounts(["80.0000"]));
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("re-save regenerates an unlocked group on sum change but keeps a locked one", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          try {
            const id = await draftBill(f, "ENTRY-REGEN-1");
            await edit(f, id, {
              lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
            });
            const first = await storedLines(f, id);
            const groupId = first[0]!.groupId;
            assert.ok(groupId);

            // Changed sum, unlocked: regenerate from the group total, same group id.
            await edit(f, id, {
              lines: first.map((l, i) => ({
                accountId: l.accountId,
                amount: i === 0 ? "70.0000" : l.amount,
                departmentId: l.departmentId,
                distributionGroupId: l.groupId,
              })),
            });
            const regen = await storedLines(f, id);
            assert.equal(regen.length, 2);
            assert.ok(regen.every((l) => l.groupId === groupId));
            assert.equal(sumAmounts(regen.map((l) => l.amount)), sumAmounts(["120.0000"]));

            // Lock, then change again: the submitted children stay exactly as sent.
            await edit(f, id, {
              lines: regen.map((l) => ({
                accountId: l.accountId,
                amount: "10.0000",
                departmentId: l.departmentId,
                distributionGroupId: l.groupId,
                distributionLocked: true,
              })),
            });
            const locked = await storedLines(f, id);
            assert.deepEqual(locked.map((l) => l.amount), ["10.0000", "10.0000"]);
            assert.ok(locked.every((l) => l.locked));
            assert.ok(locked.every((l) => l.groupId === groupId));
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("un-split collapses a group to one line at the first child's coordinates", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          try {
            const id = await draftBill(f, "ENTRY-UNSPLIT-1");
            await edit(f, id, {
              lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
            });
            const first = await storedLines(f, id);
            const groupId = first[0]!.groupId;
            assert.ok(groupId);
            await edit(f, id, {
              unsplitDistributionGroups: [groupId!],
              lines: first.map((l) => ({
                accountId: l.accountId,
                amount: l.amount,
                departmentId: l.departmentId,
                distributionGroupId: l.groupId,
              })),
            });
            const collapsed = await storedLines(f, id);
            assert.equal(collapsed.length, 1);
            assert.equal(collapsed[0]!.amount, "100.0000");
            assert.equal(collapsed[0]!.departmentId, first[0]!.departmentId);
            assert.equal(collapsed[0]!.groupId, null);
            assert.equal(collapsed[0]!.ruleId, null);
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("an explicit distributionKey explodes a manual rule and bad keys fail closed", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          const manualRuleId = randomUUID();
          const manualVersionId = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`insert into allocation_rules
              (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
              values (${manualRuleId}, ${f.org.orgId}, 'manual-pick', 'Manual pick', 'entry', 10, true, false, '{}'::jsonb)`);
            await db.execute(sql`insert into allocation_rule_versions
              (id, org_id, rule_id, version_no, status, effective_from, effective_to, book_scope, book_ids,
               document_kinds, account_scope, dimension_filters, apply_policy, source_measure, basis_kind,
               basis_config, target_kind, dynamic_target, impact, residual_policy, solve_method, run_policy,
               run_offset_days, custom)
              values (${manualVersionId}, ${f.org.orgId}, ${manualRuleId}, 1, 'draft', '2026-01-01', null, 'primary', '[]'::jsonb,
               null, '{"kind":"any"}'::jsonb, '{}'::jsonb, 'manual', 'period_activity', 'fixed_percent',
               '{}'::jsonb, 'explicit', '{}'::jsonb, 'reclass', 'largest_share', 'sequential', 'manual',
               0, '{}'::jsonb)`);
            await db.execute(sql`insert into allocation_rule_targets
              (id, org_id, version_id, sequence, department_id, fixed_percent, extra_dims, is_remainder, custom)
              values (${randomUUID()}, ${f.org.orgId}, ${manualVersionId}, 0, ${f.deptA}, '100', '{}'::jsonb, false, '{}'::jsonb)`);
            await db.execute(sql`update allocation_rule_versions set status = 'published', definition_hash = 'entry-test-hash-manual'
              where id = ${manualVersionId} and org_id = ${f.org.orgId}`);
            await db.execute(sql`update allocation_rules set current_version_id = ${manualVersionId}
              where id = ${manualRuleId} and org_id = ${f.org.orgId}`);
          });
          try {
            const id = await draftBill(f, "ENTRY-KEY-1");
            await edit(f, id, {
              lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "manual-pick" }],
            });
            const lines = await storedLines(f, id);
            assert.equal(lines.length, 1);
            assert.equal(lines[0]!.departmentId, f.deptA);
            assert.equal(lines[0]!.ruleId, manualRuleId);

            const badId = await draftBill(f, "ENTRY-KEY-2");
            await assert.rejects(
              edit(f, badId, {
                lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "no-such-rule" }],
              }),
              (error: unknown) =>
                error instanceof DocumentEditError &&
                error.status === 422 &&
                /does not match an allocation rule/.test(error.message),
            );
            // Nothing partial persists when the key is rejected.
            assert.equal((await storedLines(f, badId)).length, 0);

            const inactiveRuleId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(sql`insert into allocation_rules
                (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
                values (${inactiveRuleId}, ${f.org.orgId}, 'retired-pick', 'Retired pick', 'entry', 10, false, false, '{}'::jsonb)`);
            });
            await assert.rejects(
              edit(f, badId, {
                lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "retired-pick" }],
              }),
              (error: unknown) =>
                error instanceof DocumentEditError &&
                error.status === 422 &&
                /not active with a published version/.test(error.message),
            );

            const postRuleId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(sql`insert into allocation_rules
                (id, org_id, key, name, mode, sort_order, is_active, is_system, custom)
                values (${postRuleId}, ${f.org.orgId}, 'post-pick', 'Post pick', 'post', 10, true, false, '{}'::jsonb)`);
            });
            await assert.rejects(
              edit(f, badId, {
                lines: [{ accountId: f.expenseAccount, amount: "30.0000", distributionKey: "post-pick" }],
              }),
              (error: unknown) =>
                error instanceof DocumentEditError &&
                error.status === 422 &&
                /only entry rules can split document lines/.test(error.message),
            );
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("posting a bill with exploded children writes journal lines per child", { skip: !DB }, async () => {
          const f = await withBypassContext(() => fixture());
          try {
            const id = await draftBill(f, "ENTRY-POST-1");
            await edit(f, id, {
              lines: [{ accountId: f.expenseAccount, amount: "100.0000", departmentId: f.deptSource }],
            });
            // Submit, posting, and the journal read run in the scratch org's scope.
            const legs = await withOrgContext(f.org.orgId, async () => {
              assert.equal((await submitAndReleaseIfUngated("vendor_bill", id, f.actor)).autoApproved, true);
              await postDocument(
                id,
                { control: { ar: f.org.accounts.ar, ap: f.org.accounts.ap, bank: f.org.accounts.bank } },
                { audit: { actorId: f.actor, source: "test" } },
              );
              return (
                await db.execute<{ accountId: string; departmentId: string | null; amount: string }>(sql`
                  select l.account_id as "accountId", l.department_id as "departmentId", l.amount::text as amount
                    from journal_lines l
                    join documents d on d.org_id = l.org_id and d.posted_entry_id = l.entry_id
                   where d.org_id = ${f.org.orgId} and d.id = ${id}
                `)
              ).rows;
            });
            const children = legs.filter((l) => l.accountId === f.expenseAccount);
            assert.equal(children.length, 2);
            assert.deepEqual(
              children.map((l) => `${l.departmentId}:${l.amount}`).sort(),
              [`${f.deptA}:50.0000`, `${f.deptB}:50.0000`].sort(),
            );
            assert.equal(sumAmounts(children.map((l) => l.amount)), sumAmounts(["100.0000"]));
          } finally {
            await withBypassContext(() => dropScratchOrg(f.org.orgId));
          }
        });

        test("feature off leaves distribution lines untouched", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Entry allocation off keeper", "entry_alloc_off_keeper");
              // No feature flags: the registry defaults (off) govern.
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                values (${id},${org.orgId},'vendor_bill','draft','ENTRY-OFF-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
              return { actor, id };
            });
            // The edit and its verification reads run in the scratch org's scope.
            const lines = await withOrgContext(org.orgId, async () => {
              const current = await loadDocumentEditCurrent(id, org.orgId);
              assert.ok(current);
              await applyDocumentEdit(
                id,
                current,
                {
                  expectedUpdatedAt: current.updatedAt,
                  lines: [
                    {
                      accountId: org.accounts.cogs,
                      amount: "100.0000",
                      description: "untouched",
                      distributionKey: "whatever",
                    },
                  ],
                },
                { orgId: org.orgId, userId: actor, source: "api" },
              );
              const lines = (
                await db.execute<{ groupId: string | null; amount: string }>(sql`
                  select distribution_group_id as "groupId", amount::text as amount
                    from document_lines where document_id = ${id} and org_id = ${org.orgId}
                `)
              ).rows;
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from allocation_lineage where org_id = ${org.orgId}`))
                  .rows[0]?.n,
                0,
              );
              return lines;
            });
            assert.equal(lines.length, 1);
            assert.equal(lines[0]!.groupId, null);
            assert.equal(lines[0]!.amount, "100.0000");
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "documents inventory return", register: async () => {
        // The authoring half of stock returns. The return engines required
        // custom.inventoryReturn evidence on every returned credit line, and nothing
        // in the product could write it: the documents editor strips native custom
        // from callers and re-attaches only its own trusted keys, and inventoryReturn
        // was not one of them. These tests drive the real save path.
        const { db, withBypassContext, withOrg, withOrgContext } = await import(
          "@openbooks/engine/src/platform/db.ts"
        );
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { loadDocument, loadDocumentEditCurrent } = await import(
          "@openbooks/engine/src/ledger/document-service.ts"
        );
        const { applyDocumentEdit } = await import("./documents.ts");
        const { receiveInventory } = await import("@openbooks/engine/src/inventory/movements.ts");
        const { getOnHand } = await import("@openbooks/engine/src/inventory/position.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
          "@openbooks/engine/src/testing/fixtures.ts"
        );


        const DB = !!process.env.OPENBOOKS_DB_URL;

        type Fixture = {
          org: Awaited<ReturnType<typeof createScratchOrg>>;
          userId: string;
        };

        async function newFixture(): Promise<Fixture> {
          return withBypassContext(async () => {
            const org = await createScratchOrg();
            const userId = await createScratchUser(org.orgId, "Return author", "admin");
            return { org, userId };
          });
        }

        const depsFor = (org: Fixture["org"]) => ({
          control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
        });

        /** Post an invoice that ships stock, returning the issue movement it created. */
        async function shipOnInvoice(
          fx: Fixture,
          quantity: string,
          unitPrice: string,
          amount: string,
        ): Promise<string> {
          const { org, userId } = fx;
          const documentId = randomUUID();
          const lineId = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into documents
                (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                 posting_date, currency, fx_rate, status, subtotal, tax_total, total, custom, created_by)
              values (${documentId}, ${org.orgId}, 'customer_invoice', ${`INV-AUTH-${documentId.slice(0, 8)}`},
                      ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
                      'draft', ${amount}, '0', ${amount}, '{}'::jsonb, ${userId})`);
            await db.execute(sql`
              insert into document_lines
                (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                 amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                 stock_location_id, custom, tax_overridden)
              values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue},
                      ${quantity}, ${unitPrice}, ${amount}, '0', false, '0', '0',
                      ${org.stockLocationId}, '{}'::jsonb, false)`);
            await db.execute(sql`
              update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
          });
          await withBypassContext(() => postDocument(documentId, depsFor(org)));
          return (await withBypassContext(async () =>
            (await db.execute<{ id: string }>(sql`
              select id from inventory_movements
               where org_id = ${org.orgId} and document_line_id = ${lineId} and kind = 'issue'`)).rows[0]!.id,
          ));
        }

        /** A draft customer credit with one inventory line and no return evidence. */
        async function draftCredit(fx: Fixture, quantity: string, unitPrice: string, amount: string): Promise<string> {
          const { org, userId } = fx;
          const documentId = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into documents
                (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                 posting_date, currency, fx_rate, status, subtotal, tax_total, total, custom, created_by)
              values (${documentId}, ${org.orgId}, 'customer_credit', ${`CM-AUTH-${documentId.slice(0, 8)}`},
                      ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, 'CAD', 1,
                      'draft', ${amount}, '0', ${amount}, '{}'::jsonb, ${userId})`);
            await db.execute(sql`
              insert into document_lines
                (org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                 amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                 stock_location_id, custom, tax_overridden)
              values (${org.orgId}, ${documentId}, 1, ${org.items.fifo}, ${org.accounts.revenue},
                      ${quantity}, ${unitPrice}, ${amount}, '0', false, '0', '0',
                      ${org.stockLocationId}, '{}'::jsonb, false)`);
          });
          return documentId;
        }

        /** Drawer-shaped line input: identity plus tenant custom only. */
        function drawerLine(
          line: Record<string, unknown>,
          overrides: Partial<DocumentLineInput> = {},
        ): DocumentLineInput {
          const text = (v: unknown): string | null => (typeof v === "string" ? v : v == null ? null : String(v));
          return {
            lineId: typeof line.id === "string" ? line.id : null,
            accountId: text(line.account_id) ?? "",
            itemId: text(line.item_id),
            description: text(line.description),
            quantity: line.quantity == null ? null : String(line.quantity),
            unitPrice: line.unit_price == null ? null : String(line.unit_price),
            amount: String(line.amount),
            stockLocationId: text(line.stock_location_id),
            custom: {},
            ...overrides,
          };
        }

        async function linesOf(fx: Fixture, documentId: string): Promise<Record<string, unknown>[]> {
          const loaded = await withOrgContext(fx.org.orgId, () => loadDocument(documentId, fx.org.orgId));
          assert.ok(loaded);
          return loaded.lines;
        }

        async function save(
          fx: Fixture,
          documentId: string,
          build: (lines: Record<string, unknown>[]) => DocumentLineInput[],
        ): Promise<{ status?: number; message: string } | null> {
          const current = await withOrgContext(fx.org.orgId, () =>
            loadDocumentEditCurrent(documentId, fx.org.orgId),
          );
          assert.ok(current);
          const lines = build(await linesOf(fx, documentId));
          try {
            await withOrg(fx.org.orgId, () =>
              applyDocumentEdit(
                documentId,
                current,
                { expectedUpdatedAt: current.updatedAt, lines },
                { orgId: fx.org.orgId, userId: fx.userId, source: "ui", runFlows: false },
              ),
            );
            return null;
          } catch (error) {
            const e = error as { status?: number; message: string };
            return { status: e.status, message: e.message };
          }
        }

        function storedReturn(line: Record<string, unknown>): Record<string, unknown> | null {
          const custom = line.custom;
          if (!custom || typeof custom !== "object") return null;
          const bag = (custom as Record<string, unknown>).inventoryReturn;
          return bag && typeof bag === "object" ? (bag as Record<string, unknown>) : null;
        }

        test("the editor writes, preserves, and clears a chosen return source", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "10", unitCost: "4", subsidiaryId: fx.org.subsidiaryId,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            const issueMovementId = await shipOnInvoice(fx, "10", "25", "250");
            const creditId = await draftCredit(fx, "4", "25", "100");

            // Selecting the shipment writes the trusted bag the return engine reads.
            assert.equal(
              await save(fx, creditId, (lines) => [
                drawerLine(lines[0]!, { inventoryReturnSource: { movementId: issueMovementId } }),
              ]),
              null,
            );
            assert.deepEqual(storedReturn((await linesOf(fx, creditId))[0]!), {
              sourceIssueMovementId: issueMovementId,
            });

            // A later description-only save must not strip it — the defect this whole
            // re-attachment mechanism exists to prevent.
            assert.equal(
              await save(fx, creditId, (lines) => [drawerLine(lines[0]!, { description: "renamed" })]),
              null,
            );
            const afterRename = (await linesOf(fx, creditId))[0]!;
            assert.equal(afterRename.description, "renamed");
            assert.deepEqual(storedReturn(afterRename), { sourceIssueMovementId: issueMovementId });

            // Explicit null clears it, leaving an ordinary financial credit line.
            assert.equal(
              await save(fx, creditId, (lines) => [
                drawerLine(lines[0]!, { inventoryReturnSource: null }),
              ]),
              null,
            );
            assert.equal(storedReturn((await linesOf(fx, creditId))[0]!), null);
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });

        test("a forged return source in caller custom is ignored", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "5", unitCost: "4", subsidiaryId: fx.org.subsidiaryId,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            const issueMovementId = await shipOnInvoice(fx, "5", "20", "100");
            const creditId = await draftCredit(fx, "1", "20", "20");

            // Sent through `custom` rather than the typed field: stripped, not stored.
            assert.equal(
              await save(fx, creditId, (lines) => [
                drawerLine(lines[0]!, {
                  custom: { inventoryReturn: { sourceIssueMovementId: issueMovementId } },
                }),
              ]),
              null,
            );
            assert.equal(storedReturn((await linesOf(fx, creditId))[0]!), null);
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });

        test("a shipment that is not returnable is refused and changes nothing", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "5", unitCost: "4", subsidiaryId: fx.org.subsidiaryId,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            await shipOnInvoice(fx, "5", "20", "100");
            const creditId = await draftCredit(fx, "1", "20", "20");

            const refusal = await save(fx, creditId, (lines) => [
              drawerLine(lines[0]!, { inventoryReturnSource: { movementId: randomUUID() } }),
            ]);
            assert.ok(refusal, "an unknown movement must be refused");
            assert.match(refusal.message, /not available to return/);
            assert.match(refusal.message, /nothing was changed/);
            assert.equal(storedReturn((await linesOf(fx, creditId))[0]!), null);
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });

        test("a return source on a kind that cannot return stock is refused", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "5", unitCost: "4", subsidiaryId: fx.org.subsidiaryId,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            const issueMovementId = await shipOnInvoice(fx, "5", "20", "100");

            // A draft invoice, not a credit: it has nothing to return against.
            const invoiceId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(sql`
                insert into documents
                  (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                   posting_date, currency, fx_rate, status, subtotal, tax_total, total, custom, created_by)
                values (${invoiceId}, ${fx.org.orgId}, 'customer_invoice', ${`INV-X-${invoiceId.slice(0, 8)}`},
                        ${fx.org.customerId}, ${fx.org.subsidiaryId}, ${fx.org.date}, ${fx.org.date}, 'CAD', 1,
                        'draft', '20', '0', '20', '{}'::jsonb, ${fx.userId})`);
              await db.execute(sql`
                insert into document_lines
                  (org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                   amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                   stock_location_id, custom, tax_overridden)
                values (${fx.org.orgId}, ${invoiceId}, 1, ${fx.org.items.fifo}, ${fx.org.accounts.revenue},
                        '1', '20', '20', '0', false, '0', '0', ${fx.org.stockLocationId}, '{}'::jsonb, false)`);
            });

            const refusal = await save(fx, invoiceId, (lines) => [
              drawerLine(lines[0]!, { inventoryReturnSource: { movementId: issueMovementId } }),
            ]);
            assert.ok(refusal);
            assert.match(refusal.message, /only a vendor credit or a customer credit can return stock/);
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });

        test("a return source from another legal entity is refused at save", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            const subB = randomUUID();
            await withBypassContext(async () => {
              // One root per org: the fixture already created it, so the second
              // legal entity hangs under the root.
              await db.execute(sql`
                insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
                values (${subB}, ${fx.org.orgId}, ${fx.org.subsidiaryId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
            });
            // Stock received and shipped in B for the same customer, item and
            // warehouse as the A credit below: only the legal entity differs.
            // The customer must transact with B before an invoice can post there.
            await withBypassContext(async () => {
              await db.execute(sql`
                insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
                values (${randomUUID()}, ${fx.org.orgId}, ${fx.org.customerId}, ${subB})`);
            });
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "5", unitCost: "4", subsidiaryId: subB,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            const invoiceId = randomUUID();
            const invoiceLineId = randomUUID();
            await withBypassContext(async () => {
              await db.execute(sql`
                insert into documents
                  (id, org_id, kind, document_number, party_id, subsidiary_id, document_date,
                   posting_date, currency, fx_rate, status, subtotal, tax_total, total, custom, created_by)
                values (${invoiceId}, ${fx.org.orgId}, 'customer_invoice', ${`INV-B-${invoiceId.slice(0, 8)}`},
                        ${fx.org.customerId}, ${subB}, ${fx.org.date}, ${fx.org.date}, 'CAD', 1,
                        'draft', '100', '0', '100', '{}'::jsonb, ${fx.userId})`);
              await db.execute(sql`
                insert into document_lines
                  (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                   amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                   stock_location_id, custom, tax_overridden)
                values (${invoiceLineId}, ${fx.org.orgId}, ${invoiceId}, 1, ${fx.org.items.fifo}, ${fx.org.accounts.revenue},
                        '5', '20', '100', '0', false, '0', '0',
                        ${fx.org.stockLocationId}, '{}'::jsonb, false)`);
              await db.execute(sql`
                update documents set status = 'approved' where id = ${invoiceId} and org_id = ${fx.org.orgId}`);
            });
            await withBypassContext(() => postDocument(invoiceId, depsFor(fx.org)));
            const foreignIssue = (await withBypassContext(async () =>
              (await db.execute<{ id: string }>(sql`
                select id from inventory_movements
                 where org_id = ${fx.org.orgId} and document_line_id = ${invoiceLineId} and kind = 'issue'`)).rows[0]!.id,
            ));
            // A draft credit in A naming B's shipment: refused at save (422), before
            // the posting guard would see it, and nothing is stored.
            const creditId = await draftCredit(fx, "1", "20", "20");
            const refusal = await save(fx, creditId, (lines) => [
              drawerLine(lines[0]!, { inventoryReturnSource: { movementId: foreignIssue } }),
            ]);
            assert.ok(refusal, "a cross-entity return source must be refused at save");
            assert.equal(refusal.status, 422);
            assert.match(refusal.message, /not available to return/);
            assert.match(refusal.message, /nothing was changed/);
            assert.equal(storedReturn((await linesOf(fx, creditId))[0]!), null);
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });

        test("an authored return posts and restores the stock end to end", { skip: !DB }, async () => {
          const fx = await newFixture();
          try {
            await withBypassContext(() =>
              receiveInventory(fx.org.orgId, null, {
                itemId: fx.org.items.fifo, stockLocationId: fx.org.stockLocationId,
                quantity: "10", unitCost: "4", subsidiaryId: fx.org.subsidiaryId,
                offsetAccountId: fx.org.accounts.clearing, date: fx.org.date,
              }),
            );
            const issueMovementId = await shipOnInvoice(fx, "10", "25", "250");
            const creditId = await draftCredit(fx, "4", "25", "100");
            assert.equal(
              await save(fx, creditId, (lines) => [
                drawerLine(lines[0]!, { inventoryReturnSource: { movementId: issueMovementId } }),
              ]),
              null,
            );
            await withBypassContext(async () => {
              await db.execute(sql`
                update documents set status = 'approved' where id = ${creditId} and org_id = ${fx.org.orgId}`);
              await postDocument(creditId, depsFor(fx.org));
            });

            // Authored in the editor, restored by the engine, at the cost it left at.
            const onHand = await withBypassContext(() =>
              getOnHand(fx.org.orgId, fx.org.items.fifo, fx.org.stockLocationId),
            );
            assert.equal(onHand.quantity, "4.0000");
            assert.equal(onHand.unitCost, "4.0000");
          } finally {
            await withBypassContext(() => dropScratchOrg(fx.org.orgId));
          }
        });
  } },
  { label: "documents line scale", register: async () => {
        // Live-Postgres regression: document_lines.unit_price is numeric(28,8), so a
        // saved invoice line reads back at storage scale ('200.00000000'). The shared
        // document edit service (web/lib/documents.ts applyDocumentEdit, used by the
        // invoice/credit/bill drawers and the REST API) validated unitPrice with the
        // 4dp ledger helper, so re-saving the stored values — exactly what the
        // DocumentDrawer sends on every reload-then-save — failed with a 422
        // ('unit price is not a valid amount') instead of round-tripping. Input
        // validation must accept the column's own scale.

        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { applyDocumentEdit } = await import("./documents.ts"), { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts"), { loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");

        const DB = !!process.env.OPENBOOKS_DB_URL;

        test("applyDocumentEdit round-trips a stored 8dp unit price", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Line scale keeper", "line_scale_keeper");
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                values (${id},${org.orgId},'customer_invoice','draft','SCALE-INV-1',${org.subsidiaryId},${org.customerId},${org.date},'CAD','0','0','0',${actor})`);
              return { actor, id };
            });
            // The edit service and its readers issue bare queries with explicit org
            // predicates, which pooled RLS denies outside an explicit scope (reads see
            // zero rows) once ./documents.ts pulls in the web request-org resolver.
            const first = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(first);
            await withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              first,
              {
                expectedUpdatedAt: first.updatedAt,
                lines: [{ accountId: org.accounts.revenue, quantity: "2", unitPrice: "200.00", amount: "400.00" }],
              },
              { orgId: org.orgId, userId: actor, source: "api" },
            ));
            const stored = await withOrgContext(org.orgId, async () => (await db.execute<{ quantity: string; unit_price: string }>(sql`
              select quantity::text, unit_price::text from document_lines
               where document_id = ${id} and org_id = ${org.orgId}`)).rows[0]!);
            // Premise: storage pads to the column scale.
            assert.equal(stored.unit_price, "200.00000000");
            // The drawer sends back exactly what it read; that must save.
            const second = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(second);
            await withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              second,
              {
                expectedUpdatedAt: second.updatedAt,
                lines: [{ accountId: org.accounts.revenue, quantity: stored.quantity, unitPrice: stored.unit_price, amount: "400.00" }],
              },
              { orgId: org.orgId, userId: actor, source: "api" },
            ));
            const doc = await withOrgContext(org.orgId, async () => (await db.execute<{ subtotal: string; total: string }>(sql`
              select subtotal::text, total::text from documents where id = ${id} and org_id = ${org.orgId}`)).rows[0]!);
            assert.equal(doc.subtotal, "400.0000");
            assert.equal(doc.total, "400.0000");
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("applyDocumentEdit refuses junk quantities with a named error, not a storage failure", { skip: !DB }, async () => {
          // A sloppy line-grid save used to carry quantity straight into the
          // numeric(28,8) column: "abc", a blank cell, or a 26-digit paste died in
          // Postgres with a driver error (a 500). The edit service must fail closed
          // with the line number instead.
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, "Quantity guard", "quantity_guard"));
            for (const [index, bad] of ["abc", "", "99999999999999999999999999"].entries()) {
              const { id, current } = await withOrgContext(org.orgId, async () => {
                const id = randomUUID();
                await withBypassContext(async () => {
                  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                    values (${id},${org.orgId},'customer_invoice','draft',${`QTY-${index}-${id.slice(0, 8)}`},${org.subsidiaryId},${org.customerId},${org.date},'CAD','0','0','0',${actor})`);
                });
                const current = await loadDocumentEditCurrent(id, org.orgId);
                return { id, current };
              });
              assert.ok(current);
              await assert.rejects(
                withOrgContext(org.orgId, () => applyDocumentEdit(
                  id,
                  current,
                  {
                    expectedUpdatedAt: current.updatedAt,
                    lines: [{ accountId: org.accounts.revenue, quantity: bad, unitPrice: "200.00", amount: "400.00" }],
                  },
                  { orgId: org.orgId, userId: actor, source: "api" },
                )),
                (e: Error) => e instanceof DocumentEditError && (e as { status?: number }).status === 422 && /quantity/i.test(e.message),
                `quantity ${JSON.stringify(bad)} should fail closed with a named error`,
              );
            }
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("applyDocumentEdit refuses line money wider than its column with a named error", { skip: !DB }, async () => {
          // document_lines.amount is numeric(19,4) and unit_price numeric(28,8): a
          // pasted figure wider than the column cleared the format checks and died in
          // Postgres with a driver error (a 500). The edit service must fail closed
          // with the line number instead.
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, "Money range guard", "money_range_guard"));
            const cases = [
              { unitPrice: "200.00", amount: "9999999999999999" },
              { unitPrice: "99999999999999999999999", amount: "400.00" },
            ];
            for (const [index, line] of cases.entries()) {
              const { id, current } = await withOrgContext(org.orgId, async () => {
                const id = randomUUID();
                await withBypassContext(async () => {
                  await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                    values (${id},${org.orgId},'customer_invoice','draft',${`RNG-${index}-${id.slice(0, 8)}`},${org.subsidiaryId},${org.customerId},${org.date},'CAD','0','0','0',${actor})`);
                });
                const current = await loadDocumentEditCurrent(id, org.orgId);
                return { id, current };
              });
              assert.ok(current);
              await assert.rejects(
                withOrgContext(org.orgId, () => applyDocumentEdit(
                  id,
                  current,
                  {
                    expectedUpdatedAt: current.updatedAt,
                    lines: [{ accountId: org.accounts.revenue, quantity: "2", ...line }],
                  },
                  { orgId: org.orgId, userId: actor, source: "api" },
                )),
                (e: Error) => e instanceof DocumentEditError && (e as { status?: number }).status === 422 && /Line 1/.test(e.message),
                `line ${JSON.stringify(line)} should fail closed with a named error`,
              );
            }
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "documents subsidiary", register: async () => {
        // A document's subsidiary is structural: posting falls back to the root
        // entity when it is null, but every subsidiary-scoped list excludes null, so
        // clearing it hides a live document from restricted readers while its ledger
        // entries remain. The drawer sends `subsidiaryId: null` when its entity
        // picker is empty, and the service boundary must refuse that shape the same
        // way it refuses clearing a required party.
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { applyDocumentEdit } = await import("./documents.ts"), { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts"), { loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");

        const DB = !!process.env.OPENBOOKS_DB_URL;

        test("applyDocumentEdit refuses to clear a document's subsidiary", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Subsidiary keeper", "subsidiary_keeper");
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                values (${id},${org.orgId},'vendor_bill','draft','NULL-SUB-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
              return { actor, id };
            });
            // The edit service and its readers issue bare queries with explicit org
            // predicates, which pooled RLS denies outside an explicit scope (reads see
            // zero rows) once ./documents.ts pulls in the web request-org resolver.
            const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(current);
            await assert.rejects(
              withOrgContext(org.orgId, () => applyDocumentEdit(
                id,
                current,
                { subsidiaryId: null, expectedUpdatedAt: current.updatedAt },
                { orgId: org.orgId, userId: actor, source: "api" },
              )),
              (error: unknown) => error instanceof DocumentEditError && error.status === 422,
            );
            const after = await withOrgContext(org.orgId, async () => (await db.execute<{ subsidiary_id: string | null }>(sql`
              select subsidiary_id from documents where id = ${id} and org_id = ${org.orgId}`)));
            assert.equal(after.rows[0]?.subsidiary_id, org.subsidiaryId);
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("applyDocumentEdit validates partial header custom fields against the stored bag", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Document custom keeper", "document_custom_keeper");
              const id = randomUUID();
              await db.execute(sql`
                insert into custom_field_defs
                  (id, org_id, target_table, target_kind, key, label, field_type, config, is_required, is_active, created_by, updated_by)
                values
                  (${randomUUID()}, ${org.orgId}, 'documents', 'vendor_bill', 'required_code', 'Required code', 'text', '{}'::jsonb, true, true, ${actor}, ${actor}),
                  (${randomUUID()}, ${org.orgId}, 'documents', 'vendor_bill', 'optional_note', 'Optional note', 'text', '{}'::jsonb, false, true, ${actor}, ${actor})
              `);
              await db.execute(sql`
                insert into documents
                  (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date,
                   currency, subtotal, tax_total, total, custom, created_by)
                values
                  (${id}, ${org.orgId}, 'vendor_bill', 'draft', 'CUSTOM-PATCH-1', ${org.subsidiaryId},
                   ${org.vendorId}, ${org.date}, 'CAD', '0', '0', '0',
                   '{"required_code":"R-1"}'::jsonb, ${actor})
              `);
              return { actor, id };
            });
            const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(current);
            await withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              current,
              { custom: { optional_note: "updated" }, expectedUpdatedAt: current.updatedAt },
              { orgId: org.orgId, userId: actor, source: "api" },
            ));
            const after = await withOrgContext(org.orgId, async () => await db.execute<{ custom: Record<string, unknown> }>(sql`
              select custom from documents where id = ${id} and org_id = ${org.orgId}
            `));
            assert.deepEqual(after.rows[0]?.custom, { required_code: "R-1", optional_note: "updated" });
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });

        test("applyDocumentEdit refuses line accounts from another organization", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          const foreign = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Line account keeper", "line_account_keeper");
              const id = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                values (${id},${org.orgId},'vendor_bill','draft','FOREIGN-ACCT-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
              return { actor, id };
            });
            // A foreign UUID passes the global document_lines FK, so the service
            // itself must refuse it: otherwise the tenant-coherent lines FK kills
            // the save at the insert as an unhandled 500 deep in the transaction.
            // This probe deliberately reads across orgs, so it stays under bypass —
            // the scratch org's own scope would deny it to zero rows.
            const foreignAccount = await withBypassContext(async () => (await db.execute<{ id: string }>(sql`
              select id from accounts where org_id = ${foreign.orgId} and is_active and not is_summary limit 1`)).rows[0]!.id);
            const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(current);
            await assert.rejects(
              withOrgContext(org.orgId, () => applyDocumentEdit(
                id,
                current,
                { lines: [{ accountId: foreignAccount, amount: "10", description: "foreign account" }], expectedUpdatedAt: current.updatedAt },
                { orgId: org.orgId, userId: actor, source: "api" },
              )),
              (error: unknown) => error instanceof DocumentEditError && error.status === 404,
            );
            const lines = await withOrgContext(org.orgId, async () => await db.execute<{ n: number }>(sql`
              select count(*)::int as n from document_lines where document_id = ${id} and org_id = ${org.orgId}`));
            assert.equal(lines.rows[0]?.n, 0, "the refused save stores no foreign-account line");
            // An own-org postable account still saves.
            const reloaded = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(reloaded);
            await withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              reloaded,
              { lines: [{ accountId: org.accounts.cogs, amount: "10", description: "home account" }], expectedUpdatedAt: reloaded.updatedAt },
              { orgId: org.orgId, userId: actor, source: "api" },
            ));
            const stored = await withOrgContext(org.orgId, async () => await db.execute<{ account_id: string }>(sql`
              select account_id from document_lines where document_id = ${id} and org_id = ${org.orgId}`));
            assert.equal(stored.rows[0]?.account_id, org.accounts.cogs);
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
            await withBypassContext(() => dropScratchOrg(foreign.orgId));
          }
        });

        test("applyDocumentEdit refuses to attach a project while Projects is disabled", { skip: !DB }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const { actor, id, project } = await withBypassContext(async () => {
              const actor = await createScratchUser(org.orgId, "Project gate keeper", "project_gate_keeper");
              const id = randomUUID();
              const project = randomUUID();
              await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,subtotal,tax_total,total,created_by)
                values (${id},${org.orgId},'vendor_bill','draft','PROJ-GATE-1',${org.subsidiaryId},${org.vendorId},${org.date},'CAD','0','0','0',${actor})`);
              await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
                values (${project},${org.orgId},${org.subsidiaryId},'PROJ-GATE','Gate project',${org.customerId},'active',true,'{}'::jsonb)`);
              return { actor, id, project };
            });
            await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings,'{features,projects}','false'::jsonb) where id = ${org.orgId}`));
            const current = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(current);
            await assert.rejects(
              withOrgContext(org.orgId, () => applyDocumentEdit(
                id,
                current,
                { projectId: project, expectedUpdatedAt: current.updatedAt },
                { orgId: org.orgId, userId: actor, source: "api" },
              )),
              (error: unknown) => error instanceof DocumentEditError && error.status === 422 && /Projects feature is disabled/.test(error.message),
            );
            const after = await withOrgContext(org.orgId, async () => await db.execute<{ project_id: string | null }>(sql`
              select project_id from documents where id = ${id} and org_id = ${org.orgId}`));
            assert.equal(after.rows[0]?.project_id, null, "the refused edit attaches no project");
            // Gate on: the same edit attaches the project.
            await withBypassContext(() => db.execute(sql`update orgs set settings = jsonb_set(settings,'{features,projects}','true'::jsonb) where id = ${org.orgId}`));
            const reloaded = await withOrgContext(org.orgId, () => loadDocumentEditCurrent(id, org.orgId));
            assert.ok(reloaded);
            await withOrgContext(org.orgId, () => applyDocumentEdit(
              id,
              reloaded,
              { projectId: project, expectedUpdatedAt: reloaded.updatedAt },
              { orgId: org.orgId, userId: actor, source: "api" },
            ));
            const attached = await withOrgContext(org.orgId, async () => await db.execute<{ project_id: string | null }>(sql`
              select project_id from documents where id = ${id} and org_id = ${org.orgId}`));
            assert.equal(attached.rows[0]?.project_id, project);
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
] as const;

for (const row of consolidatedRows) await row.register();

const salesInvoiceCurrencyCases = [{ label: "sales-invoice-currency-exposure", register: async () => {
const assert: typeof import("node:assert/strict") = (await import("node:assert/strict")).default;
const { randomUUID } = await import("node:crypto");
const test = (await import("node:test")).default;
type ScratchOrg = import("@openbooks/engine/src/testing/fixtures.ts").ScratchOrg;
// applyDocumentEdit + convertOrder are server-only code exercised through the
// same module hooks as the neighbouring documents suites.
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
const { convertOrder } = await import("./order-cycle.ts");
const { applyDocumentEdit } = await import("./documents.ts");
const { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts");
const { loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");
const { issueSalesOrder, SalesOrderIssueError } = await import(
  "@openbooks/engine/src/sales/sales-orders.ts"
);
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
const { createPaymentDocument, updateDraftPayment } = await import(
  "@openbooks/engine/src/payments/payment-documents.ts"
);
const { postPaymentWithApplications } = await import(
  "@openbooks/engine/src/payments/payment-posting.ts"
);
const { sameCurrencyAllocation } = await import(
  "@openbooks/engine/src/payments/settlement-policy.ts"
);

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableSalesFx(orgId: string, date: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
      on conflict (code) do nothing`);
    await db.execute(sql`
      update orgs set settings = (coalesce(settings, '{}'::jsonb) || '{"features": {"payroll": true, "orders": true, "multiCurrency": true}}'::jsonb)
       where id = ${orgId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${orgId}, 'USD', 'CAD', ${date}, 'spot', '1.3600', 'manual'),
             (${orgId}, 'EUR', 'CAD', ${date}, 'spot', '1.4800', 'manual')
      on conflict do nothing`);
  });
}

async function seedCustomerRole(org: ScratchOrg, actorId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into customer_roles
        (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
      values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '10000', 'USD', false, ${actorId}, ${actorId})`);
  });
}

async function seedOrder(org: ScratchOrg, actorId: string, number: string, total: string): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, currency, fx_rate, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, 'USD', '1', 'draft',
              ${total}, '0', ${total}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity,
         quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
         created_by, updated_by)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '0',
              ${total}, ${total}, ${total}, '0', ${actorId}, ${actorId})`);
  });
  return id;
}

async function revisionOf(orgId: string, id: string): Promise<string> {
  return withOrgContext(orgId, async () => {
    const r = await db.execute<{ updated_at: string }>(sql`
      select (revision_seq)::text as updated_at from documents
       where id = ${id} and org_id = ${orgId}`);
    return r.rows[0]!.updated_at;
  });
}

async function issue(orgId: string, orderId: string, actorId: string, creditOverrideReason?: string) {
  return issueSalesOrder({
    orgId,
    salesOrderId: orderId,
    actorId,
    expectedUpdatedAt: await revisionOf(orgId, orderId),
    ...(creditOverrideReason === undefined ? {} : { creditOverrideReason }),
  });
}

async function approveAndPost(org: ScratchOrg, actorId: string, invoiceId: string): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
  });
}

async function payInFull(
  org: ScratchOrg,
  actorId: string,
  invoiceId: string,
  currency: string,
  amount: string,
): Promise<void> {
  const openLineId = await withOrgContext(org.orgId, async () => {
    const r = await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${invoiceId} and jl.org_id = ${org.orgId}
         and jl.is_open_item`);
    return r.rows[0]!.id;
  });
  await withBypassContext(async () => {
    const receipt = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: actorId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency,
      fxRate: "1",
    });
    await updateDraftPayment(
      receipt.id,
      {
        partyId: org.customerId,
        bankAccountId: org.accounts.bank,
        allocations: [sameCurrencyAllocation(openLineId, amount)],
      },
      actorId,
      org.orgId,
      { allowedSubsidiaryIds: null },
    );
    await db.execute(sql`
      update documents set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
       where id = ${receipt.id} and org_id = ${org.orgId}`);
    await postPaymentWithApplications(receipt.id, undefined, actorId);
  });
}

async function invoiceState(orgId: string, id: string) {
  return withOrgContext(orgId, async () => {
    const doc = (
      await db.execute<{ currency: string; total: string; status: string; number: string }>(sql`
        select currency, total::text as total, status, document_number as number from documents
         where id = ${id} and org_id = ${orgId}`)
    ).rows[0]!;
    const edge = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_links
         where org_id = ${orgId} and to_document_id = ${id} and link_type = 'bills'`)
    ).rows[0]!.n;
    const lines = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_lines
         where org_id = ${orgId} and document_id = ${id}`)
    ).rows[0]!.n;
    return { ...doc, edgeCount: edge, lineCount: lines };
  });
}

async function grantRolePermissions(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles
         set permissions = ${JSON.stringify(permissions)}::jsonb
       where org_id = ${orgId} and key = ${roleKey}`);
  });
}

async function expectIssueError(promise: Promise<unknown>, code: string, status = 422) {
  let captured: InstanceType<typeof SalesOrderIssueError> | undefined;
  await assert.rejects(promise, (error: unknown) => {
    if (!(error instanceof SalesOrderIssueError)) return false;
    captured = error;
    return error.code === code && error.status === status;
  });
  return captured!;
}

async function editCurrency(
  orgId: string,
  actorId: string,
  id: string,
  currency: string,
): Promise<void> {
  await withOrgContext(orgId, async () => {
    const current = await loadDocumentEditCurrent(id, orgId);
    assert.ok(current);
    await applyDocumentEdit(
      id,
      current,
      { currency, expectedUpdatedAt: current.updatedAt },
      { orgId, userId: actorId, source: "ui", runFlows: false },
    );
  });
}

test(
  "a converted draft invoice cannot be relabelled into another currency",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Currency exposure clerk", "currency_exposure_clerk"),
      );
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-FX-1", "10000");
      const first = await issue(org.orgId, so1, actorId);
      assert.equal(first.credit?.resultingExposure, "10000.0000");

      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
      const before = await invoiceState(org.orgId, converted.id);
      assert.equal(before.currency, "USD");
      assert.equal(before.total, "10000.0000");
      assert.equal(before.edgeCount, 1);
      const sourceBefore = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ status: string; total: string }>(sql`
          select status, total::text as total from documents
           where id = ${so1} and org_id = ${org.orgId}`);
        return r.rows[0]!;
      });

      // The relabel is refused and names the source order plus the remedy.
      let refusal: InstanceType<typeof DocumentEditError> | undefined;
      await assert.rejects(editCurrency(org.orgId, actorId, converted.id, "EUR"), (error: unknown) => {
        if (!(error instanceof DocumentEditError)) return false;
        refusal = error;
        return error.status === 422;
      });
      assert.match(refusal!.message, /SO-FX-1/);
      assert.match(refusal!.message, /sales order/);
      assert.match(refusal!.message, /Delete this draft and reconvert/);

      // The refused edit leaves source, invoice, links, and totals unchanged.
      const after = await invoiceState(org.orgId, converted.id);
      assert.deepEqual(after, before);
      const sourceAfter = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ status: string; total: string }>(sql`
          select status, total::text as total from documents
           where id = ${so1} and org_id = ${org.orgId}`);
        return r.rows[0]!;
      });
      assert.deepEqual(sourceAfter, sourceBefore);

      // Same-currency header edits still work: a memo-only save and an
      // explicit no-op currency save both succeed.
      await withOrgContext(org.orgId, async () => {
        const current = await loadDocumentEditCurrent(converted.id, org.orgId);
        assert.ok(current);
        await applyDocumentEdit(
          converted.id,
          current,
          { memo: "Billing hold for review", expectedUpdatedAt: current.updatedAt },
          { orgId: org.orgId, userId: actorId, source: "ui", runFlows: false },
        );
      });
      await editCurrency(org.orgId, actorId, converted.id, "USD");
      const settled = await invoiceState(org.orgId, converted.id);
      assert.equal(settled.currency, "USD");
      assert.equal(settled.total, "10000.0000");
      assert.equal(settled.edgeCount, 1);

      // Drafts without an order-conversion source stay freely relabellable:
      // the guard binds only conversion children to their source currency.
      const standalone = await withBypassContext(async () => {
        const draftId = randomUUID();
        await db.execute(sql`
          insert into documents
            (id, org_id, kind, document_number, party_id, subsidiary_id,
             document_date, currency, status, subtotal, tax_total, total,
             created_by, updated_by)
          values (${draftId}, ${org.orgId}, 'customer_invoice', 'INV-STANDALONE-1', ${org.customerId},
                  ${org.subsidiaryId}, ${org.date}, 'USD', 'draft', '10', '0', '10', ${actorId}, ${actorId})`);
        await db.execute(sql`
          insert into document_lines
            (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
             tax_input_amount, tax_amount, created_by, updated_by)
          values (${org.orgId}, ${draftId}, 1, ${org.accounts.revenue}, '1', '10',
                  '10', '10', '0', ${actorId}, ${actorId})`);
        return draftId;
      });
      await editCurrency(org.orgId, actorId, standalone, "EUR");
      const relabelled = await invoiceState(org.orgId, standalone);
      assert.equal(relabelled.currency, "EUR");
      assert.equal(relabelled.total, "10.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "delete-and-reconvert remedy preserves credit exposure end to end",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Currency remedy clerk", "currency_remedy_clerk"),
      );
      const approverId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Currency remedy approver", "currency_remedy_approver"),
      );
      await grantRolePermissions(org.orgId, "currency_remedy_approver", ["ar.create", "ar.approve"]);
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-FX-REM-1", "10000");
      await issue(org.orgId, so1, actorId);
      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

      // The drift is refused, so the operator deletes the draft (restoring
      // the source billed cover) and reconverts in the order currency.
      await assert.rejects(editCurrency(org.orgId, actorId, converted.id, "EUR"), (error: unknown) => {
        if (!(error instanceof DocumentEditError)) return false;
        return error.status === 422 && /reconvert/.test(error.message);
      });
      await withBypassContext(() =>
        deleteDocument(converted.id, actorId, org.orgId, { reason: "Wrong billing currency requested", allowedSubsidiaryIds: null }),
      );
      const billed = await withOrgContext(org.orgId, async () => {
        const r = await db.execute<{ quantity_billed: string }>(sql`
          select quantity_billed::text from document_lines
           where org_id = ${org.orgId} and document_id = ${so1}`);
        return r.rows[0]!.quantity_billed;
      });
      assert.equal(billed, "0.00000000");
      const reconverted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
      const rebilled = await invoiceState(org.orgId, reconverted.id);
      assert.equal(rebilled.currency, "USD");
      assert.equal(rebilled.edgeCount, 1);

      // Same-currency billing still relieves exposure once posted and paid.
      await approveAndPost(org, actorId, reconverted.id);
      await payInFull(org, actorId, reconverted.id, "USD", "10000");
      const so2 = await seedOrder(org, actorId, "SO-FX-REM-2", "5000");
      const second = await issue(org.orgId, so2, actorId);
      assert.equal(second.credit?.openOrderExposure, "0.0000");
      assert.equal(second.credit?.resultingExposure, "5000.0000");

      // The limit still engages past the threshold, and an authorized
      // override with a reason still issues.
      const so3 = await seedOrder(org, actorId, "SO-FX-REM-3", "6000");
      const refused = await expectIssueError(
        issue(org.orgId, so3, actorId),
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      );
      assert.equal(refused.details?.resultingExposure, "11000.0000");
      await expectIssueError(
        issue(org.orgId, so3, actorId, "Customer deposit confirmed by treasury"),
        "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN",
        403,
      );
      const overridden = await issue(org.orgId, so3, approverId, "Customer deposit confirmed by treasury");
      assert.equal(overridden.credit?.overridden, true);
      assert.equal(overridden.credit?.resultingExposure, "11000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "legacy cross-currency billing does not release role-currency exposure",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Legacy exposure clerk", "legacy_exposure_clerk"),
      );
      await enableSalesFx(org.orgId, org.date);
      await seedCustomerRole(org, actorId);

      const so1 = await seedOrder(org, actorId, "SO-FX-LEG-1", "10000");
      await issue(org.orgId, so1, actorId);
      const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

      // Simulate a pre-limit legacy posting, then restore the USD limit for exposure checks.
      await withBypassContext(async () => {
        await db.execute(sql`update documents set currency = 'EUR', updated_at = now(), updated_by = ${actorId}
          where id = ${converted.id} and org_id = ${org.orgId}`);
        await db.execute(sql`update customer_roles set credit_limit = null, updated_by = ${actorId}
          where org_id = ${org.orgId} and party_id = ${org.customerId}`);
      });
      await approveAndPost(org, actorId, converted.id);
      await withBypassContext(() => db.execute(sql`update customer_roles set credit_limit = '10000', updated_by = ${actorId}
        where org_id = ${org.orgId} and party_id = ${org.customerId}`));
      await payInFull(org, actorId, converted.id, "EUR", "10000");

      // No role-currency billing ever relieved SO-FX-LEG-1, so the second
      // order must refuse even though the foreign invoice is fully settled.
      const so2 = await seedOrder(org, actorId, "SO-FX-LEG-2", "5000");
      const refused = await expectIssueError(
        issue(org.orgId, so2, actorId),
        "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
      );
      assert.equal(refused.details?.existingExposure, "10000.0000");
      assert.equal(refused.details?.resultingExposure, "15000.0000");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

const consolidatedRows = [
  { label: "sales invoice party exposure", register: async () => {
        // applyDocumentEdit + convertOrder are server-only code exercised through the
        // same module hooks as the neighbouring documents suites.
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const {
          createScratchOrg,
          createScratchUser,
          dropScratchOrg,
        } = await import("@openbooks/engine/src/testing/fixtures.ts");

        const { convertOrder } = await import("./order-cycle.ts");
        const { applyDocumentEdit } = await import("./documents.ts");
        const { DocumentEditError } = await import("../../engine/src/records/document-edit-policy.ts");
        const { loadDocumentEditCurrent } = await import("../../engine/src/ledger/document-service.ts");
        const { issueSalesOrder, SalesOrderIssueError } = await import(
          "@openbooks/engine/src/sales/sales-orders.ts"
        );
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
        const { createPaymentDocument, updateDraftPayment } = await import(
          "@openbooks/engine/src/payments/payment-documents.ts"
        );
        const { postPaymentWithApplications } = await import(
          "@openbooks/engine/src/payments/payment-posting.ts"
        );
        const { sameCurrencyAllocation } = await import(
          "@openbooks/engine/src/payments/settlement-policy.ts"
        );

        const DB = !!process.env.OPENBOOKS_DB_URL;

        async function enableSalesFx(orgId: string, date: string): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into currencies (code, name, minor_units)
              values ('USD', 'US Dollar', 2), ('EUR', 'Euro', 2)
              on conflict (code) do nothing`);
            await db.execute(sql`
              update orgs set settings = (coalesce(settings, '{}'::jsonb) || '{"features": {"payroll": true, "orders": true, "multiCurrency": true}}'::jsonb)
               where id = ${orgId}`);
            await db.execute(sql`
              insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
              values (${orgId}, 'USD', 'CAD', ${date}, 'spot', '1.3600', 'manual'),
                     (${orgId}, 'EUR', 'CAD', ${date}, 'spot', '1.4800', 'manual')
              on conflict do nothing`);
          });
        }

        async function seedCustomerRole(org: ScratchOrg, actorId: string): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into customer_roles
                (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
              values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, '10000', 'USD', false, ${actorId}, ${actorId})`);
          });
        }

        async function seedOtherCustomer(org: ScratchOrg, actorId: string): Promise<string> {
          const otherParty = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into parties (id, org_id, kind, display_name, is_active, custom)
              values (${otherParty}, ${org.orgId}, 'customer', 'Distinct Customer B', true, '{}'::jsonb)`);
            await db.execute(sql`
              insert into customer_roles (org_id, party_id, ar_account_id, credit_limit, currency, is_on_hold, created_by, updated_by)
              values (${org.orgId}, ${otherParty}, ${org.accounts.ar}, '20000', 'USD', false, ${actorId}, ${actorId})`);
          });
          return otherParty;
        }

        async function seedOrder(org: ScratchOrg, actorId: string, number: string, total: string): Promise<string> {
          const id = randomUUID();
          await withBypassContext(async () => {
            await db.execute(sql`
              insert into documents
                (id, org_id, kind, document_number, party_id, subsidiary_id,
                 document_date, currency, fx_rate, status, subtotal, tax_total, total,
                 created_by, updated_by)
              values (${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
                      ${org.subsidiaryId}, ${org.date}, 'USD', '1', 'draft',
                      ${total}, '0', ${total}, ${actorId}, ${actorId})`);
            await db.execute(sql`
              insert into document_lines
                (org_id, document_id, line_number, account_id, quantity,
                 quantity_billed, unit_price, amount, tax_input_amount, tax_amount,
                 created_by, updated_by)
              values (${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '1', '0',
                      ${total}, ${total}, ${total}, '0', ${actorId}, ${actorId})`);
          });
          return id;
        }

        async function revisionOf(orgId: string, id: string): Promise<string> {
          return withOrgContext(orgId, async () => {
            const r = await db.execute<{ updated_at: string }>(sql`
              select (revision_seq)::text as updated_at from documents
               where id = ${id} and org_id = ${orgId}`);
            return r.rows[0]!.updated_at;
          });
        }

        async function issue(orgId: string, orderId: string, actorId: string, creditOverrideReason?: string) {
          return issueSalesOrder({
            orgId,
            salesOrderId: orderId,
            actorId,
            expectedUpdatedAt: await revisionOf(orgId, orderId),
            ...(creditOverrideReason === undefined ? {} : { creditOverrideReason }),
          });
        }

        async function approveAndPost(org: ScratchOrg, actorId: string, invoiceId: string): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`
              update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
               where id = ${invoiceId} and org_id = ${org.orgId}`);
            await postDocument(invoiceId, {
              control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
            });
          });
        }

        async function payInFull(
          org: ScratchOrg,
          actorId: string,
          invoiceId: string,
          currency: string,
          amount: string,
        ): Promise<void> {
          const openLineId = await withOrgContext(org.orgId, async () => {
            const r = await db.execute<{ id: string }>(sql`
              select jl.id from journal_lines jl
                join journal_entries je on je.id = jl.entry_id
               where je.source_document_id = ${invoiceId} and jl.org_id = ${org.orgId}
                 and jl.is_open_item`);
            return r.rows[0]!.id;
          });
          await withBypassContext(async () => {
            const receipt = await createPaymentDocument({ allowedSubsidiaryIds: null,
              orgId: org.orgId,
              kind: "customer_payment",
              createdBy: actorId,
              partyId: org.customerId,
              bankAccountId: org.accounts.bank,
              subsidiaryId: org.subsidiaryId,
              documentDate: org.date,
              currency,
              fxRate: "1",
            });
            await updateDraftPayment(
              receipt.id,
              {
                partyId: org.customerId,
                bankAccountId: org.accounts.bank,
                allocations: [sameCurrencyAllocation(openLineId, amount)],
              },
              actorId,
              org.orgId,
              { allowedSubsidiaryIds: null },
            );
            await db.execute(sql`
              update documents set status = 'approved', submitted_by = ${actorId}, submitted_at = now()
               where id = ${receipt.id} and org_id = ${org.orgId}`);
            await postPaymentWithApplications(receipt.id, undefined, actorId);
          });
        }

        async function invoiceState(orgId: string, id: string) {
          return withOrgContext(orgId, async () => {
            const doc = (
              await db.execute<{ party: string | null; currency: string; total: string; status: string; number: string }>(sql`
                select party_id as party, currency, total::text as total, status, document_number as number from documents
                 where id = ${id} and org_id = ${orgId}`)
            ).rows[0]!;
            const edge = (
              await db.execute<{ n: number }>(sql`
                select count(*)::int as n from document_links
                 where org_id = ${orgId} and to_document_id = ${id} and link_type = 'bills'`)
            ).rows[0]!.n;
            const lines = (
              await db.execute<{ n: number }>(sql`
                select count(*)::int as n from document_lines
                 where org_id = ${orgId} and document_id = ${id}`)
            ).rows[0]!.n;
            return { ...doc, edgeCount: edge, lineCount: lines };
          });
        }

        async function grantRolePermissions(orgId: string, roleKey: string, permissions: string[]): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`
              update app_roles
                 set permissions = ${JSON.stringify(permissions)}::jsonb
               where org_id = ${orgId} and key = ${roleKey}`);
          });
        }

        async function expectIssueError(promise: Promise<unknown>, code: string, status = 422) {
          let captured: InstanceType<typeof SalesOrderIssueError> | undefined;
          await assert.rejects(promise, (error: unknown) => {
            if (!(error instanceof SalesOrderIssueError)) return false;
            captured = error;
            return error.code === code && error.status === status;
          });
          return captured!;
        }

        async function editParty(
          orgId: string,
          actorId: string,
          id: string,
          partyId: string,
        ): Promise<void> {
          await withOrgContext(orgId, async () => {
            const current = await loadDocumentEditCurrent(id, orgId);
            assert.ok(current);
            await applyDocumentEdit(
              id,
              current,
              { partyId, expectedUpdatedAt: current.updatedAt },
              { orgId, userId: actorId, source: "ui", runFlows: false },
            );
          });
        }

        test(
          "a converted draft invoice cannot be moved to another party",
          { skip: !DB },
          async () => {
            const org = await withBypassContext(() => createScratchOrg());
            try {
              const actorId = await withBypassContext(() =>
                createScratchUser(org.orgId, "Party exposure clerk", "party_exposure_clerk"),
              );
              await enableSalesFx(org.orgId, org.date);
              await seedCustomerRole(org, actorId);
              const otherParty = await seedOtherCustomer(org, actorId);

              const so1 = await seedOrder(org, actorId, "SO-PTY-1", "10000");
              const first = await issue(org.orgId, so1, actorId);
              assert.equal(first.credit?.resultingExposure, "10000.0000");

              const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
              const before = await invoiceState(org.orgId, converted.id);
              assert.equal(before.party, org.customerId);
              assert.equal(before.total, "10000.0000");
              assert.equal(before.edgeCount, 1);
              const sourceBefore = await withOrgContext(org.orgId, async () => {
                const r = await db.execute<{ status: string; total: string; party: string }>(sql`
                  select status, total::text as total, party_id as party from documents
                   where id = ${so1} and org_id = ${org.orgId}`);
                return r.rows[0]!;
              });

              // The move is refused and names the source order plus the remedy.
              let refusal: InstanceType<typeof DocumentEditError> | undefined;
              await assert.rejects(editParty(org.orgId, actorId, converted.id, otherParty), (error: unknown) => {
                if (!(error instanceof DocumentEditError)) return false;
                refusal = error;
                return error.status === 422;
              });
              assert.match(refusal!.message, /SO-PTY-1/);
              assert.match(refusal!.message, /sales order/);
              assert.match(refusal!.message, /must keep the source order party/);
              assert.match(refusal!.message, /Delete this draft and reconvert/);

              // The refused edit leaves source, invoice, links, and totals unchanged.
              const after = await invoiceState(org.orgId, converted.id);
              assert.deepEqual(after, before);
              const sourceAfter = await withOrgContext(org.orgId, async () => {
                const r = await db.execute<{ status: string; total: string; party: string }>(sql`
                  select status, total::text as total, party_id as party from documents
                   where id = ${so1} and org_id = ${org.orgId}`);
                return r.rows[0]!;
              });
              assert.deepEqual(sourceAfter, sourceBefore);

              // Same-party header edits still work: a memo-only save and an explicit
              // no-op party save both succeed.
              await withOrgContext(org.orgId, async () => {
                const current = await loadDocumentEditCurrent(converted.id, org.orgId);
                assert.ok(current);
                await applyDocumentEdit(
                  converted.id,
                  current,
                  { memo: "Billing hold for review", expectedUpdatedAt: current.updatedAt },
                  { orgId: org.orgId, userId: actorId, source: "ui", runFlows: false },
                );
              });
              await editParty(org.orgId, actorId, converted.id, org.customerId);
              const settled = await invoiceState(org.orgId, converted.id);
              assert.equal(settled.party, org.customerId);
              assert.equal(settled.total, "10000.0000");
              assert.equal(settled.edgeCount, 1);

              // Drafts without an order-conversion source stay freely reassignable:
              // the guard binds only conversion children to their source party.
              const standalone = await withBypassContext(async () => {
                const draftId = randomUUID();
                await db.execute(sql`
                  insert into documents
                    (id, org_id, kind, document_number, party_id, subsidiary_id,
                     document_date, currency, status, subtotal, tax_total, total,
                     created_by, updated_by)
                  values (${draftId}, ${org.orgId}, 'customer_invoice', 'INV-STANDALONE-PTY-1', ${org.customerId},
                          ${org.subsidiaryId}, ${org.date}, 'USD', 'draft', '10', '0', '10', ${actorId}, ${actorId})`);
                await db.execute(sql`
                  insert into document_lines
                    (org_id, document_id, line_number, account_id, quantity, unit_price, amount,
                     tax_input_amount, tax_amount, created_by, updated_by)
                  values (${org.orgId}, ${draftId}, 1, ${org.accounts.revenue}, '1', '10',
                          '10', '10', '0', ${actorId}, ${actorId})`);
                return draftId;
              });
              await editParty(org.orgId, actorId, standalone, otherParty);
              const reassigned = await invoiceState(org.orgId, standalone);
              assert.equal(reassigned.party, otherParty);
              assert.equal(reassigned.total, "10.0000");
            } finally {
              await withBypassContext(() => dropScratchOrg(org.orgId));
            }
          },
        );

        test(
          "delete-and-reconvert remedy restores the source party billing end to end",
          { skip: !DB },
          async () => {
            const org = await withBypassContext(() => createScratchOrg());
            try {
              const actorId = await withBypassContext(() =>
                createScratchUser(org.orgId, "Party remedy clerk", "party_remedy_clerk"),
              );
              const approverId = await withBypassContext(() =>
                createScratchUser(org.orgId, "Party remedy approver", "party_remedy_approver"),
              );
              await grantRolePermissions(org.orgId, "party_remedy_approver", ["ar.create", "ar.approve"]);
              await enableSalesFx(org.orgId, org.date);
              await seedCustomerRole(org, actorId);
              const otherParty = await seedOtherCustomer(org, actorId);

              const so1 = await seedOrder(org, actorId, "SO-PTY-REM-1", "10000");
              await issue(org.orgId, so1, actorId);
              const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

              // The drift is refused, so the operator deletes the draft (restoring
              // the source billed cover) and reconverts in the source party.
              await assert.rejects(editParty(org.orgId, actorId, converted.id, otherParty), (error: unknown) => {
                if (!(error instanceof DocumentEditError)) return false;
                return error.status === 422 && /reconvert/.test(error.message);
              });
              await withBypassContext(() =>
                deleteDocument(converted.id, actorId, org.orgId, { reason: "Wrong billing party requested", allowedSubsidiaryIds: null }),
              );
              const billed = await withOrgContext(org.orgId, async () => {
                const r = await db.execute<{ quantity_billed: string }>(sql`
                  select quantity_billed::text from document_lines
                   where org_id = ${org.orgId} and document_id = ${so1}`);
                return r.rows[0]!.quantity_billed;
              });
              assert.equal(billed, "0.00000000");
              const reconverted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");
              const rebilled = await invoiceState(org.orgId, reconverted.id);
              assert.equal(rebilled.party, org.customerId);
              assert.equal(rebilled.edgeCount, 1);

              // Same-party billing still relieves exposure once posted and paid.
              await approveAndPost(org, actorId, reconverted.id);
              await payInFull(org, actorId, reconverted.id, "USD", "10000");
              const so2 = await seedOrder(org, actorId, "SO-PTY-REM-2", "5000");
              const second = await issue(org.orgId, so2, actorId);
              assert.equal(second.credit?.openOrderExposure, "0.0000");
              assert.equal(second.credit?.resultingExposure, "5000.0000");

              // The limit still engages past the threshold, and an authorized
              // override with a reason still issues.
              const so3 = await seedOrder(org, actorId, "SO-PTY-REM-3", "6000");
              const refused = await expectIssueError(
                issue(org.orgId, so3, actorId),
                "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
              );
              assert.equal(refused.details?.resultingExposure, "11000.0000");
              await expectIssueError(
                issue(org.orgId, so3, actorId, "Customer deposit confirmed by treasury"),
                "CUSTOMER_CREDIT_OVERRIDE_FORBIDDEN",
                403,
              );
              const overridden = await issue(org.orgId, so3, approverId, "Customer deposit confirmed by treasury");
              assert.equal(overridden.credit?.overridden, true);
              assert.equal(overridden.credit?.resultingExposure, "11000.0000");
            } finally {
              await withBypassContext(() => dropScratchOrg(org.orgId));
            }
          },
        );

        test(
          "legacy mismatched-party billing does not release the source order exposure",
          { skip: !DB },
          async () => {
            const org = await withBypassContext(() => createScratchOrg());
            try {
              const actorId = await withBypassContext(() =>
                createScratchUser(org.orgId, "Legacy party clerk", "legacy_party_clerk"),
              );
              await enableSalesFx(org.orgId, org.date);
              await seedCustomerRole(org, actorId);
              const otherParty = await seedOtherCustomer(org, actorId);

              const so1 = await seedOrder(org, actorId, "SO-PTY-LEG-1", "10000");
              await issue(org.orgId, so1, actorId);
              const converted = await convertOrder(org.orgId, actorId, so1, "customer_invoice");

              // Legacy simulation: rows relabelled through the pre-fix unguarded path
              // bypass the edit guard, so raw SQL stands in for those inconsistent
              // rows. The credit math must still fail closed on them.
              await withBypassContext(async () => {
                await db.execute(sql`
                  update documents set party_id = ${otherParty}, updated_at = now(), updated_by = ${actorId}
                   where id = ${converted.id} and org_id = ${org.orgId}`);
              });
              await approveAndPost(org, actorId, converted.id);

              // No same-party billing ever relieved SO-PTY-LEG-1, so the second order
              // must refuse even though the stray invoice is still open against B.
              const so2 = await seedOrder(org, actorId, "SO-PTY-LEG-2", "5000");
              const refused = await expectIssueError(
                issue(org.orgId, so2, actorId),
                "CUSTOMER_CREDIT_LIMIT_EXCEEDED",
              );
              assert.equal(refused.details?.existingExposure, "10000.0000");
              assert.equal(refused.details?.resultingExposure, "15000.0000");
            } finally {
              await withBypassContext(() => dropScratchOrg(org.orgId));
            }
          },
        );
  } },
] as const;

for (const row of consolidatedRows) await row.register();
}}] as const; for (const row of salesInvoiceCurrencyCases) await row.register();

const documentRevisionCases = [{ label: "interactive document revision lifecycle", register: async () => {
  type SessionUser = import("./auth").SessionUser;
  const session: { user: SessionUser | null } = { user: null };
  Object.assign(globalThis, { __documentRevisionSession: session });
  (await import("../testing/stub-modules.ts")).stubModules({ intl: true, navigation: false, authz: false, features: false });
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts"))
      return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__documentRevisionSession.user}" };
    return next(specifier, context);
  }});
  const documentVoidRouteModule: string = "../app/api/documents/[id]/void/route.ts?document-revision";
  const documentRouteModule: string = "../app/api/documents/[id]/route.ts?document-revision";
  const { POST } = await import(documentVoidRouteModule) as typeof import("../app/api/documents/[id]/void/route");
  const { DELETE } = await import(documentRouteModule) as typeof import("../app/api/documents/[id]/route");
  hooks.deregister();
  for (const operation of ["void stale", "void current", "void missing", "delete stale", "delete current", "delete missing"]) {
    test(`interactive document lifecycle: ${operation}`, { skip: !DB }, async () => {
      const org = await withBypassContext(() => createScratchOrg());
      try {
        const actor = await withBypassContext(() => createScratchUser(org.orgId, "Document controller", "reviewer"));
        await withBypassContext(() => db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`));
        const id = randomUUID();
        await withBypassContext(() => db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,party_id,subsidiary_id,currency)
          values (${id},${org.orgId},'customer_invoice',${id},${org.date},${org.customerId},${org.subsidiaryId},'CAD')`));
        await withBypassContext(() => db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount)
          values (${org.orgId},${id},1,${org.accounts.revenue},1,'100','100')`));
        if (operation.startsWith("void")) await withBypassContext(() => db.execute(sql`update documents set status='approved' where id=${id}`));
        const token = (await withBypassContext(() => db.execute<{ revision: string }>(sql`select revision_seq::text as revision from documents where id=${id}`))).rows[0]!.revision;
        if (operation.endsWith("stale")) await withBypassContext(() => db.execute(sql`update documents set memo='Concurrent change',updated_at=updated_at+interval '1 microsecond' where id=${id}`));
        session.user = { id: actor, orgId: org.orgId, name: "Document controller", email: "doc@scratch.test", roles: [], isSuperAdmin: false,
          envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
        const isVoid = operation.startsWith("void");
        const response = await withOrgContext(org.orgId, () => (isVoid ? POST : DELETE)(new Request(`http://audit.local/api/documents/${id}/void`, {
          method: isVoid ? "POST" : "DELETE", body: JSON.stringify({ reason: "Cancel reviewed invoice", reversalDate: org.date, expectedUpdatedAt: operation.endsWith("missing") ? undefined : token }),
        }), { params: Promise.resolve({ id }) }));
        const expectedStatus = operation.endsWith("current")
          ? 200
          : operation.endsWith("missing")
            ? 400
            : 409;
        assert.equal(response.status, expectedStatus, JSON.stringify(await response.json()));
        const row = (await withOrgContext(org.orgId, () => db.execute<{ status: string }>(sql`select status from documents where id=${id}`))).rows[0];
        if (operation === "delete current") assert.equal(row, undefined);
        else assert.equal(row?.status, operation === "void current" ? "voided" : isVoid ? "approved" : "draft");
      } finally { session.user = null; await dropScratchOrg(org.orgId); }
    });
  }
}}] as const;
for (const row of documentRevisionCases) await row.register();

const currencyRegistryCases = [{ label: "currency registry document to statement chain", register: async () => {
  const { partnerStatement } = await import('./reports/registers.ts');
  const { exportDataToCsv, partnerStatementExportData } = await import('./report-pdf.ts');
  const { createPaymentDocument, updateDraftPayment } = await import('@openbooks/engine/src/payments/payment-documents.ts');
  const { postPaymentWithApplications } = await import('@openbooks/engine/src/payments/payment-posting.ts');
  const atLedgerScale = (total: string) => total.includes('.') ? total.padEnd(total.indexOf('.') + 5, '0') : `${total}.0000`;
  const translate = (key: string) => key;
  for (const [currency, fxRate, total, paid, open, baseOpen, baseTotal] of [
    ['JPY', '0.0091', '10501', '5000', '5501.0000', '50.0591', '95.5591'],
    ['KWD', '3.6000', '1000.005', '400.002', '600.0030', '2160.0108', '3600.0180'],
  ] as const) test(`${currency} keeps its ISO precision from invoice through statement export`, { skip: !DB }, async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Currency chain clerk', 'admin'));
      const registry = await withBypassContext(() => db.execute<{ code: string; minor_units: number }>(sql`select code,minor_units from currencies where code in ('JPY','KWD') order by code`));
      assert.deepEqual(registry.rows, [{ code: 'JPY', minor_units: 0 }, { code: 'KWD', minor_units: 3 }]);
      const invoice = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into documents(id,org_id,kind,status,document_number,subsidiary_id,party_id,document_date,currency,fx_rate,subtotal,tax_total,total,created_by)
          values(${invoice},${org.orgId},'customer_invoice','draft',${`CUR-${currency}`},${org.subsidiaryId},${org.customerId},${org.date},${currency},${fxRate},${total},0,${total},${actor})`);
        await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount,tax_input_amount)
          values(${org.orgId},${invoice},1,${org.accounts.revenue},1,${total},${total},0,${total})`);
        await db.execute(sql`update documents set status='approved' where id=${invoice} and org_id=${org.orgId}`);
      });
      const entry = await withBypassContext(() => postDocument(invoice, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }));
      const legs = await withBypassContext(() => db.execute<{ total: string }>(sql`select coalesce(sum(amount),0)::text as total from journal_lines where entry_id=${entry}`));
      assert.equal(legs.rows[0]?.total, '0.0000');
      const balance = await withBypassContext(() => db.execute<{ open_balance: string }>(sql`select open_balance::text as open_balance from documents where id=${invoice}`));
      assert.equal(balance.rows[0]?.open_balance, atLedgerScale(total));
      const line = (await withBypassContext(() => db.execute<{ id: string }>(sql`select id from journal_lines where entry_id=${entry} and is_open_item`))).rows[0]!.id;
      const paymentDocument = await withBypassContext(() => createPaymentDocument({ allowedSubsidiaryIds: null, orgId: org.orgId, kind: 'customer_payment', createdBy: actor,
        partyId: org.customerId, bankAccountId: org.accounts.bank, subsidiaryId: org.subsidiaryId, documentDate: org.date, currency, fxRate }));
      await withBypassContext(() => updateDraftPayment(paymentDocument.id, { bankAccountId: org.accounts.bank, allocations: [{ openLineId: line,
        sourceTransactionAmount: paid, targetTransactionAmount: paid, settlementRate: '1', settlementRateSource: 'same_currency', settlementRateReference: 'CURRENCY-E2E' }] }, actor, org.orgId,
  { allowedSubsidiaryIds: null },
));
      await withBypassContext(() => db.execute(sql`update documents set status='approved',submitted_by=${actor},submitted_at=now() where id=${paymentDocument.id}`));
      await withBypassContext(() => postPaymentWithApplications(paymentDocument.id, undefined, actor));
      const balances = await withBypassContext(() => db.execute<{ id: string; open_balance: string }>(sql`select id,open_balance::text as open_balance from documents where id in (${invoice},${paymentDocument.id})`));
      const byId = new Map(balances.rows.map(row => [row.id,row.open_balance]));
      assert.equal(byId.get(invoice), open); assert.equal(byId.get(paymentDocument.id), '0.0000');
      const statement = await withOrgContext(org.orgId, () => partnerStatement(org.customerId, org.orgId, { from: '2026-07-01', to: '2026-07-31', side: 'ar' }));
      assert.equal(statement.closing, baseOpen); assert.equal(statement.aging.total, baseOpen);
      assert.equal(statement.lines.find(line => line.docKind === 'customer_invoice')?.debit, baseTotal);
      assert.ok(exportDataToCsv(partnerStatementExportData(statement, translate as never), {}).includes(baseOpen));
    } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
  });
}}] as const;
for (const row of currencyRegistryCases) await row.register();
