import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const { sql } = await import("drizzle-orm");
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
const { convertOrder } = await import("./order-cycle.ts");
const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");

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
 * Converted SO lines never inherited the item's income account,
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


const consolidatedRows = [
  { label: "order draft currency", register: async () => {
        // createOrderDraft must refuse when the org base currency is missing instead
        // of inventing CAD — the same rule the canonical order create enforces, so a
        // draft can never silently book foreign-currency intent as domestic.
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { createOrderDraft, OrderDraftError } = await import("./order-cycle.ts");
        
        
        test("createOrderDraft refuses when the org base currency is missing", async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, "Drafter", "order_drafter"));
            // base_currency is NOT NULL, so an unconfigured org carries the empty
            // string — the same falsy "missing" state the canonical create refuses.
            await withBypassContext(() => db.execute(sql`update orgs set base_currency = '' where id = ${org.orgId}`));
            await assert.rejects(
              () => withBypassContext(() => createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null)),
              (error: unknown) => {
                assert.ok(error instanceof OrderDraftError);
                assert.match(error.message, /no base currency configured/);
                assert.match(error.message, /set one before creating orders/);
                return true;
              },
            );
            const count = (await withBypassContext(() => db.execute<{ n: string }>(sql`
              select count(*) as n from documents where org_id = ${org.orgId} and kind = 'purchase_order'`))).rows[0]!.n;
            assert.equal(Number(count), 0);
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
        
        test("createOrderDraft mints the draft in the org base currency", async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actor = await withBypassContext(() => createScratchUser(org.orgId, "Drafter", "order_drafter"));
            const draft = await withBypassContext(() => createOrderDraft(org.orgId, actor, "purchase_order", randomUUID(), null));
            const row = (await withBypassContext(() => db.execute<{ currency: string }>(sql`
              select currency from documents where id = ${draft.id} and org_id = ${org.orgId}`))).rows[0]!;
            assert.equal(row.currency, "CAD");
          } finally {
            await withBypassContext(() => dropScratchOrg(org.orgId));
          }
        });
  } },
  { label: "order billed unwind", register: async () => {
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const {
          createScratchOrg,
          createScratchUser,
          dropScratchOrg,
        } = await import("@openbooks/engine/src/testing/fixtures.ts");
        
        const { convertOrder } = await import("./order-cycle.ts");
        const { requestDocumentVoid } = await import("@openbooks/engine/src/ledger/document-void.ts");
        const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
        const { postDocument } = await import("@openbooks/engine/src/ledger/posting-document.ts");
        const { materializeCapture } = await import("@openbooks/engine/src/payables/ap-capture-service.ts");
        
        async function seedOrder(
          org: ScratchOrg,
          actorId: string,
          kind: "quote" | "sales_order",
          number: string,
          quantity = "10",
        ): Promise<string> {
          const id = randomUUID();
          const amount = String(Number(quantity) * 100);
          await withBypassContext(() => (db.execute(sql`
            insert into documents
              (id, org_id, kind, document_number, party_id, subsidiary_id,
               document_date, currency, status, subtotal, tax_total, total,
               created_by, updated_by)
            values (
              ${id}, ${org.orgId}, ${kind}, ${number}, ${org.customerId},
              ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${amount}, '0', ${amount},
              ${actorId}, ${actorId}
            )
          `)));
          await withBypassContext(() => (db.execute(sql`
            insert into document_lines
              (org_id, document_id, line_number, account_id, quantity,
               quantity_billed, quantity_fulfilled, unit_price, amount,
               tax_input_amount, tax_amount, created_by, updated_by)
            values (
              ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, ${quantity},
              '0', '0', '100', ${amount}, ${amount}, '0', ${actorId}, ${actorId}
            )
          `)));
          await withBypassContext(() => (db.execute(sql`
            update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${org.orgId}
          `)));
          return id;
        }
        
        // Seeding helpers run under withBypassContext at their call sites: importing
        // ./order-cycle.ts pulls in the web request-org resolver, which denies every
        // unscoped query under pooled RLS (bare setup dies with 42501). convertOrder
        // and requestDocumentVoid scope their own transactions internally and run
        // bare; the remaining engine calls (post, delete, materialize) rely on ambient
        // scope like the sibling order-convert-income suite, so they run under bypass.
        // Reads run in the scratch org's scope.
        async function billedOf(orgId: string, documentId: string): Promise<string> {
          return withOrgContext(orgId, async () => {
            const r = (await db.execute<{ quantity_billed: string }>(sql`
              select quantity_billed::text from document_lines
               where org_id = ${orgId} and document_id = ${documentId}
               order by line_number limit 1`));
            return r.rows[0]!.quantity_billed;
          });
        }
        
        async function approveAndPostInvoice(org: ScratchOrg, actorId: string, invoiceId: string): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`);
            await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
          });
        }
        
        test("voiding a converted invoice restores the sales order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const soId = await withBypassContext(() => seedOrder(org, actorId, "sales_order", "SO-BILLED-VOID-1"));
            const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
            assert.equal(await billedOf(org.orgId, soId), "10.00000000");
            await approveAndPostInvoice(org, actorId, converted.id);
            const voided = await requestDocumentVoid({
              documentId: converted.id, orgId: org.orgId, actorId,
              reason: "Void a mistakenly converted invoice", reversalDate: org.date, source: "api",
            });
            assert.equal(voided.status, "voided");
            assert.equal(await billedOf(org.orgId, soId), "0.00000000");
            const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
            assert.ok(again.id);
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
        
        test("deleting a draft converted invoice restores the sales order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const soId = await withBypassContext(() => seedOrder(org, actorId, "sales_order", "SO-BILLED-DELETE-1"));
            const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
            assert.equal(await billedOf(org.orgId, soId), "10.00000000");
            await withBypassContext(() => deleteDocument(converted.id, actorId, org.orgId, { reason: "Discard a mistakenly converted draft", allowedSubsidiaryIds: null }));
            assert.equal(await billedOf(org.orgId, soId), "0.00000000");
            const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
            assert.ok(again.id);
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
        
        async function seedServicePO(
          org: ScratchOrg,
          actorId: string,
          number: string,
          quantity = "10",
        ): Promise<{ poId: string; lineId: string }> {
          const amount = String(Number(quantity) * 100);
          const poId = randomUUID();
          const lineId = randomUUID();
          await withBypassContext(() => (db.execute(sql`
            insert into documents
              (id, org_id, kind, document_number, party_id, subsidiary_id,
               document_date, currency, status, subtotal, tax_total, total,
               created_by, updated_by)
            values (
              ${poId}, ${org.orgId}, 'purchase_order', ${number}, ${org.vendorId},
              ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${amount}, '0', ${amount},
              ${actorId}, ${actorId}
            )
          `)));
          await withBypassContext(() => (db.execute(sql`
            insert into document_lines
              (id, org_id, document_id, line_number, account_id, quantity,
               quantity_billed, quantity_fulfilled, unit_price, amount,
               tax_input_amount, tax_amount, created_by, updated_by)
            values (
              ${lineId}, ${org.orgId}, ${poId}, 1, ${org.accounts.adjustment}, ${quantity},
              '0', '0', '100', ${amount}, ${amount}, '0', ${actorId}, ${actorId}
            )
          `)));
          await withBypassContext(() => (db.execute(sql`
            update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
             where id = ${poId} and org_id = ${org.orgId}
          `)));
          await withBypassContext(() => (db.execute(sql`
            insert into vendor_roles (org_id, party_id, created_by, updated_by)
            values (${org.orgId}, ${org.vendorId}, ${actorId}, ${actorId})
          `)));
          return { poId, lineId };
        }
        
        async function seedCaptureItem(
          org: ScratchOrg,
          actorId: string,
          input: {
            kind: "vendor_bill" | "vendor_credit";
            poId: string;
            poLineId: string;
            quantity: string;
            invoiceNumber: string;
          },
        ): Promise<string> {
          const amount = String(Number(input.quantity) * 100);
          const folderId = randomUUID();
          await withBypassContext(() => (db.execute(sql`
            insert into folders (id, org_id, name, created_by, updated_by)
            values (${folderId}, ${org.orgId}, 'AP capture', ${actorId}, ${actorId})
          `)));
          const fileId = randomUUID();
          await withBypassContext(() => (db.execute(sql`
            insert into files (id, org_id, folder_id, name, content_type, size_bytes, created_by, updated_by)
            values (${fileId}, ${org.orgId}, ${folderId}, 'capture.pdf', 'application/pdf', 10, ${actorId}, ${actorId})
          `)));
          const itemId = randomUUID();
          const normalized = {
            vendorName: "Acme Vendor",
            vendorTaxId: null,
            invoiceNumber: input.invoiceNumber,
            invoiceDate: org.date,
            dueDate: null,
            purchaseOrderNumber: null,
            currency: "CAD",
            subtotal: amount,
            taxTotal: "0",
            total: amount,
            memo: null,
            lines: [{
              description: "Services",
              productCode: null,
              quantity: input.quantity,
              unit: null,
              unitPrice: "100",
              amount,
              taxAmount: "0",
              accountId: org.accounts.adjustment,
              itemId: null,
              purchaseOrderLineId: input.poLineId,
              confidence: null,
            }],
          };
          await withBypassContext(() => (db.execute(sql`
            insert into ap_capture_items
              (id, org_id, file_id, status, original_filename, content_hash, document_kind,
               normalized, vendor_candidate_id, purchase_order_id, created_by, updated_by)
            values (${itemId}, ${org.orgId}, ${fileId}, 'ready', 'capture.pdf',
              ${randomUUID().replace(/-/g, "")}, ${input.kind}, ${JSON.stringify(normalized)}::jsonb,
              ${org.vendorId}, ${input.poId}, ${actorId}, ${actorId})
          `)));
          return itemId;
        }
        
        async function approveAndPostBill(org: ScratchOrg, billId: string): Promise<void> {
          await withBypassContext(async () => {
            await db.execute(sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`);
            await postDocument(billId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
          });
        }
        
        test("voiding a converted sales order restores the quote billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const quoteId = await withBypassContext(() => seedOrder(org, actorId, "quote", "QUOTE-BILLED-VOID-1", "5"));
            const converted = await convertOrder(org.orgId, actorId, quoteId, "sales_order");
            assert.equal(await billedOf(org.orgId, quoteId), "5.00000000");
            const voided = await requestDocumentVoid({
              documentId: converted.id, orgId: org.orgId, actorId,
              reason: "Cancel a mistakenly converted order", reversalDate: org.date, source: "api",
            });
            assert.equal(voided.status, "voided");
            assert.equal(await billedOf(org.orgId, quoteId), "0.00000000");
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
        
        test("deleting a draft captured bill restores the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const { poId, lineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-DELETE-1"));
            const itemId = await withBypassContext(() => seedCaptureItem(org, actorId, {
              kind: "vendor_bill", poId, poLineId: lineId, quantity: "10", invoiceNumber: "AP-DELETE-1",
            }));
            const materialized = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: itemId, actorId, allowedSubsidiaryIds: null }));
            assert.equal(await billedOf(org.orgId, poId), "10.00000000");
            await withBypassContext(() => deleteDocument(materialized.documentId, actorId, org.orgId, { reason: "Discard a mistakenly captured draft", allowedSubsidiaryIds: null }));
            assert.equal(await billedOf(org.orgId, poId), "0.00000000");
            const released = await withOrgContext(org.orgId, async () => (await db.execute<{ status: string; document_id: string | null }>(sql`
              select status, document_id from ap_capture_items where id = ${itemId} and org_id = ${org.orgId}`)).rows[0]!);
            assert.equal(released.status, "needs_review");
            assert.equal(released.document_id, null);
            const again = await convertOrder(org.orgId, actorId, poId, "vendor_bill");
            assert.ok(again.id, "the received remainder is billable again");
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
        
        test("voiding a captured bill restores the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const { poId, lineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-VOID-1"));
            const itemId = await withBypassContext(() => seedCaptureItem(org, actorId, {
              kind: "vendor_bill", poId, poLineId: lineId, quantity: "10", invoiceNumber: "AP-VOID-1",
            }));
            const materialized = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: itemId, actorId, allowedSubsidiaryIds: null }));
            await approveAndPostBill(org, materialized.documentId);
            const voided = await requestDocumentVoid({
              documentId: materialized.documentId, orgId: org.orgId, actorId,
              reason: "Void a mistakenly captured bill", reversalDate: org.date, source: "api",
            });
            assert.equal(voided.status, "voided");
            assert.equal(await billedOf(org.orgId, poId), "0.00000000");
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
        
        test("voiding a captured vendor credit re-consumes the purchase order billed quantity", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Billed Unwind", "admin"));
            const { poId, lineId: poLineId } = await withBypassContext(() => seedServicePO(org, actorId, "PO-BILLED-CREDIT-1"));
            const billItem = await withBypassContext(() => seedCaptureItem(org, actorId, {
              kind: "vendor_bill", poId, poLineId, quantity: "10", invoiceNumber: "AP-CREDIT-BILL-1",
            }));
            const bill = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: billItem, actorId, allowedSubsidiaryIds: null }));
            await approveAndPostBill(org, bill.documentId);
            assert.equal(await billedOf(org.orgId, poId), "10.00000000");
            const creditItem = await withBypassContext(() => seedCaptureItem(org, actorId, {
              kind: "vendor_credit", poId, poLineId, quantity: "4", invoiceNumber: "AP-CREDIT-1",
            }));
            const credit = await withBypassContext(() => materializeCapture({ orgId: org.orgId, captureItemId: creditItem, actorId, allowedSubsidiaryIds: null }));
            assert.equal(await billedOf(org.orgId, poId), "6.00000000");
            await approveAndPostBill(org, credit.documentId);
            const voided = await requestDocumentVoid({
              documentId: credit.documentId, orgId: org.orgId, actorId,
              reason: "Void a mistakenly captured credit", reversalDate: org.date, source: "api",
            });
            assert.equal(voided.status, "voided");
            assert.equal(await billedOf(org.orgId, poId), "10.00000000");
            // The unwind must not open headroom for a second billing of the same units.
            await assert.rejects(
              convertOrder(org.orgId, actorId, poId, "vendor_bill"),
              /fully converted|do not cover|already/,
            );
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
  } },
  { label: "order convert release concurrency", register: async () => {
        const { sql } = await import("drizzle-orm");
        const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
        const {
          createScratchOrg,
          createScratchUser,
          dropScratchOrg,
        } = await import("@openbooks/engine/src/testing/fixtures.ts");
        
        const { convertOrder } = await import("./order-cycle.ts");
        const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");
        
        // F26: conversion vs draft-child deletion must take source-order locks in the
        // same header-before-lines order. convertOrder (web/lib/order-cycle.ts,
        // source header FOR UPDATE then source lines FOR UPDATE OF dl) is
        // header-first; releaseConvertedOrderQuantities must match it.
        //
        // Evidence shape, stated honestly: the converter side below replays
        // convertOrder's exact lock-acquisition order (same tables, same predicates,
        // same FOR UPDATE forms) rather than the full conversion, because a real
        // conversion cannot be paused between its header lock and its line locks —
        // and pausing there is precisely what stages the cycle. The deleter side is
        // the unmodified production path: real deleteDocument into the real
        // releaseConvertedOrderQuantities. The probe waits until the deleter is
        // observably blocked on the converter-held header (pg_blocking_pids — not a
        // sleep) and only then attempts the source line locks. Inverted order
        // deadlocks here with SQLSTATE 40P01; canonical order serializes. The real
        // convertOrder is exercised after the race for both safe outcomes: a
        // successful re-conversion of the released remainder, then an explicitly
        // classified no-remainder refusal on the second attempt.
        
        const PROBE_ROLLBACK = "F26-PROBE-ROLLBACK";
        
        function describeRejection(error: unknown): string {
          const parts: string[] = [];
          let cur = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
          const seen = new Set<unknown>();
          while (cur && (typeof cur === "object" || typeof cur === "function") && !seen.has(cur) && parts.length < 6) {
            seen.add(cur);
            parts.push(`[${String(cur.code ?? "?")}] ${String(cur.message ?? cur)}`);
            cur = (cur.cause ?? null) as typeof cur;
          }
          if (parts.length === 0) parts.push(String(error));
          return parts.join(" <- ");
        }
        
        function isDeadlock(error: unknown): boolean {
          return /40P01|deadlock detected/i.test(describeRejection(error));
        }
        
        async function seedOrder(org: ScratchOrg, actorId: string, number: string): Promise<string> {
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
              (org_id, document_id, line_number, account_id, quantity,
               quantity_billed, quantity_fulfilled, unit_price, amount,
               tax_input_amount, tax_amount, created_by, updated_by)
            values (
              ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '10',
              '0', '0', '100', '1000', '1000', '0', ${actorId}, ${actorId}
            )
          `);
          await db.execute(sql`
            update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${org.orgId}
          `);
          return id;
        }
        
        async function billedOf(orgId: string, documentId: string): Promise<string> {
          return withOrgContext(orgId, async () => {
            const r = (await db.execute<{ quantity_billed: string }>(sql`
              select quantity_billed::text from document_lines
               where org_id = ${orgId} and document_id = ${documentId}
               order by line_number limit 1`));
            return r.rows[0]!.quantity_billed;
          });
        }
        
        test("conversion and draft-child deletion serialize on source-order locks (no 40P01)", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          const org = await withBypassContext(() => createScratchOrg());
          try {
            const actorId = await withBypassContext(() => createScratchUser(org.orgId, "F26 Concurrency", "admin"));
            const tag = randomUUID().slice(0, 8);
            const soId = await withBypassContext(() => seedOrder(org, actorId, `SO-F26-${tag}`));
            const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
            assert.equal(await billedOf(org.orgId, soId), "10.00000000");
        
            let releaseHeaderHeld!: () => void;
            const headerHeld = new Promise<void>((resolve) => { releaseHeaderHeld = resolve; });
            let releaseLines!: () => void;
            const linesGate = new Promise<void>((resolve) => { releaseLines = resolve; });
            let converterPid = 0;
        
            // Converter lock probe: takes the source header lock first, exactly as
            // convertOrder does (documents FOR UPDATE before document_lines
            // FOR UPDATE OF dl), then waits for the deleter to be observably
            // blocked before touching the source lines. Rolls itself back with a
            // sentinel once the line locks are taken.
            const converter = withBypassContext(() => db.transaction(async (tx) => {
              try {
                await tx.execute(sql`set local lock_timeout = '15s'`);
                converterPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
                await tx.execute(sql`
                  select id from documents where id = ${soId} and org_id = ${org.orgId} for update
                `);
                releaseHeaderHeld();
                await linesGate;
                await tx.execute(sql`
                  select dl.id from document_lines dl
                   where dl.document_id = ${soId} and dl.org_id = ${org.orgId}
                   order by dl.line_number
                   for update of dl
                `);
              } finally {
                // Never leave the probe parked on the gate holding the source
                // header, whatever fails above.
                try { releaseLines(); } catch { /* gate already released */ }
              }
              throw new Error(PROBE_ROLLBACK);
            }));
            // Attach a settlement handler promptly so a probe failure before the
            // race below can never surface as an unhandled rejection.
            void converter.then(() => {}, () => {});
            let releaser: Promise<{ documentId: string }> | null = null;
            try {
              await Promise.race([
                headerHeld,
                converter.then(
                  () => { throw new Error("converter probe exited before holding the source header"); },
                  (err) => { throw new Error(`converter probe failed before holding the source header: ${describeRejection(err)}`); },
                ),
                new Promise((_, reject) => setTimeout(
                  () => reject(new Error("timed out waiting for the converter to hold the source header")),
                  15_000,
                )),
              ]);
              // The REAL production delete path (deleteDocument ->
              // releaseConvertedOrderQuantities) starts only after the converter
              // holds the source header.
              releaser = withBypassContext(() => deleteDocument(converted.id, actorId, org.orgId, {
                reason: `F26 concurrency probe ${tag}`,
                allowedSubsidiaryIds: null,
              }));
              void releaser.then(() => {}, () => {});
        
              // Blocking probe: wait until a live backend is blocked BY the
              // converter. The converter holds only the source header at this
              // point, so the blocked waiter must be queued on that header row.
              // This schedules the converter's line attempt deterministically.
              let blockedObserved = false;
              try {
                const deadline = Date.now() + 15_000;
                while (Date.now() < deadline) {
                  const found = (await db.execute<{ pid: number }>(sql`
                    select pid from pg_stat_activity
                     where datname = current_database()
                       and state = 'active'
                       and pid <> pg_backend_pid()
                       and ${converterPid} = any(pg_blocking_pids(pid))
                     limit 1
                  `)).rows[0];
                  if (found) { blockedObserved = true; break; }
                  if ((await Promise.race([
                    releaser.then(() => "done" as const, () => "done" as const),
                    new Promise((resolve) => setTimeout(() => resolve("wait" as const), 25)),
                  ])) === "done") break;
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
              } finally {
                // Always release the converter's line attempt: it either deadlocks
                // (pre-fix, the finding) or takes the free line locks (post-fix).
                // Never leave it parked on the gate holding the source header.
                releaseLines();
              }
              assert.ok(blockedObserved, "deleter must queue on the converter-held source header before lines are attempted");
        
              const [converterOutcome, releaserOutcome] = await Promise.allSettled([converter, releaser]);
              const problems: string[] = [];
              if (converterOutcome.status === "rejected" && isDeadlock(converterOutcome.reason)) {
                problems.push(`converter deadlocked: ${describeRejection(converterOutcome.reason)}`);
              }
              if (releaserOutcome.status === "rejected" && isDeadlock(releaserOutcome.reason)) {
                problems.push(`deleter deadlocked: ${describeRejection(releaserOutcome.reason)}`);
              }
              assert.deepEqual(problems, [], "conversion vs draft deletion must serialize without a 40P01 deadlock");
              assert.equal(
                converterOutcome.status,
                "rejected",
                "converter probe must roll itself back after taking the line locks",
              );
              assert.match(
                String((converterOutcome as PromiseRejectedResult).reason?.message ?? converterOutcome),
                new RegExp(PROBE_ROLLBACK),
                "converter probe must end in its sentinel rollback, not a lock error",
              );
              assert.equal(
                releaserOutcome.status,
                "fulfilled",
                `deleter must complete once the converter releases the header; got: ${
                  releaserOutcome.status === "rejected" ? describeRejection(releaserOutcome.reason) : "fulfilled"
                }`,
              );
              assert.equal(await billedOf(org.orgId, soId), "0.00000000");
              // Both real-conversion safe outcomes: the released remainder
              // converts again, and a further conversion is refused as fully
              // converted (no-remainder refusal, explicitly classified).
              const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
              assert.ok(again.id, "the released remainder is convertible again");
              await assert.rejects(
                convertOrder(org.orgId, actorId, soId, "customer_invoice"),
                /fully converted/,
                "a further conversion must be refused as fully converted",
              );
            } finally {
              // Settle both tenants before the scratch org is dropped: no open
              // transaction may still hold source locks when cleanup runs, on any
              // path including timeouts and assertion failures.
              try { releaseLines(); } catch { /* gate already released */ }
              await Promise.allSettled([converter, releaser ?? Promise.resolve()]);
            }
          } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
        });
  } },
] as const;

for(const row of consolidatedRows) await row.register();
