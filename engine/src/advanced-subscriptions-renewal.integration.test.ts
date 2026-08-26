import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  activateLifecycle,
  applyAmendment,
  createPlanVersion,
  prepareAdvancedSubscriptionBilling,
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
import { SYSTEM_ACTOR_ID } from "./banking.ts";
import { runDueSubscriptions } from "./subscription-billing.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Scheduled renewal provenance (fnd_mt97nsbf_qvlaww): the scheduler's
 * auto-renewal must never borrow `subscriptions.created_by` as its amendment
 * actor, and a null-author imported subscription must renew instead of being
 * refused. Every proof below is read straight out of the subscription_amendments
 * table — applied_by / created_by / updated_by plus the persisted immutable
 * request snapshot — so the amendment evidence stands on its own and is
 * distinct from any document-level attribution.
 */

/**
 * Seed an advanced auto-renew contract whose next due date IS its term end
 * (the imported/backlog shape: months elapsed without a scheduler tick), so
 * one runDueSubscriptions pass crosses the renewal boundary.
 */
async function seedRenewableSubscription(
  org: ScratchOrg,
  creatorId: string | null,
): Promise<string> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Renewal Plan', '0', 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${creatorId})
  `);
  const versionId = await createPlanVersion(org.orgId, creatorId ?? SYSTEM_ACTOR_ID, {
    planId,
    effectiveFrom: "2026-05-01",
    components: [
      {
        componentKey: "platform",
        name: "Platform fee",
        quantity: "1",
        unitPrice: "100.00",
        incomeAccountId: org.accounts.revenue,
      },
    ],
  });
  await publishPlanVersion(org.orgId, creatorId ?? SYSTEM_ACTOR_ID, versionId);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on,
       auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, '1', 'active',
            '2026-05-15', '2026-05-15', false, ${creatorId})
  `);
  await activateLifecycle(org.orgId, creatorId ?? SYSTEM_ACTOR_ID, {
    subscriptionId,
    planVersionId: versionId,
    termStartsOn: "2026-05-15",
    termEndsOn: "2026-06-15",
    renewalPolicy: "auto",
    renewalTermMonths: 12,
  });
  // Simulate the month gap between the lifecycle start and today's overdue
  // tick: the scheduler's own dues gate (dueOn = next_bill_on) must land on
  // the term boundary so this single pass performs the scheduled renewal.
  await db.execute(sql`
    update subscriptions set next_bill_on = '2026-06-15' where id = ${subscriptionId}
  `);
  return subscriptionId;
}

interface AmendmentEvidence extends Record<string, unknown> {
  id: string;
  amendmentType: string;
  status: string;
  idempotencyKey: string;
  reason: string | null;
  appliedBy: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  sourceKind: string | null;
  sourceOrigin: string | null;
  sourceDueOn: string | null;
  requestType: string | null;
}

async function renewalAmendments(orgId: string, subscriptionId: string): Promise<AmendmentEvidence[]> {
  const rows = (await db.execute<AmendmentEvidence>(sql`
    select id::text as id,
           amendment_type as "amendmentType",
           status,
           idempotency_key as "idempotencyKey",
           reason,
           applied_by::text as "appliedBy",
           created_by::text as "createdBy",
           updated_by::text as "updatedBy",
           request->>'type' as "requestType",
           request->'source'->>'kind' as "sourceKind",
           request->'source'->>'origin' as "sourceOrigin",
           request->'source'->>'dueOn' as "sourceDueOn"
      from subscription_amendments
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
     order by amendment_number
  `));
  return rows.rows;
}

/**
 * Per-subscription scheduling evidence. runDueSubscriptions scans every due
 * production-kind org in the shared test database, so its aggregate counters
 * say nothing about this slice's subscription — assert on these rows instead.
 */
async function subscriptionState(orgId: string, subscriptionId: string): Promise<{
  lastError: string | null;
  periodInvoices: number;
}> {
  const row = (await db.execute<{ lastError: string | null; periodInvoices: number }>(sql`
    select s.last_error as "lastError",
           (select count(*)::int from subscription_period_invoices pi
             where pi.org_id = ${orgId} and pi.subscription_id = ${subscriptionId}) as "periodInvoices"
      from subscriptions s
     where s.id = ${subscriptionId} and s.org_id = ${orgId}
  `));
  return row.rows[0]!;
}

test(
  "a scheduled renewal of a null-author imported subscription succeeds with system provenance",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const subscriptionId = await seedRenewableSubscription(org, null);

      await runDueSubscriptions(org.date);
      const state = await subscriptionState(org.orgId, subscriptionId);
      assert.equal(state.lastError, null, "a null-author import must renew without an owning user");
      assert.ok(state.periodInvoices >= 1, "billing completed after the scheduled renewal");

      const amendments = await renewalAmendments(org.orgId, subscriptionId);
      assert.equal(amendments.length, 1);
      const evidence = amendments[0]!;
      assert.equal(evidence.amendmentType, "renew");
      assert.equal(evidence.status, "applied");
      assert.equal(evidence.requestType, "renew");
      assert.match(evidence.idempotencyKey, /^auto-renew:/, "the deterministic scheduler key is preserved");
      assert.equal(evidence.reason, "Automatic renewal");

      // The amendment row itself carries the system actor — not NULL, not a
      // real operator, satisfying the applied-attribution constraint.
      assert.equal(evidence.appliedBy, SYSTEM_ACTOR_ID);
      assert.equal(evidence.createdBy, SYSTEM_ACTOR_ID);
      assert.equal(evidence.updatedBy, SYSTEM_ACTOR_ID);

      // The durable scheduler source/run marker rides in the same row; the
      // recorded dueOn is the dues-gate value that triggered this run (the
      // term boundary itself, exactly what a replay investigator needs).
      assert.equal(evidence.sourceKind, "system");
      assert.equal(evidence.sourceOrigin, "subscription-billing-scheduler");
      assert.equal(evidence.sourceDueOn, "2026-06-15");

      const lifecycle = (await db.execute<{ termEndsOn: string; revision: number }>(sql`
        select term_ends_on as "termEndsOn", contract_revision as revision
          from subscription_lifecycles
         where org_id = ${org.orgId} and subscription_id = ${subscriptionId}
      `)).rows[0]!;
      assert.equal(lifecycle.termEndsOn, "2027-06-15", "the term advanced by the renewal term months");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a scheduled renewal never impersonates the subscription's historical creator",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const creatorId = await createScratchUser(org.orgId, "Historical creator", "admin");
      const subscriptionId = await seedRenewableSubscription(org, creatorId);

      await runDueSubscriptions(org.date);
      const state = await subscriptionState(org.orgId, subscriptionId);
      assert.equal(state.lastError, null);

      const [evidence] = await renewalAmendments(org.orgId, subscriptionId);
      assert.ok(evidence, "the auto-renewal produced an amendment");
      assert.notEqual(evidence.appliedBy, creatorId, "the creator must never be attributed to a background run");
      assert.notEqual(evidence.createdBy, creatorId);
      assert.equal(evidence.appliedBy, SYSTEM_ACTOR_ID);
      assert.equal(evidence.sourceKind, "system");
      assert.equal(evidence.sourceOrigin, "subscription-billing-scheduler");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an interactive renewal still records the permission gate's authenticated user",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const gateUserId = await createScratchUser(org.orgId, "Gate operator", "admin");
      const subscriptionId = await seedRenewableSubscription(org, null);

      const result = await applyAmendment(org.orgId, gateUserId, {
        subscriptionId,
        type: "renew",
        effectiveOn: org.date,
        renewalTermMonths: 12,
        idempotencyKey: `interactive-renew:${subscriptionId}:${org.date}`,
        reason: "Operator renewed the contract",
      });
      assert.equal(result.replayed, false);

      const [evidence] = await renewalAmendments(org.orgId, subscriptionId);
      assert.ok(evidence);
      assert.equal(evidence.appliedBy, gateUserId);
      assert.equal(evidence.createdBy, gateUserId);
      assert.equal(evidence.updatedBy, gateUserId);
      assert.equal(evidence.sourceKind, null, "interactive amendments carry no system marker");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an interrupted scheduled renewal commits nothing and replays cleanly through the same deterministic key",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const subscriptionId = await seedRenewableSubscription(org, null);
    // Scoped to exactly this subscription's UUID so a failing assertion can
    // never poison renewals elsewhere on the shared test database.
    const suffix = subscriptionId.replaceAll("-", "").slice(0, 12);
    const functionName = `openbooks_test_fail_renewal_${suffix}`;
    const triggerName = `openbooks_test_fail_renewal_${suffix}`;
    const teardown = async () => {
      await db.execute(sql.raw(`drop trigger if exists ${triggerName} on public.subscription_amendments`));
      await db.execute(sql.raw(`drop function if exists public.${functionName}()`));
    };
    try {
      await db.execute(sql.raw(`
        create function public.${functionName}() returns trigger
        language plpgsql as $$
        begin
          raise exception 'forced scheduled-renewal failure';
        end
        $$
      `));
      await db.execute(sql.raw(`
        create trigger ${triggerName}
        before insert on public.subscription_amendments
        for each row
        when (new.amendment_type = 'renew' and new.subscription_id = '${subscriptionId}'::uuid)
        execute function public.${functionName}()
      `));

      // The scheduler surfaces the failure through last_error; nothing about
      // the amendment, the lifecycle mutation, or the claim may survive.
      // (Drizzle wraps the driver error, so the stored message is its failed
      // query preamble — the trigger's own text lives on the cause.)
      await runDueSubscriptions(org.date);
      const broken = await subscriptionState(org.orgId, subscriptionId);
      assert.match(broken.lastError ?? "", /Failed query.*subscription_amendments/s);
      assert.equal(broken.periodInvoices, 0, "nothing was billed behind the refused amendment");

      const before = (await db.execute<{
        amendments: number;
        termEndsOn: string | null;
        revision: number;
        nextBillOn: string;
      }>(sql`
        select (select count(*) from subscription_amendments
                 where org_id = ${org.orgId} and subscription_id = ${subscriptionId})::int as amendments,
               l.term_ends_on as "termEndsOn", l.contract_revision as revision,
               s.next_bill_on as "nextBillOn"
          from subscriptions s join subscription_lifecycles l
            on l.subscription_id = s.id and l.org_id = s.org_id
         where s.id = ${subscriptionId}
      `)).rows[0]!;
      assert.equal(before.amendments, 0, "no orphan amendment survives a failed renewal");
      assert.equal(before.termEndsOn, "2026-06-15", "the contract did not extend behind the failed amendment");
      assert.equal(before.revision, 1, "the revision still reads as activated — the renew's bump rolled back");
      assert.equal(before.nextBillOn, "2026-06-15", "the billing claim rolled back with the transaction");

      await teardown();

      // The retry renews once, through the same deterministic idempotency key.
      await runDueSubscriptions(org.date);
      const retry = await subscriptionState(org.orgId, subscriptionId);
      assert.equal(retry.lastError, null);
      const amendments = await renewalAmendments(org.orgId, subscriptionId);
      assert.equal(amendments.length, 1);
      assert.match(amendments[0]!.idempotencyKey, new RegExp(`^auto-renew:${subscriptionId}:2026-06-15$`));
      assert.equal(amendments[0]!.appliedBy, SYSTEM_ACTOR_ID);
      assert.ok(retry.periodInvoices >= 1, "the retried tick billed through the renewed contract");
    } finally {
      await teardown();
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "prepare itself stamps system provenance and no longer refuses missing authors",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const subscriptionId = await seedRenewableSubscription(org, null);
      // Driven directly so a regression in prepareAdvancedSubscriptionBilling's
      // own attribution logic fails fast with the original defect's error text.
      const prepared = await prepareAdvancedSubscriptionBilling(org.orgId, subscriptionId, org.date);
      assert.equal(prepared, true, "a due auto-renew contract is billable regardless of authorship");
      const [evidence] = await renewalAmendments(org.orgId, subscriptionId);
      assert.ok(evidence, "prepare itself appended the scheduler renewal amendment");
      assert.equal(evidence.appliedBy, SYSTEM_ACTOR_ID);
      assert.equal(evidence.createdBy, SYSTEM_ACTOR_ID);
      assert.equal(evidence.updatedBy, SYSTEM_ACTOR_ID);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
