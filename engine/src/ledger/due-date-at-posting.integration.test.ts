import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { addCalendarDays } from "../platform/civil-date.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

import { postDocument } from "./posting-document.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function control(org: ScratchOrg) {
  return { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
}

async function paymentTerms(org: ScratchOrg, name: string, netDays: number): Promise<string> {
  const id = randomUUID();
  await db.execute(
    sql`insert into payment_terms (id, org_id, name, net_days) values (${id}, ${org.orgId}, ${name}, ${netDays})`,
  );
  return id;
}

/** An approved customer invoice with one revenue line and the given due date (null when blank). */
async function approvedInvoice(
  org: ScratchOrg,
  number: string,
  dueDate: string | null,
): Promise<string> {
  const docId = randomUUID();
  await db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date, due_date, currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${docId}, ${org.orgId}, 'customer_invoice', ${number}, ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, ${dueDate}, 'CAD', 1, 'draft', '900', '0', '900', false, '{}'::jsonb, '{}'::jsonb)`);
  await db.execute(sql`insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed, custom, tax_overridden, extra_dims)
    values (${randomUUID()}, ${org.orgId}, ${docId}, 1, null, ${org.accounts.revenue}, '1', '900', '900', '0', false, '0', '0', '{}'::jsonb, false, '{}'::jsonb)`);
  await db.execute(
    sql`update documents set status = 'approved', updated_at = now() where id = ${docId} and org_id = ${org.orgId}`,
  );
  return docId;
}

async function header(docId: string) {
  return (
    await db.execute<{
      status: string;
      due_date: string | null;
      document_date: string;
      posted_entry_id: string | null;
    }>(
      sql`
    select status, due_date::text as due_date, document_date::text as document_date, posted_entry_id from documents where id = ${docId}`,
      "objects",
    )
  )[0]!;
}

test(
  "a customer invoice posted with no due date takes the due date its customer's terms imply",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const net15 = await paymentTerms(org, "Net 15", 15);
        await db.execute(
          sql`insert into customer_roles (org_id, party_id, payment_terms_id) values (${org.orgId}, ${org.customerId}, ${net15})`,
        );
        const docId = await approvedInvoice(org, "INV-TERMS", null);
        await postDocument(docId, control(org));
        const row = await header(docId);
        const due = addCalendarDays(org.date, 15);
        assert.equal(row.status, "posted");
        assert.equal(row.due_date, due, "the document header carries the derived due date");
        const lines = await db.execute<{ due_date: string | null }>(
          sql`
        select due_date::text as due_date from journal_lines where entry_id = ${row.posted_entry_id} and is_open_item`,
          "objects",
        );
        assert.deepEqual(
          lines.map((line) => line.due_date),
          [due],
          "the open item carries the same due date",
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a blank due date falls back to the organization's default terms when the customer has none",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const net30 = await paymentTerms(org, "Net 30", 30);
        await db.execute(sql`update orgs set settings = coalesce(settings, '{}'::jsonb)
        || jsonb_build_object('billing', coalesce(settings->'billing', '{}'::jsonb) || jsonb_build_object('defaultPaymentTermsId', ${net30}::text))
        where id = ${org.orgId}`);
        const docId = await approvedInvoice(org, "INV-DEFAULT", null);
        await postDocument(docId, control(org));
        assert.equal((await header(docId)).due_date, addCalendarDays(org.date, 30));
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an invoice with no due date and no terms is due on receipt", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withBypassContext(async () => {
      const docId = await approvedInvoice(org, "INV-NOTERMS", null);
      await postDocument(docId, control(org));
      const row = await header(docId);
      assert.equal(row.status, "posted");
      assert.equal(
        row.due_date,
        row.document_date,
        "with no terms the invoice is due on its document date",
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a due date the document states is kept even when terms would imply another",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const net15 = await paymentTerms(org, "Net 15", 15);
        await db.execute(
          sql`insert into customer_roles (org_id, party_id, payment_terms_id) values (${org.orgId}, ${org.customerId}, ${net15})`,
        );
        const stated = addCalendarDays(org.date, 45);
        const docId = await approvedInvoice(org, "INV-STATED", stated);
        await postDocument(docId, control(org));
        assert.equal((await header(docId)).due_date, stated);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a vendor bill under day-of-month terms posts due on that day of the month its terms reach",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await withBypassContext(async () => {
        const terms = randomUUID();
        await db.execute(sql`insert into payment_terms (id, org_id, name, net_days, due_day_of_month)
        values (${terms}, ${org.orgId}, 'Net 30, 1st following', 30, 1)`);
        await db.execute(sql`insert into vendor_roles (org_id, party_id, ap_account_id, payment_terms_id, is_active)
        values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${terms}, true)`);
        const docId = randomUUID();
        await db.execute(sql`insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, subtotal, tax_total, total)
        values (${docId}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-DAY-TERMS', ${org.subsidiaryId}, ${org.vendorId}, ${org.date}, 'CAD', '100', '0', '100')`);
        await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
        values (${org.orgId}, ${docId}, 1, ${org.accounts.cogs}, '1', '100', '100', '0')`);
        await db.execute(
          sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${docId}`,
        );
        await postDocument(docId, control(org));
        const row = await header(docId);
        // Dated 15 July: thirty days reach 14 August, so the next 1st is 1 September.
        assert.equal(row.document_date, "2026-07-15");
        assert.equal(row.status, "posted");
        assert.equal(row.due_date, "2026-09-01");
        const lines = await db.execute<{ due_date: string | null }>(
          sql`
        select due_date::text as due_date from journal_lines where entry_id = ${row.posted_entry_id} and is_open_item`,
          "objects",
        );
        assert.deepEqual(
          lines.map((line) => line.due_date),
          ["2026-09-01"],
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
