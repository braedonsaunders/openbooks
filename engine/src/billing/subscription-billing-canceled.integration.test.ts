import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  billSubscriptionNow,
  prorateFirstInvoice,
  runDueSubscriptions,
  SubscriptionError,
} from "./subscription-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedSubscription(
  org: ScratchOrg,
  actorId: string,
  opts: { status?: string; autoPost?: boolean; startOn?: string; nextBillOn?: string } = {},
): Promise<string> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Canceled-guard Plan', '100.00', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})
  `);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1',
            ${opts.status ?? "active"},
            ${opts.startOn ?? org.date}, ${opts.nextBillOn ?? org.date},
            ${opts.autoPost ?? true}, ${actorId})
  `);
  return subscriptionId;
}

async function mutationSnapshot(orgId: string, subscriptionId: string) {
  const docs = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind in ('customer_invoice', 'customer_credit')
  `)).rows[0]!.n;
  const journals = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}
  `)).rows[0]!.n;
  const guards = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from subscription_period_invoices
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
  `)).rows[0]!.n;
  const sub = (await db.execute<{ runCount: number; lastInvoiceId: string | null }>(sql`
    select run_count as "runCount", last_invoice_id as "lastInvoiceId"
      from subscriptions where id = ${subscriptionId}
  `)).rows[0]!;
  return { docs: Number(docs), journals: Number(journals), guards: Number(guards), runCount: Number(sub.runCount), lastInvoiceId: sub.lastInvoiceId };
}

async function assertRefusesCanceled(promise: Promise<unknown>, path: string): Promise<void> {
  await assert.rejects(
    promise,
    (e: unknown) =>
      e instanceof SubscriptionError &&
      /subscription is canceled/.test(e.message) &&
      /active/.test(e.message),
    `${path} must refuse a canceled subscription and name the remedy`,
  );
}

for (const autoPost of [true, false]) {
  test(
    `billSubscriptionNow refuses a canceled subscription (autoPost ${autoPost ? "on" : "off"}) with zero mutations`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      try {
        const actorId = await createScratchUser(org.orgId, "Billing", "admin");
        const subscriptionId = await seedSubscription(org, actorId, { status: "canceled", autoPost });
        const before = await mutationSnapshot(org.orgId, subscriptionId);

        await assertRefusesCanceled(
          billSubscriptionNow(subscriptionId, org.date, { actorId }),
          "billSubscriptionNow",
        );

        const after = await mutationSnapshot(org.orgId, subscriptionId);
        assert.deepEqual(after, before, "no document, journal, period-guard, or run_count mutation on a canceled bill-now");
      } finally {
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
}

test(
  "prorateFirstInvoice refuses a canceled subscription with zero mutations",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedSubscription(org, actorId, { status: "canceled", autoPost: true });
      const before = await mutationSnapshot(org.orgId, subscriptionId);

      await assertRefusesCanceled(
        prorateFirstInvoice(subscriptionId, "2026-09-15", org.date, { actorId }),
        "prorateFirstInvoice",
      );

      const after = await mutationSnapshot(org.orgId, subscriptionId);
      assert.deepEqual(after, before, "no document, journal, period-guard, or run_count mutation on a canceled first proration");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the scheduler skips canceled subscriptions without failing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const subscriptionId = await seedSubscription(org, actorId, { status: "canceled", autoPost: true });
      const before = await mutationSnapshot(org.orgId, subscriptionId);

      const result = await runDueSubscriptions(org.date);
      assert.equal(result.billed, 0);
      assert.equal(result.failed, 0);

      assert.deepEqual(await mutationSnapshot(org.orgId, subscriptionId), before);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "active controls: bill-now bills once and replays the same invoice without new documents",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedSubscription(org, actorId, { status: "active", autoPost: true });

      const first = await billSubscriptionNow(subscriptionId, org.date, { actorId });
      assert.ok(first.invoiceId);
      assert.equal(first.posted, true);
      const mid = await mutationSnapshot(org.orgId, subscriptionId);
      assert.equal(mid.docs, 1);

      const replay = await billSubscriptionNow(subscriptionId, org.date, { actorId });
      assert.equal(replay.invoiceId, first.invoiceId, "same-occurrence replay returns the committed invoice");
      assert.deepEqual(
        await mutationSnapshot(org.orgId, subscriptionId),
        { ...mid, runCount: mid.runCount + 1 },
        "replay creates no new document, journal, or guard row",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "paused subscriptions keep manual bill-now (scheduled-only pause is not imposed here)",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedSubscription(org, actorId, { status: "paused", autoPost: false });

      const gen = await billSubscriptionNow(subscriptionId, org.date, { actorId });
      assert.ok(gen.invoiceId, "paused bill-now still bills: pause gates the scheduler only");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
