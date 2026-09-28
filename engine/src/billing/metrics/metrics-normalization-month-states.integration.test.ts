import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { UsageBillingError } from "../usage/errors.ts";
import {
  approveAndExecuteNormalizationRequest,
  approveNormalizationRequest,
  cancelNormalizationRequest,
  claimNormalizationRequest,
  createNormalizationRequest,
  listNormalizationMonthStates,
  type NormalizationMonthStates,
} from "./metrics-normalization-service.ts";
import { computeLegacyV0Month } from "./metrics-ledger.ts";

/**
 * Slice E properties for the single read-only month-state classifier,
 * executed by the repository's database gate. Every state below is reached
 * through the real request lifecycle and real stored rows — never through a
 * classifier double — so a red here means the Settings card would show the
 * wrong month. Refusal cases pin the Company Setup → SaaS Metrics remedy
 * the operator must read.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const MONTH = "2026-07-01";
const REASON = "Correct the July legacy denomination after the packs rollout.";
const V1_EVIDENCE = '{"inputs_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';

interface Fixture {
  org: ScratchOrg;
  requester: string;
  approver: string;
}

async function withFixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const requester = await createScratchUser(org.orgId, "Normalization Reader", "admin");
    const approver = await createScratchUser(org.orgId, "Normalization Decider", "admin");
    await withOrgTransaction(org.orgId, async () => {
      const result = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          settings,
          '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"subscriptionBilling":true,"saasMetrics":true}'::jsonb
        ) where id = ${org.orgId} returning id
      `);
      assert.equal(result.rows.length, 1, "the feature setting must be applied to the scratch organization");
    });
    await run({ org, requester, approver });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function expectRefusal(promise: Promise<unknown>, code: string, remedySnippet: string) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof UsageBillingError, `expected a UsageBillingError, got ${String(error)}`);
    assert.equal(error.code, code, "the refusal names its code");
    assert.ok(
      error.remedy.includes(remedySnippet),
      `the remedy must point at Company Setup → SaaS Metrics, got: ${error.remedy}`,
    );
    return error;
  }
  assert.fail(`expected refusal ${code} but the call succeeded`);
}

async function seedCustomerAndSubscription(ctx: Fixture): Promise<{ customerId: string; subscriptionId: string }> {
  const customerId = randomUUID();
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  await withOrgTransaction(ctx.org.orgId, async () => {
    const customer = await db.execute<{ id: string }>(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${customerId}, ${ctx.org.orgId}, 'customer', 'Metrics Customer', ${ctx.org.subsidiaryId})
      returning id
    `);
    assert.equal(customer.rows.length, 1, "the customer must be stored");
    const plan = await db.execute<{ id: string }>(sql`
      insert into subscription_plans
        (id, org_id, name, amount, currency_code, interval, interval_count, income_account_id, created_by)
      values (${planId}, ${ctx.org.orgId}, 'Metrics plan', '100.0000', 'CAD', 'monthly', 1, null, ${ctx.requester})
      returning id
    `);
    assert.equal(plan.rows.length, 1, "the subscription plan must be stored");
    const subscription = await db.execute<{ id: string }>(sql`
      insert into subscriptions
        (id, org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on, canceled_on, auto_post, created_by)
      values (${subscriptionId}, ${ctx.org.orgId}, ${customerId}, ${planId}, '1', '100.0000',
              'active', '2026-07-01', '2026-08-15', null, false, ${ctx.requester})
      returning id
    `);
    assert.equal(subscription.rows.length, 1, "the subscription must be stored");
  });
  return { customerId, subscriptionId };
}

async function seedLegacyMonth(ctx: Fixture, month: string = MONTH): Promise<void> {
  await seedCustomerAndSubscription(ctx);
  const v0 = await withOrgTransaction(ctx.org.orgId, async () =>
    computeLegacyV0Month(db, ctx.org.orgId, month));
  await withOrgTransaction(ctx.org.orgId, async () => {
    for (const row of v0.monthly) {
      const stored = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_monthly
          (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
           mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
           reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
        values (${ctx.org.orgId}, ${row.subsidiaryId}, ${row.customerId}, ${row.subscriptionId},
                ${row.month}::date, ${row.cohortMonth}::date,
                ${row.mrrStart}, ${row.mrrEnd}, ${row.newMrr}, ${row.expansionMrr},
                ${row.contractionMrr}, ${row.churnedMrr}, ${row.reactivationMrr}, ${row.movement},
                ${row.recognizedRevenue}, ${row.deferredDelta}, ${v0.legacyHash})
        returning id
      `);
      assert.equal(stored.rows.length, 1, "the legacy monthly row must be stored");
    }
    for (const row of v0.facts) {
      const stored = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_facts_monthly
          (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
           contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
           mrr_at_risk, customers_start, customers_end, customers_new, customers_churned,
           customers_reactivated, gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash)
        values (${ctx.org.orgId}, ${row.subsidiaryId}, ${row.month}::date,
                ${row.mrrStart}, ${row.mrrEnd}, ${row.newMrr}, ${row.expansionMrr},
                ${row.contractionMrr}, ${row.churnedMrr}, ${row.reactivationMrr},
                ${row.recognizedRevenue}, ${row.deferredDelta}, ${row.mrrAtRisk},
                ${row.customersStart}, ${row.customersEnd},
                ${row.customersNew}, ${row.customersChurned}, ${row.customersReactivated},
                ${row.glRevenue}, ${row.glCogs}, ${row.bookings}, ${row.billings}, ${row.deferredBalance},
                ${row.basis}, ${v0.legacyHash})
        returning id
      `);
      assert.equal(stored.rows.length, 1, "the legacy facts row must be stored");
    }
    for (const row of v0.cohorts) {
      const stored = await db.execute<{ id: string }>(sql`
        insert into saas_metrics_cohort_monthly
          (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
           start_customers, customers, inputs_hash)
        values (${ctx.org.orgId}, ${row.subsidiaryId}, ${row.cohortMonth}::date, ${row.month}::date,
                ${row.monthsSinceStart}, ${row.startMrr}, ${row.mrr},
                ${row.startCustomers}, ${row.customers}, ${v0.legacyHash})
        returning id
      `);
      assert.equal(stored.rows.length, 1, "the legacy cohort row must be stored");
    }
  });
}

async function fileRequest(ctx: Fixture, month: string = MONTH) {
  return createNormalizationRequest({
    orgId: ctx.org.orgId,
    month,
    reason: REASON,
    requestedBy: ctx.requester,
    idempotencyKey: randomUUID(),
  });
}

function onlyMonth(states: NormalizationMonthStates[], month: string): NormalizationMonthStates {
  const found = states.filter((state) => state.month === month);
  assert.equal(found.length, 1, `exactly one state row must describe ${month}`);
  return found[0]!;
}

test("a stored legacy month reads legacy with row counts and no request", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "legacy");
    assert.deepEqual(state.counts, { monthly: 1, facts: 1, cohorts: 1 });
    assert.equal(state.denominationVersion, null);
    assert.equal(state.reportingCurrency, null);
    assert.equal(state.request, null);
    assert.equal(state.failure, null);
    assert.equal(state.remedy, null);
  });
});

test("a filed request reads pending with its token-free identity", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "pending");
    assert.deepEqual(state.request, { id: filed.request.id, status: "pending" });
    assert.equal(state.failure, null);
    assert.equal(state.remedy, null);
  });
});

test("an approved and claimed request reads running", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "running");
    assert.deepEqual(state.request, { id: filed.request.id, status: "running" });
  });
});

test("an executed correction reads ready with result-consistent counts", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    const done = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    assert.equal(done.request.status, "succeeded");
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "ready");
    assert.equal(state.denominationVersion, "v1");
    assert.equal(state.reportingCurrency, done.result.reportingCurrency);
    assert.equal(state.counts.monthly, done.result.subscriptionRows);
    assert.equal(state.counts.monthly, done.result.replacedMonthly);
    assert.equal(state.counts.facts, done.result.replacedFacts);
    assert.equal(state.counts.cohorts, done.result.replacedCohorts);
    assert.deepEqual(state.request, { id: filed.request.id, status: "succeeded" });
  });
});

test("sources that move under a request fail it and read failed with the Setup remedy", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await seedCustomerAndSubscription(ctx);
    await expectRefusal(
      approveAndExecuteNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        approverId: ctx.approver,
      }),
      "saas_normalization_v0_key_drift",
      "Company Setup → SaaS Metrics",
    );
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "failed");
    assert.deepEqual(state.request, { id: filed.request.id, status: "failed" });
    assert.ok(state.failure && state.failure.length > 0, "the failure text must be exposed");
    assert.ok(
      state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"),
      `the remedy must name the Setup surface, got: ${state.remedy}`,
    );
  });
});

test("a newer pending request is never shadowed by an older failed one", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const first = await fileRequest(ctx);
    await seedCustomerAndSubscription(ctx);
    await expectRefusal(
      approveAndExecuteNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: first.request.id,
        approverId: ctx.approver,
      }),
      "saas_normalization_v0_key_drift",
      "Company Setup → SaaS Metrics",
    );
    const second = await fileRequest(ctx);
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "pending");
    assert.deepEqual(state.request, { id: second.request.id, status: "pending" });
  });
});

test("a cancelled request falls back to the stored-row legacy classification", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await cancelNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, actorId: ctx.requester });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "legacy");
    assert.deepEqual(state.request, { id: filed.request.id, status: "cancelled" });
    assert.equal(state.failure, null);
  });
});

test("mixed legacy and normalized rows refuse by name instead of reading ready", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "one monthly row must be normalized");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(state.failure && state.failure.includes("mixes"), `the failure must name the mix, got: ${state.failure}`);
    assert.ok(
      state.remedy && state.remedy.includes("different authorized approver"),
      "a refused month names the request and distinct-approval remedy",
    );
    assert.equal(state.request, null);
  });
});

test("an unsupported version outranks multiple currencies by name", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      await db.execute(sql`
        update saas_metrics_monthly
           set reporting_currency = 'CAD', denomination_version = 'v9',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
      await db.execute(sql`
        update saas_metrics_facts_monthly
           set reporting_currency = 'EUR', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
      await db.execute(sql`
        update saas_metrics_cohort_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("unsupported denomination version (v9)"),
      `the version refusal must outrank the currency mix, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
    assert.ok(state.remedy && state.remedy.includes("different authorized approver"));
  });
});

test("multiple reporting currencies refuse by name", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      await db.execute(sql`
        update saas_metrics_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
      await db.execute(sql`
        update saas_metrics_facts_monthly
           set reporting_currency = 'EUR', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
      await db.execute(sql`
        update saas_metrics_cohort_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("currencies"),
      `the failure must name the currencies, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
  });
});

test("an unsupported denomination version refuses by name", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      await db.execute(sql`
        update saas_metrics_monthly
           set reporting_currency = 'CAD', denomination_version = 'v9',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("unsupported denomination version"),
      `the failure must name the version, got: ${state.failure}`,
    );
  });
});

test("a request-only month with no rows refuses as empty", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const filed = await fileRequest(ctx);
    await cancelNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, actorId: ctx.requester });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("no stored metric rows"),
      `the failure must name the empty month, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
  });
});

test("a disabled feature refuses the read by name", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await withOrgTransaction(ctx.org.orgId, async () => {
      const result = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"saasMetrics":false}'::jsonb
        ) where id = ${ctx.org.orgId} returning id
      `);
      assert.equal(result.rows.length, 1, "the feature must be switched off");
    });
    await expectRefusal(listNormalizationMonthStates(ctx.org.orgId), "feature_off", "Company Settings → Features");
  });
});

test("month states never carry lease, hash, reason, progress, or audit fields", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    const body = JSON.stringify(await listNormalizationMonthStates(ctx.org.orgId));
    for (const forbidden of [
      "leaseToken", "lease_token", "leaseExpires", "requestHash", "request_hash",
      "reason", "progress", "monthHash", "sourceV0", "audit", "digest",
      "attemptCount", "updatedAt", "approvedBy", "requestedBy",
    ]) {
      assert.ok(!body.includes(`"${forbidden}"`), `the DTO must not expose ${forbidden}`);
    }
    assert.ok(body.includes(filed.request.id), "the current request id stays visible");
  });
});

test("a hand-edited row hash refuses with the tamper named, not ready", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    await withOrgTransaction(ctx.org.orgId, async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_monthly
           set inputs_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "one stored row must be tampered with");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("stored row hashes do not match the recorded month hash"),
      `the failure must name the hash tamper, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
    assert.equal(state.denominationVersion, null, "a refused month exposes no denomination");
  });
});

test("a hand-edited evidence hash refuses with the evidence named", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    await withOrgTransaction(ctx.org.orgId, async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_monthly
           set normalization_evidence = '{"inputs_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}'::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "one stored evidence must be tampered with");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("evidence hashes do not agree on one canonical hash"),
      `the failure must name the evidence tamper, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
  });
});

test("rows removed after success refuse with the counts named", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    const filed = await fileRequest(ctx);
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    await withOrgTransaction(ctx.org.orgId, async () => {
      const removed = await db.execute<{ id: string }>(sql`
        delete from saas_metrics_facts_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(removed.rows.length, 1, "one stored facts row must be removed");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("stored counts"),
      `the failure must name the count drift, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
  });
});

test("a partial evidence triple cannot be stored, so the classifier never meets one", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    // The table's complete-triple check refuses a v1/currency row with
    // missing evidence, which is why the classifier's v1 counter mirrors
    // the full triple instead of trusting currency and version alone.
    try {
      await withOrgTransaction(ctx.org.orgId, () =>
        db.execute(sql`
          update saas_metrics_monthly
             set reporting_currency = 'CAD', denomination_version = 'v1',
                 normalization_evidence = null
           where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        `),
      );
      assert.fail("partial evidence must be refused by the table check");
    } catch (error) {
      assert.ok(error instanceof Error && error.cause instanceof Error, "the write must retain its database refusal cause");
      assert.ok("code" in error.cause && "constraint" in error.cause);
      assert.equal(error.cause.code, "23514", "incomplete normalization evidence must violate the stored-row invariant");
      assert.equal(error.cause.constraint, "saas_metrics_monthly_norm_complete");
    }
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "legacy", "the refused write stores nothing");
  });
});

const CANONICAL_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function normalizeRowsToV1(ctx: Fixture, month: string = MONTH): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const monthly = await db.execute<{ id: string }>(sql`
      update saas_metrics_monthly
         set reporting_currency = 'CAD', denomination_version = 'v1',
             normalization_evidence = ${V1_EVIDENCE}::jsonb,
             inputs_hash = ${CANONICAL_HASH}
       where org_id = ${ctx.org.orgId} and month = ${month}::date
      returning id
    `);
    assert.ok(monthly.rows.length >= 1, "the monthly rows must be normalized");
    const facts = await db.execute<{ id: string }>(sql`
      update saas_metrics_facts_monthly
         set reporting_currency = 'CAD', denomination_version = 'v1',
             normalization_evidence = ${V1_EVIDENCE}::jsonb,
             inputs_hash = ${CANONICAL_HASH}
       where org_id = ${ctx.org.orgId} and month = ${month}::date
      returning id
    `);
    assert.ok(facts.rows.length >= 1, "the facts rows must be normalized");
    const cohorts = await db.execute<{ id: string }>(sql`
      update saas_metrics_cohort_monthly
         set reporting_currency = 'CAD', denomination_version = 'v1',
             normalization_evidence = ${V1_EVIDENCE}::jsonb,
             inputs_hash = ${CANONICAL_HASH}
       where org_id = ${ctx.org.orgId} and month = ${month}::date
      returning id
    `);
    assert.ok(cohorts.rows.length >= 1, "the cohort rows must be normalized");
  });
}

test("ordinary v1 rows with no request read ready when every row is bound", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await normalizeRowsToV1(ctx);
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "ready");
    assert.equal(state.denominationVersion, "v1");
    assert.equal(state.reportingCurrency, "CAD");
    assert.equal(state.request, null, "no request selected this month");
    assert.equal(state.failure, null);
  });
});

test("ordinary v1 rows with a hand-edited row hash refuse with no request", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await normalizeRowsToV1(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_monthly
           set inputs_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "one stored row hash must be tampered with");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(
      state.failure && state.failure.includes("mixes stored row hashes"),
      `the failure must name the hash disagreement, got: ${state.failure}`,
    );
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
    assert.ok(state.remedy && state.remedy.includes("different authorized approver"));
    assert.equal(state.request, null);
  });
});

test("ordinary v1 rows with a hand-edited evidence hash refuse with no request", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedLegacyMonth(ctx);
    await normalizeRowsToV1(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const updated = await db.execute<{ id: string }>(sql`
        update saas_metrics_facts_monthly
           set normalization_evidence = '{"inputs_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}'::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(updated.rows.length, 1, "one stored evidence hash must be tampered with");
    });
    const state = onlyMonth(await listNormalizationMonthStates(ctx.org.orgId), MONTH);
    assert.equal(state.state, "refused");
    assert.ok(state.failure, "the refused month must expose its reason");
    assert.ok(state.failure.includes(MONTH), `the refusal must identify the affected month: ${state.failure}`);
    assert.match(state.failure, /evidence hashes.*do not agree.*stored canonical hash/);
    assert.ok(state.remedy && state.remedy.includes("Company Setup → SaaS Metrics"));
  });
});

test("one organization never reads another organization's months", { skip: !DB }, async () => {
  await withFixture(async (first) => {
    await seedLegacyMonth(first);
    await withFixture(async (second) => {
      const states = await listNormalizationMonthStates(second.org.orgId);
      assert.ok(
        states.every((state) => state.month !== MONTH || state.counts.monthly === 0),
        "the second organization must not observe the first organization's rows",
      );
    });
  });
});
