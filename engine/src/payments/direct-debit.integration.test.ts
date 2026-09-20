import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createDirectDebitRun } from "./direct-debit.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { PaymentError } from "./payment-errors.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("duplicate direct-debit selection is a domain failure", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const options = await withBypass(async () => {
      const actorId = await createScratchUser(org.orgId, "Collection Operator", "accountant");
      const formatId = randomUUID();
      const profileId = randomUUID();
      const partyBankAccountId = randomUUID();
      const mandateId = randomUUID();
      const invoiceAId = randomUUID();
      const invoiceBId = randomUUID();

      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
        values
          (${formatId}, ${org.orgId}, 'NACHA-DD-DUPLICATE', 'NACHA debit duplicate test',
           'nacha_debit', 'debit', 'US', 'CAD', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
           currency, country, created_by, updated_by)
        values
          (${profileId}, ${org.orgId}, 'Duplicate collection profile', ${org.accounts.bank},
           ${org.subsidiaryId}, ${formatId}, 'CAD', 'CA', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into party_bank_accounts
          (id, org_id, party_id, bank_name, country, currency, routing,
           account_last_four, approved_at, approved_by, created_by, updated_by)
        values
          (${partyBankAccountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
           'CA', 'CAD', '{}'::jsonb, '1234', ${org.date}, ${actorId}, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_mandates
          (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
           status, signed_on, valid_from, created_by, updated_by)
        values
          (${mandateId}, ${org.orgId}, ${org.customerId}, ${partyBankAccountId},
           'nacha', 'MANDATE-DUPLICATE', 'active', ${org.date}, ${org.date},
           ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values
          (${invoiceAId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-DUPLICATE-A',
           ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
           '75', '0', '75', ${actorId}),
          (${invoiceBId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-DUPLICATE-B',
           ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
           '125', '0', '125', ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, tax_input_amount)
        values
          (${org.orgId}, ${invoiceAId}, 1, ${org.accounts.revenue}, '1', '75',
           '75', '0', '75'),
          (${org.orgId}, ${invoiceBId}, 1, ${org.accounts.revenue}, '1', '125',
           '125', '0', '125')`);
      await db.execute(sql`
        update documents
           set status = 'approved', updated_at = now()
         where org_id = ${org.orgId}
           and id in (${invoiceAId}, ${invoiceBId})`);
      await postDocument(invoiceAId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      await postDocument(invoiceBId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });

      return {
        base: {
          orgId: org.orgId,
          createdBy: actorId,
          paymentBankProfileId: profileId,
          scheduledFor: org.date,
        },
        invoiceAId,
        invoiceBId,
      };
    });

    await withOrgContext(org.orgId, async () => {
      const selectedB = await createDirectDebitRun({
        ...options.base,
        invoiceDocumentIds: [options.invoiceBId],
      });

      await assert.rejects(
        () => createDirectDebitRun({
          ...options.base,
          invoiceDocumentIds: [options.invoiceAId, options.invoiceBId],
        }),
        (error: unknown) => {
          assert.ok(error instanceof PaymentError);
          assert.equal(
            error.message,
            "a selected invoice is already reserved by another live payment run",
          );
          return true;
        },
      );

      const selectedA = await createDirectDebitRun({
        ...options.base,
        invoiceDocumentIds: [options.invoiceAId],
      });

      const runs = (await db.execute<{
        id: string;
        status: string;
        item_count: number;
        instruction_count: number;
        receipt_count: number;
        failed_event_count: number;
        source_document_ids: string[];
      }>(sql`
        select run.id, run.status,
               (select count(*)::int from payment_run_items item
                 where item.org_id = run.org_id and item.payment_run_id = run.id) as item_count,
               (select count(*)::int from payment_instructions instruction
                 where instruction.org_id = run.org_id
                   and instruction.payment_run_id = run.id) as instruction_count,
               (select count(*)::int from documents receipt
                 where receipt.org_id = run.org_id
                   and receipt.kind = 'customer_payment'
                   and receipt.memo = 'Collection run ' || run.run_number) as receipt_count,
               (select count(*)::int from payment_events event
                 where event.org_id = run.org_id
                   and event.payment_run_id = run.id
                   and event.event_type = 'run_creation_failed') as failed_event_count,
               array(select item.source_document_id::text from payment_run_items item
                 where item.org_id = run.org_id and item.payment_run_id = run.id
                 order by item.source_document_id)::text[] as source_document_ids
          from payment_runs run
         where run.org_id = ${org.orgId}
           and run.direction = 'inbound'
           and run.purpose = 'customer_collections'
         order by run.status, run.id
      `));

      assert.equal(runs.rows.length, 3);
      const failed = runs.rows.find((run) => run.status === "cancelled");
      assert.ok(failed);
      assert.deepEqual(failed, {
        id: failed.id,
        status: "cancelled",
        item_count: 0,
        instruction_count: 0,
        receipt_count: 0,
        failed_event_count: 1,
        source_document_ids: [],
      });
      assert.deepEqual(
        runs.rows.find((run) => run.id === selectedA.id),
        {
          id: selectedA.id,
          status: "draft",
          item_count: 1,
          instruction_count: 1,
          receipt_count: 1,
          failed_event_count: 0,
          source_document_ids: [options.invoiceAId],
        },
      );
      assert.deepEqual(
        runs.rows.find((run) => run.id === selectedB.id),
        {
          id: selectedB.id,
          status: "draft",
          item_count: 1,
          instruction_count: 1,
          receipt_count: 1,
          failed_event_count: 0,
          source_document_ids: [options.invoiceBId],
        },
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("direct-debit collection uses the transaction-ledger open, not base divided by rate", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const ids = await withBypass(async () => {
      const actorId = await createScratchUser(org.orgId, "FX Collection Operator", "accountant");
      const formatId = randomUUID();
      const profileId = randomUUID();
      const partyBankAccountId = randomUUID();
      const mandateId = randomUUID();
      const invoiceId = randomUUID();

      await db.execute(sql`
        insert into payment_formats
          (id, org_id, code, name, rail, direction, country, currency, created_by, updated_by)
        values
          (${formatId}, ${org.orgId}, 'SEPA-DD-FX-OPEN', 'SEPA debit FX open test',
           'sepa_debit', 'debit', 'DE', 'USD', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_bank_profiles
          (id, org_id, name, bank_account_id, subsidiary_id, payment_format_id,
           currency, country, created_by, updated_by)
        values
          (${profileId}, ${org.orgId}, 'FX collection profile', ${org.accounts.bank},
           ${org.subsidiaryId}, ${formatId}, 'USD', 'DE', ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into party_bank_accounts
          (id, org_id, party_id, bank_name, country, currency, routing,
           account_last_four, approved_at, approved_by, created_by, updated_by)
        values
          (${partyBankAccountId}, ${org.orgId}, ${org.customerId}, 'Customer bank',
           'DE', 'USD', '{}'::jsonb, '1234', ${org.date}, ${actorId}, ${actorId}, ${actorId})`);
      await db.execute(sql`
        insert into payment_mandates
          (id, org_id, party_id, party_bank_account_id, scheme, mandate_reference,
           status, signed_on, valid_from, created_by, updated_by)
        values
          (${mandateId}, ${org.orgId}, ${org.customerId}, ${partyBankAccountId},
           'sepa', 'MANDATE-FX-OPEN', 'active', ${org.date}, ${org.date},
           ${actorId}, ${actorId})`);
      // 1000.00 USD at 0.8765 posts a base leg of 876.5000. A 0.10 partial
      // extinguishes round(876.5000 * 0.10 / 1000) = 0.0877 of base, leaving
      // 876.4123 — and round(876.4123 / 0.8765, 4) = 999.8999, NOT the
      // ledger's transaction open of 999.9000.
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values
          (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-FX-OPEN',
           ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'USD', '0.8765',
           '1000', '0', '1000', ${actorId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price,
           amount, tax_amount, tax_input_amount)
        values
          (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '1000',
           '1000', '0', '1000')`);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${invoiceId} and org_id = ${org.orgId}`);
      const invoiceEntryId = await postDocument(invoiceId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const openLineId = (await db.execute<{ id: string }>(sql`
        select id from journal_lines
         where entry_id = ${invoiceEntryId} and org_id = ${org.orgId} and is_open_item
      `)).rows[0]!.id;
      return { actorId, profileId, invoiceId, openLineId };
    });

    await withOrgContext(org.orgId, async () => {
      const { createPaymentDocument, updateDraftPayment } = await import("./payment-documents.ts"), { postPaymentWithApplications } = await import("./payment-posting.ts"), { sameCurrencyAllocation } = await import("./settlement-policy.ts");
      const receipt = await createPaymentDocument({
        orgId: org.orgId,
        kind: "customer_payment",
        createdBy: ids.actorId,
        partyId: org.customerId,
        bankAccountId: org.accounts.bank,
        subsidiaryId: org.subsidiaryId,
        documentDate: org.date,
        currency: "USD",
        fxRate: "0.8765",
      });
      await updateDraftPayment(receipt.id, {
        partyId: org.customerId,
        bankAccountId: org.accounts.bank,
        allocations: [sameCurrencyAllocation(ids.openLineId, "0.1")],
      }, ids.actorId, org.orgId);
      await db.execute(sql`
        update documents set status = 'approved', submitted_by = ${ids.actorId}, submitted_at = now()
         where id = ${receipt.id} and org_id = ${org.orgId}`);
      await postPaymentWithApplications(receipt.id, undefined, ids.actorId);

      await createDirectDebitRun({
        orgId: org.orgId,
        createdBy: ids.actorId,
        paymentBankProfileId: ids.profileId,
        invoiceDocumentIds: [ids.invoiceId],
        scheduledFor: org.date,
      });
      const items = (await db.execute<{ gross: string; payment: string; instruction: string }>(sql`
        select item.gross_amount::text as gross, item.payment_amount::text as payment,
               (select instruction.amount::text from payment_instructions instruction
                 where instruction.org_id = item.org_id
                   and instruction.payment_run_id = item.payment_run_id
                 limit 1) as instruction
          from payment_run_items item
         where item.org_id = ${org.orgId} and item.source_document_id = ${ids.invoiceId}
      `));
      // The ledger's transaction open is 1000 - 0.10 = 999.90; dividing the
      // rounded base back by the rate must never shrink (or grow) it.
      assert.deepEqual(items.rows[0], { gross: "999.9000", payment: "999.9000", instruction: "999.9000" });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
