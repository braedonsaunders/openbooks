import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";
import { releaseRetainage } from "./construction-billing.ts";
import { releaseVendorRetainage } from "./subcontracts.ts";
import { deleteDocument } from "./document-delete.ts";
import { saveSetupBook } from "./web/lib/setup/books.ts";
import { SETUP_ENTITY_BY_KEY } from "./web/lib/setup/registry.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function constructionFixture(run: (f: {
  org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; project: string;
}) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Gap controller", "admin");
    const project = randomUUID(), type = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find(p => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'gap_test','Gap test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch gap policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'GAP','Gap job',${org.customerId},${type},'active')`);
    await run({ org, actor, project });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

test("saving a second primary book demotes the first through one shared path", enabled, async () => constructionFixture(async ({ org, actor }) => {
  const entity = SETUP_ENTITY_BY_KEY["accounting-books"]!;
  const second = await withOrgTransaction(org.orgId, async () => {
    const tx = { execute: db.execute.bind(db) } as Parameters<typeof saveSetupBook>[4];
    return saveSetupBook(entity, org.orgId, actor, { code: "SECOND", name: "Second book" }, tx);
  });
  assert.ok(second);
  const primaries = (await db.execute<{ code: string; is_primary: boolean }>(sql`select code,is_primary from accounting_books where org_id=${org.orgId} and is_primary`)).rows;
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0]!.code, "SECOND");
}));

test("vendor retainage release bill deletion leaves capacity stranded", enabled, async () => constructionFixture(async ({ org, actor }) => {
  const vendor = randomUUID(), subcontract = randomUUID();
  await db.execute(sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${org.orgId},'vendor','Gap vendor',true)`);
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainagePayable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
  const project = (await db.execute<{ id: string }>(sql`select id from projects where org_id=${org.orgId}`)).rows[0]!.id;
  await db.execute(sql`insert into subcontracts(id,org_id,project_id,vendor_id,number,currency,status) values(${subcontract},${org.orgId},${project},${vendor},'SC-GAP','CAD','active')`);
  const sov = randomUUID(), app = randomUUID();
  await db.execute(sql`insert into subcontract_sov_lines(id,org_id,subcontract_id,description,scheduled_value,sort_order) values(${sov},${org.orgId},${subcontract},'Work','1000',1)`);
  const bill = randomUUID();
  await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,project_id,subsidiary_id,subtotal,tax_total,total)
    values(${bill},${org.orgId},'vendor_bill','BILL-GAP',${vendor},${org.date},'CAD','posted',${project},${org.subsidiaryId},900,0,900)`);
  await db.execute(sql`insert into vendor_pay_applications(id,org_id,subcontract_id,application_number,period_end,status,gross_this_period,retainage_this_period,net_due,vendor_bill_document_id)
    values(${app},${org.orgId},${subcontract},1,${org.date},'billed','1000','100','900',${bill})`);
  const first = await withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" }));
  await withOrgTransaction(org.orgId, () => deleteDocument(first.vendorBillDocumentId, actor, org.orgId, { reason: "Correct release amount" }));
  const status = (await db.execute(sql`select status from documents where org_id=${org.orgId} and id=${first.vendorBillDocumentId}`)).rows.length;
  assert.equal(status, 0);
  // Capacity accounting still counts the deleted bill as released: the second release fails.
  await assert.rejects(
    withOrgTransaction(org.orgId, () => releaseVendorRetainage({ orgId: org.orgId, userId: actor, subcontractId: subcontract, periodEnd: org.date, amount: "100" })),
    /Release exceeds posted retainage/,
  );
}));

test("customer release rejects a non-primary-book target without naming the book", enabled, async () => constructionFixture(async ({ org, actor, project }) => {
  const tax = randomUUID();
  await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${tax},${org.orgId},'TAX2','Tax 2',false,true,true)`);
  const entry = randomUUID();
  await withOrgTransaction(org.orgId, async () => {
    await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
      values(${entry},${org.orgId},${tax},${org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
    await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,project_id)
      values(${org.orgId},${entry},1,${org.accounts.invAsset},${org.subsidiaryId},100,'CAD',100,1,${project}),
      (${org.orgId},${entry},2,${org.accounts.revenue},${org.subsidiaryId},-100,'CAD',-100,1,${project})`);
    await db.execute(sql`update journal_entries set status='posted',posted_by=${actor},posted_at=now() where org_id=${org.orgId} and id=${entry}`);
  });
  await assert.rejects(
    withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, org.date, "50")),
    /exceeds available retained funds/,
  );
}));
