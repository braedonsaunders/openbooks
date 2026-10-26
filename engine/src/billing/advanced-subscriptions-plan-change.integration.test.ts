import { installEngineSeams } from "../composition/install.ts";
installEngineSeams();
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import {
  activateLifecycle,
  applyAmendment,
  createPlanVersion,
  publishPlanVersion,
} from "./advanced-subscriptions.ts";
import { contractRecurringAmounts, runDueSubscriptions } from "./subscription-billing.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Contract plan change: a contract moves to a published version of another
 * plan from an effective date. Invoiced periods keep their prices, the
 * components re-seed from the new version, the change is recorded once per
 * idempotency key, and MRR reads the plan in force on each date.
 */

async function seedPlanVersion(
  org: ScratchOrg,
  actorId: string,
  input: {
    name: string;
    unitPrice: string;
    currency?: string;
    interval?: "monthly" | "annually";
    effectiveFrom?: string;
  },
): Promise<{ planId: string; versionId: string }> {
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, ${input.name}, '0', ${input.currency ?? "CAD"}, ${input.interval ?? "monthly"}, 1,
            ${org.accounts.revenue}, true, ${actorId})
  `);
  const versionId = await createPlanVersion(
    org.orgId,
    actorId,
    {
      planId,
      effectiveFrom: input.effectiveFrom ?? "2026-05-01",
      interval: input.interval,
      components: [
        {
          componentKey: "platform",
          name: "Platform fee",
          quantity: "1",
          unitPrice: input.unitPrice,
          incomeAccountId: org.accounts.revenue,
        },
      ],
    },
    null,
  );
  await publishPlanVersion(org.orgId, actorId, versionId, null);
  return { planId, versionId };
}

/** A contract on plan A starting 2026-05-15, invoiced once so its paid-through date is 2026-06-15. */
async function seedBilledContract(org: ScratchOrg, actorId: string) {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb) || '{"subscriptionBilling":true,"advancedSubscriptions":true}'::jsonb)
    where id=${org.orgId}`);
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    select ${randomUUID()}, ${org.orgId}, 2026, 5, '2026-05', '2026-05-01', '2026-05-31', false, fiscal_calendar_id
      from accounting_periods where id = ${org.periodId} and org_id = ${org.orgId}`);
  const plan = await seedPlanVersion(org, actorId, { name: "Plan A", unitPrice: "100.00" });
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${plan.planId}, '1', 'active',
            '2026-05-15', '2026-05-15', true, ${actorId})
  `);
  await activateLifecycle(org.orgId, actorId, {
    subscriptionId,
    planVersionId: plan.versionId,
    termStartsOn: "2026-05-15",
    renewalPolicy: "none",
  });
  const run = await withOrgContext(org.orgId, () => runDueSubscriptions("2026-05-15"));
  const billed = (
    await db.execute<{ next_bill_on: string; last_error: string | null }>(
      sql`
    select next_bill_on::text, last_error from subscriptions
     where org_id = ${org.orgId} and id = ${subscriptionId}`,
      "objects",
    )
  )[0]!;
  assert.equal(run.failed, 0, billed.last_error ?? "the first contract invoice must succeed");
  assert.equal(run.billed, 1);
  assert.equal(run.posted, 1);
  assert.equal(billed.next_bill_on, "2026-06-15");
  return { subscriptionId, planA: plan };
}

async function lifecycleVersion(orgId: string, subscriptionId: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select plan_version_id as id from subscription_lifecycles where org_id = ${orgId} and subscription_id = ${subscriptionId}
  `,
      "objects",
    )
  )[0]!.id;
}

test(
  "a plan change on the paid-through date re-seeds the components and records one amendment per key",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Plan editor", "admin");
      const { subscriptionId, planA } = await seedBilledContract(org, actorId);
      const planB = await seedPlanVersion(org, actorId, { name: "Plan B", unitPrice: "250.00" });
      const request = {
        subscriptionId,
        type: "change_plan" as const,
        effectiveOn: "2026-06-15",
        idempotencyKey: randomUUID(),
        planVersionId: planB.versionId,
        reason: "Customer upgraded to the premium platform",
      };

      const first = await applyAmendment(org.orgId, actorId, request, {
        allowedSubsidiaryIds: null,
      });
      assert.equal(first.replayed, false);
      assert.equal(await lifecycleVersion(org.orgId, subscriptionId), planB.versionId);

      const windows = await db.execute<{
        unitPrice: string;
        effectiveFrom: string;
        effectiveTo: string | null;
      }>(
        sql`
      select unit_price::text as "unitPrice", effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo"
        from subscription_components where org_id = ${org.orgId} and subscription_id = ${subscriptionId} and component_key = 'platform'
       order by effective_from
    `,
        "objects",
      );
      assert.deepEqual(
        windows.map((row) => [row.unitPrice, row.effectiveFrom, row.effectiveTo]),
        [
          ["100.0000", "2026-05-15", "2026-06-14"],
          ["250.0000", "2026-06-15", null],
        ],
      );

      const planOfRecord = (
        await db.execute<{ planId: string }>(
          sql`
      select plan_id as "planId" from subscriptions where id = ${subscriptionId}
    `,
          "objects",
        )
      )[0]!.planId;
      assert.equal(planOfRecord, planB.planId);
      assert.notEqual(planA.planId, planB.planId);

      const replay = await applyAmendment(org.orgId, actorId, request, {
        allowedSubsidiaryIds: null,
      });
      assert.equal(
        replay.replayed,
        true,
        "the same idempotency key replays without a second change",
      );
      assert.equal(replay.id, first.id);

      await assert.rejects(
        applyAmendment(
          org.orgId,
          actorId,
          { ...request, planVersionId: planA.versionId },
          { allowedSubsidiaryIds: null },
        ),
        /different amendment request/,
        "a reused key carrying another request is refused",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a plan change refuses an effective date before the paid-through date and a currency change",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Plan editor", "admin");
      const { subscriptionId } = await seedBilledContract(org, actorId);
      const usd = await seedPlanVersion(org, actorId, {
        name: "Plan USD",
        unitPrice: "300.00",
        currency: "USD",
      });
      const cad = await seedPlanVersion(org, actorId, { name: "Plan CAD", unitPrice: "300.00" });

      await assert.rejects(
        applyAmendment(
          org.orgId,
          actorId,
          {
            subscriptionId,
            type: "change_plan",
            effectiveOn: "2026-06-01",
            idempotencyKey: randomUUID(),
            planVersionId: cad.versionId,
            reason: "Too early",
          },
          { allowedSubsidiaryIds: null },
        ),
        /precedes the paid-through date 2026-06-15/,
      );
      await assert.rejects(
        applyAmendment(
          org.orgId,
          actorId,
          {
            subscriptionId,
            type: "change_plan",
            effectiveOn: "2026-06-15",
            idempotencyKey: randomUUID(),
            planVersionId: usd.versionId,
            reason: "Wrong currency",
          },
          { allowedSubsidiaryIds: null },
        ),
        /billing currency cannot change mid-contract/,
      );
      assert.notEqual(
        await lifecycleVersion(org.orgId, subscriptionId),
        cad.versionId,
        "a refused change writes nothing",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "MRR reads the plan in force on each date, including a future-dated change of the same cadence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Plan editor", "admin");
      const { subscriptionId } = await seedBilledContract(org, actorId);
      const planB = await seedPlanVersion(org, actorId, { name: "Plan B", unitPrice: "250.00" });
      await applyAmendment(
        org.orgId,
        actorId,
        {
          subscriptionId,
          type: "change_plan",
          effectiveOn: "2026-07-01",
          idempotencyKey: randomUUID(),
          planVersionId: planB.versionId,
          reason: "Scheduled upgrade",
        },
        { allowedSubsidiaryIds: null },
      );

      const before = (await contractRecurringAmounts(org.orgId, "2026-06-30")).get(subscriptionId);
      const after = (await contractRecurringAmounts(org.orgId, "2026-07-01")).get(subscriptionId);
      assert.equal(
        before?.amount,
        "100.0000",
        "before the effective date the predecessor's price is the MRR",
      );
      assert.equal(
        after?.amount,
        "250.0000",
        "from the effective date the new plan's price is the MRR",
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a change of billing cadence is allowed only on the paid-through date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Plan editor", "admin");
      const { subscriptionId } = await seedBilledContract(org, actorId);
      const annual = await seedPlanVersion(org, actorId, {
        name: "Plan Annual",
        unitPrice: "1200.00",
        interval: "annually",
      });

      await assert.rejects(
        applyAmendment(
          org.orgId,
          actorId,
          {
            subscriptionId,
            type: "change_plan",
            effectiveOn: "2026-07-01",
            idempotencyKey: randomUUID(),
            planVersionId: annual.versionId,
            reason: "Cadence change too late",
          },
          { allowedSubsidiaryIds: null },
        ),
        /takes effect only on the paid-through date 2026-06-15/,
      );
      await applyAmendment(
        org.orgId,
        actorId,
        {
          subscriptionId,
          type: "change_plan",
          effectiveOn: "2026-06-15",
          idempotencyKey: randomUUID(),
          planVersionId: annual.versionId,
          reason: "Move to annual billing",
        },
        { allowedSubsidiaryIds: null },
      );
      const annualMrr = (await contractRecurringAmounts(org.orgId, "2026-06-15")).get(
        subscriptionId,
      );
      assert.equal(annualMrr?.interval, "annually");
      assert.equal(annualMrr?.intervalCount, 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
