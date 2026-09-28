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
  approveNormalizationRequest,
  cancelNormalizationRequest,
  claimNormalizationRequest,
  createNormalizationRequest,
  executeNormalizationRequest,
  getNormalizationRequest,
  heartbeatNormalizationRequest,
  normalizationLeaseDigest,
  normalizationMonthLockKey,
  reacquireNormalizationRequest,
  retryNormalizationRequest,
} from "./metrics-normalization-service.ts";

/**
 * Slice D properties, authored with the Slice D change and executed by the
 * repository's database gate. Every refusal below pins the usable remedy
 * the operator reads; every fence asserts the zero-row path refuses rather
 * than reporting success.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const MONTH = "2026-07-01";
const REASON = "Correct the July legacy denomination after the packs rollout.";
const V1_EVIDENCE = '{"inputs_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';

async function enableMetrics(orgId: string): Promise<void> {
  const result = await db.execute<{ id: string }>(sql`
    update orgs set settings = jsonb_set(
      settings,
      '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"subscriptionBilling":true,"saasMetrics":true}'::jsonb
    ) where id = ${orgId} returning id
  `);
  assert.equal(result.rows.length, 1, "the feature setting must be applied to the scratch organization");
}

interface Fixture {
  org: ScratchOrg;
  requester: string;
  approver: string;
}

async function withFixture(run: (ctx: Fixture) => Promise<void>): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const requester = await createScratchUser(org.orgId, "Normalization Requester", "admin");
    const approver = await createScratchUser(org.orgId, "Normalization Approver", "admin");
    await withOrgTransaction(org.orgId, async () => {
      await enableMetrics(org.orgId);
    });
    await run({ org, requester, approver });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function fileRequest(ctx: Fixture, overrides?: Partial<{ month: string; reason: string; requestedBy: string; idempotencyKey: string }>) {
  return createNormalizationRequest({
    orgId: ctx.org.orgId,
    month: overrides?.month ?? MONTH,
    reason: overrides?.reason ?? REASON,
    requestedBy: overrides?.requestedBy ?? ctx.requester,
    idempotencyKey: overrides?.idempotencyKey ?? randomUUID(),
  });
}

async function approvedClaim(ctx: Fixture, overrides?: { idempotencyKey?: string }) {
  const filed = await fileRequest(ctx, overrides);
  await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
  return claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
}

async function seedCustomerAndSubscription(ctx: Fixture, currency = "CAD"): Promise<{ customerId: string; subscriptionId: string }> {
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
      values (${planId}, ${ctx.org.orgId}, 'Metrics plan', '100.0000', ${currency}, 'monthly', 1, null, ${ctx.requester})
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

/** Seed one legacy month: all three row sets with the reporting triple absent. */
async function seedLegacyMonth(ctx: Fixture, customerId: string, subscriptionId: string): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const monthly = await db.execute<{ id: string }>(sql`
      insert into saas_metrics_monthly
        (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
         mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
         reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${customerId}, ${subscriptionId},
              ${MONTH}::date, ${MONTH}::date, '0', '100.0000', '100.0000', '0', '0', '0',
              '0', 'new', '0', '0', 'legacy-seed')
      returning id
    `);
    assert.equal(monthly.rows.length, 1, "the legacy monthly row must be stored");
    const facts = await db.execute<{ id: string }>(sql`
      insert into saas_metrics_facts_monthly
        (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
         contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
         mrr_at_risk, customers_start, customers_end, customers_new, customers_churned,
         customers_reactivated, gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${MONTH}::date, '0', '100.0000', '100.0000', '0',
              '0', '0', '0', '0', '0', '0', 0, 1, 1, 0, 0, '0', '0', '1200.0000', '0', '0',
              'recognised', 'legacy-seed')
      returning id
    `);
    assert.equal(facts.rows.length, 1, "the legacy facts row must be stored");
    const cohorts = await db.execute<{ id: string }>(sql`
      insert into saas_metrics_cohort_monthly
        (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
         start_customers, customers, inputs_hash)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${MONTH}::date, ${MONTH}::date,
              0, '100.0000', '100.0000', 1, 1, 'legacy-seed')
      returning id
    `);
    assert.equal(cohorts.rows.length, 1, "the legacy cohort row must be stored");
  });
}

async function seedNormalizedMonth(ctx: Fixture, customerId: string, subscriptionId: string): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    await db.execute(sql`
      insert into saas_metrics_monthly
        (org_id, subsidiary_id, customer_id, subscription_id, month, cohort_month,
         mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr, churned_mrr,
         reactivation_mrr, movement, recognized_revenue, deferred_delta, inputs_hash,
         reporting_currency, denomination_version, normalization_evidence)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${customerId}, ${subscriptionId},
              ${MONTH}::date, ${MONTH}::date, '0', '100.0000', '100.0000', '0', '0', '0',
              '0', 'new', '0', '0',
              'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              'CAD', 'v1', ${V1_EVIDENCE}::jsonb)
    `);
    await db.execute(sql`
      insert into saas_metrics_facts_monthly
        (org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr,
         contraction_mrr, churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta,
         mrr_at_risk, customers_start, customers_end, customers_new, customers_churned,
         customers_reactivated, gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash,
         reporting_currency, denomination_version, normalization_evidence)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${MONTH}::date, '0', '100.0000', '100.0000', '0',
              '0', '0', '0', '0', '0', '0', 0, 1, 1, 0, 0, '0', '0', '1200.0000', '0', '0',
              'recognised', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              'CAD', 'v1', ${V1_EVIDENCE}::jsonb)
    `);
    await db.execute(sql`
      insert into saas_metrics_cohort_monthly
        (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
         start_customers, customers, inputs_hash,
         reporting_currency, denomination_version, normalization_evidence)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${MONTH}::date, ${MONTH}::date,
              0, '100.0000', '100.0000', 1, 1,
              'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              'CAD', 'v1', ${V1_EVIDENCE}::jsonb)
    `);
  });
}

async function requestAuditEvents(orgId: string, requestId: string): Promise<Array<{ action: string; changes: Record<string, unknown> }>> {
  return withOrgTransaction(orgId, async () =>
    (await db.execute<{ action: string; changes: Record<string, unknown> }>(sql`
      select action, changes from audit_log
       where org_id = ${orgId} and table_name = 'saas_metrics_normalization_requests' and row_id = ${requestId}
       order by at
    `)).rows);
}

async function correctionAuditEvents(orgId: string): Promise<Array<{ table: string; row: string; changes: Record<string, unknown> }>> {
  return withOrgTransaction(orgId, async () =>
    (await db.execute<{ table: string; row: string; changes: Record<string, unknown> }>(sql`
      select table_name as table, row_id::text as row, changes from audit_log
       where org_id = ${orgId} and action = 'saas_normalization_corrected'
       order by table_name, row_id
    `)).rows);
}

async function expectRefusal(
  run: Promise<unknown>,
  code: string,
  remedyFragment: string,
): Promise<UsageBillingError> {
  const error = await run.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof UsageBillingError, `expected a UsageBillingError (${code}), saw ${String(error)}`);
  assert.equal(error.code, code, "the refusal must name its code");
  assert.match(error.remedy, new RegExp(remedyFragment), "the refusal must pin a usable remedy");
  return error;
}

test("lease digests never expose the raw token", () => {
  const first = normalizationLeaseDigest("token-a");
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.ok(!first.includes("token-a"), "the digest must not contain the raw token");
  assert.notEqual(first, normalizationLeaseDigest("token-b"), "distinct tokens digest distinctly");
  assert.equal(first, normalizationLeaseDigest("token-a"), "the digest is deterministic");
});

test("the month correction lock key is deterministic and D-specific", () => {
  assert.equal(normalizationMonthLockKey("org-1", MONTH), "openbooks:saas-normalization:org-1:2026-07-01");
  assert.notEqual(
    normalizationMonthLockKey("org-1", MONTH),
    normalizationMonthLockKey("org-1", "2026-08-01"),
    "one month never contends with another",
  );
});

test("request creation validates month, reason, and identities before any write", async () => {
  const orgId = randomUUID();
  const actor = randomUUID();
  const key = randomUUID();
  await expectRefusal(
    createNormalizationRequest({ orgId, month: "2026-07-15", reason: REASON, requestedBy: actor, idempotencyKey: key }),
    "saas_normalization_month_invalid",
    "YYYY-MM-01",
  );
  await expectRefusal(
    createNormalizationRequest({ orgId, month: MONTH, reason: "too short", requestedBy: actor, idempotencyKey: key }),
    "saas_normalization_reason_invalid",
    "Company Setup",
  );
  await expectRefusal(
    createNormalizationRequest({ orgId, month: MONTH, reason: REASON, requestedBy: "", idempotencyKey: key }),
    "saas_normalization_requested_by_invalid",
    "UUID",
  );
});

test("same key with a byte-identical body replays, with a different body conflicts", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const key = randomUUID();
    const first = await fileRequest(ctx, { idempotencyKey: key });
    assert.equal(first.created, true);
    assert.equal(first.request.status, "pending");
    const replay = await fileRequest(ctx, { idempotencyKey: key });
    assert.equal(replay.created, false, "the identical body must return the existing request");
    assert.equal(replay.request.id, first.request.id);
    await expectRefusal(
      fileRequest(ctx, { idempotencyKey: key, reason: "A completely different correction story." }).then(() => null),
      "saas_normalization_idempotency_conflict",
      "new idempotency key",
    );
  });
});

test("one live request per org and month names the live request", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const first = await fileRequest(ctx);
    await expectRefusal(
      fileRequest(ctx).then(() => null),
      "saas_normalization_request_live",
      first.request.id,
    );
  });
});

test("a requester outside the organization is refused and stores nothing", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const outsider = randomUUID();
    await assert.rejects(
      fileRequest(ctx, { requestedBy: outsider }).then(() => null),
      "an out-of-organization requester must fail the subject guard",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from saas_metrics_normalization_requests where org_id = ${ctx.org.orgId}
      `)).rows[0]?.count);
    assert.equal(rows, "0", "the refused write must store no request row");
  });
});

test("self-approval refuses even for an admin; a distinct approver records", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const filed = await fileRequest(ctx);
    await expectRefusal(
      approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.requester }),
      "saas_normalization_self_approval",
      "different authorized approver",
    );
    const approved = await approveNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    assert.equal(approved.approvedBy, ctx.approver);
    const replay = await approveNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    assert.equal(replay.approvedBy, ctx.approver, "re-approval by the recorded approver replays");
    const events = await requestAuditEvents(ctx.org.orgId, filed.request.id);
    const kinds = events.map((event) => event.action);
    assert.ok(kinds.includes("saas_normalization_requested"), "creation records the typed requested event");
    assert.ok(kinds.includes("saas_normalization_approved"), "approval records the typed approved event");
    const requested = events.find((event) => event.action === "saas_normalization_requested")!;
    assert.equal(requested.changes.actor, ctx.requester, "the requested event carries the truthful actor");
    assert.equal(requested.changes.reason, REASON, "the requested event carries the reason");
  });
});

test("a concurrent second claim matches zero rows and names the live request", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const filed = await fileRequest(ctx);
    await expectRefusal(
      claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id }),
      "saas_normalization_claim_unapproved",
      "distinct approver",
    );
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    const first = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.equal(first.request.status, "running");
    assert.equal(first.request.attemptCount, 1);
    assert.match(first.leaseToken, /^[0-9a-f-]{36}$/);
    await expectRefusal(
      claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id }),
      "saas_normalization_already_claimed",
      "Company Setup",
    );
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.ok(!("leaseToken" in status), "status reads never expose the live token");
  });
});

test("heartbeats extend under the live token; stale tokens refuse without new attempts", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const { request, leaseToken } = await approvedClaim(ctx);
    const heartbeat = await heartbeatNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: request.id,
      leaseToken,
      progress: { pct: 10 },
    });
    assert.equal(heartbeat.attemptCount, 1, "a heartbeat opens no new attempt");
    assert.equal(heartbeat.progress.pct, 10, "heartbeat progress is recorded");
    assert.ok(
      (heartbeat.leaseExpiresAt ?? "") >= (request.leaseExpiresAt ?? ""),
      "a heartbeat never shortens the lease",
    );
    await expectRefusal(
      heartbeatNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: request.id,
        leaseToken: "00000000-0000-0000-0000-000000000000",
      }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    const after = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
    assert.equal(after.attemptCount, 1, "a stale token manufactures no attempt");
    const events = await requestAuditEvents(ctx.org.orgId, request.id);
    assert.ok(
      !events.some((event) => event.action === "saas_normalization_heartbeat"),
      "heartbeats manufacture no attempt audit event",
    );
  });
});

test("reacquisition refuses while the lease is live and shortens nothing", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const { request } = await approvedClaim(ctx);
    await expectRefusal(
      reacquireNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id }),
      "saas_normalization_lease_live",
      "wait for expiry",
    );
    const shortened = await withOrgTransaction(ctx.org.orgId, async () =>
      db.execute(sql`
        update saas_metrics_normalization_requests
           set lease_expires_at = lease_expires_at - make_interval(mins => 1), updated_by = approved_by
         where org_id = ${ctx.org.orgId} and id = ${request.id}
      `).then(() => "updated", () => "refused"));
    assert.equal(shortened, "refused", "the guard never lets a heartbeat shorten the lease");
  });
});

test("executing a pending request refuses; a stale token records no failure", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    await expectRefusal(
      executeNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        leaseToken: randomUUID(),
      }),
      "saas_normalization_execute_state",
      "claim the request",
    );
    const { request, leaseToken } = await claimNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
    });
    await expectRefusal(
      executeNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: request.id,
        leaseToken: randomUUID(),
      }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
    assert.equal(status.status, "running", "a stale execution attempt records no failed outcome");
    assert.equal(status.failure, null);
    assert.ok(leaseToken.length > 0);
  });
});

test("an empty month refuses with the recompute remedy and records the failure", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_nothing_to_correct",
      "ordinary SaaS metrics recompute",
    );
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
    assert.equal(status.status, "failed");
    assert.match(status.failure ?? "", /saas_normalization_nothing_to_correct/);
    assert.match(status.remedy ?? "", /ordinary SaaS metrics recompute/);
    const stored = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from saas_metrics_monthly where org_id = ${ctx.org.orgId}
      `)).rows[0]?.count);
    assert.equal(stored, "0", "no metric write survives a refused proof");
  });
});

test("a fully normalized month refuses as already done and keeps its rows", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedNormalizedMonth(ctx, seeded.customerId, seeded.subscriptionId);
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_already_normalized",
      "recorded result",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ hash: string }>(sql`
        select inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the refused correction writes nothing");
    assert.equal(
      rows[0]?.hash,
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "the stored v1 hash is untouched",
    );
  });
});

test("a mixed legacy and normalized month refuses as unsupported partial", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    await withOrgTransaction(ctx.org.orgId, async () => {
      await db.execute(sql`
        update saas_metrics_facts_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `);
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_partial_denominations",
      "uniform row set",
    );
    const monthly = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(monthly[0]?.currency, null, "the legacy row stays legacy after the refused batch");
  });
});

test("missing FX evidence fails the batch with its setup remedy and no writes", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx, "EUR");
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    const { request, leaseToken } = await approvedClaim(ctx);
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_metrics_fx_rate_missing",
      "FX rates",
    );
    assert.match(error.message, /EUR→CAD/, "the refusal names the uncovered pair");
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
    assert.equal(status.status, "failed");
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null; hash: string }>(sql`
        select reporting_currency as currency, inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.currency, null, "the legacy row is untouched by the failed batch");
    assert.equal(rows[0]?.hash, "legacy-seed");
    const corrections = await correctionAuditEvents(ctx.org.orgId);
    assert.equal(corrections.length, 0, "a failed batch records no per-row correction evidence");
  });
});

test("a legacy open month corrects atomically with per-row before and after evidence", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    const journalBefore = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from journal_entries where org_id = ${ctx.org.orgId}
      `)).rows[0]?.count);
    const { request, leaseToken } = await approvedClaim(ctx);
    const result = await executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken });
    assert.equal(result.month, MONTH);
    assert.equal(result.reportingCurrency, "CAD");
    assert.equal(result.denominationVersion, "v1");
    assert.match(result.monthHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.sourceV0Hashes, ["legacy-seed"]);
    assert.equal(result.replacedMonthly, 1);
    const stored = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ hash: string; currency: string; version: string }>(sql`
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        union all
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_facts_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        union all
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_cohort_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(stored.length, 3, "exactly the month's three row sets are replaced");
    for (const row of stored) {
      assert.equal(row.hash, result.monthHash, "every replaced row carries the canonical v1 hash");
      assert.equal(row.currency, "CAD");
      assert.equal(row.version, "v1");
    }
    const corrections = await correctionAuditEvents(ctx.org.orgId);
    assert.equal(corrections.length, 3, "each replaced row carries before and after evidence");
    for (const event of corrections) {
      const changes = event.changes as Record<string, unknown>;
      assert.equal(changes.requestId, request.id);
      assert.equal(changes.attempt, 1);
      assert.equal(changes.actor, ctx.approver);
      assert.equal(changes.reason, REASON);
      assert.equal(changes.sourceV0Hash, "legacy-seed");
      assert.equal(changes.v1Hash, result.monthHash);
      assert.ok(changes.before, "the legacy before-image is recorded");
      assert.ok(changes.after, "the normalized after-image is recorded");
      assert.ok(
        !JSON.stringify(changes).includes(leaseToken),
        "raw lease tokens never enter audit",
      );
    }
    const replay = await executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken });
    assert.deepEqual(replay, result, "a succeeded byte-identical replay returns the recorded result");
    const journalAfter = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from journal_entries where org_id = ${ctx.org.orgId}
      `)).rows[0]?.count);
    assert.equal(journalAfter, journalBefore, "posted accounting history is never rewritten");
  });
});

test("a closed month corrects only through the approved request without reopening", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const closed = await db.execute(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state)
        values (${ctx.org.orgId}, ${ctx.org.periodId}, ${ctx.org.bookId}, null, 'ar', 'closed')
        returning period_id
      `);
      assert.equal(closed.rows.length, 1, "July AR must be closed before the correction");
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    const result = await executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken });
    assert.match(result.monthHash, /^[0-9a-f]{64}$/);
    const locks = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ state: string }>(sql`
        select state from period_locks
         where org_id = ${ctx.org.orgId} and period_id = ${ctx.org.periodId} and module = 'ar'
      `)).rows);
    assert.equal(locks[0]?.state, "closed", "the accounting period stays closed throughout");
  });
});

test("a crashed worker supersedes cleanly: old tokens die, the new attempt re-proves", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    const crashed = await claimNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      leaseTtlMinutes: 1,
    });
    // The crash: the worker vanishes holding attempt one's lease. Force the
    // lease past expiry through the reacquire fence by waiting out a
    // one-minute lease, then reacquire and rerun the complete proof.
    const waitForExpiry = async (): Promise<void> => {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const expired = await withOrgTransaction(ctx.org.orgId, async () =>
          (await db.execute<{ expired: boolean }>(sql`
            select lease_expires_at <= now() as expired
              from saas_metrics_normalization_requests
             where org_id = ${ctx.org.orgId} and id = ${filed.request.id}
          `)).rows[0]?.expired ?? false);
        if (expired) return;
        if (Date.now() > deadline) throw new Error("the one-minute lease never expired");
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    };
    assert.equal(crashed.request.attemptCount, 1);
    await waitForExpiry();
    const revived = await reacquireNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.equal(revived.request.attemptCount, 2, "reacquisition opens a fresh attempt");
    assert.notEqual(revived.leaseToken, crashed.leaseToken, "reacquisition mints a fresh token");
    await expectRefusal(
      heartbeatNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        leaseToken: crashed.leaseToken,
      }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    await expectRefusal(
      executeNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        leaseToken: crashed.leaseToken,
      }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    const result = await executeNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      leaseToken: revived.leaseToken,
    });
    assert.equal(result.attempt, 2);
    const events = await requestAuditEvents(ctx.org.orgId, filed.request.id);
    const kinds = events.map((event) => event.action);
    assert.ok(kinds.includes("saas_normalization_abandoned"), "the crashed attempt is abandoned in audit");
    assert.ok(kinds.includes("saas_normalization_reacquired"), "the revival is claimed in audit");
    assert.ok(kinds.includes("saas_normalization_succeeded"), "the revived attempt finalizes");
  });
}, { timeout: 180_000 });

test("retry after failure re-proves and succeeds without resuming payload", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx, "EUR");
    await seedLegacyMonth(ctx, seeded.customerId, seeded.subscriptionId);
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    const first = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, leaseToken: first.leaseToken }),
      "saas_metrics_fx_rate_missing",
      "FX rates",
    );
    await withOrgTransaction(ctx.org.orgId, async () => {
      const rate = await db.execute(sql`
        insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${ctx.org.orgId}, 'EUR', 'CAD', '2026-07-31', 'spot', '1.5000000000', 'manual')
        returning id
      `);
      assert.equal(rate.rows.length, 1, "the covering EUR rate must be stored");
    });
    const retried = await retryNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.equal(retried.request.attemptCount, 2);
    const result = await executeNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      leaseToken: retried.leaseToken,
    });
    assert.equal(result.attempt, 2);
    assert.match(result.monthHash, /^[0-9a-f]{64}$/);
  });
});

test("cancellation honors requester, approver, and terminal immutability", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const filed = await fileRequest(ctx);
    await expectRefusal(
      cancelNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, actorId: ctx.approver }),
      "saas_normalization_cancel_forbidden",
      "Only the requester",
    );
    const cancelled = await cancelNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      actorId: ctx.requester,
    });
    assert.equal(cancelled.status, "cancelled");
    await expectRefusal(
      approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver }),
      "saas_normalization_approval_state",
      "Company Setup",
    );
  });
});
