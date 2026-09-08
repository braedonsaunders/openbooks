import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withOrgTransaction } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";
import { createPayApplication, generatePayApplicationInvoice, releaseRetainage, voidPayApplication } from "./construction-billing.ts";
import { deleteDocument } from "./document-delete.ts";
import { releaseBillingProvenance } from "./billing-provenance.ts";
import { requestDocumentVoid } from "./document-void.ts";
import { reverseProjectGlEntry } from "./project-recognition.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
async function fixture(run: (f: {
  org: Awaited<ReturnType<typeof createScratchOrg>>; actor: string; project: string;
  hold: (options?: { book?: string; subsidiary?: string; currency?: string; amount?: string; txnAmount?: string }) => Promise<string>;
  release: (amount: string) => ReturnType<typeof releaseRetainage>;
}) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Retainage controller", "admin");
    const project = randomUUID(), type = randomUUID();
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{controlAccounts}',coalesce(settings->'controlAccounts','{}'::jsonb)||jsonb_build_object('retainageReceivable',${org.accounts.invAsset}::text)) where id=${org.orgId}`);
    const profile = BUILTIN_PROJECT_TYPES.find(p => p.key === "schedule_of_values")!;
    await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
      values(${type},${org.orgId},'retainage_test','Retainage test','fixed_price',${JSON.stringify(profile.invoicingProfile)}::jsonb,${JSON.stringify(profile.backupProfile)}::jsonb)`);
    await db.execute(sql`insert into project_financial_profile_versions(org_id,project_type_id,effective_from,financial_profile,reason)
      values(${org.orgId},${type},'2000-01-01',${JSON.stringify(profile.financialProfile)}::jsonb,'Scratch retainage policy')`);
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status)
      values(${project},${org.orgId},${org.subsidiaryId},'RET','Retainage job',${org.customerId},${type},'active')`);
    await db.execute(sql`insert into sov_lines(org_id,project_id,description,scheduled_value,sort_order,income_account_id)
      values(${org.orgId},${project},'Work','1000',1,${org.accounts.revenue})`);
    const hold = async (options: { book?: string; subsidiary?: string; currency?: string; amount?: string; txnAmount?: string } = {}) => {
      const entry = randomUUID(), amount = options.amount ?? "100", txnAmount = options.txnAmount ?? amount;
      await withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status,origin)
          values(${entry},${org.orgId},${options.book ?? org.bookId},${options.subsidiary ?? org.subsidiaryId},${entry},${org.date},${org.periodId},'draft','manual')`);
        await db.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,project_id)
          values(${org.orgId},${entry},1,${org.accounts.invAsset},${options.subsidiary ?? org.subsidiaryId},${amount},${options.currency ?? 'CAD'},${txnAmount},${amount}::numeric/${txnAmount}::numeric,${project}),
          (${org.orgId},${entry},2,${org.accounts.revenue},${options.subsidiary ?? org.subsidiaryId},-${amount}::numeric,${options.currency ?? 'CAD'},-${txnAmount}::numeric,${amount}::numeric/${txnAmount}::numeric,${project})`);
        await db.execute(sql`update journal_entries set status='posted',posted_by=${actor},posted_at=now() where org_id=${org.orgId} and id=${entry}`);
      });
      return entry;
    };
    await run({ org, actor, project, hold, release: amount => withOrgTransaction(org.orgId, () => releaseRetainage(org.orgId, actor, project, org.date, amount)) });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

test("retainage capacity counts the primary book once and reserves competing drafts", enabled, async () => fixture(async ({ org, hold, release }) => {
  const tax = randomUUID();
  await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${tax},${org.orgId},'TAX','Tax',false,true,true)`);
  await hold(); await hold({ book: tax });
  await assert.rejects(release("150"), /exceeds available retained funds/);
  const competing = await Promise.allSettled([release("60"), release("60")]);
  assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
  await release("40");
  await assert.rejects(release("0.0001"), /exceeds available retained funds/);
}));

test("retainage capacity excludes another legal entity but includes converted transaction currency", enabled, async () => fixture(async ({ org, hold, release }) => {
  const other = randomUUID();
  await db.execute(sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict do nothing`);
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${other},${org.orgId},${org.subsidiaryId},'Other entity','CAD','CA')`);
  await hold({ currency: "USD", txnAmount: "80" });
  await hold({ subsidiary: other });
  await assert.rejects(release("150"), /exceeds available retained funds/);
  const result = await release("100");
  const doc = (await db.execute<{ currency: string; subsidiary_id: string; total: string }>(sql`select currency,subsidiary_id,total from documents where org_id=${org.orgId} and id=${result.invoiceId}`)).rows[0]!;
  assert.deepEqual(doc, { currency: "CAD", subsidiary_id: org.subsidiaryId, total: "100.0000" });
}));

test("reversed retainage is not available for release", enabled, async () => fixture(async ({ org, actor, hold, release }) => {
  const entry = await hold();
  await reverseProjectGlEntry(org.orgId, actor, entry, "Correct retained amount", org.date);
  await assert.rejects(release("1"), /exceeds available retained funds/);
}));

test("pending releases with a changed currency fail closed", enabled, async () => fixture(async ({ org, hold, release }) => {
  await hold();
  const first = await release("25");
  await db.execute(sql`insert into currencies(code,name,minor_units) values('USD','US Dollar',2) on conflict do nothing`);
  await db.execute(sql`update documents set currency='USD' where org_id=${org.orgId} and id=${first.invoiceId}`);
  await assert.rejects(release("1"), /Correct or cancel the pending retainage invoice/);
}));

test("controlled void cancels a release reservation and permits replacement", enabled, async () => fixture(async ({ org, actor, hold, release }) => {
  await hold();
  const first = await release("100");
  await db.execute(sql`update documents set status='approved' where org_id=${org.orgId} and id=${first.invoiceId}`);
  const result = await requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: first.invoiceId, reason: "Correct retainage request", reversalDate: org.date });
  assert.equal(result.status, "voided");
  assert.equal((await db.execute(sql`select status from pay_applications where org_id=${org.orgId}`)).rows[0]!.status, "void");
  await release("100");
}));

test("ordinary progress applications preserve their lines and regenerate after deletion", enabled, async () => fixture(async ({ org, actor, project }) => {
  const app = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, org.date));
  await db.execute(sql`update pay_application_lines set this_period_completed=100 where org_id=${org.orgId} and pay_application_id=${app.id}`);
  await db.execute(sql`update pay_applications set status='approved' where org_id=${org.orgId} and id=${app.id}`);
  const first = await withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, app.id));
  await withOrgTransaction(org.orgId, () => deleteDocument(first.invoiceId, actor, org.orgId, { reason: "Correct progress invoice" }));
  assert.equal((await db.execute(sql`select status from pay_applications where org_id=${org.orgId} and id=${app.id}`)).rows[0]!.status, "approved");
  const replacement = await withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, app.id));
  assert.notEqual(replacement.invoiceId, first.invoiceId);
  assert.equal(replacement.currentDue, first.currentDue);
  assert.equal(replacement.retainage, first.retainage);
}));

test("release cleanup is tenant scoped and its audit rolls back with the transition", enabled, async () => fixture(async ({ org, actor, hold, release }) => {
  await hold();
  const first = await release("100");
  await withOrgTransaction(randomUUID(), () => releaseBillingProvenance(db, randomUUID(), first.invoiceId, { actorId: actor, reason: "Foreign attempt" }));
  await assert.rejects(withOrgTransaction(org.orgId, async () => {
    await releaseBillingProvenance(db, org.orgId, first.invoiceId, { actorId: actor, reason: "Rollback proof" });
    throw new Error("rollback proof");
  }), /rollback proof/);
  assert.deepEqual((await db.execute(sql`select status,invoice_document_id from pay_applications where org_id=${org.orgId}`)).rows, [{ status: "invoiced", invoice_document_id: first.invoiceId }]);
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and table_name='pay_applications' and action='billing_released'`)).rows.length, 0);
  await assert.rejects(release("1"), /exceeds available retained funds/);
}));

for (const policy of ["inactive book", "nonposting book", "missing entity"] as const) {
  test(`retainage refuses ${policy}`, enabled, async () => fixture(async ({ org, project, hold, release }) => {
    await hold();
    if (policy === "missing entity") await db.execute(sql`update projects set subsidiary_id=null where org_id=${org.orgId} and id=${project}`);
    else await db.execute(sql`update accounting_books set is_active=${policy !== 'inactive book'},posts_gl=${policy !== 'nonposting book'} where org_id=${org.orgId} and id=${org.bookId}`);
    await assert.rejects(release("50"), policy === "missing entity" ? /legal entity/ : /active primary posting book/);
  }));
}

test("deleting a release invoice cancels its application with evidence and permits a fresh release and progress draw", enabled, async () => fixture(async ({ org, actor, project, hold, release }) => {
  await hold();
  const first = await release("100");
  const app = (await db.execute<{ id: string }>(sql`select id from pay_applications where org_id=${org.orgId} and invoice_document_id=${first.invoiceId}`)).rows[0]!.id;
  await withOrgTransaction(org.orgId, () => deleteDocument(first.invoiceId, actor, org.orgId, { reason: "Correct release amount" }));
  assert.deepEqual((await db.execute(sql`select status,invoice_document_id,updated_by from pay_applications where org_id=${org.orgId} and id=${app}`)).rows, [{ status: "void", invoice_document_id: null, updated_by: actor }]);
  const evidence = (await db.execute<{ changes: { before: { status: string }; after: { status: string }; reason: string }; actor_id: string }>(sql`select changes,actor_id from audit_log where org_id=${org.orgId} and row_id=${app} and action='billing_released'`)).rows;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.changes.before.status, "invoiced");
  assert.equal(evidence[0]!.changes.after.status, "void");
  assert.equal(evidence[0]!.changes.reason, "Correct release amount");
  assert.equal(evidence[0]!.actor_id, actor);
  await withOrgTransaction(org.orgId, () => releaseBillingProvenance(db, org.orgId, first.invoiceId, { actorId: actor, reason: "Repeat cleanup" }));
  assert.equal((await db.execute(sql`select id from audit_log where org_id=${org.orgId} and row_id=${app} and action='billing_released'`)).rows.length, 1);
  const replacement = await release("75");
  assert.notEqual(replacement.invoiceId, first.invoiceId);
  await assert.rejects(release("26"), /exceeds available retained funds/);
  const progress = await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, "2026-07-31"));
  assert.equal(progress.applicationNumber, 3);
}));

test("legacy stranded release applications get an actionable recovery error and can be voided", enabled, async () => fixture(async ({ org, actor, project }) => {
  const app = randomUUID();
  await db.execute(sql`insert into pay_applications(id,org_id,project_id,application_number,period_end,kind,status,retainage_percent)
    values(${app},${org.orgId},${project},1,${org.date},'retainage_release','approved',0)`);
  await assert.rejects(withOrgTransaction(org.orgId, () => generatePayApplicationInvoice(org.orgId, actor, app)), /Void this release application.*new retainage release/);
  await withOrgTransaction(org.orgId, () => voidPayApplication(org.orgId, actor, app));
  assert.equal((await withOrgTransaction(org.orgId, () => createPayApplication(org.orgId, actor, project, org.date))).applicationNumber, 2);
}));
