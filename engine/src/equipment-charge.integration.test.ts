import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("equipment charge posts balanced job cost and recovery with unit attribution", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = randomUUID();
    const itemId = randomUUID();
    const equipmentId = randomUUID();
    const documentId = randomUUID();
    await db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-1', 'Equipment job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into items (id, org_id, kind, code, name, default_cost, default_rate, expense_account_id,
                         cost_recovery_account_id, income_account_id, is_active, custom)
      values (${itemId}, ${org.orgId}, 'equipment_charge', 'EXC', 'Excavator', '125.3750', '250.0000',
              ${org.accounts.cogs}, ${org.accounts.adjustment}, ${org.accounts.revenue}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into equipment_units (id, org_id, subsidiary_id, unit_number, name, status, charge_item_id, purchase_price)
      values (${equipmentId}, ${org.orgId}, ${org.subsidiaryId}, 'EQ-0001', 'Excavator 1', 'active', ${itemId}, '75000')`);
    await db.execute(sql`
      insert into documents (id, org_id, kind, document_number, document_date, posting_date, currency, status,
                             project_id, subsidiary_id, subtotal, tax_total, total, custom, extra_dims)
      values (${documentId}, ${org.orgId}, 'project_charge', 'CHG-1', ${org.date}, ${org.date}, 'CAD', 'draft',
              ${projectId}, ${org.subsidiaryId}, '125.3750', '0', '125.3750', '{}'::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, description,
                                  quantity, amount, project_id, equipment_unit_id, recovery_account_id,
                                  cost_rate, bill_rate, cost_amount, bill_amount, is_billable, custom, extra_dims)
      values (${randomUUID()}, ${org.orgId}, ${documentId}, 1, ${itemId}, ${org.accounts.cogs}, 'Excavator usage',
              '1', '125.3750', ${projectId}, ${equipmentId}, ${org.accounts.adjustment},
              '125.3750', '250.0000', '125.3750', '250.0000', true, '{}'::jsonb, '{}'::jsonb)`);

    const entryId = await postDocument(documentId, {
      control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
    });
    const result = (await db.execute(sql`
      select account_id, amount, project_id, equipment_unit_id
        from journal_lines where entry_id = ${entryId} order by line_number
    `)) as any;
    assert.deepEqual(result.rows.map((row: any) => ({
      account: row.account_id,
      amount: String(row.amount),
      project: row.project_id,
      equipment: row.equipment_unit_id,
    })), [
      { account: org.accounts.cogs, amount: "125.3750", project: projectId, equipment: equipmentId },
      { account: org.accounts.adjustment, amount: "-125.3750", project: null, equipment: equipmentId },
    ]);
    const balance = (await db.execute(sql`select sum(amount) as amount from journal_lines where entry_id = ${entryId}`)) as any;
    assert.equal(String(balance.rows[0].amount), "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
