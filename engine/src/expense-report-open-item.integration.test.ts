import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import {
  createPaymentDocument,
  openItemsForParty,
  postPaymentWithApplications,
  sameCurrencyAllocation,
  updateDraftPayment,
} from "./payments.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Regression: every industry preset wires the employee-reimbursements control
 * (settings.controlAccounts.employeePayable) to a liability_current_other
 * account. Open-item capability must follow from that control DESIGNATION, not
 * only from the receivable/payable account types — otherwise an expense
 * report's control line is never an open item and the reimbursement can never
 * be applied through the payment engine. Surfaced by the differential-corpus
 * harness (engine/src/harness/differential).
 */
test(
  "expense report on a liability_current_other employee-payable control is an open item and settles",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // The preset shape: Employee Payable is NOT a liability_payable account.
      const employeePayable = randomUUID();
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${employeePayable}, ${org.orgId}, '2400', 'Employee Payable', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,employeePayable}', to_jsonb(${employeePayable}::text), true)
         where id = ${org.orgId}`);

      const employeeId = randomUUID();
      await db.execute(sql`
        insert into parties (id, org_id, kind, display_name, is_active, custom)
        values (${employeeId}, ${org.orgId}, 'employee', 'Riley Fieldworker', true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${org.orgId}, ${employeeId})`);

      const actorId = randomUUID();
      await db.transaction(async (tx) => {
        const role = (await tx.execute<{ id: string }>(sql`
          insert into app_roles (org_id, key, name, is_built_in, permissions)
          values (${org.orgId}, 'accountant', 'accountant', false, '[]'::jsonb)
          on conflict (org_id, key) do update set updated_at = now()
          returning id`));
        await tx.execute(sql`
          insert into users (id, org_id, email, name, password_hash, is_active)
          values (${actorId}, ${org.orgId}, ${`clerk-${actorId.slice(0, 8)}@test.local`}, 'AP Clerk', 'x', true)`);
        await tx.execute(sql`
          insert into role_assignments (org_id, user_id, role_id)
          values (${org.orgId}, ${actorId}, ${role.rows[0]!.id})`);
      });

      const deps: PostingDeps = {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank, employeePayable },
      };

      const documentId = randomUUID();
      await db.execute(sql`
        insert into documents (id, org_id, kind, status, document_number, document_date, party_id, subsidiary_id, currency, subtotal, tax_total, total, custom)
        values (${documentId}, ${org.orgId}, 'expense_report', 'approved', 'EXP-OPENITEM-1', ${org.date}, ${employeeId}, ${org.subsidiaryId}, 'CAD', '123.45', '0', '123.45', '{}'::jsonb)`);
      await db.execute(sql`
        insert into document_lines (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount)
        values (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${org.accounts.cogs}, 'Travel & per diem', '1', '123.45', '123.45', '0')`);

      const entryId = await postDocument(documentId, deps);

      const control = (await db.execute<{ id: string; amount: string; is_open_item: boolean }>(sql`
        select id, amount::text, is_open_item from journal_lines
         where entry_id = ${entryId} and account_id = ${employeePayable}`));
      assert.equal(control.rows.length, 1, "expense report must credit the configured employee-payable control");
      assert.equal(control.rows[0]!.is_open_item, true, "control line must be an open item despite its account type");

      const open = await openItemsForParty(employeeId, "ap");
      assert.equal(open.length, 1);
      assert.equal(open[0]!.open, "123.4500");

      // Settle it end-to-end through the payment-application engine.
      const payment = await createPaymentDocument({
        orgId: org.orgId,
        kind: "vendor_payment",
        createdBy: actorId,
        partyId: employeeId,
        bankAccountId: org.accounts.bank,
        documentDate: org.date,
        currency: "CAD",
        memo: "Expense reimbursement",
      });
      await updateDraftPayment(
        payment.id,
        { allocations: [sameCurrencyAllocation(open[0]!.lineId, "123.45")], bankAccountId: org.accounts.bank },
        actorId,
      );
      await db.execute(sql`update documents set status = 'approved' where id = ${payment.id} and org_id = ${org.orgId}`);
      await postPaymentWithApplications(payment.id, undefined, actorId);

      const after = await openItemsForParty(employeeId, "ap");
      assert.equal(after.length, 0, "reimbursement must settle the expense report's open item exactly");
    } finally {
      // dropScratchOrg's fixed table list predates employee_roles and the
      // user/role rows this test adds — clear them first or its parties/orgs
      // deletes trip FKs.
      await db.execute(sql`delete from employee_roles where org_id = ${org.orgId}`);
      await db.execute(sql`update users set is_active = false where org_id = ${org.orgId}`);
      await db.execute(sql`delete from role_assignments where org_id = ${org.orgId}`);
      await db.execute(sql`delete from users where org_id = ${org.orgId}`);
      await db.execute(sql`delete from app_roles where org_id = ${org.orgId}`);
      await dropScratchOrg(org.orgId);
    }
  },
);
