import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";

// A consolidated invoice carries several children's charges on one payer
// header; the AR list's service-party filter finds the payer invoices
// holding one child's lines. SQL builders and storage are real; only the
// server-only seam is stubbed.
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { invoiceServicePartyWhere } = await import("./list-query.ts");
const { defaultListView } = await import("@openbooks/customization");

const DB = !!process.env.OPENBOOKS_DB_URL;
const KINDS = ["customer_invoice"] as const;

async function fixture() {
  const org = await createScratchOrg();
  const payer = randomUUID();
  const child = randomUUID();
  const stranger = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${payer}, ${org.orgId}, 'customer', 'Parent Co', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${child}, ${org.orgId}, 'customer', 'Child Co', ${org.subsidiaryId}, true, '{}'::jsonb),
           (${stranger}, ${org.orgId}, 'customer', 'Stranger Co', ${org.subsidiaryId}, true, '{}'::jsonb)`);
  const consolidated = randomUUID();
  const plain = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, status, document_number, document_date, subsidiary_id, party_id, currency, subtotal, tax_total, total, custom)
    values (${consolidated}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-C', ${org.date}, ${org.subsidiaryId}, ${payer}, 'USD', '10', '0', '10', '{}'::jsonb),
           (${plain}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-P', ${org.date}, ${org.subsidiaryId}, ${payer}, 'USD', '5', '0', '5', '{}'::jsonb)`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
       quantity, unit_price, custom, extra_dims, service_party_id)
    values (${randomUUID()}, ${org.orgId}, ${consolidated}, 1, ${org.accounts.revenue}, '10', 0,
            1, '10', '{}'::jsonb, '{}'::jsonb, ${child}),
           (${randomUUID()}, ${org.orgId}, ${plain}, 1, ${org.accounts.revenue}, '5', 0,
            1, '5', '{}'::jsonb, '{}'::jsonb, null)`);
  return { org, payer, child, stranger };
}

async function countRows(
  orgId: string,
  adhoc: { filters?: Record<string, string | undefined> },
  clauses: { key: string; operator: "eq" | "ne"; value: string }[] = [],
): Promise<number> {
  const view = { ...defaultListView("customer_invoice"), filters: clauses };
  const rows = (
    await db.execute<{ n: number }>(sql`select count(*)::int as n from documents d
      where ${invoiceServicePartyWhere([...KINDS], view, adhoc, orgId, null)}`)
  ).rows;
  return rows[0]!.n;
}

test("the AR service-party filter finds the payer invoices carrying the child's charges", { skip: !DB }, async () => {
  const { org, child, stranger } = await fixture();
  try {
    assert.equal(await countRows(org.orgId, {}), 2, "unfiltered list sees both invoices");
    assert.equal(
      await countRows(org.orgId, { filters: { service_party_id: child } }),
      1,
      "the child's filter finds exactly the consolidated invoice",
    );
    assert.equal(
      await countRows(org.orgId, { filters: { service_party_id: stranger } }),
      0,
      "an uninvolved customer matches nothing",
    );
    assert.equal(
      await countRows(org.orgId, { filters: { service_party_id: "not-a-uuid" } }),
      0,
      "a malformed service party matches nothing instead of throwing",
    );
    assert.equal(
      await countRows(org.orgId, {}, [{ key: "service_party_id", operator: "eq", value: child }]),
      1,
      "a saved view on the service party filters the same way",
    );
    assert.equal(
      await countRows(org.orgId, {}, [{ key: "service_party_id", operator: "ne", value: child }]),
      1,
      "negating the service party keeps the invoice without the child's lines",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
