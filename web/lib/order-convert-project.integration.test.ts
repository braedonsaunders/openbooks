import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectFinancials } from "@openbooks/engine/src/projects/financials.ts";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
import { convertOrder } from "./order-cycle.ts";
import { postDocument } from "@openbooks/engine/src/ledger/posting-document.ts";

const fixedPrice = BUILTIN_PROJECT_TYPES.find((t) => t.key === "fixed_price")!.financialProfile;

/**
 * An invoice converted from a project estimate carries the estimate's
 * project link on the header and every line, posts, and counts in the
 * project's invoiced to date. The native convert path copies both; this
 * pins the whole chain so a missing link fails loudly at its source.
 */
test("an invoice converted from a project estimate carries the project and counts in invoiced to date", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Profit Converter", "admin"));
    await withBypassContext(() => db.execute(sql`update items set income_account_id = ${org.accounts.revenue}, recognition_rule_id = null, deferred_account_id = null where id = ${org.items.service} and org_id = ${org.orgId}`));
    const customer = randomUUID();
    const project = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values (${customer},${org.orgId},'customer','Profit Customer',${org.subsidiaryId},true)`));
    await withBypassContext(() => db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,contract_value,status,is_active,custom) values (${project},${org.orgId},${org.subsidiaryId},'PROFIT','Profit job',${customer},'8400','active',true,'{}'::jsonb)`));
    const quote = randomUUID();
    await withBypassContext(() => db.execute(sql`insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, currency, status, project_id, subtotal, tax_total, total, created_by, updated_by) values (${quote}, ${org.orgId}, 'quote', 'Q-PROFIT', ${customer}, ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', ${project}, '4200', '0', '4200', ${actor}, ${actor})`));
    await withBypassContext(() => db.execute(sql`insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity, unit_price, amount, project_id, created_by, updated_by) values (${org.orgId}, ${quote}, 1, ${org.items.service}, ${org.accounts.revenue}, 'Deposit', '1', '4200', '4200', ${project}, ${actor}, ${actor})`));
    await withBypassContext(() => db.execute(sql`update documents set status='approved' where id=${quote}`));
    const converted = await convertOrder(org.orgId, actor, quote, "customer_invoice");
    const header = (await withBypassContext(() => db.execute<{ project_id: string | null }>(sql`select project_id from documents where id=${converted.id}`))).rows[0]!;
    assert.equal(header.project_id, project, "converted invoice header carries the estimate project");
    const lines = (await withBypassContext(() => db.execute<{ project_id: string | null }>(sql`select project_id from document_lines where document_id=${converted.id}`))).rows;
    assert.ok(lines.length > 0);
    for (const line of lines) assert.equal(line.project_id, project, "converted invoice lines carry the estimate project");
    await withBypassContext(() => db.execute(sql`update documents set status='approved' where id=${converted.id}`));
    await withBypassContext(() => postDocument(converted.id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }));
    const financials = await resolveProjectFinancials(org.orgId, project, fixedPrice);
    assert.equal(financials.measures.invoiced_to_date, "4200.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
