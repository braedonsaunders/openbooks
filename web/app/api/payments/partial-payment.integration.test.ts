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

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __payPartialAuth: state });
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
            "export async function getAuthz(){return {user:globalThis.__payPartialAuth.user,allowedSubsidiaryIds:null,permissions:['ap.pay']}};export function can(){return true};export function guardSubsidiaryScope(){return null};export async function guardPermission(){return {user:globalThis.__payPartialAuth.user,allowedSubsidiaryIds:null,permissions:['ap.pay']}}",
          ),
      };
    }
    return next(specifier, context);
  },
});

const { POST: createPayment } = await import("./route.ts");
const { POST: postPayment } = await import("./post-with-applications/route.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function seedOpenBill(
  org: Awaited<ReturnType<typeof createScratchOrg>>,
  actorId: string,
  amount: string,
): Promise<{ billId: string; openLineId: string }> {
  await db.execute(sql`
    insert into vendor_roles (org_id, party_id, ap_account_id, is_active, created_by)
    values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, true, ${actorId})
    on conflict (party_id) do nothing`);
  const billId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${billId}, ${org.orgId}, 'vendor_bill', 'draft', 'BILL-PARTIAL-1', ${org.subsidiaryId},
            ${org.vendorId}, ${org.date}, 'CAD', '1', ${amount}, '0', ${amount}, ${actorId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${billId}, 1, ${org.accounts.cogs}, '1', ${amount}, ${amount}, '0', null)`);
  await db.execute(
    sql`update documents set status = 'approved' where id = ${billId} and org_id = ${org.orgId}`,
  );
  await postDocument(billId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  const openLineId = (
    await db.execute<{ id: string }>(
      sql`
    select jl.id from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where je.source_document_id = ${billId} and je.status = 'posted' and jl.is_open_item
  `,
      "objects",
    )
  )[0]!.id;
  return { billId, openLineId };
}

function partialAllocation(openLineId: string, amount: string) {
  return {
    openLineId,
    sourceTransactionAmount: amount,
    targetTransactionAmount: amount,
    settlementRate: "1",
    settlementRateSource: "same_currency",
    settlementRateReference: "same transaction currency",
  };
}

/**
 * A partial vendor payment posts the entered amount and leaves the bill
 * open with the remainder: 3,500 applied against an 8,814.00 bill leaves
 * 5,314.00 still open to pay.
 */
test("a partial vendor payment posts and leaves the remainder open", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "AP Clerk", "admin");
    state.user = { orgId: org.orgId, id: actorId };
    const { openLineId } = await seedOpenBill(org, actorId, "8814.00");

    const created = (await createPayment(
      new Request("http://openbooks.test/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
        body: JSON.stringify({
          kind: "vendor_payment",
          partyId: org.vendorId,
          bankAccountId: org.accounts.bank,
          documentDate: org.date,
          allocations: [partialAllocation(openLineId, "3500")],
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
          allocations: [partialAllocation(openLineId, "3500")],
        }),
      }) as never,
    )) as unknown as Response;
    assert.equal(posted.status, 200, await posted.clone().text());

    const payment = (
      await db.execute<{ total: string; status: string }>(
        sql`
      select total::text as total, status from documents where id = ${draft.doc.id} and org_id = ${org.orgId}
    `,
        "objects",
      )
    )[0]!;
    assert.equal(toUnits(payment.total), toUnits("3500"), "the payment carries the partial amount");
    assert.equal(payment.status, "posted", "the partial payment posts");

    const items = await openItemsForParty(org.vendorId, "ap", org.orgId);
    const bill = items.find((item) => item.lineId === openLineId);
    assert.ok(bill, "the bill is still open after a partial payment");
    assert.equal(
      toUnits(bill.transactionOpen),
      toUnits("5314.00"),
      "the remainder stays open to pay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
