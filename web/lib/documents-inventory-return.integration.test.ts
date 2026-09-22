import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The authoring half of stock returns. The return engines required
// custom.inventoryReturn evidence on every returned credit line, and nothing
// in the product could write it: the documents editor strips native custom
// from callers and re-attaches only its own trusted keys, and inventoryReturn
// was not one of them. These tests drive the real save path.
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
const { applyDocumentEdit } = await import("./documents.ts");
const { receiveInventory } = await import("@openbooks/engine/src/inventory/movements.ts");
const { getOnHand } = await import("@openbooks/engine/src/inventory/position.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
import type { DocumentLineInput } from "@openbooks/engine/src/ledger/document-input.ts";

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
