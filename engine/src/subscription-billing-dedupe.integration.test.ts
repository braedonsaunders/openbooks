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
  "an interrupted billing tick consumes nothing — the next tick retries and completes it",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Scheduler", "admin");
      const subscriptionId = await seedPlainSubscription(org, actorId);

      // Force a mid-billing failure AFTER the claim: posting refuses an org
      // whose control accounts are unconfigured, which createSubscriptionInvoice
      // hits only once the draft document and its lines are already inserted.
      // Atomicity makes that indistinguishable from a hard process kill between
      // claiming and billing — nothing about the claim may become durable,
      // or a crash would strand an advanced next_bill_on with no invoice and
      // permanently lose this billable period.
      const settings = (await db.execute<{ s: Record<string, unknown> }>(sql`
        select settings as s from orgs where id = ${org.orgId}
      `)).rows[0]!.s;
      await db.execute(sql`
        update orgs set settings = settings - 'controlAccounts' where id = ${org.orgId}
      `);

      const run = await runDueSubscriptions(org.date);
      assert.equal(run.failed, 1);
      const state = (await db.execute<{
        nextBillOn: string;
        currentPeriodStart: string | null;
        lastError: string | null;
        runCount: number;
        lastInvoiceId: string | null;
      }>(sql`
        select next_bill_on as "nextBillOn", current_period_start as "currentPeriodStart",
               last_error as "lastError", run_count as "runCount", last_invoice_id as "lastInvoiceId"
          from subscriptions where id = ${subscriptionId}
      `));
      assert.equal(state.rows[0]!.nextBillOn, org.date, "the occurrence stays due for the next tick");
      assert.equal(state.rows[0]!.currentPeriodStart, null, "the period pointer was never moved");
      assert.ok(state.rows[0]!.lastError, "last_error names the failure");
      assert.equal(state.rows[0]!.runCount, 0, "no success bookkeeping leaked from the failed tick");
      assert.equal(state.rows[0]!.lastInvoiceId, null);
      assert.equal(await postedInvoiceCount(org.orgId), 0);
      assert.equal(await journalEntryCount(org.orgId), 0);
      assert.equal((await guardRows(org.orgId, subscriptionId)).length, 0,
        "a failed attempt never consumes the period");

      // The crash-window regression: whatever killed the first attempt (here a
      // mid-billing throw; equally a SIGKILL — no durable claim exists to
      // strand), the next tick must complete the SAME occurrence exactly once.
      await db.execute(sql`
        update orgs set settings = ${JSON.stringify(settings)}::jsonb where id = ${org.orgId}
      `);
      await db.execute(sql`update subscriptions set last_error = null where id = ${subscriptionId}`);
      const retry = await runDueSubscriptions(org.date);
      assert.equal(retry.failed, 0);
      assert.equal(retry.billed, 1, "the retried tick bills the missed occurrence");
      assert.equal(retry.posted, 1);
      assert.equal(await postedInvoiceCount(org.orgId), 1, "exactly one invoice ever exists");
      assert.equal(await journalEntryCount(org.orgId), 1, "the ledger was hit exactly once");
      const guard = await guardRows(org.orgId, subscriptionId);
      assert.equal(guard.length, 1);
      assert.equal(guard[0]!.startsOn, org.date);
      assert.equal(guard[0]!.endsOn, "2026-08-15");
      const retriedState = (await db.execute<{ nextBillOn: string; runCount: number }>(sql`
        select next_bill_on as "nextBillOn", run_count as "runCount" from subscriptions where id = ${subscriptionId}
      `));
      assert.notEqual(retriedState.rows[0]!.nextBillOn, org.date, "the claim now advances");
      assert.equal(retriedState.rows[0]!.runCount, 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "concurrent scheduler ticks converge on exactly one invoice for the due period",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      const subscriptionId = await seedPlainSubscription(org, actorId);

      // Two scheduler instances race the same due occurrence: both pass the
      // scan, but only one can win the compare-and-swap claim inside the
      // billing transaction — the loser re-evaluates the claim against the
      // committed schedule and claims zero rows.
      const [a, b] = await Promise.all([
        runDueSubscriptions(org.date),
        runDueSubscriptions(org.date),
      ]);
      assert.equal(a.billed + b.billed, 1, "exactly one tick bills the occurrence");
      for (const run of [a, b]) assert.equal(run.failed, 0);
      assert.equal(await postedInvoiceCount(org.orgId), 1);
      assert.equal(await journalEntryCount(org.orgId), 1);
      assert.equal((await guardRows(org.orgId, subscriptionId)).length, 1);
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
