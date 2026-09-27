import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createUsageMeter, ingestUsageRecords } from "../billing/usage/records.ts";
import { createUsageRatingPlan, createUsageRatingPlanVersion, publishUsagePlanVersion, replaceUsageRatingBands } from "../billing/usage/rating-plans.ts";
import { commitRateRun } from "../billing/usage/rate-run.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runScenario } from "../golden/scenario.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function usageInvoice(org: ScratchOrg, actor: string, tag: string) {
  const itemId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
      values (${itemId}, ${org.orgId}, 'service', ${`Usage ${tag}`}, ${org.accounts.revenue}, true, '{}'::jsonb)`);
  });
  const meter = await createUsageMeter(org.orgId, actor, {
    key: `${tag}-${randomUUID()}`, name: `Usage ${tag}`, unit: "request", aggregation: "sum", itemId,
  });
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
      values (${planId}, ${org.orgId}, ${`Usage plan ${tag}`}, 0, 'CAD', 'monthly', 1)`);
    await db.execute(sql`insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, 1, 'active', ${org.date}, ${org.date})`);
  });
  const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Rate ${tag}-${randomUUID()}`, currency: "CAD" });
  const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
  await replaceUsageRatingBands(org.orgId, actor, version.id, [{ meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "1.25" }]);
  await publishUsagePlanVersion(org.orgId, actor, version.id);
  const link = (await withBypassContext(() => db.execute<{ id: string }>(sql`insert into subscription_usage_links
    (org_id, subscription_id, customer_id, plan_version_id, meter_ids, effective_from, created_by, updated_by)
    values (${org.orgId}, ${subscriptionId}, ${org.customerId}, ${version.id}, ARRAY[${meter.id}]::uuid[], ${org.date}, ${actor}, ${actor}) returning id`))).rows[0]!;
  await ingestUsageRecords(org.orgId, actor, [{ meterKey: meter.key, customerId: org.customerId, subscriptionId, occurredOn: org.date,
    quantity: "3", source: "api", idempotencyKey: randomUUID() }]);
  const run = await commitRateRun(org.orgId, actor, link.id, org.date, org.date);
  assert.ok(run.invoiceId);
  return run.invoiceId;
}

async function post(org: ScratchOrg, actor: string, invoiceId: string): Promise<void> {
  await withBypassContext(async () => {
    const approved = await db.execute(sql`update documents set status = 'approved'
      where org_id = ${org.orgId} and id = ${invoiceId} and status = 'draft' returning id`);
    assert.equal(approved.rows.length, 1);
  });
  await postDocument(invoiceId, { control: await loadRequiredControlAccounts(org.orgId) }, { audit: { actorId: actor, source: "usage-trace-test" } });
}

function check(cp: Awaited<ReturnType<typeof runScenario>>, name: string) {
  const result = cp.checks.find((item) => item.name === name); assert.ok(result, `checkpoint must carry the ${name} check`);
  return result;
}

test("usage-invoice-trace passes clean rated invoices and identifies a changed draft line after posting", DB, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Usage trace reviewer", "admin");
    await withBypassContext(async () => {
      const enabled = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        '{"subscriptionBilling":true,"usageBilling":true}'::jsonb, true) where id = ${org.orgId}`);
      assert.equal(enabled.rowCount, 1);
    });
    const cleanInvoice = await usageInvoice(org, actor, "clean");
    const changedInvoice = await usageInvoice(org, actor, "changed");
    await post(org, actor, cleanInvoice);
    const clean = await runScenario(org.orgId, { at: org.date });
    assert.equal(check(clean, "usage-invoice-trace").ok, true);

    const line = (await db.execute<{ id: string; number: number }>(sql`
      select id, line_number as number from document_lines
       where org_id = ${org.orgId} and document_id = ${changedInvoice} order by line_number limit 1`)).rows[0]!;
    const changed = await db.execute(sql`update document_lines set amount = amount + 0.01 where org_id = ${org.orgId} and id = ${line.id} returning id`);
    assert.equal(changed.rows.length, 1);
    const header = await db.execute(sql`update documents d set subtotal = totals.subtotal, tax_total = totals.tax_total, total = totals.total
      from (select sum(amount) as subtotal, sum(tax_amount) as tax_total, sum(amount + tax_amount) as total
              from document_lines where org_id = ${org.orgId} and document_id = ${changedInvoice}) totals
      where d.org_id = ${org.orgId} and d.id = ${changedInvoice} and d.status = 'draft' returning d.id`);
    assert.equal(header.rows.length, 1);
    await post(org, actor, changedInvoice);

    const cp = await runScenario(org.orgId, { at: org.date });
    const trace = check(cp, "usage-invoice-trace");
    assert.equal(trace.ok, false, trace.detail);
    assert.match(trace.detail, new RegExp(changedInvoice));
    assert.match(trace.detail, new RegExp(line.id));
    for (const other of cp.checks.filter((item) => item.name !== "usage-invoice-trace")) {
      assert.equal(other.ok, true, `${other.name} must remain green: ${other.detail}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
