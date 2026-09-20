import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  changeSubscription,
  prorate,
} from "./subscription-billing.ts";
import { computeLineTaxes } from "../tax/tax.ts";
import { loadTaxComponentConfig } from "../tax/persist.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const TAX_RATE = "13";
const PERIOD_START = "2026-07-01";
const PERIOD_END = "2026-08-01";
const AS_OF = "2026-07-15";

type Fixture = { org: ScratchOrg; actor: string; taxCodeId: string; subscriptionId: string };
async function fixture(run: (f: Fixture) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Subscription proration controller", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
    const taxCodeId = randomUUID();
    await db.execute(sql`insert into tax_codes (id,org_id,code,name,collected_account_id,paid_account_id)
      values (${taxCodeId},${org.orgId},'SUB-13','Subscription 13%',${org.accounts.taxOutput},${org.accounts.taxInput})`);
    await db.execute(sql`insert into tax_rates (org_id,tax_code_id,rate_percent,effective_from)
      values (${org.orgId},${taxCodeId},${TAX_RATE},'2026-01-01')`);
    const planId = randomUUID(), subscriptionId = randomUUID();
    await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,interval,interval_count,income_account_id,tax_code_id,created_by)
      values(${planId},${org.orgId},'Taxed proration plan','100.0000','monthly',1,${org.accounts.revenue},${taxCodeId},${actor})`);
    await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by)
      values(${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active',${PERIOD_START},${PERIOD_END},false,${actor})`);
    await run({ org, actor, taxCodeId, subscriptionId });
  } finally { await dropScratchOrgReporting(org.orgId); }
}

async function invoiceOf(orgId: string, invoiceId: string) {
  const doc = (await db.execute<{ kind: string; subtotal: string; tax_total: string; total: string }>(
    sql`select kind, subtotal::text as subtotal, tax_total::text as tax_total, total::text as total from documents where id=${invoiceId} and org_id=${orgId}`,
  )).rows[0]!;
  const lines = (await db.execute<{ tax_code_id: string | null; tax_amount: string }>(
    sql`select tax_code_id, tax_amount::text as tax_amount from document_lines where document_id=${invoiceId} and org_id=${orgId} order by line_number`,
  )).rows;
  return { doc, lines };
}

test("an upgrade proration taxes the remaining slice under the plan tax code", enabled, () => fixture(async (f) => {
  const result = await changeSubscription(f.subscriptionId, { quantity: "2" }, AS_OF, { actorId: f.actor });
  assert.ok(result.invoiceId, "an upgrade must cut a proration invoice");
  // Same remaining-slice math as the first-period proration: one extra unit
  // over [AS_OF, PERIOD_END], taxed exactly like a normal invoice line.
  const expectedNet = prorate("100.0000", PERIOD_START, PERIOD_END, AS_OF);
  const cfg = await loadTaxComponentConfig(f.org.orgId, f.taxCodeId, AS_OF);
  assert.ok(cfg.length > 0, "the plan tax code resolves an effective rate");
  const expectedTax = computeLineTaxes(expectedNet, cfg, {}).taxTotal;
  assert.notEqual(expectedTax, "0.0000", "the 13% code must produce tax on the slice");
  const { doc, lines } = await invoiceOf(f.org.orgId, result.invoiceId);
  assert.equal(doc.kind, "customer_invoice");
  assert.equal(doc.subtotal, expectedNet);
  assert.equal(doc.tax_total, expectedTax);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.tax_code_id, f.taxCodeId);
  assert.equal(lines[0]!.tax_amount, expectedTax);
}));

test("a downgrade proration credits the remaining slice with its tax", enabled, () => fixture(async (f) => {
  await changeSubscription(f.subscriptionId, { quantity: "2" }, AS_OF, { actorId: f.actor });
  const result = await changeSubscription(f.subscriptionId, { quantity: "1" }, AS_OF, { actorId: f.actor });
  assert.ok(result.invoiceId, "a downgrade must cut a proration credit");
  const expectedNet = prorate("100.0000", PERIOD_START, PERIOD_END, AS_OF);
  const cfg = await loadTaxComponentConfig(f.org.orgId, f.taxCodeId, AS_OF);
  const expectedTax = computeLineTaxes(expectedNet, cfg, {}).taxTotal;
  const { doc, lines } = await invoiceOf(f.org.orgId, result.invoiceId);
  assert.equal(doc.kind, "customer_credit");
  assert.equal(doc.subtotal, expectedNet);
  assert.equal(doc.tax_total, expectedTax);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.tax_code_id, f.taxCodeId);
  assert.equal(lines[0]!.tax_amount, expectedTax);
}));
