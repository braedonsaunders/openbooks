import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../platform/db.ts";
import { add } from "../money/money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { generateInvoiceFromBillingRequest } from "../ledger/billing-invoice.ts";
import { deleteDocument } from "../ledger/document-delete.ts";
import { createInternalBillingRuleVersion, internalBillingRuleInEffect, listInternalBillingRules } from "./rules.ts";
import { postInternalBilling, saveInternalBillingDraft, voidInternalBilling } from "./documents.ts";
import { InternalBillingError } from "./errors.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

interface Fixture {
  org: ScratchOrg;
  actor: string;
  shop: string;
  field: string;
  project: string;
  account: (type: string, eliminate?: boolean) => Promise<string>;
}

async function fixture(run: (f: Fixture) => Promise<void>): Promise<void> {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(org.orgId)).adminId;
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"internalBilling": true, "projects": true, "multiSubsidiary": true}'::jsonb)
         where id = ${org.orgId}`);
      const shop = randomUUID();
      const field = randomUUID();
      await db.execute(sql`
        insert into departments (id, org_id, code, name) values
          (${shop}, ${org.orgId}, 'SHOP', 'Shop'), (${field}, ${org.orgId}, 'FIELD', 'Field')`);
      const project = randomUUID();
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-IB', 'Plant upgrade', ${org.customerId}, 'active', true, '{}'::jsonb)`);
      let next = 7100;
      const account = async (type: string, eliminate = false) => {
        const id = randomUUID();
        next += 1;
        await db.execute(sql`
          insert into accounts (id, org_id, number, name, type, eliminate)
          values (${id}, ${org.orgId}, ${String(next)}, ${`Internal ${type} ${next}`}, ${type}, ${eliminate})`);
        return id;
      };
      await run({ org, actor, shop, field, project, account });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

async function entryLines(entryId: string) {
  return (await db.execute<{ account_id: string; amount: string; subsidiary_id: string; department_id: string | null; project_id: string | null }>(sql`
    select account_id, amount::text as amount, subsidiary_id, department_id, project_id
      from journal_lines where entry_id = ${entryId} order by line_number`)).rows;
}

test("a department credit posts balanced, moves department revenue and leaves company revenue unchanged", enabled, () => fixture(async (f) => {
  const receiving = await f.account("income");
  const providing = await f.account("income");
  await createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "Shop is credited for field work",
    rule: { code: "SHOP", name: "Shop credit", method: "revenue_credit", debitAccountId: receiving, creditAccountId: providing, effectiveFrom: "2026-01-01" },
  });
  const saved = await saveInternalBillingDraft({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: {
      ruleCode: "SHOP", documentDate: f.org.date, departmentId: f.shop,
      lines: [{ description: "Fabrication for the field crew", quantity: "3", rate: "400", departmentId: f.field, projectId: f.project }],
    },
  });
  const posted = await postInternalBilling({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id });
  assert.equal(posted.status, "posted");
  const lines = await entryLines((posted as { entryId: string }).entryId);
  assert.deepEqual(lines.map((l) => ({ account: l.account_id, amount: l.amount, dept: l.department_id, project: l.project_id })), [
    { account: receiving, amount: "1200.0000", dept: f.field, project: null },
    { account: providing, amount: "-1200.0000", dept: f.shop, project: null },
  ]);
  const byDepartment = (await db.execute<{ department_id: string | null; amount: string }>(sql`
    select l.department_id, sum(l.amount)::text as amount
      from journal_lines l join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${f.org.orgId} and a.type in ('income', 'income_other')
     group by l.department_id order by l.department_id`)).rows;
  const revenue = new Map(byDepartment.map((row) => [row.department_id, row.amount]));
  assert.equal(revenue.get(f.shop), "-1200.0000", "the providing department is credited with the sale");
  assert.equal(revenue.get(f.field), "1200.0000");
  const company = (await db.execute<{ amount: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as amount
      from journal_lines l join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${f.org.orgId} and a.type in ('income', 'income_other')`)).rows[0]!;
  assert.equal(company.amount, "0.0000", "company revenue is not double counted");

  // A posted document is no longer editable; a correction is a void.
  await assert.rejects(
    saveInternalBillingDraft({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id,
      input: { ruleCode: "SHOP", documentDate: f.org.date, departmentId: f.shop, lines: [{ amount: "1", departmentId: f.field }] } }),
    /only a draft can be edited/,
  );
  const voided = await voidInternalBilling({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id, reason: "entered twice", reversalDate: f.org.date });
  assert.equal(voided.status, "voided");
}));

test("rule versions are effective-dated and a document without a rule in effect is refused", enabled, () => fixture(async (f) => {
  const a = await f.account("income");
  const b = await f.account("income");
  const c = await f.account("income");
  const first = await createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "initial treatment",
    rule: { code: "SHOP", name: "Shop credit", method: "revenue_credit", debitAccountId: a, creditAccountId: b, effectiveFrom: "2026-02-01" },
  });
  const second = await createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "new revenue account from July",
    rule: { code: "SHOP", name: "Shop credit", method: "revenue_credit", debitAccountId: a, creditAccountId: c, effectiveFrom: "2026-07-01" },
  });
  const versions = await listInternalBillingRules(f.org.orgId);
  assert.deepEqual(versions.map((v) => [v.id, v.effectiveFrom, v.effectiveTo]), [
    [second.id, "2026-07-01", null],
    [first.id, "2026-02-01", "2026-06-30"],
  ]);
  assert.equal((await internalBillingRuleInEffect(db, f.org.orgId, "SHOP", "2026-06-30"))?.id, first.id);
  assert.equal((await internalBillingRuleInEffect(db, f.org.orgId, "SHOP", "2026-07-01"))?.id, second.id);
  // A version cannot start before one already in force.
  await assert.rejects(createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "backdated treatment",
    rule: { code: "SHOP", name: "Shop credit", method: "revenue_credit", debitAccountId: a, creditAccountId: b, effectiveFrom: "2026-03-01" },
  }), /starts on or after 2026-03-01/);
  await assert.rejects(saveInternalBillingDraft({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { ruleCode: "SHOP", documentDate: "2026-01-15", departmentId: f.shop, lines: [{ amount: "10", departmentId: f.field }] },
  }), /no version of internal billing rule SHOP is in effect on 2026-01-15/);
  // Wrong account types are refused at the rule.
  const cost = await f.account("cogs");
  await assert.rejects(createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "wrong account kind",
    rule: { code: "BAD", name: "Bad", method: "revenue_credit", debitAccountId: cost, creditAccountId: b, effectiveFrom: "2026-01-01" },
  }), (error) => error instanceof InternalBillingError && /department credit rule/.test(error.message));
  const audit = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from audit_log where org_id = ${f.org.orgId} and table_name = 'internal_billing_rules'`)).rows[0]!;
  assert.equal(audit.n, 3, "two versions created and one window closed, each with evidence");
}));

test("a billable cost transfer is invoiced once to the receiving project and released when the invoice is deleted", enabled, () => fixture(async (f) => {
  const jobCost = await f.account("cogs");
  const shopCost = await f.account("expense");
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,projectRevenue}', to_jsonb(${f.org.accounts.revenue}::text)) where id = ${f.org.orgId}`);
  await createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "shop time charged to jobs",
    rule: { code: "SHOPTIME", name: "Shop time", method: "cost_transfer", debitAccountId: jobCost, creditAccountId: shopCost, billableByDefault: true, effectiveFrom: "2026-01-01" },
  });
  const item = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, income_account_id, is_active)
    values (${item}, ${f.org.orgId}, 'service', 'Shop fabrication', ${f.org.accounts.revenue}, true)`);
  const saved = await saveInternalBillingDraft({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: {
      ruleCode: "SHOPTIME", documentDate: f.org.date, departmentId: f.shop,
      lines: [{ itemId: item, quantity: "2", rate: "150", billRate: "220", projectId: f.project }],
    },
  });
  const posted = await postInternalBilling({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id });
  const legs = await entryLines((posted as { entryId: string }).entryId);
  assert.deepEqual(legs.map((l) => ({ account: l.account_id, amount: l.amount, project: l.project_id })), [
    { account: jobCost, amount: "300.0000", project: f.project },
    { account: shopCost, amount: "-300.0000", project: null },
  ]);

  const request = async () => {
    const id = randomUUID();
    await db.execute(sql`
      insert into billing_requests (id, org_id, project_id, request_number, invoice_type, basis, cutoff_date,
                                    billing_method_snapshot, backup_required, status, created_by, updated_by)
      values (${id}, ${f.org.orgId}, ${f.project}, ${`BR-${id.slice(0, 8)}`}, 'progress', 'date_range', ${f.org.date},
              'time_and_materials', false, 'open', ${f.actor}, ${f.actor})`);
    return id;
  };
  const invoice = await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, await request());
  const billedLines = (await db.execute<{ amount: string; quantity: string; item_id: string }>(sql`
    select i.amount::text as amount, i.quantity::text as quantity, i.item_id
      from document_lines s join document_lines i on i.org_id = s.org_id and i.id = s.billed_by_line_id
     where s.org_id = ${f.org.orgId} and s.document_id = ${saved.id} and i.document_id = ${invoice.id}`)).rows;
  assert.deepEqual(billedLines, [{ amount: "440.0000", quantity: "2.00000000", item_id: item }]);

  // Already billed: a second request cannot bill the line again.
  await generateInvoiceFromBillingRequest(f.org.orgId, f.actor, await request()).catch(() => null);
  const billedTwice = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from document_lines i
      join documents d on d.id = i.document_id and d.org_id = i.org_id
     where i.org_id = ${f.org.orgId} and d.kind = 'customer_invoice' and i.item_id = ${item}`)).rows[0]!;
  assert.equal(billedTwice.n, 1);

  // A billed line refuses a void until the invoice lets it go.
  await assert.rejects(
    voidInternalBilling({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id, reason: "wrong job" }),
    /This cost is billed on invoice .+; void or delete that invoice first/,
  );
  await deleteDocument(invoice.id, f.actor, f.org.orgId, { allowedSubsidiaryIds: null, reason: "rebill later" });
  const released = (await db.execute<{ billed: string | null }>(sql`
    select billed_by_line_id as billed from document_lines where org_id = ${f.org.orgId} and document_id = ${saved.id}`)).rows;
  assert.deepEqual(released, [{ billed: null }]);
}));

test("an intercompany sale posts eliminated revenue and cost with due-to and due-from legs", enabled, () => fixture(async (f) => {
  const icCost = await f.account("cogs", true);
  const icSales = await f.account("income", true);
  const plainSales = await f.account("income");
  const dueFrom = await f.account("asset_current_other", true);
  const dueTo = await f.account("liability_current_other", true);
  const buyer = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${buyer}, ${f.org.orgId}, ${f.org.subsidiaryId}, 'Field Services Ltd', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into intercompany_pairs (org_id, from_subsidiary_id, to_subsidiary_id, due_from_account_id, due_to_account_id)
    values (${f.org.orgId}, ${f.org.subsidiaryId}, ${buyer}, ${dueFrom}, ${dueTo})`);
  await assert.rejects(createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "missing elimination flag",
    rule: { code: "IC", name: "Intercompany", method: "intercompany_sale", debitAccountId: icCost, creditAccountId: plainSales, effectiveFrom: "2026-01-01" },
  }), /mark the account Eliminate on consolidation in Chart of accounts/);
  await createInternalBillingRuleVersion({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, reason: "intercompany services",
    rule: { code: "IC", name: "Intercompany", method: "intercompany_sale", debitAccountId: icCost, creditAccountId: icSales, effectiveFrom: "2026-01-01" },
  });
  await assert.rejects(saveInternalBillingDraft({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { ruleCode: "IC", documentDate: f.org.date, lines: [{ amount: "500", subsidiaryId: f.org.subsidiaryId }] },
  }), /must bill a different subsidiary/);
  const saved = await saveInternalBillingDraft({
    orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null,
    input: { ruleCode: "IC", documentDate: f.org.date, lines: [{ amount: "500", subsidiaryId: buyer }] },
  });
  const posted = await postInternalBilling({ orgId: f.org.orgId, actorId: f.actor, allowedSubsidiaryIds: null, id: saved.id });
  const legs = await entryLines((posted as { entryId: string }).entryId);
  const bySubsidiary = new Map<string, string>();
  for (const leg of legs) bySubsidiary.set(leg.subsidiary_id, add(bySubsidiary.get(leg.subsidiary_id) ?? "0", leg.amount));
  assert.deepEqual([...bySubsidiary.values()], ["0.0000", "0.0000"], "each subsidiary balances on its own");
  const accounts = legs.map((l) => [l.account_id, l.subsidiary_id, l.amount]);
  assert.deepEqual(new Set(accounts.map((a) => JSON.stringify(a))), new Set([
    [icCost, buyer, "500.0000"],
    [icSales, f.org.subsidiaryId, "-500.0000"],
    [dueTo, buyer, "-500.0000"],
    [dueFrom, f.org.subsidiaryId, "500.0000"],
  ].map((a) => JSON.stringify(a))));
}));
