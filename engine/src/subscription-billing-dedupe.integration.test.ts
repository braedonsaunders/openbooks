import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { billSubscriptionNow, runDueSubscriptions } from "./subscription-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Seed a PLAIN plan-based subscription (no lifecycle): exactly the path that
 * used to fall through billOne with no dedupe guard and could double-bill when
 * a retried tick re-claimed an already-billed period.
 */
async function seedPlainSubscription(
  org: ScratchOrg,
  actorId: string,
  opts: { nextBillOn?: string; autoPost?: boolean } = {},
): Promise<string> {
  // The billing feature gate rides on the org settings next to controlAccounts.
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Dedupe Plan', '100.00', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})
  `);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            ${opts.nextBillOn ?? org.date}, ${opts.nextBillOn ?? org.date},
            ${opts.autoPost ?? true}, ${actorId})
  `);
  return subscriptionId;
}

async function postedInvoiceCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from documents
     where org_id = ${orgId} and kind = 'customer_invoice' and status = 'posted'
  `));
  return Number(r.rows[0]!.n);
}

async function journalEntryCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}
  `));
  return Number(r.rows[0]!.n);
}

async function guardRows(orgId: string, subscriptionId: string): Promise<{ startsOn: string; endsOn: string; revision: number; invoiceId: string }[]> {
  const r = (await db.execute<{ startsOn: string; endsOn: string; revision: number; invoiceId: string }>(sql`
    select period_starts_on as "startsOn", period_ends_on as "endsOn",
           contract_revision as "revision", invoice_id as "invoiceId"
      from subscription_period_invoices
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
     order by period_starts_on
  `));
  return r.rows;
}

/** Re-create the defect window: the claim was rolled back AFTER a posted invoice committed. */
async function restoreClaim(subscriptionId: string, occurrenceOn: string): Promise<void> {
  await db.execute(sql`
    update subscriptions
       set next_bill_on = ${occurrenceOn}, current_period_start = null, last_billed_at = null
     where id = ${subscriptionId}
  `);
}

test(
  "a plain-plan tick retrying an already-billed period replays the same invoice instead of double-billing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedPlainSubscription(org, actorId);

      const first = await runDueSubscriptions(org.date);
      assert.equal(first.failed, 0);
      assert.equal(first.billed, 1);
      assert.equal(first.posted, 1);
      assert.equal(await postedInvoiceCount(org.orgId), 1);
      assert.equal(await journalEntryCount(org.orgId), 1);
      const firstInvoiceId = (await db.execute<{ id: string }>(sql`
        select last_invoice_id as "id" from subscriptions where id = ${subscriptionId}
      `)).rows[0]!.id;

      // Plain subscriptions now record their period through the SAME
      // subscription_period_invoices guard the advanced lifecycle uses.
      const guard = await guardRows(org.orgId, subscriptionId);
      assert.equal(guard.length, 1);
      assert.equal(guard[0]!.startsOn, org.date);
      assert.equal(guard[0]!.endsOn, "2026-08-15", "the plain-sub key is the service month starting on the billed date");
      assert.equal(guard[0]!.invoiceId, firstInvoiceId);

      // The pre-fix double-bill state: success bookkeeping failed after the
      // post and the catch restored the claim to the billed date.
      await restoreClaim(subscriptionId, org.date);
      const second = await runDueSubscriptions(org.date);
      assert.equal(second.failed, 0);
      assert.equal(second.billed, 1, "the retry still reports the replayed billing");
      assert.equal(second.posted, 1);
      assert.equal(await postedInvoiceCount(org.orgId), 1, "exactly one invoice exists for the period");
      assert.equal(await journalEntryCount(org.orgId), 1, "the ledger was hit exactly once");
      assert.equal((await guardRows(org.orgId, subscriptionId)).length, 1);
      const lastInvoiceId = (await db.execute<{ id: string }>(sql`
        select last_invoice_id as "id" from subscriptions where id = ${subscriptionId}
      `)).rows[0]!.id;
      assert.equal(lastInvoiceId, firstInvoiceId, "bookkeeping points at the same committed invoice");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "concurrent bill-now attempts for the same period converge on one invoice",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedPlainSubscription(org, actorId);

      // A double-click on "bill now": both serialize on the subscription row
      // lock inside billOne, the loser replays the winner's committed guard.
      const [a, b] = await Promise.all([
        billSubscriptionNow(subscriptionId, org.date),
        billSubscriptionNow(subscriptionId, org.date),
      ]);
      assert.equal(a.invoiceId, b.invoiceId, "both callers observe the same invoice");
      assert.equal(await postedInvoiceCount(org.orgId), 1);
      assert.equal(await journalEntryCount(org.orgId), 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
