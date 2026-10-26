import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, withBypass } from "@openbooks/engine/platform/db";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import {
  assembleBatchList,
  loadStatementBatchParties,
  listStatementCustomerCurrencies,
  partyOverdueMap,
} from "./statement-batch.ts";

/**
 * Batched statements resolve recipients from live open items: a posted
 * overdue invoice lands its customer in the batch with the billing
 * contact's mailbox and the overdue figure, while a customer with no
 * mailbox anywhere is an exclusion, never a send.
 */
async function seedInvoice(
  org: ScratchOrg,
  opts: { customerId: string; documentNumber: string; dueDate: string; total?: string },
): Promise<string> {
  const userId = await createScratchUser(org.orgId, "Statement Batch Tester", "accountant");
  const invoiceId = randomUUID();
  const total = opts.total ?? "100";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${opts.documentNumber},
            ${org.subsidiaryId}, ${opts.customerId}, ${org.date}, ${opts.dueDate},
            'CAD', '1', ${total}, '0', ${total}, ${userId})
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${total}, ${total}, '0', '0')
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}
  `);
  await postDocument(invoiceId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  return invoiceId;
}

test("overdue balances, billing contacts, and no-email exclusions resolve from live postings", async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await withOrg(org.orgId, async () => {
      await db.execute(
        sql`update parties set email = 'office@acme.test' where id = ${org.customerId} and org_id = ${org.orgId}`,
      );
      await db.execute(sql`
        insert into contacts (org_id, party_id, name, role, email, is_primary, is_active)
        values (${org.orgId}, ${org.customerId}, 'Acme Billing', 'Billing', 'ap@acme.test', false, true)
      `);
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, currency)
        values (${org.orgId}, ${org.customerId}, 'CAD')
        on conflict (party_id) do update set currency = excluded.currency
      `);
      const day = (offset: number): string => {
        const d = new Date(`${org.date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + offset);
        return d.toISOString().slice(0, 10);
      };
      const asOf = org.date;
      await seedInvoice(org, {
        customerId: org.customerId,
        documentNumber: "INV-OVERDUE",
        dueDate: day(-30),
      });

      const silentId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${silentId}, ${org.orgId}, 'customer', 'Silent Customer', ${org.subsidiaryId})
      `);
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, currency) values (${org.orgId}, ${silentId}, 'CAD')
      `);
      await seedInvoice(org, {
        customerId: silentId,
        documentNumber: "INV-CURRENT",
        dueDate: day(60),
      });
      const overdue = await partyOverdueMap(org.orgId, asOf, {});
      assert.equal(Number(overdue.get(org.customerId)), 100);
      assert.ok(!overdue.has(silentId), "a current invoice is not overdue");

      const parties = await loadStatementBatchParties(org.orgId, [org.customerId, silentId]);
      assert.equal(parties.get(org.customerId)?.currency, "CAD");
      assert.equal(parties.get(org.customerId)?.contacts.length, 1);

      const { recipients, excluded } = assembleBatchList({
        balances: [
          { id: org.customerId, display_name: "Acme Customer", balance: "100.0000" },
          { id: silentId, display_name: "Silent Customer", balance: "100.0000" },
        ],
        parties,
        overdueByParty: overdue,
        filters: { to: asOf },
        allowedSubsidiaryIds: null,
      });
      assert.equal(recipients.length, 1);
      assert.equal(recipients[0]!.partyId, org.customerId);
      assert.equal(recipients[0]!.toEmail, "ap@acme.test");
      assert.equal(Number(recipients[0]!.overdue), 100);
      assert.equal(excluded.length, 1);
      assert.equal(excluded[0]!.partyId, silentId);
      assert.equal(excluded[0]!.reason, "no-email");

      const overdueOnly = assembleBatchList({
        balances: [
          { id: org.customerId, display_name: "Acme Customer", balance: "100.0000" },
          { id: silentId, display_name: "Silent Customer", balance: "100.0000" },
        ],
        parties,
        overdueByParty: overdue,
        filters: { to: asOf, overdueOnly: true },
        allowedSubsidiaryIds: null,
      });
      assert.deepEqual(
        overdueOnly.recipients.map((r) => r.partyId),
        [org.customerId],
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("statement currency filters include only customers in the caller’s subsidiary scope", async () => {
  const org = await withBypass(() => createScratchOrg());
  const otherSubsidiaryId = randomUUID();
  const otherCustomerId = randomUUID();
  try {
    await withOrg(org.orgId, async () => {
      await db.execute(sql`
        update parties set subsidiary_id = ${org.subsidiaryId}
         where org_id = ${org.orgId} and id = ${org.customerId}
      `);
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, currency)
        values (${org.orgId}, ${org.customerId}, 'CAD')
        on conflict (party_id) do update set currency = excluded.currency
      `);
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other subsidiary', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)
      `);
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, subsidiary_id)
        values (${otherCustomerId}, ${org.orgId}, 'customer', 'Other subsidiary customer', ${otherSubsidiaryId})
      `);
      await db.execute(sql`
        insert into customer_roles (org_id, party_id, currency)
        values (${org.orgId}, ${otherCustomerId}, 'JPY')
      `);

      assert.deepEqual(
        await listStatementCustomerCurrencies(org.orgId, new Set([org.subsidiaryId])),
        ["CAD"],
      );
      assert.deepEqual(
        await listStatementCustomerCurrencies(org.orgId, new Set([otherSubsidiaryId])),
        ["JPY"],
      );
      assert.deepEqual(await listStatementCustomerCurrencies(org.orgId, null), ["CAD", "JPY"]);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
