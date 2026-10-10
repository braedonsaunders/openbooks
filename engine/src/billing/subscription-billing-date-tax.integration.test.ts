import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { billSubscriptionNow } from "./subscription-billing.ts";
import { computeLineTaxes } from "../tax/tax.ts";
import { loadTaxComponentConfig } from "../tax/persist.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

// Subscription invoices carry the scheduled bill date — never today — and
// resolve line tax through the native defaults (plan, then payer, then
// item). Tax that applies but cannot be resolved refuses explicitly instead
// of invoicing at silent zero.

type Fixture = {
  org: ScratchOrg;
  actor: string;
  hstCodeId: string | null;
  subscriptionId: string;
};

type TaxSetup = { code: string; rate: string; active: boolean };

async function seedTaxCode(org: ScratchOrg, setup: TaxSetup): Promise<string> {
  const taxCodeId = randomUUID();
  await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id,is_active)
    values (${taxCodeId},${org.orgId},${setup.code},${setup.code},${org.accounts.taxOutput},${org.accounts.taxInput},${setup.active})`);
  await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
    values (${org.orgId},${taxCodeId},${setup.rate},'2025-01-01')`);
  return taxCodeId;
}

async function fixture(
  run: (f: Fixture) => Promise<void>,
  opts: { planTax?: TaxSetup | null; customerTax?: TaxSetup | null; nextBillOn?: string } = {},
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subscription date-tax controller", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
    const nextBillOn = opts.nextBillOn ?? org.date;
    if (nextBillOn !== org.date) {
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
               2026, 11, '2025-11', '2025-11-01', '2025-11-30', false,
               '{}'::jsonb
          from accounting_periods
         where id = ${org.periodId}
      `);
    }
    let hstCodeId: string | null = null;
    if (opts.customerTax) {
      const customerTaxId = await seedTaxCode(org, opts.customerTax);
      if (opts.customerTax.code === "CA-ON-HST") hstCodeId = customerTaxId;
      await db.execute(sql`insert into customer_roles (org_id, party_id, tax_code_id, created_by, updated_by)
        values (${org.orgId}, ${org.customerId}, ${customerTaxId}, ${actor}, ${actor})`);
    }
    const planTaxId = opts.planTax ? await seedTaxCode(org, opts.planTax) : null;
    const planId = randomUUID();
    await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,interval,interval_count,income_account_id,tax_code_id,created_by)
      values(${planId},${org.orgId},'Snow season monthly 2025-26','130.0000','monthly',1,${org.accounts.revenue},${planTaxId},${actor})`);
    const subscriptionId = randomUUID();
    await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by)
      values(${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active','2025-11-01',${nextBillOn},true,${actor})`);
    await run({ org, actor, hstCodeId, subscriptionId });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

async function invoiceOf(orgId: string, invoiceId: string) {
  const doc = (await db.execute<{ document_date: string; subtotal: string; tax_total: string; total: string }>(sql`
    select document_date::text as document_date, subtotal::text as subtotal, tax_total::text as tax_total, total::text as total
      from documents where id = ${invoiceId} and org_id = ${orgId}`)).rows[0]!;
  const lines = (await db.execute<{ tax_code_id: string | null; tax_amount: string }>(sql`
    select tax_code_id, tax_amount::text as tax_amount from document_lines
     where document_id = ${invoiceId} and org_id = ${orgId} order by line_number`)).rows;
  return { doc, lines };
}

async function invoiceCount(orgId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents where org_id = ${orgId} and kind = 'customer_invoice'`)).rows[0]?.n ?? 0);
}

test("bill-now dates the invoice at the scheduled bill date, never today", enabled, () => fixture(async (f) => {
  const gen = await billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null);
  assert.ok(gen.invoiceId);
  assert.equal(gen.posted, true);
  const { doc } = await invoiceOf(f.org.orgId, gen.invoiceId);
  assert.equal(doc.document_date, "2025-11-10", "a back-dated start bills its period on its own date");
}, { nextBillOn: "2025-11-10" }));

test("bill-now applies the customer's default tax when the plan names none", enabled, () => fixture(async (f) => {
  const gen = await billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null);
  const cfg = await loadTaxComponentConfig(f.org.orgId, f.hstCodeId!, f.org.date);
  const expectedTax = computeLineTaxes("130.0000", cfg, {}).taxTotal;
  assert.notEqual(expectedTax, "0.0000");
  const { doc, lines } = await invoiceOf(f.org.orgId, gen.invoiceId);
  assert.equal(doc.tax_total, expectedTax);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.tax_code_id, f.hstCodeId, "the payer default resolves through native defaults");
  assert.equal(lines[0]!.tax_amount, expectedTax);
}, { customerTax: { code: "CA-ON-HST", rate: "13", active: true } }));

test("the plan tax code wins over the customer default", enabled, () => fixture(async (f) => {
  const gen = await billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null);
  const { lines } = await invoiceOf(f.org.orgId, gen.invoiceId);
  assert.equal(lines.length, 1);
  assert.ok(lines[0]!.tax_code_id, "a code resolves");
  assert.notEqual(lines[0]!.tax_code_id, f.hstCodeId, "the explicit plan term beats the payer default");
}, {
  planTax: { code: "PLAN-5", rate: "5", active: true },
  customerTax: { code: "CA-ON-HST", rate: "13", active: true },
}));

test("an inactive customer tax code refuses instead of invoicing zero", enabled, () => fixture(async (f) => {
  await assert.rejects(
    billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null),
    /cannot be resolved to an active tax code/,
  );
  assert.equal(await invoiceCount(f.org.orgId), 0, "the refusal cuts no invoice");
}, { customerTax: { code: "CA-ON-DEAD", rate: "13", active: false } }));

test("an inactive plan tax code refuses instead of falling back silently", enabled, () => fixture(async (f) => {
  await assert.rejects(
    billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null),
    /not active in this organization/,
  );
  assert.equal(await invoiceCount(f.org.orgId), 0, "the refusal cuts no invoice");
}, { planTax: { code: "PLAN-DEAD", rate: "5", active: false } }));

test("no tax anywhere invoices untaxed without refusing", enabled, () => fixture(async (f) => {
  const gen = await billSubscriptionNow(f.org.orgId, f.subscriptionId, { actorId: f.actor }, null);
  const { doc, lines } = await invoiceOf(f.org.orgId, gen.invoiceId);
  assert.equal(doc.tax_total, "0.0000");
  assert.equal(lines[0]!.tax_code_id, null);
}));
