import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

test(
  "pay-application invoices cannot cross organization boundaries",
  { skip: !DB },
  async () => {
    const owner = await createScratchOrg();
    const foreign = await createScratchOrg();
    try {
      const projectId = randomUUID();
      await db.execute(sql`
        insert into projects
          (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values
          (${projectId}, ${owner.orgId}, ${owner.subsidiaryId}, ${`PAY-${projectId}`},
           'Pay application regression project', ${owner.customerId}, 'active', true, '{}'::jsonb)
      `);

      const foreignInvoiceId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, document_date, currency)
        values
          (${foreignInvoiceId}, ${foreign.orgId}, 'customer_invoice', ${`INV-${foreignInvoiceId}`},
           ${foreign.date}, 'CAD')
      `);

      // RED before 0073: 0003's single-column FK accepts this UUID. GREEN
      // after 0073: the composite key rejects the cross-organization pointer.
      await assert.rejects(
        db.execute(sql`
          insert into pay_applications
            (id, org_id, project_id, application_number, period_end, status, invoice_document_id)
          values
            (${randomUUID()}, ${owner.orgId}, ${projectId}, 1, ${owner.date}, 'invoiced', ${foreignInvoiceId})
        `),
        (error: unknown) => errorChainMatches(error, /pay_applications_invoice_document_id_fkey/),
      );

      const ownerInvoiceId = randomUUID();
      const ownerApplicationId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, document_number, document_date, currency)
        values
          (${ownerInvoiceId}, ${owner.orgId}, 'customer_invoice', ${`INV-${ownerInvoiceId}`},
           ${owner.date}, 'CAD')
      `);
      await db.execute(sql`
        insert into pay_applications
          (id, org_id, project_id, application_number, period_end, status, invoice_document_id)
        values
          (${ownerApplicationId}, ${owner.orgId}, ${projectId}, 1, ${owner.date}, 'invoiced', ${ownerInvoiceId})
      `);

      const linked = await db.execute<{
        org_id: string;
        invoice_document_id: string | null;
      }>(sql`
        select org_id::text, invoice_document_id::text
          from pay_applications
         where id = ${ownerApplicationId}
      `);
      assert.deepEqual(linked.rows, [{ org_id: owner.orgId, invoice_document_id: ownerInvoiceId }]);
    } finally {
      await dropScratchOrg(foreign.orgId);
      await dropScratchOrg(owner.orgId);
    }
  },
);
