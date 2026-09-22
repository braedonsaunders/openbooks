import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  billSubscriptionNow,
  changeSubscription,
  prorateFirstInvoice,
  runDueSubscriptions,
  SubscriptionError,
} from "./subscription-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Both subscription loaders used to stamp every invoice with the hardcoded
 * org root (`parent_id is null`), ignoring the customer's own subsidiary —
 * while subscriptionScopeSql authorizes by the customer entity
 * (`scoped_customer.subsidiary_id … or null-is-org-wide`). A branch
 * customer's invoice therefore posted to the root entity. The loaders now
 * derive the invoice entity from parties.subsidiary_id (trusted same-org
 * active subsidiary only); the root remains solely the null-customer
 * (org-wide) fallback.
 */
async function seedBranchCustomer(org: ScratchOrg, name: string): Promise<{ customerId: string; branchId: string }> {
  const branchId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Branch B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  const customerId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${customerId}, ${org.orgId}, 'customer', ${name}, ${branchId}, true, '{}'::jsonb)`);
  return { customerId, branchId };
}

async function seedPlan(org: ScratchOrg, actorId: string): Promise<string> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Entity Plan', '100.00', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})
  `);
  return planId;
}

async function seedSubscription(
  org: ScratchOrg,
  actorId: string,
  planId: string,
  customerId: string,
  opts: { startOn?: string; nextBillOn?: string; autoPost?: boolean } = {},
): Promise<string> {
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${customerId}, ${planId}, '1', 'active',
            ${opts.startOn ?? org.date}, ${opts.nextBillOn ?? org.date},
            ${opts.autoPost ?? false}, ${actorId})
  `);
  return subscriptionId;
}

async function invoiceSubsidiary(orgId: string, invoiceId: string): Promise<{ subsidiaryId: string | null; orgId: string }> {
  const row = (await db.execute<{ subsidiaryId: string | null; orgId: string }>(sql`
    select d.subsidiary_id as "subsidiaryId", sub.org_id as "orgId"
      from documents d left join subsidiaries sub on sub.id = d.subsidiary_id
     where d.id = ${invoiceId} and d.org_id = ${orgId}
  `)).rows[0];
  assert.ok(row, "the billed invoice must exist");
  return { subsidiaryId: row.subsidiaryId, orgId: row.orgId ?? orgId };
}

test(
  "bill-now invoices the customer's own entity, falling back to root only for org-wide customers",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const planId = await seedPlan(org, actorId);
      const branch = await seedBranchCustomer(org, "Branch B Customer");
      // The bill-now route (web/app/api/subscriptions) authorizes by this
      // same customer entity, so the engine must post to it too.
      const branchSub = await seedSubscription(org, actorId, planId, branch.customerId);
      const rootSub = await seedSubscription(org, actorId, planId, org.customerId);

      const branchGen = await billSubscriptionNow(branchSub, org.date, { actorId });
      const branchInvoice = await invoiceSubsidiary(org.orgId, branchGen.invoiceId);
      assert.equal(branchInvoice.subsidiaryId, branch.branchId, "customer B's invoice must carry branch B, not the root");
      assert.equal(branchInvoice.orgId, org.orgId, "no cross-org entity may leak onto the invoice");

      const rootGen = await billSubscriptionNow(rootSub, org.date, { actorId });
      const rootInvoice = await invoiceSubsidiary(org.orgId, rootGen.invoiceId);
      assert.equal(rootInvoice.subsidiaryId, org.subsidiaryId, "a null-entity (org-wide) customer keeps the root fallback");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the scheduler tick invoices the customer's own entity (SUB_SELECT claim path)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const planId = await seedPlan(org, actorId);
      const branch = await seedBranchCustomer(org, "Branch B Scheduled");
      const subscriptionId = await seedSubscription(org, actorId, planId, branch.customerId);

      const run = await runDueSubscriptions(org.date);
      assert.equal(run.failed, 0);
      assert.equal(run.billed, 1);
      const invoiceId = (await db.execute<{ id: string }>(sql`
        select last_invoice_id as "id" from subscriptions where id = ${subscriptionId}
      `)).rows[0]!.id;
      assert.equal(
        (await invoiceSubsidiary(org.orgId, invoiceId)).subsidiaryId,
        branch.branchId,
        "the scheduled invoice must carry branch B, not the root",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "change-subscription proration carries the customer's own entity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const planId = await seedPlan(org, actorId);
      const branch = await seedBranchCustomer(org, "Branch B Churn");
      const subscriptionId = await seedSubscription(org, actorId, planId, branch.customerId, {
        startOn: "2026-07-01",
        nextBillOn: "2026-08-01",
      });

      const changed = await changeSubscription(subscriptionId, { quantity: "2" }, "2026-07-15", { actorId });
      assert.ok(changed.invoiceId, "the upgrade must cut a proration invoice");
      assert.equal(
        (await invoiceSubsidiary(org.orgId, changed.invoiceId!)).subsidiaryId,
        branch.branchId,
        "the proration invoice must carry branch B, not the root",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "first-period proration carries the customer's own entity",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const planId = await seedPlan(org, actorId);
      const branch = await seedBranchCustomer(org, "Branch B Starter");
      const subscriptionId = await seedSubscription(org, actorId, planId, branch.customerId, {
        startOn: "2026-07-10",
        nextBillOn: "2026-07-10",
      });

      const gen = await prorateFirstInvoice(subscriptionId, "2026-08-01", "2026-07-15", { actorId });
      assert.equal(
        (await invoiceSubsidiary(org.orgId, gen.invoiceId)).subsidiaryId,
        branch.branchId,
        "the first-period invoice must carry branch B, not the root",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an inactive customer entity refuses by name with zero mutations — never the root",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const planId = await seedPlan(org, actorId);
      const branch = await seedBranchCustomer(org, "Branch B Dormant");
      const subscriptionId = await seedSubscription(org, actorId, planId, branch.customerId);
      await db.execute(sql`update subsidiaries set is_active = false where id = ${branch.branchId}`);
      const before = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind in ('customer_invoice', 'customer_credit')
      `)).rows[0]!.n;

      await assert.rejects(
        billSubscriptionNow(subscriptionId, org.date, { actorId }),
        (e: unknown) =>
          e instanceof SubscriptionError &&
          /not active/.test(e.message) &&
          /reassign the customer/.test(e.message),
        "must refuse by name and point at the party-record remedy",
      );

      const after = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind in ('customer_invoice', 'customer_credit')
      `)).rows[0]!.n;
      assert.equal(after, Number(before), "no invoice may be cut to the root for an untrusted entity");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
