import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../../../lib/auth";

/**
 * Goods-receipt void relief through the API boundary: a consumed receipt
 * refuses with the typed code and its dependents, void-with-dependents
 * cascades through the fulfillment's own void, and the remainder route
 * corrects a phantom over-delivery while the receipt stands.
 */
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __receiptReliefUser: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next-intl/server")
      return virtual(
        'export async function getTranslations(){return (key)=>key}; export async function getLocale(){return "en"}',
      );
    if (
      (specifier === "./auth" || specifier.endsWith("/lib/auth")) &&
      context.parentURL?.endsWith("/web/lib/authz.ts")
    ) {
      return virtual(
        "export async function currentUser(){return globalThis.__receiptReliefUser.user}",
      );
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { toUnits } = await import("@openbooks/engine/money/money");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { postDocument } = await import("@openbooks/engine/ledger/posting-document");
const { createOrderDraft, fulfillSalesOrder, receivePurchaseOrder } =
  await import("@/lib/order-cycle.ts");
const { POST: voidDocument } = await import("../void/route.ts");
const { POST: correctRemainder } = await import("./route.ts");

const GRANTS =
  '["purchase_orders.read","purchase_orders.create","goods_receipts.create","goods_receipts.read","items.reverse","ar.read","ar.create","ap.read","ap.create","ap.post","orders.fulfill"]';

const actorFor = (id: string, orgId: string): SessionUser => ({
  id,
  orgId,
  name: "Void clerk",
  email: "void@scratch.test",
  roles: [],
  isSuperAdmin: false,
  envKind: "production",
  productionOrgId: orgId,
  homeOrgId: orgId,
  homeUserId: id,
});

async function seedOrg() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Void clerk", "void_clerk"),
  );
  await withBypassContext(() =>
    db.execute(sql`update app_roles set permissions=${GRANTS}::jsonb
    where org_id = ${org.orgId} and key = 'void_clerk'`),
  );
  state.user = actorFor(actor, org.orgId);
  return { org, actor };
}

async function seedPo(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actor: string,
  _number: string,
) {
  const order = await withOrgContext(org.orgId, () =>
    createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null),
  );
  const lineId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.invAsset},
            'Widget', '10', 'ea', '2', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update documents set status = 'approved', party_id = ${org.vendorId}, subsidiary_id = ${org.subsidiaryId},
           document_date = ${org.date}, subtotal = '20', total = '20'
     where id = ${order.id} and org_id = ${org.orgId}`),
  );
  return { orderId: order.id, lineId };
}

async function receiveFull(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actor: string,
  orderId: string,
  lineId: string,
) {
  return withOrgContext(org.orgId, () =>
    receivePurchaseOrder(org.orgId, actor, orderId, {
      receiptDate: org.date,
      idempotencyKey: randomUUID(),
      lines: [{ sourceLineId: lineId, quantity: "10" }],
    }),
  );
}

async function seedInvoice(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actor: string,
  number: string,
) {
  const invoiceId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', ${number}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '20', '0', '20',
            '{}'::jsonb, ${actor}, ${actor})`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity,
       unit, unit_price, amount, tax_amount, quantity_fulfilled, quantity_billed,
       stock_location_id, custom)
    values (${randomUUID()}, ${org.orgId}, ${invoiceId}, 1, ${org.items.fifo}, ${org.accounts.revenue},
            'Widget', '4', 'ea', '5', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`),
  );
  await withOrgContext(org.orgId, () =>
    postDocument(invoiceId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    }),
  );
  return invoiceId;
}

async function seedFulfillment(org: Awaited<ReturnType<typeof createScratchOrg>>, actor: string) {
  const order = await withOrgContext(org.orgId, () =>
    createOrderDraft(org.orgId, actor, "sales_order", randomUUID(), null),
  );
  const lineId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (${lineId}, ${org.orgId}, ${order.id}, 1, ${org.items.fifo}, ${org.accounts.revenue},
            'Widget', '4', 'ea', '5', '20', '0', '0', '0', ${org.stockLocationId}, '{}'::jsonb)`),
  );
  await withBypassContext(() =>
    db.execute(sql`
    update documents set status = 'approved', party_id = ${org.customerId}, subsidiary_id = ${org.subsidiaryId},
           document_date = ${org.date}, subtotal = '20', total = '20'
     where id = ${order.id} and org_id = ${org.orgId}`),
  );
  return withOrgContext(org.orgId, () =>
    fulfillSalesOrder(org.orgId, actor, order.id, {
      fulfillmentDate: org.date,
      idempotencyKey: randomUUID(),
      lines: [{ sourceLineId: lineId, quantity: "4" }],
    }),
  );
}

const voidCall = (receiptId: string, body: unknown) =>
  new Request(`http://probe.local/api/documents/${receiptId}/void`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function revisionOf(orgId: string, receiptId: string): Promise<string> {
  const row = await withBypassContext(() =>
    db.execute<{ revision: string }>(
      sql`
    select revision_seq::text as revision from documents where id = ${receiptId} and org_id = ${orgId}`,
      "objects",
    ),
  );
  return row[0]!.revision;
}

test("a consumed receipt refuses typed with its dependents and without the cascade offer", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W1");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    await seedInvoice(org, actor, "INV-M38-W1");
    const revision = await revisionOf(org.orgId, receipt.id);
    const response = await withOrgContext(org.orgId, () =>
      voidDocument(
        voidCall(receipt.id, {
          reason: "overstated delivery on the packing slip",
          reversalDate: org.date,
          expectedUpdatedAt: revision,
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
    const body = (await response.json()) as {
      error: string;
      code: string;
      details: {
        allowVoidWithDependents: boolean;
        remainderQuantity: string;
        blockers: { dependents: { sourceDocument: { id: string; number: string } | null }[] }[];
      };
    };
    assert.equal(body.code, "receipt-stock-consumed");
    assert.match(body.error, /INV-M38-W1/);
    assert.equal(body.details.allowVoidWithDependents, false);
    assert.equal(body.details.blockers.length, 1);
    assert.equal(body.details.blockers[0]!.dependents[0]!.sourceDocument?.number, "INV-M38-W1");
    assert.ok(
      body.details.blockers[0]!.dependents[0]!.sourceDocument?.id,
      "the dialog links the source document",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a closed-period reversal date refuses typed so the void dialog stays open", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W4");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    await withBypassContext(() =>
      db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
             2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, '{}'::jsonb
        from accounting_periods where id = ${org.periodId}`),
    );
    const { setPeriodLockState } = await import("@openbooks/engine/periods/period-locks");
    await withOrgContext(org.orgId, () =>
      setPeriodLockState({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "ap",
        state: "closed",
        actorId: actor,
        reason: "closed-period void control",
      }),
    );
    const revision = await revisionOf(org.orgId, receipt.id);
    const response = await withOrgContext(org.orgId, () =>
      voidDocument(
        voidCall(receipt.id, {
          reason: "overstated delivery on the packing slip",
          reversalDate: org.date,
          expectedUpdatedAt: revision,
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    // The dialog stays open on any refusal: the status decides, so the
    // closed-period refusal must arrive typed with its remedy in the body.
    assert.equal(response.status, 422, JSON.stringify(await response.clone().json()));
    const body = (await response.json()) as { error: string; code: string };
    assert.equal(body.code, "reversal-period-closed");
    assert.match(body.error, /reversal period for .* is closed/);
    const status = await withBypassContext(() =>
      db.execute<{ status: string }>(
        sql`
      select status from documents where id = ${receipt.id}`,
        "objects",
      ),
    );
    assert.equal(status[0]!.status, "approved", "the refused receipt stays voidable");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("void with dependents cascades through the fulfillment void", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W2");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    const shipment = await seedFulfillment(org, actor);
    const revision = await revisionOf(org.orgId, receipt.id);
    const refused = await withOrgContext(org.orgId, () =>
      voidDocument(
        voidCall(receipt.id, {
          reason: "overstated delivery on the packing slip",
          reversalDate: org.date,
          expectedUpdatedAt: revision,
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(refused.status, 422);
    const refusedBody = (await refused.json()) as { details: { allowVoidWithDependents: boolean } };
    assert.equal(refusedBody.details.allowVoidWithDependents, true);
    const revision2 = await revisionOf(org.orgId, receipt.id);
    const response = await withOrgContext(org.orgId, () =>
      voidDocument(
        voidCall(receipt.id, {
          reason: "overstated delivery on the packing slip",
          reversalDate: org.date,
          expectedUpdatedAt: revision2,
          withDependents: true,
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const states = await withBypassContext(() =>
      db.execute<{ id: string; status: string }>(
        sql`
      select id, status from documents where org_id = ${org.orgId} and id in (${receipt.id}, ${shipment.id})`,
        "objects",
      ),
    );
    assert.deepEqual(
      new Map(states.map((row) => [row.id, row.status])),
      new Map([
        [receipt.id, "voided"],
        [shipment.id, "voided"],
      ]),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the remainder route corrects a phantom over-delivery while the receipt stands", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W3");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    await seedInvoice(org, actor, "INV-M38-W3");
    const response = await withOrgContext(org.orgId, () =>
      correctRemainder(
        new Request(`http://probe.local/api/documents/${receipt.id}/receipt-remainder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "overstated delivery on the packing slip",
            date: org.date,
          }),
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = (await response.json()) as { ok: boolean; adjustedQuantity: string };
    assert.equal(body.ok, true);
    assert.equal(toUnits(body.adjustedQuantity), toUnits("6"));
    const facts = await withBypassContext(() =>
      db.execute<{ status: string; received: string }>(
        sql`
      select (select status from documents where id = ${receipt.id}) as status,
             (select quantity_fulfilled::text from document_lines where id = ${po.lineId}) as received`,
        "objects",
      ),
    );
    assert.equal(facts[0]!.status, "approved");
    assert.equal(toUnits(facts[0]!.received), toUnits("4"));
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the remainder route corrects a consumed line to its delivered quantity", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W4");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    await seedFulfillment(org, actor);
    const line = await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
      select id from document_lines where document_id = ${receipt.id} and org_id = ${org.orgId}`,
        "objects",
      ),
    );
    const response = await withOrgContext(org.orgId, () =>
      correctRemainder(
        new Request(`http://probe.local/api/documents/${receipt.id}/receipt-remainder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "supplier short-shipped three units against the packing slip",
            date: org.date,
            lines: [{ receiptLineId: line[0]!.id, correctedQuantity: "7" }],
          }),
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = (await response.json()) as { ok: boolean; adjustedQuantity: string };
    assert.equal(body.ok, true);
    assert.equal(toUnits(body.adjustedQuantity), toUnits("3"));
    const facts = await withBypassContext(() =>
      db.execute<{ status: string; received: string; line: string }>(
        sql`
      select (select status from documents where id = ${receipt.id}) as status,
             (select quantity_fulfilled::text from document_lines where id = ${po.lineId}) as received,
             (select quantity::text from document_lines where id = ${line[0]!.id}) as line`,
        "objects",
      ),
    );
    assert.equal(facts[0]!.status, "approved");
    assert.equal(toUnits(facts[0]!.received), toUnits("7"));
    assert.equal(
      toUnits(facts[0]!.line),
      toUnits("10"),
      "the receipt line quantity is never edited",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the remainder route refuses a correction past the unconsumed remainder", async () => {
  const { org, actor } = await seedOrg();
  try {
    const po = await seedPo(org, actor, "PO-M38-W5");
    const receipt = await receiveFull(org, actor, po.orderId, po.lineId);
    await seedFulfillment(org, actor);
    const line = await withBypassContext(() =>
      db.execute<{ id: string }>(
        sql`
      select id from document_lines where document_id = ${receipt.id} and org_id = ${org.orgId}`,
        "objects",
      ),
    );
    const response = await withOrgContext(org.orgId, () =>
      correctRemainder(
        new Request(`http://probe.local/api/documents/${receipt.id}/receipt-remainder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "supplier short-shipped seven units against the packing slip",
            date: org.date,
            lines: [{ receiptLineId: line[0]!.id, correctedQuantity: "3" }],
          }),
        }),
        { params: Promise.resolve({ id: receipt.id }) },
      ),
    );
    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /remains unconsumed/);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
