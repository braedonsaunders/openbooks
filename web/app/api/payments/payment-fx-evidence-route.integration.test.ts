import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { openItemsForParty } from "@openbooks/engine/payments/payment-queries";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";

const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __payFxRouteAuth: state });
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
            "export async function getAuthz(){return {user:globalThis.__payFxRouteAuth.user,allowedSubsidiaryIds:null,permissions:['ap.pay','ar.pay']}};export function can(authz,permission){return authz.permissions.includes(permission)};export function guardSubsidiaryScope(){return null};export async function guardPermission(){return {user:globalThis.__payFxRouteAuth.user,allowedSubsidiaryIds:null,permissions:['ap.pay','ar.pay']}}",
          ),
      };
    }
    return next(specifier, context);
  },
});

const { POST: createPayment } = await import("./route.ts");
const { PATCH: patchPayment } = await import("./[id]/route.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Public CREATE/PATCH with a manual settlement-rate election and no global
 * rate rows anywhere: the manual election replaces the ordinary
 * organization exchange-rate lookup on both routes, so neither route may
 * resolve a global basis before the locked draft save records it.
 */
test(
  "public create and patch record a manual payment rate with zero global rates",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "AR Clerk", "admin");
      state.user = { orgId: org.orgId, id: actorId };
      await db.execute(sql`
      update orgs set settings = settings || '{"features":{"banking":true,"multiCurrency":true}}'::jsonb
       where id = ${org.orgId}`);
      await db.execute(sql`
      insert into currencies (code, name, minor_units) values ('EUR', 'Euro', 2)
      on conflict (code) do nothing`);
      await db.execute(sql`
      insert into customer_roles (org_id, party_id, ar_account_id, is_active, created_by)
      values (${org.orgId}, ${org.customerId}, ${org.accounts.ar}, true, ${actorId})
      on conflict (party_id) do nothing`);

      // EUR 1000 invoice carried at a stated document rate of 1.10 — a
      // document rate, never an fx_rates row.
      const invoiceId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`INV-${randomUUID().slice(0, 8)}`},
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'EUR', '1.1', '1000', '0', '1000', ${actorId})`);
      await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '1000', '1000', '0', '0')`);
      await db.execute(
        sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`,
      );
      await postDocument(invoiceId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const item = (await openItemsForParty(org.customerId, "ar", org.orgId)).find(
        (candidate) => candidate.documentId === invoiceId,
      );
      assert.ok(item, "the invoice is an open item");

      const allocation = {
        openLineId: item.lineId,
        sourceTransactionAmount: "1000",
        targetTransactionAmount: "1000",
        settlementRate: "1",
        settlementRateSource: "same_currency",
        settlementRateReference: "same transaction currency",
      };
      const explicitFx = (rate: string) => ({
        rate,
        source: "Bank confirmation",
        reason: "Rate evidenced on the bank's receipt confirmation",
        fromCurrency: "EUR",
        toCurrency: "CAD",
        rateDate: org.date,
      });

      const created = (await createPayment(
        new Request("http://openbooks.test/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
          body: JSON.stringify({
            kind: "customer_payment",
            partyId: org.customerId,
            bankAccountId: org.accounts.bank,
            currency: "EUR",
            documentDate: org.date,
            allocations: [allocation],
            explicitFx: explicitFx("1.115"),
          }),
        }) as never,
      )) as unknown as Response;
      assert.equal(created.status, 201, await created.clone().text());
      const draft = (await created.json()) as {
        doc: {
          id: string;
          updated_at: string;
          fx_rate: string;
          document_fx_rate_evidence: { rate: string } | null;
        };
      };
      assert.equal(
        draft.doc.document_fx_rate_evidence?.rate,
        "1.115",
        "create records the manual election",
      );
      assert.equal(draft.doc.fx_rate, "1.1150000000");

      const patched = (await patchPayment(
        new Request(`http://openbooks.test/api/payments/${draft.doc.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedUpdatedAt: draft.doc.updated_at,
            explicitFx: explicitFx("1.12"),
          }),
        }) as never,
        { params: Promise.resolve({ id: draft.doc.id }) } as never,
      )) as unknown as Response;
      assert.equal(patched.status, 200, await patched.clone().text());
      const updated = (await patched.json()) as {
        doc: {
          updated_at: string;
          fx_rate: string;
          document_fx_rate_evidence: { rate: string } | null;
        };
      };
      assert.equal(
        updated.doc.document_fx_rate_evidence?.rate,
        "1.12",
        "patch replaces the recorded rate",
      );
      assert.equal(updated.doc.fx_rate, "1.1200000000");

      const cleared = (await patchPayment(
        new Request(`http://openbooks.test/api/payments/${draft.doc.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedUpdatedAt: updated.doc.updated_at, explicitFx: null }),
        }) as never,
        { params: Promise.resolve({ id: draft.doc.id }) } as never,
      )) as unknown as Response;
      assert.equal(cleared.status, 200, await cleared.clone().text());
      const clearedDoc = (await cleared.json()) as {
        doc: { fx_rate: string; document_fx_rate_evidence: { rate: string } | null };
      };
      assert.equal(
        clearedDoc.doc.document_fx_rate_evidence,
        null,
        "patch null clears the recorded rate",
      );
      assert.equal(
        clearedDoc.doc.fx_rate,
        "1.0000000000",
        "clearing returns the header rate to unset",
      );

      const fxRows = await db.execute<{ count: string }>(
        sql`
      select count(*)::text as count from fx_rates where org_id = ${org.orgId}`,
        "objects",
      );
      assert.equal(fxRows[0]!.count, "0", "no global rate row was seeded, resolved or invented");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
