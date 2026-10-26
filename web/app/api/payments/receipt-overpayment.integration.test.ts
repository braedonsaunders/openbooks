import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { ensurePartyRoleRow } from "../../../lib/party-roles";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __receiptOverpaymentAuth: state });
registerHooks({
  resolve(specifier, context, next) {
    if (
      (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/payments/")) ||
      specifier === "@/lib/authz"
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function getAuthz(){return {user:globalThis.__receiptOverpaymentAuth.user,allowedSubsidiaryIds:null,permissions:['ar.receive']}};export function can(){return true};export function guardSubsidiaryScope(){return null};export async function guardPermission(){return {user:globalThis.__receiptOverpaymentAuth.user,allowedSubsidiaryIds:null,permissions:['ar.receive']}}",
          ),
      };
    }
    return next(specifier, context);
  },
});

const { POST: createPayment } = await import("./route.ts");
const { POST: postPayment } = await import("./post-with-applications/route.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Cash received beyond what a receipt applies is never dropped: an operator
 * who records 198.00 received against a 99.00 invoice posts a 198.00 receipt
 * whose 99.00 excess stays open as the customer's unapplied credit.
 */
test(
  "a receipt larger than its applications keeps the excess on account",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "AR Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      await ensurePartyRoleRow(db, {
        orgId: org.orgId,
        partyId: org.customerId,
        kind: "customer",
        actorId,
      });
      const invoiceId = randomUUID();
      await db.execute(sql`
      insert into documents (id, org_id, kind, status, document_number, subsidiary_id, party_id,
                             document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-OVERPAY-1', ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'CAD', '1', '99', '0', '99', ${actorId})`);
      await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '99', '99', '0')`);
      await db.execute(
        sql`update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`,
      );
      await postDocument(invoiceId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const openLineId = (
        await db.execute<{ id: string }>(
          sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where je.source_document_id = ${invoiceId} and je.status = 'posted' and jl.is_open_item`,
          "objects",
        )
      )[0]!.id;
      const allocation = {
        openLineId,
        sourceTransactionAmount: "99",
        targetTransactionAmount: "99",
        settlementRate: "1",
        settlementRateSource: "same_currency",
        settlementRateReference: "same transaction currency",
      };

      const created = (await createPayment(
        new Request("http://openbooks.test/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
          body: JSON.stringify({
            kind: "customer_payment",
            partyId: org.customerId,
            bankAccountId: org.accounts.bank,
            documentDate: org.date,
            allocations: [allocation],
            onAccountAmount: "99",
          }),
        }) as never,
      )) as unknown as Response;
      assert.equal(created.status, 201, await created.clone().text());
      const draft = (await created.json()) as { doc: { id: string; updated_at: string } };

      const posted = (await postPayment(
        new Request("http://openbooks.test/api/payments/post-with-applications", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentId: draft.doc.id,
            expectedUpdatedAt: draft.doc.updated_at,
            allocations: [allocation],
          }),
        }) as never,
      )) as unknown as Response;
      assert.equal(posted.status, 200, await posted.clone().text());

      const receipt = (
        await db.execute<{ total: string; status: string; on_account: string | null }>(
          sql`
      select total::text as total, status, custom->>'onAccountAmount' as on_account
        from documents where id = ${draft.doc.id} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(receipt.status, "posted");
      assert.equal(
        toUnits(receipt.total),
        toUnits("198"),
        "the receipt carries the full amount received",
      );
      assert.equal(toUnits(receipt.on_account ?? "0"), toUnits("99"));
      const bank = (
        await db.execute<{ amount: string }>(
          sql`
      select coalesce(sum(jl.amount), 0)::text as amount from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where je.source_document_id = ${draft.doc.id} and jl.account_id = ${org.accounts.bank}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        toUnits(bank.amount),
        toUnits("198"),
        "the bank is debited the full amount received",
      );

      const items = await openItemsForParty(org.customerId, "ar", org.orgId);
      assert.equal(
        items.find((item) => item.lineId === openLineId),
        undefined,
        "the invoice is settled",
      );
      // The receipt's unapplied 99 stays open on it as the customer's credit.
      const open = (
        await db.execute<{ open_balance: string | null }>(
          sql`
      select open_balance::text as open_balance from documents where id = ${draft.doc.id} and org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!;
      const unapplied = toUnits(open.open_balance ?? "0");
      assert.equal(
        unapplied < 0n ? -unapplied : unapplied,
        toUnits("99"),
        "the excess stays open as an unapplied credit",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
