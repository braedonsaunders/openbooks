import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { toUnits } from "@openbooks/engine/src/money/money.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __poReceiveAudit: state });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier === "../../../../../lib/authz" &&
        context.parentURL?.includes("/api/purchase-orders/")) ||
      (specifier === "./authz" && context.parentURL?.endsWith("/lib/feature-gates.ts"))
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__poReceiveAudit.user,allowedSubsidiaryIds:null,permissions:['goods_receipts.create','items.post']}};export function can(){return true};export function guardSubsidiaryScope(){return null}",
          ),
      };
    }
    return next(specifier, context);
  },
});

const { POST } = await import("./route.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const PAST_DATE = "2026-07-10";

async function seedApprovedPo(
  orgId: string,
  actorId: string,
  vendorId: string,
  subsidiaryId: string,
  documentDate: string,
  itemId: string,
  assetAccountId: string,
  stockLocationId: string,
  number: string,
): Promise<{ orderId: string; lineId: string }> {
  const orderId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${orderId}, ${orgId}, 'purchase_order', ${number}, ${vendorId},
      ${subsidiaryId}, ${documentDate}, 'CAD', 'draft', '20', '0', '20',
      ${actorId}, ${actorId}
    )`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description,
       quantity, unit, unit_price, amount, tax_amount,
       quantity_fulfilled, quantity_billed, stock_location_id, custom)
    values (
      ${lineId}, ${orgId}, ${orderId}, 1, ${itemId}, ${assetAccountId}, 'Widget',
      '10', 'ea', '2', '20', '0', '0', '0', ${stockLocationId}, '{}'::jsonb
    )`);
  // Approved lines are storage-immutable: issue the order only after its
  // lines exist.
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${orderId} and org_id = ${orgId}`);
  return { orderId, lineId };
}

function postReceive(orderId: string, key: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return POST(
    new Request(`http://openbooks.test/api/purchase-orders/${orderId}/receive`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: orderId }) } as never,
  ) as unknown as Promise<Response>;
}

async function receiptFacts(orgId: string, lineId: string) {
  return (
    await db.execute<{
      received: string;
      receipts: number;
      moved: string;
      receiptDate: string;
      postingDate: string;
    }>(sql`
      select (select quantity_fulfilled::text from document_lines where id = ${lineId}) as received,
             (select count(*)::int from documents where org_id = ${orgId} and kind = 'purchase_receipt') as receipts,
             (select coalesce(sum(quantity), 0)::text from inventory_movements
               where org_id = ${orgId} and status = 'posted') as moved,
             (select document_date::text from documents where org_id = ${orgId} and kind = 'purchase_receipt' limit 1) as "receiptDate",
             (select posting_date::text from journal_entries where org_id = ${orgId} limit 1) as "postingDate"
    `)
  ).rows[0]!;
}

/**
 * The explicit receive endpoint posts a partial receipt dated in the past
 * (inside the open period) and replays a retried save instead of receiving
 * twice.
 */
test("explicit receive posts a partial past-dated receipt exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
    state.user = { orgId: org.orgId, id: actorId };
    const { orderId, lineId } = await seedApprovedPo(
      org.orgId, actorId, org.vendorId, org.subsidiaryId, org.date,
      org.items.fifo, org.accounts.invAsset, org.stockLocationId, "PO-RCV-1",
    );
    const key = randomUUID();
    const first = await postReceive(orderId, key, {
      receiptDate: PAST_DATE,
      lines: [{ sourceLineId: lineId, quantity: "4" }],
    });
    assert.equal(first.status, 200, await first.clone().text());
    const created = (await first.json()) as { kind: string; id: string; documentNumber: string };
    assert.equal(created.kind, "purchase_receipt");

    const facts = await receiptFacts(org.orgId, lineId);
    assert.equal(toUnits(facts.received), toUnits("4"), "only the entered quantity advances the order");
    assert.equal(facts.receipts, 1);
    assert.equal(toUnits(facts.moved), toUnits("4"), "only the entered quantity moves stock");
    assert.equal(facts.receiptDate, PAST_DATE, "the receipt carries the entered past date");
    assert.equal(facts.postingDate, PAST_DATE, "the inventory journal posts on the entered past date");

    const retry = await postReceive(orderId, key, {
      receiptDate: PAST_DATE,
      lines: [{ sourceLineId: lineId, quantity: "4" }],
    });
    assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { replayed?: boolean }).replayed, true);
    const after = await receiptFacts(org.orgId, lineId);
    assert.equal(toUnits(after.received), toUnits("4"), "a retried save never double-receives");
    assert.equal(after.receipts, 1);
    assert.equal(toUnits(after.moved), toUnits("4"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("explicit receive refuses without an idempotency key and over-receipt commits nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Receiving Clerk", "admin");
    state.user = { orgId: org.orgId, id: actorId };
    const { orderId, lineId } = await seedApprovedPo(
      org.orgId, actorId, org.vendorId, org.subsidiaryId, org.date,
      org.items.fifo, org.accounts.invAsset, org.stockLocationId, "PO-RCV-2",
    );
    const noKey = await postReceive(orderId, null, {
      receiptDate: org.date,
      lines: [{ sourceLineId: lineId, quantity: "1" }],
    });
    assert.equal(noKey.status, 400);

    const over = await postReceive(orderId, randomUUID(), {
      receiptDate: org.date,
      lines: [{ sourceLineId: lineId, quantity: "99" }],
    });
    assert.equal(over.status, 422);
    const facts = await receiptFacts(org.orgId, lineId);
    assert.equal(toUnits(facts.received), toUnits("0"), "a refused save advances nothing");
    assert.equal(facts.receipts, 0, "a refused save creates no receipt");
    assert.equal(toUnits(facts.moved), toUnits("0"), "a refused save moves no stock");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
