import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { postDocument } from "./posting-document.ts";
import { generateInvoiceFromBillingRequest } from "./billing-invoice.ts";
import { deleteDocument } from "./document-delete.ts";
import { DocumentVoidError, requestDocumentVoid } from "./document-void.ts";

test("a billed project charge cannot be voided until its customer invoice releases it", { skip: !process.env.OPENBOOKS_DB_URL }, () =>
  withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`
        update orgs set settings = jsonb_set(jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects": true}'::jsonb),
          '{controlAccounts,projectRevenue}', to_jsonb(${org.accounts.revenue}::text))
         where id = ${org.orgId}`);
      const project = randomUUID();
      const item = randomUUID();
      const charge = randomUUID();
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-V', 'Void guard job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into items (id, org_id, kind, name, income_account_id, is_active)
        values (${item}, ${org.orgId}, 'service', 'Crane time', ${org.accounts.revenue}, true)`);
      await db.execute(sql`
        insert into documents (id, org_id, kind, document_number, document_date, posting_date, currency, status,
                               project_id, subsidiary_id, subtotal, tax_total, total)
        values (${charge}, ${org.orgId}, 'project_charge', 'CHG-V1', ${org.date}, ${org.date}, 'CAD', 'draft',
                ${project}, ${org.subsidiaryId}, '100', '0', '100')`);
      await db.execute(sql`
        insert into document_lines (org_id, document_id, line_number, item_id, account_id, recovery_account_id, description,
                                    quantity, amount, project_id, cost_rate, bill_rate, cost_amount, bill_amount, is_billable)
        values (${org.orgId}, ${charge}, 1, ${item}, ${org.accounts.cogs}, ${org.accounts.adjustment}, 'Crane time',
                '1', '100', ${project}, '100', '150', '100', '150', true)`);
      await db.execute(sql`update documents set status = 'approved' where id = ${charge} and org_id = ${org.orgId}`);
      await postDocument(charge, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

      const request = randomUUID();
      await db.execute(sql`
        insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis, cutoff_date,
                                      billing_method_snapshot, backup_required, status, created_by, updated_by)
        values (${request}, ${org.orgId}, ${project}, 'BR-V1', 'progress', 'date_range', ${org.date},
                'time_and_materials', false, 'open', ${actor}, ${actor})`);
      const invoice = await generateInvoiceFromBillingRequest(org.orgId, actor, request);
      const invoiceNumber = (await db.execute<{ n: string }>(sql`
        select document_number as n from documents where id = ${invoice.id} and org_id = ${org.orgId}`)).rows[0]!.n;

      const voidCharge = () => requestDocumentVoid({
        documentId: charge, orgId: org.orgId, actorId: actor, reason: "charged to the wrong job", reversalDate: org.date,
      });
      await assert.rejects(voidCharge(), (error: unknown) =>
        error instanceof DocumentVoidError &&
        error.code === "billed-on-invoice" &&
        error.message === `This cost is billed on invoice ${invoiceNumber}; void or delete that invoice first`);
      const stillPosted = (await db.execute<{ status: string }>(sql`
        select status from documents where id = ${charge} and org_id = ${org.orgId}`)).rows[0]!;
      assert.equal(stillPosted.status, "posted", "a refused void leaves the charge untouched");

      await deleteDocument(invoice.id, actor, org.orgId, { allowedSubsidiaryIds: null, reason: "rebill after correction" });
      const voided = await voidCharge();
      assert.equal(voided.status, "voided");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  }));
