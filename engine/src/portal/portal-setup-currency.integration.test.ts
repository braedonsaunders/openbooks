import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { PortalRefusal } from "./errors.ts";
import { previewSubscriptionChange } from "./changes.ts";
import { resolvePortalSetupCurrency } from "./workspace.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function enablePortalBilling(orgId: string): Promise<void> {
  const result = await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
      || '{"customerPortal": true, "subscriptionBilling": true}'::jsonb) where id = ${orgId} returning id`));
  assert.equal(result.rows.length, 1);
}

async function seedPlanSubscription(orgId: string, customerId: string): Promise<string> {
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into subscription_plans (id, org_id, name, amount, interval, interval_count, income_account_id)
    values (${planId}, ${orgId}, 'Portal plan', '100.0000', 'monthly', 1,
      (select id from accounts where org_id = ${orgId} limit 1))`));
  await withBypassContext(() => db.execute(sql`
    insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, current_period_start, next_bill_on, auto_post)
    values (${subscriptionId}, ${orgId}, ${customerId}, ${planId}, '1', 'active', '2026-07-01', '2026-07-01', '2026-08-01', false)`));
  return subscriptionId;
}

async function seedInvoice(orgId: string, customerId: string, currency: string, date: string): Promise<void> {
  const documentId = randomUUID();
  await withBypassContext(() => db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, document_date, currency, status,
                           subtotal, tax_total, total, custom)
    values (${documentId}, ${orgId}, 'customer_invoice', ${`INV-${documentId.slice(0, 8)}`}, ${customerId},
            ${date}, ${currency}, 'draft', '100', '0', '100', '{}'::jsonb)`));
}

test("setup currency follows the latest invoice, else the org base", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    assert.equal(
      await withOrgContext(org.orgId, () => resolvePortalSetupCurrency(org.orgId, org.customerId)),
      "CAD",
    );
    await seedInvoice(org.orgId, org.customerId, "EUR", "2026-07-10");
    await seedInvoice(org.orgId, org.customerId, "USD", "2026-07-12");
    assert.equal(
      await withOrgContext(org.orgId, () => resolvePortalSetupCurrency(org.orgId, org.customerId)),
      "USD",
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("an unreadable quantity is refused with its remedy, not stored", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await enablePortalBilling(org.orgId);
    const subscriptionId = await seedPlanSubscription(org.orgId, org.customerId);
    await assert.rejects(
      previewSubscriptionChange(org.orgId, org.customerId, { subscriptionId, quantity: "not-a-number" }),
      (error: unknown) =>
        error instanceof PortalRefusal &&
        error.code === "invalid_input" &&
        /plain number with up to four decimals/i.test(error.message) &&
        /how many seats or units/i.test(error.remedy ?? ""),
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
