import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
}});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/test-fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/test-fixtures.ts";
const { convertOrder } = await import("./order-cycle.ts");
const { postDocument } = await import("@openbooks/engine/src/posting.ts");

async function seedOrderWithoutLineAccount(
  org: ScratchOrg,
  actorId: string,
  itemId: string,
  number: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '1000', '0', '1000',
      ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, item_id, account_id, quantity,
       quantity_billed, quantity_fulfilled, unit_price, amount,
       tax_input_amount, tax_amount, created_by, updated_by)
    values (
      ${org.orgId}, ${id}, 1, ${itemId}, null, '10',
      '0', '0', '100', '1000', '1000', '0', ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${id} and org_id = ${org.orgId}
  `);
  return id;
}

/**
 * F-t09-012: converted SO lines never inherited the item's income account,
 * so SO-converted invoices were unpostable once Approved ("document line 1
 * has no resolvable account"). The convert must carry item income accounts
 * onto lines that have none, and the converted invoice must post end to end.
 */
test("sales-order conversion inherits the item income account onto account-less lines", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Order Converter", "admin"));
    const soId = await withBypassContext(async () => {
      await db.execute(sql`update items set income_account_id = ${org.accounts.revenue}, recognition_rule_id = null, deferred_account_id = null where id = ${org.items.service} and org_id = ${org.orgId}`);
      return seedOrderWithoutLineAccount(org, actorId, org.items.service, "SO-INC-1");
    });

    const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    const lines = (await withBypassContext(() => db.execute<{ account_id: string | null }>(sql`
      select account_id from document_lines where org_id = ${org.orgId} and document_id = ${converted.id} order by line_number`))).rows;
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.account_id, org.accounts.revenue);

    await withBypassContext(async () => {
      await db.execute(sql`update documents set status = 'approved' where id = ${converted.id} and org_id = ${org.orgId}`);
      await postDocument(converted.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    });
    const status = (await withBypassContext(() => db.execute<{ status: string }>(sql`select status from documents where id = ${converted.id}`))).rows[0]!.status;
    assert.equal(status, "posted");
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});
