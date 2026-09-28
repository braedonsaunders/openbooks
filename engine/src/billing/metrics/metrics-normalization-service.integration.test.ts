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
  executeNormalizationRequest,
  getNormalizationRequest,
  heartbeatNormalizationRequest,
  normalizationLeaseDigest,
  normalizationMonthLockKey,
  reacquireNormalizationRequest,
  retryNormalizationRequest,
} from "./metrics-normalization-service.ts";
import {
  computeLegacyV0Month,
  historyRowFromProvenance,
  recomputeSaasMetrics,
  startRowFromProvenance,
  validateProvenanceCounts,
  validateProvenanceEvent,
  type LegacyV0Month,
  type ProvenanceEvent,
  type ProvenanceRequest,
} from "./metrics-ledger.ts";

/**
 * Slice D properties, authored with the Slice D change and executed by the
 * repository's database gate. Every refusal below pins the usable remedy
 * the operator reads; every fence asserts the zero-row path refuses rather
 * than reporting success.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const MONTH = "2026-07-01";
const NEXT_MONTH = "2026-08-01";
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

/**
 * Seed one realistic legacy month: the exact v0 reproduction of the seeded
 * sources, stored with the reporting triple absent and the one canonical v0
 * hash. The proof accepts these rows because v0 recomputation reproduces
 * them byte-for-byte — never because a marker was trusted.
 */
async function seedV0Month(ctx: Fixture, month: string = MONTH): Promise<LegacyV0Month> {
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
  return v0;
}

async function setSaaSMetricsFeature(ctx: Fixture, enabled: boolean): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const result = await db.execute<{ id: string }>(sql`
      update orgs set settings = jsonb_set(
        settings,
        '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ saasMetrics: enabled })}::jsonb
      ) where id = ${ctx.org.orgId} returning id
    `);
    assert.equal(result.rows.length, 1, "the feature setting must be applied to the scratch organization");
  });
}

async function seedFxRate(ctx: Fixture, from: string, to: string, asOf: string, rate: string): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const stored = await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${ctx.org.orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'manual')
      returning id
    `);
    assert.equal(stored.rows.length, 1, "the covering spot rate must be stored");
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
       order by at, id
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

function expectSyncRefusal(run: () => unknown, code: string, remedyFragment: string, label = "provenance"): UsageBillingError {
  let error: unknown = null;
  try {
    run();
  } catch (failure) {
    error = failure;
  }
  assert.ok(error instanceof UsageBillingError, `${label}: expected a UsageBillingError (${code}), saw ${String(error)}`);
  assert.equal(error.code, code, `${label}: the refusal must name its code`);
  assert.match(error.remedy, new RegExp(remedyFragment), `${label}: the refusal must pin a usable remedy`);
  return error;
}

const PROV_APPROVER = "11111111-1111-4111-8111-111111111111";
const PROV_REQUEST = "22222222-2222-4222-8222-222222222222";
const PROV_KEY = "33333333-3333-4333-8333-333333333333";
const PROV_SUB = "44444444-4444-4444-8444-444444444444";
const PROV_CUSTOMER = "66666666-6666-4666-8666-666666666666";
const PROV_SUBSIDIARY = "77777777-7777-4777-8777-777777777777";
const PROV_ROW = "55555555-5555-4555-8555-555555555555";
const PROV_V0H = "b".repeat(64);
const PROV_V1H = "a".repeat(64);

function provRequest(overrides: Partial<ProvenanceRequest> = {}): ProvenanceRequest {
  return {
    id: PROV_REQUEST,
    month: MONTH,
    idempotencyKey: PROV_KEY,
    approvedBy: PROV_APPROVER,
    status: "succeeded",
    attemptCount: 1,
    result: {
      month: MONTH,
      monthHash: PROV_V1H,
      replacedMonthly: 1,
      replacedFacts: 1,
      replacedCohorts: 1,
      sourceV0Hashes: [PROV_V0H],
    },
    ...overrides,
  };
}

function provEvent(overrides: Partial<ProvenanceEvent> = {}): ProvenanceEvent {
  return {
    table: "saas_metrics_monthly",
    rowId: PROV_ROW,
    month: MONTH,
    naturalKey: { subscriptionId: PROV_SUB, month: MONTH },
    event: "saas_normalization_corrected",
    change: "corrected",
    actor: PROV_APPROVER,
    requestId: PROV_REQUEST,
    requestKey: PROV_KEY,
    attempt: 1,
    sourceV0Hash: PROV_V0H,
    v1Hash: PROV_V1H,
    before: {
      subscriptionId: PROV_SUB,
      month: MONTH,
      customerId: PROV_CUSTOMER,
      subsidiaryId: PROV_SUBSIDIARY,
      cohortMonth: MONTH,
      mrrEnd: "100.0000",
      inputsHash: PROV_V0H,
      reportingCurrency: null,
      denominationVersion: null,
    },
    after: { id: PROV_ROW, inputsHash: PROV_V1H },
    ...overrides,
  };
}

test("a joined provenance event validates every identity and digest", () => {
  const before = validateProvenanceEvent(provEvent(), provRequest(), "saas_metrics_monthly", MONTH);
  assert.equal((before as Record<string, unknown>).subscriptionId, PROV_SUB);
  const history = historyRowFromProvenance(before, PROV_SUB, MONTH, MONTH);
  assert.equal(history.mrr_end, "100.0000");
  assert.equal(history.reporting_currency, null);
  validateProvenanceCounts(
    { saas_metrics_monthly: 1, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 },
    provRequest().result!,
    MONTH,
  );
});

test("provenance field mismatches refuse as tampered before any write", () => {
  const cases: Array<[string, Partial<ProvenanceEvent>, Partial<ProvenanceRequest>]> = [
    ["table", { table: "saas_metrics_facts_monthly" }, {}],
    ["event", { event: "saas_normalization_approved" }, {}],
    ["change", { change: "added" }, {}],
    ["month", { month: NEXT_MONTH }, {}],
    ["naturalKey month", { naturalKey: { subscriptionId: PROV_SUB, month: NEXT_MONTH } }, {}],
    ["attempt", { attempt: 2 }, {}],
    ["actor", { actor: PROV_APPROVER.replace("1", "9") }, {}],
    ["requestKey", { requestKey: PROV_KEY.replace("3", "9") }, {}],
    ["requestId", { requestId: PROV_REQUEST.replace("2", "9") }, {}],
    ["sourceV0Hash outside the recorded set", { sourceV0Hash: "c".repeat(64) }, {}],
    [
      "sourceV0Hash detached from the before hash",
      { sourceV0Hash: "c".repeat(64) },
      { result: { ...provRequest().result!, sourceV0Hashes: [PROV_V0H, "c".repeat(64)] } },
    ],
    ["malformed before hash", { sourceV0Hash: "xyz", before: { ...(provEvent().before as Record<string, unknown>), inputsHash: "xyz" } }, {}],
    ["v1Hash", { v1Hash: "d".repeat(64) }, {}],
    ["after hash", { after: { id: PROV_ROW, inputsHash: "d".repeat(64) } }, {}],
    ["row identity", { rowId: PROV_ROW.replace("5", "9") }, {}],
    ["failed request", {}, { status: "failed" }],
    ["null result", {}, { result: null }],
    ["wrong result month", {}, { result: { ...provRequest().result!, month: NEXT_MONTH } }],
  ];
  for (const [name, eventOverride, requestOverride] of cases) {
    expectSyncRefusal(
      () => validateProvenanceEvent(provEvent(eventOverride), provRequest(requestOverride), "saas_metrics_monthly", MONTH),
      "saas_normalization_provenance_tampered",
      "escalate with the request id",
      name,
    );
  }
});

test("provenance count shortfalls refuse as incomplete and over-counts as tampered", () => {
  const result = provRequest().result!;
  expectSyncRefusal(
    () => validateProvenanceCounts({ saas_metrics_monthly: 0, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 }, result, MONTH),
    "saas_normalization_provenance_incomplete",
    "escalate with the request id",
  );
  expectSyncRefusal(
    () => validateProvenanceCounts({ saas_metrics_monthly: 2, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 }, result, MONTH),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
});

test("provenance legacy shapes refuse non-legacy and mismatched before-images", () => {
  const before = provEvent().before as Record<string, unknown>;
  expectSyncRefusal(
    () => historyRowFromProvenance({ ...before, reportingCurrency: "CAD" }, PROV_SUB, MONTH, MONTH),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
  expectSyncRefusal(
    () => historyRowFromProvenance({ ...before, subscriptionId: PROV_SUB.replace("4", "9") }, PROV_SUB, MONTH, MONTH),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
  const startBefore = {
    subsidiaryId: PROV_SUBSIDIARY,
    cohortMonth: MONTH,
    startMrr: "100.0000",
    startCustomers: 1,
    inputsHash: PROV_V0H,
    reportingCurrency: null,
    denominationVersion: null,
  };
  const start = startRowFromProvenance(startBefore, PROV_SUBSIDIARY, MONTH, MONTH);
  assert.equal(start.start_mrr, "100.0000");
  expectSyncRefusal(
    () => startRowFromProvenance({ ...startBefore, startCustomers: -1 }, PROV_SUBSIDIARY, MONTH, MONTH),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
});

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
      "stored month",
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
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
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
      "never edited by hand",
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
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    const v0 = await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const removed = await db.execute(sql`
        delete from fx_rates
         where org_id = ${ctx.org.orgId} and from_currency = 'EUR' and to_currency = 'CAD'
        returning id
      `);
      assert.equal(removed.rows.length, 1, "the covering rate must be withdrawn to stage the drift");
    });
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
    assert.equal(rows[0]?.hash, v0.legacyHash, "the recorded v0 hash is untouched by the failed batch");
    const corrections = await correctionAuditEvents(ctx.org.orgId);
    assert.equal(corrections.length, 0, "a failed batch records no per-row correction evidence");
  });
});

test("a reproduced legacy month corrects atomically with per-row before and after evidence", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    const v0 = await seedV0Month(ctx);
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
    assert.deepEqual(result.sourceV0Hashes, [v0.legacyHash], "the proof pins the one common reproduced v0 hash");
    assert.equal(result.replacedMonthly, v0.monthly.length);
    assert.equal(result.replacedFacts, v0.facts.length);
    assert.equal(result.replacedCohorts, v0.cohorts.length);
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
    assert.equal(
      stored.length,
      v0.monthly.length + v0.facts.length + v0.cohorts.length,
      "exactly the month's three row sets are replaced",
    );
    for (const row of stored) {
      assert.equal(row.hash, result.monthHash, "every replaced row carries the canonical v1 hash");
      assert.equal(row.currency, "CAD");
      assert.equal(row.version, "v1");
    }
    const corrections = await correctionAuditEvents(ctx.org.orgId);
    assert.equal(corrections.length, stored.length, "each replaced row carries before and after evidence");
    for (const event of corrections) {
      const changes = event.changes as Record<string, unknown>;
      assert.equal(changes.requestId, request.id);
      assert.equal(changes.attempt, 1);
      assert.equal(changes.actor, ctx.approver);
      assert.equal(changes.reason, REASON);
      assert.equal(changes.change, "corrected", "grain-preserving corrections never add or remove rows");
      assert.equal(changes.sourceV0Hash, v0.legacyHash);
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
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
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
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
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
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const removed = await db.execute(sql`
        delete from fx_rates
         where org_id = ${ctx.org.orgId} and from_currency = 'EUR' and to_currency = 'CAD'
        returning id
      `);
      assert.equal(removed.rows.length, 1, "the covering rate must be withdrawn to stage the drift");
    });
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    const first = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, leaseToken: first.leaseToken }),
      "saas_metrics_fx_rate_missing",
      "FX rates",
    );
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
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

test("a changed source refuses as drift with zero writes and the chained remedy", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const seeded = await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const changed = await db.execute(sql`
        update subscriptions set price_override = '200.0000'
         where org_id = ${ctx.org.orgId} and id = ${seeded.subscriptionId}
        returning id
      `);
      assert.equal(changed.rows.length, 1, "the subscription price must move to stage source drift");
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_source_drift",
      "earlier months first",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the drifted batch writes no v1 row");
    assert.equal(rows[0]?.currency, null, "the legacy row stays legacy after source drift");
  });
});

test("a tampered stored value refuses with zero writes and administrator escalation", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    const v0 = await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const tampered = await db.execute(sql`
        update saas_metrics_monthly set mrr_end = mrr_end + 1
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(tampered.rows.length, 1, "the stored value must move to stage tamper");
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_stored_tamper",
      "never edited by hand",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null; hash: string }>(sql`
        select reporting_currency as currency, inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the tampered batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
    assert.equal(rows[0]?.hash, v0.legacyHash, "the recorded hash still stands");
  });
});

test("a tampered stored hash refuses with zero writes and administrator escalation", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const tampered = await db.execute(sql`
        update saas_metrics_monthly
           set inputs_hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(tampered.rows.length, 1, "the stored hash must move to stage tamper");
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_hash_tamper",
      "never edited by hand",
    );
    assert.match(error.remedy, /escalate with the request id/);
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the tampered batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
  });
});

test("a missing stored row refuses as key drift with zero writes", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const removed = await db.execute(sql`
        delete from saas_metrics_facts_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(removed.rows.length, 1, "the facts row must leave to stage a missing key");
    });
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_v0_key_drift",
      "new request",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the key-drifted batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
  });
});

test("an extra source key refuses as key drift with zero writes", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await seedCustomerAndSubscription(ctx);
    const { request, leaseToken } = await approvedClaim(ctx);
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_v0_key_drift",
      "new request",
    );
    assert.match(error.message, /saas_metrics_monthly:/, "the refusal names the drifted natural key");
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, 1, "the key-drifted batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
  });
});

test("the E-facing action approves, claims, and executes with no token returned", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    const v0 = await seedV0Month(ctx);
    const filed = await fileRequest(ctx);
    const done = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    assert.equal(done.request.status, "succeeded");
    assert.equal(done.request.approvedBy, ctx.approver);
    assert.equal(done.request.attemptCount, 1, "one atomic action opens exactly one attempt");
    assert.ok(!("leaseToken" in done) && !("leaseToken" in done.request), "the raw token never leaves the server");
    assert.deepEqual(done.result.sourceV0Hashes, [v0.legacyHash]);
    const events = await requestAuditEvents(ctx.org.orgId, filed.request.id);
    const kinds = events.map((event) => event.action);
    assert.deepEqual(
      kinds,
      ["saas_normalization_requested", "saas_normalization_approved", "saas_normalization_claimed", "saas_normalization_succeeded"],
      "one action records approval, first claim, and finalization with no approved-pending gap",
    );
    const replay = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      approverId: ctx.approver,
    });
    assert.deepEqual(replay.result, done.result, "the E-facing replay returns the recorded result");
  });
});

test("the E-facing action refuses self-approval and concurrent losers with zero gaps", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    const filed = await fileRequest(ctx);
    await expectRefusal(
      approveAndExecuteNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        approverId: ctx.requester,
      }),
      "saas_normalization_self_approval",
      "different authorized approver",
    );
    const secondApprover = await createScratchUser(ctx.org.orgId, "Normalization Rival", "admin");
    const [first, second] = await Promise.allSettled([
      approveAndExecuteNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        approverId: ctx.approver,
      }),
      approveAndExecuteNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        approverId: secondApprover,
      }),
    ]);
    const wins = [first, second].filter((outcome) => outcome.status === "fulfilled");
    const losses = [first, second].filter((outcome) => outcome.status === "rejected");
    assert.equal(wins.length, 1, "exactly one concurrent approval claims the request");
    assert.equal(losses.length, 1, "the concurrent loser refuses on zero rows");
    const loss = (losses[0] as PromiseRejectedResult).reason as unknown;
    assert.ok(loss instanceof UsageBillingError, "the loser refuses with a named refusal");
    assert.ok(
      ["saas_normalization_approver_recorded", "saas_normalization_already_claimed", "saas_normalization_approval_state"].includes(loss.code),
      `the loser names the race it lost, saw ${loss.code}`,
    );
    const events = await requestAuditEvents(ctx.org.orgId, filed.request.id);
    assert.equal(
      events.filter((event) => event.action === "saas_normalization_approved").length,
      1,
      "concurrent losers record no second approval",
    );
    assert.equal(
      events.filter((event) => event.action === "saas_normalization_claimed").length,
      1,
      "concurrent losers record no second claim",
    );
  });
});

test("a running request cancels only by the approver under the live lease", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      cancelNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, actorId: ctx.requester, leaseToken }),
      "saas_normalization_cancel_forbidden",
      "recorded approver",
    );
    await expectRefusal(
      cancelNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: request.id,
        actorId: ctx.approver,
        leaseToken: randomUUID(),
      }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    const cancelled = await cancelNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: request.id,
      actorId: ctx.approver,
      leaseToken,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failure, null);
    assert.equal(cancelled.remedy, null);
    assert.equal(cancelled.result, null);
  });
});

test("a failed request records failure then cancels cleanly by the approver", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    const { request, leaseToken } = await approvedClaim(ctx);
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, leaseToken }),
      "saas_normalization_nothing_to_correct",
      "ordinary SaaS metrics recompute",
    );
    const failed = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
    assert.equal(failed.status, "failed");
    assert.ok(failed.failure && failed.remedy, "the failed outcome is recorded");
    await expectRefusal(
      cancelNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id, actorId: ctx.requester }),
      "saas_normalization_cancel_forbidden",
      "recorded approver",
    );
    const cancelled = await cancelNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: request.id,
      actorId: ctx.approver,
    });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failure, null, "the failed failure clears atomically with the cancel");
    assert.equal(cancelled.remedy, null, "the failed remedy clears atomically with the cancel");
    assert.equal(cancelled.result, null);
    const events = await requestAuditEvents(ctx.org.orgId, request.id);
    const last = events[events.length - 1]!;
    assert.equal(last.action, "saas_normalization_cancelled", "the cancel records its canonical event");
    assert.equal(last.changes.actor, ctx.approver, "the cancelled event carries the truthful approver actor");
  });
});

test("chained mixed-currency months reproduce v0 across the audited correction", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    await seedV0Month(ctx, MONTH);
    const augustBefore = await withOrgTransaction(ctx.org.orgId, async () =>
      computeLegacyV0Month(db, ctx.org.orgId, NEXT_MONTH));
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    const doneJuly = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedJuly.request.id,
      approverId: ctx.approver,
    });
    assert.equal(doneJuly.request.status, "succeeded");
    const augustAfter = await withOrgTransaction(ctx.org.orgId, async () =>
      computeLegacyV0Month(db, ctx.org.orgId, NEXT_MONTH));
    assert.equal(
      augustAfter.legacyHash,
      augustBefore.legacyHash,
      "August reproduces its original v0 hash from July's preserved before-image",
    );
    await seedV0Month(ctx, NEXT_MONTH);
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    const doneAugust = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedAugust.request.id,
      approverId: ctx.approver,
    });
    assert.equal(doneAugust.request.status, "succeeded");
    assert.deepEqual(doneAugust.result.sourceV0Hashes, [augustBefore.legacyHash]);
    const augustRows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ version: string | null }>(sql`
        select denomination_version as version from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `)).rows);
    assert.ok(augustRows.length > 0, "August stores corrected rows");
    for (const row of augustRows) assert.equal(row.version, "v1");
  });
});

test("a prior ordinary v1 rewrite with no preserved provenance refuses", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    await seedV0Month(ctx, MONTH);
    await seedV0Month(ctx, NEXT_MONTH);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const rewritten = await recomputeSaasMetrics(ctx.org.orgId, MONTH);
      assert.equal(rewritten.frozen, false, "the ordinary recompute rewrites July without audit provenance");
    });
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, approverId: ctx.approver });
    const { leaseToken } = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id });
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, leaseToken }),
      "saas_normalization_v0_provenance_missing",
      "audited normalization workflow",
    );
    assert.match(error.message, /saas_metrics_monthly:/, "the refusal names the unprovenanced dependency");
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id });
    assert.equal(status.status, "failed");
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `)).rows);
    assert.ok(rows.length > 0, "August legacy rows remain");
    for (const row of rows) assert.equal(row.currency, null, "no August row normalizes without provenance");
  });
});

test("a tampered prior v1 row does not poison the next month's proof", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    await seedV0Month(ctx, MONTH);
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedJuly.request.id,
      approverId: ctx.approver,
    });
    await withOrgTransaction(ctx.org.orgId, async () => {
      const tampered = await db.execute(sql`
        update saas_metrics_monthly set mrr_end = mrr_end + 1
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `);
      assert.equal(tampered.rows.length, 1, "the corrected July row must move to stage prior tamper");
    });
    const augustV0 = await seedV0Month(ctx, NEXT_MONTH);
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    const doneAugust = await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedAugust.request.id,
      approverId: ctx.approver,
    });
    assert.equal(doneAugust.request.status, "succeeded", "the immutable before-image still proves August");
    assert.deepEqual(doneAugust.result.sourceV0Hashes, [augustV0.legacyHash]);
  });
});

async function monthlyCorrectedChanges(ctx: Fixture): Promise<Record<string, unknown>> {
  const found = await withOrgTransaction(ctx.org.orgId, async () =>
    (await db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log
       where org_id = ${ctx.org.orgId} and table_name = 'saas_metrics_monthly'
         and action = 'saas_normalization_corrected'
       order by at limit 1
    `)).rows[0]?.changes);
  assert.ok(found, "a corrected monthly event must exist to stage conflicting provenance");
  return found;
}

async function appendAuditEvent(
  ctx: Fixture,
  table: string,
  rowId: string,
  changes: Record<string, unknown>,
  actorId: string,
  requestKey: string,
): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const stored = await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${ctx.org.orgId}, ${table}, ${rowId}, 'saas_normalization_corrected',
              ${JSON.stringify(changes)}::jsonb, ${actorId}, ${requestKey})
      returning id
    `);
    assert.equal(stored.rows.length, 1, "the conflicting audit candidate must append");
  });
}

test("a conflicting appended provenance candidate refuses as ambiguous", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx, MONTH);
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedJuly.request.id,
      approverId: ctx.approver,
    });
    await seedV0Month(ctx, NEXT_MONTH);
    const genuine = await monthlyCorrectedChanges(ctx);
    await appendAuditEvent(ctx, "saas_metrics_monthly", randomUUID(), {
      ...genuine,
      requestId: randomUUID(),
      request_id: randomUUID(),
    }, ctx.approver, randomUUID());
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, approverId: ctx.approver });
    const { leaseToken } = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id });
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, leaseToken }),
      "saas_normalization_provenance_ambiguous",
      "escalate with the request id",
    );
    assert.match(error.message, /prior month/, "the refusal names the ambiguously provenanced month");
    const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id });
    assert.equal(status.status, "failed");
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `)).rows);
    assert.ok(rows.length > 0, "August legacy rows remain");
    for (const row of rows) assert.equal(row.currency, null, "no August row normalizes on ambiguous provenance");
  });
});

test("a duplicated provenance event refuses as tampered over-count", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx, MONTH);
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    await approveAndExecuteNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filedJuly.request.id,
      approverId: ctx.approver,
    });
    await seedV0Month(ctx, NEXT_MONTH);
    const genuine = await monthlyCorrectedChanges(ctx);
    await appendAuditEvent(ctx, "saas_metrics_monthly", randomUUID(), genuine, ctx.approver, randomUUID());
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, approverId: ctx.approver });
    const { leaseToken } = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id });
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filedAugust.request.id, leaseToken }),
      "saas_normalization_provenance_tampered",
      "escalate with the request id",
    );
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null }>(sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `)).rows);
    assert.ok(rows.length > 0, "August legacy rows remain");
    for (const row of rows) assert.equal(row.currency, null, "no August row normalizes on a duplicated set");
  });
});

test("a post-claim feature-off records a fenced failed outcome, never a stranded run", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    const v0 = await seedV0Month(ctx);
    const filed = await fileRequest(ctx);
    await approveNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, approverId: ctx.approver });
    const { leaseToken } = await claimNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    await setSaaSMetricsFeature(ctx, false);
    const error = await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, leaseToken }),
      "feature_off",
      "Company Settings → Features",
    );
    assert.match(error.remedy, /SaaS metrics/, "the refusal carries the real Features remedy");
    const failed = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.equal(failed.status, "failed", "the claimed request never strands running");
    assert.match(failed.failure ?? "", /feature_off/);
    assert.match(failed.remedy ?? "", /Features/);
    const rows = await withOrgTransaction(ctx.org.orgId, async () =>
      (await db.execute<{ currency: string | null; hash: string }>(sql`
        select reporting_currency as currency, inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `)).rows);
    assert.equal(rows.length, v0.monthly.length, "no metric write survives the feature-off rollback");
    for (const row of rows) {
      assert.equal(row.currency, null);
      assert.equal(row.hash, v0.legacyHash);
    }
    await setSaaSMetricsFeature(ctx, true);
    const retried = await retryNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    await expectRefusal(
      executeNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id, leaseToken }),
      "saas_normalization_lease_mismatch",
      "live token",
    );
    const revived = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id });
    assert.equal(revived.status, "running", "the stale token never overwrites the newer lease");
    const result = await executeNormalizationRequest({
      orgId: ctx.org.orgId,
      requestId: filed.request.id,
      leaseToken: retried.leaseToken,
    });
    assert.equal(result.attempt, 2);
    assert.match(result.monthHash, /^[0-9a-f]{64}$/);
  });
});
