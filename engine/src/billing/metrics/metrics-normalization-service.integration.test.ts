import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { decideGate } from "../../flows/gates.ts";
import {
  prepareNormalizationFlowFixture,
  completeNormalizationFlowFixture,
  executeNormalizationFlowFixture,
  normalizationGateIds,
} from "../../testing/metrics-normalization.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  grantScratchPermissions,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { UsageBillingError } from "../usage/errors.ts";
import {
  approveAndExecuteNormalizationRequest,
  releaseNormalizationApproval,
  cancelNormalizationRequest,
  createNormalizationRequest,
  getNormalizationRequest,
  normalizationLeaseDigest,
  normalizationMonthLockKey,
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
const V1_EVIDENCE =
  '{"inputs_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}';

async function enableMetrics(orgId: string): Promise<void> {
  const result = await db.execute<{ id: string }>(
    sql`
    update orgs set settings = jsonb_set(
      settings,
      '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"subscriptionBilling":true,"saasMetrics":true}'::jsonb
    ) where id = ${orgId} returning id
  `,
    "objects",
  );
  assert.equal(result.length, 1, "the feature setting must be applied to the scratch organization");
}

interface Fixture {
  org: ScratchOrg;
  requester: string;
  approver: string;
}

async function withFixture(
  run: (ctx: Fixture) => Promise<void>,
  options: Parameters<typeof prepareNormalizationFlowFixture>[1] = {},
): Promise<void> {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const requester = await createScratchUser(
      org.orgId,
      "Normalization Requester",
      "metrics_requester",
    );
    const approver = await createScratchUser(org.orgId, "Normalization Approver", "admin");
    await withOrgTransaction(org.orgId, async () => {
      await enableMetrics(org.orgId);
    });
    const ctx = { org, requester, approver };
    await prepareNormalizationFlowFixture(ctx, options);
    await run(ctx);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function fileRequest(
  ctx: Fixture,
  overrides?: Partial<{
    month: string;
    reason: string;
    requestedBy: string;
    idempotencyKey: string;
  }>,
) {
  return createNormalizationRequest({
    orgId: ctx.org.orgId,
    month: overrides?.month ?? MONTH,
    reason: overrides?.reason ?? REASON,
    requestedBy: overrides?.requestedBy ?? ctx.requester,
    idempotencyKey: overrides?.idempotencyKey ?? randomUUID(),
  });
}

async function pendingFlowRequest(ctx: Fixture, overrides?: { idempotencyKey?: string }) {
  return fileRequest(ctx, overrides);
}

async function seedCustomerAndSubscription(
  ctx: Fixture,
  currency = "CAD",
): Promise<{ customerId: string; subscriptionId: string }> {
  const customerId = randomUUID();
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  await withOrgTransaction(ctx.org.orgId, async () => {
    const customer = await db.execute<{ id: string }>(
      sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id)
      values (${customerId}, ${ctx.org.orgId}, 'customer', 'Metrics Customer', ${ctx.org.subsidiaryId})
      returning id
    `,
      "objects",
    );
    assert.equal(customer.length, 1, "the customer must be stored");
    const plan = await db.execute<{ id: string }>(
      sql`
      insert into subscription_plans
        (id, org_id, name, amount, currency_code, interval, interval_count, income_account_id, created_by)
      values (${planId}, ${ctx.org.orgId}, 'Metrics plan', '100.0000', ${currency}, 'monthly', 1, null, ${ctx.requester})
      returning id
    `,
      "objects",
    );
    assert.equal(plan.length, 1, "the subscription plan must be stored");
    const subscription = await db.execute<{ id: string }>(
      sql`
      insert into subscriptions
        (id, org_id, customer_id, plan_id, quantity, price_override, status, start_on, next_bill_on, canceled_on, auto_post, created_by)
      values (${subscriptionId}, ${ctx.org.orgId}, ${customerId}, ${planId}, '1', '100.0000',
              'active', '2026-07-01', '2026-08-15', null, false, ${ctx.requester})
      returning id
    `,
      "objects",
    );
    assert.equal(subscription.length, 1, "the subscription must be stored");
  });
  return { customerId, subscriptionId };
}

/**
 * Seed one realistic legacy month: the exact v0 reproduction of the seeded
 * sources, stored with the reporting triple absent and the one canonical v0
 * hash. The proof accepts these rows because v0 recomputation reproduces
 * them byte-for-byte — never because a marker was trusted.
 */
async function seedV0Month(
  ctx: Fixture,
  month: string = MONTH,
  repeated = false,
): Promise<LegacyV0Month> {
  const v0 = await withOrgTransaction(ctx.org.orgId, async () =>
    computeLegacyV0Month(db, ctx.org.orgId, month),
  );
  await withOrgTransaction(ctx.org.orgId, async () => {
    for (const row of v0.monthly) {
      const stored = await db.execute<{ id: string }>(
        sql`
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
      `,
        "objects",
      );
      assert.equal(stored.length, 1, "the legacy monthly row must be stored");
    }
    for (const row of v0.facts) {
      const stored = await db.execute<{ id: string }>(
        sql`
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
      `,
        "objects",
      );
      assert.equal(stored.length, 1, "the legacy facts row must be stored");
    }
    for (const row of v0.cohorts) {
      const stored = await db.execute<{ id: string }>(
        sql`
        insert into saas_metrics_cohort_monthly
          (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
           start_customers, customers, inputs_hash)
        values (${ctx.org.orgId}, ${row.subsidiaryId}, ${row.cohortMonth}::date, ${row.month}::date,
                ${row.monthsSinceStart}, ${row.startMrr}, ${row.mrr},
                ${row.startCustomers}, ${row.customers}, ${v0.legacyHash})
        returning id
      `,
        "objects",
      );
      assert.equal(stored.length, 1, "the legacy cohort row must be stored");
    }
  });
  const replay = await withOrgTransaction(ctx.org.orgId, async () =>
    computeLegacyV0Month(db, ctx.org.orgId, month),
  );
  assert.equal(
    replay.initialLegacyHash,
    v0.legacyHash,
    "writing the cohort output must preserve the first computation's reproducible digest",
  );
  assert.deepEqual(replay.monthly, v0.monthly);
  assert.deepEqual(replay.facts, v0.facts);
  assert.deepEqual(replay.cohorts, v0.cohorts);
  if (!repeated) return v0;
  await withOrgTransaction(ctx.org.orgId, async () => {
    for (const table of [
      "saas_metrics_monthly",
      "saas_metrics_facts_monthly",
      "saas_metrics_cohort_monthly",
    ]) {
      const stored = await db.execute(
        sql`
        update ${sql.identifier(table)} set inputs_hash = ${replay.legacyHash}
         where org_id = ${ctx.org.orgId} and month = ${month}::date returning id
      `,
        "objects",
      );
      assert.equal(stored.length, 1, `${table} must record the repeated historical computation`);
    }
  });
  return replay;
}

async function setSaaSMetricsFeature(ctx: Fixture, enabled: boolean): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const result = await db.execute<{ id: string }>(
      sql`
      update orgs set settings = jsonb_set(
        settings,
        '{features}',
        coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ saasMetrics: enabled })}::jsonb
      ) where id = ${ctx.org.orgId} returning id
    `,
      "objects",
    );
    assert.equal(
      result.length,
      1,
      "the feature setting must be applied to the scratch organization",
    );
  });
}

async function seedFxRate(
  ctx: Fixture,
  from: string,
  to: string,
  asOf: string,
  rate: string,
): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const stored = await db.execute(
      sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${ctx.org.orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'manual')
      returning id
    `,
      "objects",
    );
    assert.equal(stored.length, 1, "the covering spot rate must be stored");
  });
}

async function seedNormalizedMonth(
  ctx: Fixture,
  customerId: string,
  subscriptionId: string,
): Promise<void> {
  await withOrgTransaction(ctx.org.orgId, async () => {
    const monthly = await db.execute(
      sql`
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
      returning id
    `,
      "objects",
    );
    assert.equal(monthly.length, 1, "the normalized subscription month must be stored");
    const facts = await db.execute(
      sql`
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
      returning id
    `,
      "objects",
    );
    assert.equal(facts.length, 1, "the normalized subsidiary facts must be stored");
    const cohort = await db.execute(
      sql`
      insert into saas_metrics_cohort_monthly
        (org_id, subsidiary_id, cohort_month, month, months_since_start, start_mrr, mrr,
         start_customers, customers, inputs_hash,
         reporting_currency, denomination_version, normalization_evidence)
      values (${ctx.org.orgId}, ${ctx.org.subsidiaryId}, ${MONTH}::date, ${MONTH}::date,
              0, '100.0000', '100.0000', 1, 1,
              'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
              'CAD', 'v1', ${V1_EVIDENCE}::jsonb)
      returning id
    `,
      "objects",
    );
    assert.equal(cohort.length, 1, "the normalized cohort month must be stored");
  });
}

async function requestAuditEvents(
  orgId: string,
  requestId: string,
): Promise<Array<{ action: string; changes: Record<string, unknown> }>> {
  return withOrgTransaction(
    orgId,
    async () =>
      await db.execute<{ action: string; changes: Record<string, unknown> }>(
        sql`
      select action, changes from audit_log
       where org_id = ${orgId} and table_name = 'saas_metrics_normalization_requests' and row_id = ${requestId}
       order by at, cmin::text::bigint, id
    `,
        "objects",
      ),
  );
}

async function correctionAuditEvents(
  orgId: string,
): Promise<Array<{ table: string; row: string; changes: Record<string, unknown> }>> {
  return withOrgTransaction(
    orgId,
    async () =>
      await db.execute<{ table: string; row: string; changes: Record<string, unknown> }>(
        sql`
      select table_name as table, row_id::text as row, changes from audit_log
       where org_id = ${orgId} and action = 'saas_normalization_corrected'
       order by table_name, row_id
    `,
        "objects",
      ),
  );
}

async function expectRefusal(
  run: Promise<unknown>,
  code: string,
  remedyFragment: string,
): Promise<UsageBillingError> {
  let error: unknown = await run.then(
    () => null,
    (failure: unknown) => failure,
  );
  for (
    let depth = 0;
    depth < 8 && error instanceof Error && !(error instanceof UsageBillingError) && error.cause;
    depth++
  )
    error = error.cause;
  assert.ok(
    error instanceof UsageBillingError,
    `expected a UsageBillingError (${code}), saw ${String(error)}`,
  );
  assert.equal(error.code, code, "the refusal must name its code");
  assert.match(error.remedy, new RegExp(remedyFragment), "the refusal must pin a usable remedy");
  return error;
}

function expectSyncRefusal(
  run: () => unknown,
  code: string,
  remedyFragment: string,
  label = "provenance",
): UsageBillingError {
  let error: unknown = null;
  try {
    run();
  } catch (failure) {
    error = failure;
  }
  assert.ok(
    error instanceof UsageBillingError,
    `${label}: expected a UsageBillingError (${code}), saw ${String(error)}`,
  );
  assert.equal(error.code, code, `${label}: the refusal must name its code`);
  assert.match(
    error.remedy,
    new RegExp(remedyFragment),
    `${label}: the refusal must pin a usable remedy`,
  );
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
    columnRequestKey: PROV_KEY,
    columnActorId: PROV_APPROVER,
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
    after: { id: PROV_ROW, subscriptionId: PROV_SUB, month: MONTH, inputsHash: PROV_V1H },
    ...overrides,
  };
}

function provFactsEvent(overrides: Partial<ProvenanceEvent> = {}): ProvenanceEvent {
  return {
    table: "saas_metrics_facts_monthly",
    rowId: PROV_ROW,
    month: MONTH,
    naturalKey: { subsidiaryId: PROV_SUBSIDIARY, month: MONTH },
    event: "saas_normalization_corrected",
    change: "corrected",
    actor: PROV_APPROVER,
    requestId: PROV_REQUEST,
    columnRequestKey: PROV_KEY,
    columnActorId: PROV_APPROVER,
    attempt: 1,
    sourceV0Hash: PROV_V0H,
    v1Hash: PROV_V1H,
    before: {
      subsidiaryId: PROV_SUBSIDIARY,
      month: MONTH,
      mrrEnd: "100.0000",
      inputsHash: PROV_V0H,
      reportingCurrency: null,
      denominationVersion: null,
    },
    after: { id: PROV_ROW, subsidiaryId: PROV_SUBSIDIARY, month: MONTH, inputsHash: PROV_V1H },
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
    ["column actor", { columnActorId: PROV_APPROVER.replace("1", "9") }, {}],
    ["column idempotency key", { columnRequestKey: PROV_KEY.replace("3", "9") }, {}],
    ["null column idempotency key", { columnRequestKey: null }, {}],
    ["requestId", { requestId: PROV_REQUEST.replace("2", "9") }, {}],
    ["sourceV0Hash outside the recorded set", { sourceV0Hash: "c".repeat(64) }, {}],
    [
      "sourceV0Hash detached from the before hash",
      { sourceV0Hash: "c".repeat(64) },
      { result: { ...provRequest().result!, sourceV0Hashes: [PROV_V0H, "c".repeat(64)] } },
    ],
    [
      "malformed before hash",
      {
        sourceV0Hash: "xyz",
        before: { ...(provEvent().before as Record<string, unknown>), inputsHash: "xyz" },
      },
      {},
    ],
    ["v1Hash", { v1Hash: "d".repeat(64) }, {}],
    [
      "after hash",
      {
        after: { id: PROV_ROW, subscriptionId: PROV_SUB, month: MONTH, inputsHash: "d".repeat(64) },
      },
      {},
    ],
    ["row identity", { rowId: PROV_ROW.replace("5", "9") }, {}],
    [
      "after subscription",
      {
        after: {
          id: PROV_ROW,
          subscriptionId: PROV_SUB.replace("4", "9"),
          month: MONTH,
          inputsHash: PROV_V1H,
        },
      },
      {},
    ],
    [
      "after month",
      {
        after: { id: PROV_ROW, subscriptionId: PROV_SUB, month: NEXT_MONTH, inputsHash: PROV_V1H },
      },
      {},
    ],
    ["failed request", {}, { status: "failed" }],
    ["null result", {}, { result: null }],
    ["wrong result month", {}, { result: { ...provRequest().result!, month: NEXT_MONTH } }],
    [
      "malformed sourceV0Hashes",
      {},
      {
        result: { ...provRequest().result!, sourceV0Hashes: "b".repeat(64) as unknown as string[] },
      },
    ],
  ];
  for (const [name, eventOverride, requestOverride] of cases) {
    expectSyncRefusal(
      () =>
        validateProvenanceEvent(
          provEvent(eventOverride),
          provRequest(requestOverride),
          "saas_metrics_monthly",
          MONTH,
        ),
      "saas_normalization_provenance_tampered",
      "escalate with the request id",
      name,
    );
  }
});

test("provenance count shortfalls refuse as incomplete and over-counts as tampered", () => {
  const result = provRequest().result!;
  expectSyncRefusal(
    () =>
      validateProvenanceCounts(
        { saas_metrics_monthly: 0, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 },
        result,
        MONTH,
      ),
    "saas_normalization_provenance_incomplete",
    "escalate with the request id",
  );
  expectSyncRefusal(
    () =>
      validateProvenanceCounts(
        { saas_metrics_monthly: 2, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 },
        result,
        MONTH,
      ),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
});

test("malformed recorded result shapes refuse instead of bypassing", () => {
  const good = provRequest().result!;
  expectSyncRefusal(
    () =>
      validateProvenanceCounts(
        { saas_metrics_monthly: 1, saas_metrics_facts_monthly: 1, saas_metrics_cohort_monthly: 1 },
        { ...good, replacedMonthly: -1 },
        MONTH,
      ),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
  expectSyncRefusal(
    () =>
      validateProvenanceCounts(
        { saas_metrics_monthly: 1, saas_metrics_facts_monthly: 1 },
        good,
        MONTH,
      ),
    "saas_normalization_provenance_incomplete",
    "escalate with the request id",
  );
});

test("facts events authenticate with the same contract and after natural key", () => {
  const before = validateProvenanceEvent(
    provFactsEvent(),
    provRequest(),
    "saas_metrics_facts_monthly",
    MONTH,
  );
  assert.equal((before as Record<string, unknown>).subsidiaryId, PROV_SUBSIDIARY);
  expectSyncRefusal(
    () =>
      validateProvenanceEvent(
        provFactsEvent({
          after: {
            id: PROV_ROW,
            subsidiaryId: PROV_SUBSIDIARY.replace("7", "9"),
            month: MONTH,
            inputsHash: PROV_V1H,
          },
        }),
        provRequest(),
        "saas_metrics_facts_monthly",
        MONTH,
      ),
    "saas_normalization_provenance_tampered",
    "escalate with the request id",
  );
  expectSyncRefusal(
    () =>
      validateProvenanceEvent(
        provFactsEvent({ actor: PROV_APPROVER.replace("1", "9") }),
        provRequest(),
        "saas_metrics_facts_monthly",
        MONTH,
      ),
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
    () =>
      historyRowFromProvenance(
        { ...before, subscriptionId: PROV_SUB.replace("4", "9") },
        PROV_SUB,
        MONTH,
        MONTH,
      ),
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
    () =>
      startRowFromProvenance({ ...startBefore, startCustomers: -1 }, PROV_SUBSIDIARY, MONTH, MONTH),
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
  assert.equal(
    normalizationMonthLockKey("org-1", MONTH),
    "openbooks:saas-normalization:org-1:2026-07-01",
  );
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
    createNormalizationRequest({
      orgId,
      month: "2026-07-15",
      reason: REASON,
      requestedBy: actor,
      idempotencyKey: key,
    }),
    "saas_normalization_month_invalid",
    "YYYY-MM-01",
  );
  await expectRefusal(
    createNormalizationRequest({
      orgId,
      month: MONTH,
      reason: "short",
      requestedBy: actor,
      idempotencyKey: key,
    }),
    "saas_normalization_reason_invalid",
    "Company Setup",
  );
  await expectRefusal(
    createNormalizationRequest({
      orgId,
      month: MONTH,
      reason: REASON,
      requestedBy: "",
      idempotencyKey: key,
    }),
    "saas_normalization_requested_by_invalid",
    "UUID",
  );
});

test(
  "same key with a byte-identical body replays, with a different body conflicts",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      const key = randomUUID();
      const first = await fileRequest(ctx, { idempotencyKey: key });
      assert.equal(first.created, true);
      assert.equal(first.request.status, "pending");
      const replay = await fileRequest(ctx, { idempotencyKey: key });
      assert.equal(replay.created, false, "the identical body must return the existing request");
      assert.equal(replay.request.id, first.request.id);
      await expectRefusal(
        fileRequest(ctx, {
          idempotencyKey: key,
          reason: "A completely different correction story.",
        }).then(() => null),
        "saas_normalization_idempotency_conflict",
        "new idempotency key",
      );
    });
  },
);

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

test(
  "a requester outside the organization is refused and stores nothing",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      const outsider = randomUUID();
      await assert.rejects(
        fileRequest(ctx, { requestedBy: outsider }).then(() => null),
        "an out-of-organization requester must fail the subject guard",
      );
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          (
            await db.execute<{ count: string }>(
              sql`
        select count(*)::text as count from saas_metrics_normalization_requests where org_id = ${ctx.org.orgId}
      `,
              "objects",
            )
          )[0]?.count,
      );
      assert.equal(rows, "0", "the refused write must store no request row");
    });
  },
);

test(
  "an empty month refuses with the recompute remedy and records the failure",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      const { request } = await pendingFlowRequest(ctx);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_nothing_to_correct",
        "ordinary SaaS metrics recompute",
      );
      const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
      assert.equal(status.status, "pending", "a refused native decision rolls its lifecycle back");
      assert.equal(status.failure, null);
      assert.equal(status.remedy, null);
      const stored = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          (
            await db.execute<{ count: string }>(
              sql`
        select count(*)::text as count from saas_metrics_monthly where org_id = ${ctx.org.orgId}
      `,
              "objects",
            )
          )[0]?.count,
      );
      assert.equal(stored, "0", "no metric write survives a refused proof");
    });
  },
);

test(
  "a fully normalized month refuses as already done and keeps its rows",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      const seeded = await seedCustomerAndSubscription(ctx);
      await seedNormalizedMonth(ctx, seeded.customerId, seeded.subscriptionId);
      const { request } = await pendingFlowRequest(ctx);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_already_normalized",
        "stored month",
      );
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ hash: string }>(
            sql`
        select inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(rows.length, 1, "the refused correction writes nothing");
      assert.equal(
        rows[0]?.hash,
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "the stored v1 hash is untouched",
      );
    });
  },
);

test(
  "a mixed legacy and normalized month refuses as unsupported partial",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const changed = await db.execute(
          sql`
        update saas_metrics_facts_monthly
           set reporting_currency = 'CAD', denomination_version = 'v1',
               normalization_evidence = ${V1_EVIDENCE}::jsonb
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `,
          "objects",
        );
        assert.equal(
          changed.length,
          1,
          "the subsidiary facts must become normalized to stage a mixed month",
        );
      });
      const { request } = await pendingFlowRequest(ctx);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_partial_denominations",
        "never edited by hand",
      );
      const monthly = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null }>(
            sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(
        monthly[0]?.currency,
        null,
        "the legacy row stays legacy after the refused batch",
      );
    });
  },
);

test(
  "missing FX evidence fails the batch with its setup remedy and no writes",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx, "EUR");
      await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
      const v0 = await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const removed = await db.execute(
          sql`
        delete from fx_rates
         where org_id = ${ctx.org.orgId} and from_currency = 'EUR' and to_currency = 'CAD'
        returning id
      `,
          "objects",
        );
        assert.equal(removed.length, 1, "the covering rate must be withdrawn to stage the drift");
      });
      const { request } = await pendingFlowRequest(ctx);
      const error = await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_metrics_fx_rate_missing",
        "FX rates",
      );
      assert.match(error.message, /EUR→CAD/, "the refusal names the uncovered pair");
      const status = await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: request.id });
      assert.equal(status.status, "pending", "a refused native decision rolls its lifecycle back");
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null; hash: string }>(
            sql`
        select reporting_currency as currency, inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.currency, null, "the legacy row is untouched by the failed batch");
      assert.equal(
        rows[0]?.hash,
        v0.legacyHash,
        "the recorded v0 hash is untouched by the failed batch",
      );
      const corrections = await correctionAuditEvents(ctx.org.orgId);
      assert.equal(corrections.length, 0, "a failed batch records no per-row correction evidence");
    });
  },
);

test(
  "a reproduced legacy month corrects atomically with per-row before and after evidence",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      const v0 = await seedV0Month(ctx);
      const journalBefore = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          (
            await db.execute<{ count: string }>(
              sql`
        select count(*)::text as count from journal_entries where org_id = ${ctx.org.orgId}
      `,
              "objects",
            )
          )[0]?.count,
      );
      const { request } = await pendingFlowRequest(ctx);
      const result = await executeNormalizationFlowFixture(ctx, request.id);
      assert.equal(result.month, MONTH);
      assert.equal(result.reportingCurrency, "CAD");
      assert.equal(result.denominationVersion, "v1");
      assert.match(result.monthHash, /^[0-9a-f]{64}$/);
      assert.deepEqual(
        result.sourceV0Hashes,
        [v0.legacyHash],
        "the proof pins the one common reproduced v0 hash",
      );
      assert.equal(result.replacedMonthly, v0.monthly.length);
      assert.equal(result.replacedFacts, v0.facts.length);
      assert.equal(result.replacedCohorts, v0.cohorts.length);
      const stored = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ hash: string; currency: string; version: string }>(
            sql`
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        union all
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_facts_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        union all
        select inputs_hash as hash, reporting_currency as currency, denomination_version as version
          from saas_metrics_cohort_monthly where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(
        stored.length,
        v0.monthly.length + v0.facts.length + v0.cohorts.length,
        "exactly the month's three row sets are replaced",
      );
      for (const row of stored) {
        assert.equal(
          row.hash,
          result.monthHash,
          "every replaced row carries the canonical v1 hash",
        );
        assert.equal(row.currency, "CAD");
        assert.equal(row.version, "v1");
      }
      const corrections = await correctionAuditEvents(ctx.org.orgId);
      assert.equal(
        corrections.length,
        stored.length,
        "each replaced row carries before and after evidence",
      );
      for (const event of corrections) {
        const changes = event.changes as Record<string, unknown>;
        assert.equal(changes.requestId, request.id);
        assert.equal(changes.attempt, 1);
        assert.equal(changes.actor, ctx.approver);
        assert.equal(changes.reason, REASON);
        assert.equal(
          changes.change,
          "corrected",
          "grain-preserving corrections never add or remove rows",
        );
        assert.equal(changes.sourceV0Hash, v0.legacyHash);
        assert.equal(changes.v1Hash, result.monthHash);
        assert.ok(changes.before, "the legacy before-image is recorded");
        assert.ok(changes.after, "the normalized after-image is recorded");
        assert.equal(
          Object.hasOwn(changes, "leaseToken"),
          false,
          "raw lease tokens never enter audit",
        );
      }
      const replay = await executeNormalizationFlowFixture(ctx, request.id);
      assert.deepEqual(
        replay,
        result,
        "a succeeded byte-identical replay returns the recorded result",
      );
      const journalAfter = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          (
            await db.execute<{ count: string }>(
              sql`
        select count(*)::text as count from journal_entries where org_id = ${ctx.org.orgId}
      `,
              "objects",
            )
          )[0]?.count,
      );
      assert.equal(journalAfter, journalBefore, "posted accounting history is never rewritten");
    });
  },
);

test(
  "a closed month corrects only through the approved request without reopening",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const closed = await db.execute(
          sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state)
        values (${ctx.org.orgId}, ${ctx.org.periodId}, ${ctx.org.bookId}, null, 'ar', 'closed')
        returning period_id
      `,
          "objects",
        );
        assert.equal(closed.length, 1, "July AR must be closed before the correction");
      });
      const { request } = await pendingFlowRequest(ctx);
      const result = await executeNormalizationFlowFixture(ctx, request.id);
      assert.match(result.monthHash, /^[0-9a-f]{64}$/);
      const locks = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ state: string }>(
            sql`
        select state from period_locks
         where org_id = ${ctx.org.orgId} and period_id = ${ctx.org.periodId} and module = 'ar'
      `,
            "objects",
          ),
      );
      assert.equal(locks[0]?.state, "closed", "the accounting period stays closed throughout");
    });
  },
);

test(
  "a changed source refuses as drift with zero writes and the chained remedy",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      const seeded = await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const changed = await db.execute(
          sql`
        update subscriptions set price_override = '200.0000'
         where org_id = ${ctx.org.orgId} and id = ${seeded.subscriptionId}
        returning id
      `,
          "objects",
        );
        assert.equal(changed.length, 1, "the subscription price must move to stage source drift");
      });
      const { request } = await pendingFlowRequest(ctx);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_source_drift",
        "earlier months first",
      );
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null }>(
            sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(rows.length, 1, "the drifted batch writes no v1 row");
      assert.equal(rows[0]?.currency, null, "the legacy row stays legacy after source drift");
    });
  },
);

test(
  "a tampered stored value refuses with zero writes and administrator escalation",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      const v0 = await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const tampered = await db.execute(
          sql`
        update saas_metrics_monthly set mrr_end = mrr_end + 1, expansion_mrr = expansion_mrr + 1
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `,
          "objects",
        );
        assert.equal(tampered.length, 1, "the stored value must move to stage tamper");
      });
      const { request } = await pendingFlowRequest(ctx);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_stored_tamper",
        "never edited by hand",
      );
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null; hash: string }>(
            sql`
        select reporting_currency as currency, inputs_hash as hash from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(rows.length, 1, "the tampered batch writes no v1 row");
      assert.equal(rows[0]?.currency, null);
      assert.equal(rows[0]?.hash, v0.legacyHash, "the recorded hash still stands");
    });
  },
);

test(
  "a tampered stored hash refuses with zero writes and administrator escalation",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const tampered = await db.execute(
          sql`
        update saas_metrics_monthly
           set inputs_hash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `,
          "objects",
        );
        assert.equal(tampered.length, 1, "the stored hash must move to stage tamper");
      });
      const { request } = await pendingFlowRequest(ctx);
      const error = await expectRefusal(
        executeNormalizationFlowFixture(ctx, request.id),
        "saas_normalization_hash_tamper",
        "never edited by hand",
      );
      assert.match(error.remedy, /escalate with the request id/);
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null }>(
            sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
            "objects",
          ),
      );
      assert.equal(rows.length, 1, "the tampered batch writes no v1 row");
      assert.equal(rows[0]?.currency, null);
    });
  },
);

test("a missing stored row refuses as key drift with zero writes", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const removed = await db.execute(
        sql`
        delete from saas_metrics_facts_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `,
        "objects",
      );
      assert.equal(removed.length, 1, "the facts row must leave to stage a missing key");
    });
    const { request } = await pendingFlowRequest(ctx);
    await expectRefusal(
      executeNormalizationFlowFixture(ctx, request.id),
      "saas_normalization_v0_key_drift",
      "new request",
    );
    const rows = await withOrgTransaction(
      ctx.org.orgId,
      async () =>
        await db.execute<{ currency: string | null }>(
          sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
          "objects",
        ),
    );
    assert.equal(rows.length, 1, "the key-drifted batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
  });
});

test("an extra source key refuses as key drift with zero writes", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx);
    await seedCustomerAndSubscription(ctx);
    const { request } = await pendingFlowRequest(ctx);
    const error = await expectRefusal(
      executeNormalizationFlowFixture(ctx, request.id),
      "saas_normalization_v0_key_drift",
      "new request",
    );
    assert.match(
      error.message,
      /saas_metrics_monthly:/,
      "the refusal names the drifted natural key",
    );
    const rows = await withOrgTransaction(
      ctx.org.orgId,
      async () =>
        await db.execute<{ currency: string | null }>(
          sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
      `,
          "objects",
        ),
    );
    assert.equal(rows.length, 1, "the key-drifted batch writes no v1 row");
    assert.equal(rows[0]?.currency, null);
  });
});

test(
  "chained mixed-currency months reproduce v0 across the audited correction",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx, "EUR");
      await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
      await seedV0Month(ctx, MONTH);
      const augustBefore = await withOrgTransaction(ctx.org.orgId, async () =>
        computeLegacyV0Month(db, ctx.org.orgId, NEXT_MONTH),
      );
      const filedJuly = await fileRequest(ctx, { month: MONTH });
      const doneJuly = await completeNormalizationFlowFixture(ctx, filedJuly.request.id);
      assert.equal(doneJuly.request.status, "succeeded");
      const augustAfter = await withOrgTransaction(ctx.org.orgId, async () =>
        computeLegacyV0Month(db, ctx.org.orgId, NEXT_MONTH),
      );
      assert.equal(
        augustAfter.legacyHash,
        augustBefore.legacyHash,
        "August reproduces its original v0 hash from July's preserved before-image",
      );
      await seedV0Month(ctx, NEXT_MONTH);
      const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
      const doneAugust = await completeNormalizationFlowFixture(ctx, filedAugust.request.id);
      assert.equal(doneAugust.request.status, "succeeded");
      assert.deepEqual(doneAugust.result.sourceV0Hashes, [augustBefore.legacyHash]);
      const augustRows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ version: string | null }>(
            sql`
        select denomination_version as version from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `,
            "objects",
          ),
      );
      assert.ok(augustRows.length > 0, "August stores corrected rows");
      for (const row of augustRows) assert.equal(row.version, "v1");
    });
  },
);

test(
  "a prior ordinary v1 rewrite with no preserved provenance refuses",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx, "EUR");
      await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
      await seedV0Month(ctx, MONTH);
      await seedV0Month(ctx, NEXT_MONTH);
      await withOrgTransaction(ctx.org.orgId, async () => {
        const rewritten = await recomputeSaasMetrics(ctx.org.orgId, MONTH);
        assert.equal(
          rewritten.frozen,
          false,
          "the ordinary recompute rewrites July without audit provenance",
        );
      });
      const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
      const error = await expectRefusal(
        executeNormalizationFlowFixture(ctx, filedAugust.request.id),
        "saas_normalization_v0_provenance_missing",
        "audited normalization workflow",
      );
      assert.ok(
        error.message.includes(`Month ${NEXT_MONTH} depends on prior month ${MONTH}`),
        `the refusal must name the affected month and its unprovenanced dependency; received ${error.message}`,
      );
      const status = await getNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filedAugust.request.id,
      });
      assert.equal(status.status, "pending", "a refused native decision rolls its lifecycle back");
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null }>(
            sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `,
            "objects",
          ),
      );
      assert.ok(rows.length > 0, "August legacy rows remain");
      for (const row of rows)
        assert.equal(row.currency, null, "no August row normalizes without provenance");
    });
  },
);

test("a tampered prior v1 row does not poison the next month's proof", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx, "EUR");
    await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
    await seedV0Month(ctx, MONTH);
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    await completeNormalizationFlowFixture(ctx, filedJuly.request.id);
    await withOrgTransaction(ctx.org.orgId, async () => {
      const tampered = await db.execute(
        sql`
        update saas_metrics_monthly set mrr_end = mrr_end + 1, expansion_mrr = expansion_mrr + 1
         where org_id = ${ctx.org.orgId} and month = ${MONTH}::date
        returning id
      `,
        "objects",
      );
      assert.equal(tampered.length, 1, "the corrected July row must move to stage prior tamper");
    });
    const augustV0 = await seedV0Month(ctx, NEXT_MONTH);
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    const doneAugust = await completeNormalizationFlowFixture(ctx, filedAugust.request.id);
    assert.equal(
      doneAugust.request.status,
      "succeeded",
      "the immutable before-image still proves August",
    );
    assert.deepEqual(doneAugust.result.sourceV0Hashes, [augustV0.legacyHash]);
  });
});

async function monthlyCorrectedChanges(ctx: Fixture): Promise<Record<string, unknown>> {
  const found = await withOrgTransaction(
    ctx.org.orgId,
    async () =>
      (
        await db.execute<{ changes: Record<string, unknown> }>(
          sql`
      select changes from audit_log
       where org_id = ${ctx.org.orgId} and table_name = 'saas_metrics_monthly'
         and action = 'saas_normalization_corrected'
       order by at limit 1
    `,
          "objects",
        )
      )[0]?.changes,
  );
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
    const stored = await db.execute(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${ctx.org.orgId}, ${table}, ${rowId}, 'saas_normalization_corrected',
              ${JSON.stringify(changes)}::jsonb, ${actorId}, ${requestKey})
      returning id
    `,
      "objects",
    );
    assert.equal(stored.length, 1, "the conflicting audit candidate must append");
  });
}

test(
  "a succeeded correction binds audit columns, counts, and hashes to its request",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx, MONTH);
      const filed = await fileRequest(ctx);
      const done = await completeNormalizationFlowFixture(ctx, filed.request.id);
      assert.equal(done.request.status, "succeeded");
      const bound = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{
            table: string;
            row_id: string;
            request_key: string | null;
            actor_id: string | null;
            changes: Record<string, unknown>;
          }>(
            sql`
        select table_name as table, row_id::text as row_id,
               request_id as request_key, actor_id::text as actor_id, changes
          from audit_log
         where org_id = ${ctx.org.orgId} and action = 'saas_normalization_corrected'
         order by at
      `,
            "objects",
          ),
      );
      assert.equal(bound.length, 3, "one correction records all three row sets");
      const counts: Record<string, number> = {};
      for (const row of bound) {
        counts[row.table] = (counts[row.table] ?? 0) + 1;
        assert.equal(
          row.request_key,
          filed.request.idempotencyKey,
          "the canonical column carries the idempotency key",
        );
        assert.equal(row.actor_id, ctx.approver, "the canonical column carries the approver actor");
        const changes = row.changes;
        assert.equal(changes.requestId, filed.request.id, "the envelope binds the request row");
        assert.equal(
          changes.actor,
          ctx.approver,
          "the envelope actor matches the canonical column",
        );
        assert.equal(changes.sourceV0Hash, (changes.before as Record<string, unknown>).inputsHash);
        assert.equal(changes.v1Hash, done.result.monthHash);
        assert.equal((changes.after as Record<string, unknown>).id, row.row_id);
        assert.equal((changes.after as Record<string, unknown>).inputsHash, done.result.monthHash);
      }
      assert.deepEqual(
        counts,
        {
          saas_metrics_monthly: done.result.replacedMonthly,
          saas_metrics_facts_monthly: done.result.replacedFacts,
          saas_metrics_cohort_monthly: done.result.replacedCohorts,
        },
        "event counts equal the recorded replacement counts",
      );
      assert.ok(
        (done.result.sourceV0Hashes as string[]).length > 0,
        "the recorded result carries the proved v0 hashes",
      );
    });
  },
);

test(
  "a conflicting appended provenance candidate refuses as ambiguous",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx, MONTH);
      const filedJuly = await fileRequest(ctx, { month: MONTH });
      await completeNormalizationFlowFixture(ctx, filedJuly.request.id);
      await seedV0Month(ctx, NEXT_MONTH);
      const genuine = await monthlyCorrectedChanges(ctx);
      await appendAuditEvent(
        ctx,
        "saas_metrics_monthly",
        randomUUID(),
        {
          ...genuine,
          requestId: randomUUID(),
          request_id: randomUUID(),
        },
        ctx.approver,
        randomUUID(),
      );
      const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
      const error = await expectRefusal(
        executeNormalizationFlowFixture(ctx, filedAugust.request.id),
        "saas_normalization_provenance_ambiguous",
        "escalate with the request id",
      );
      assert.match(
        error.message,
        /prior month/,
        "the refusal names the ambiguously provenanced month",
      );
      const status = await getNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filedAugust.request.id,
      });
      assert.equal(status.status, "pending", "a refused native decision rolls its lifecycle back");
      const rows = await withOrgTransaction(
        ctx.org.orgId,
        async () =>
          await db.execute<{ currency: string | null }>(
            sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `,
            "objects",
          ),
      );
      assert.ok(rows.length > 0, "August legacy rows remain");
      for (const row of rows)
        assert.equal(row.currency, null, "no August row normalizes on ambiguous provenance");
    });
  },
);

test("a duplicated provenance event refuses as tampered over-count", { skip: !DB }, async () => {
  await withFixture(async (ctx) => {
    await seedCustomerAndSubscription(ctx);
    await seedV0Month(ctx, MONTH);
    const filedJuly = await fileRequest(ctx, { month: MONTH });
    await completeNormalizationFlowFixture(ctx, filedJuly.request.id);
    await seedV0Month(ctx, NEXT_MONTH);
    const genuine = await monthlyCorrectedChanges(ctx);
    await appendAuditEvent(
      ctx,
      "saas_metrics_monthly",
      randomUUID(),
      genuine,
      ctx.approver,
      randomUUID(),
    );
    const filedAugust = await fileRequest(ctx, { month: NEXT_MONTH });
    await expectRefusal(
      executeNormalizationFlowFixture(ctx, filedAugust.request.id),
      "saas_normalization_provenance_tampered",
      "escalate with the request id",
    );
    const rows = await withOrgTransaction(
      ctx.org.orgId,
      async () =>
        await db.execute<{ currency: string | null }>(
          sql`
        select reporting_currency as currency from saas_metrics_monthly
         where org_id = ${ctx.org.orgId} and month = ${NEXT_MONTH}::date
      `,
          "objects",
        ),
    );
    assert.ok(rows.length > 0, "August legacy rows remain");
    for (const row of rows)
      assert.equal(row.currency, null, "no August row normalizes on a duplicated set");
  });
});

test(
  "zero tenant gates release a correction without a separate approver",
  { skip: !DB },
  async () => {
    await withFixture(
      async (ctx) => {
        await seedCustomerAndSubscription(ctx);
        await seedV0Month(ctx);
        assert.equal(
          await withOrgTransaction(ctx.org.orgId, () =>
            actorHasPermission(db, ctx.org.orgId, ctx.requester, "close.reopen"),
          ),
          false,
        );
        const filed = await fileRequest(ctx);
        assert.equal(filed.request.status, "succeeded");
        assert.equal(filed.request.approvedBy, ctx.requester);
        assert.deepEqual(await normalizationGateIds(ctx, filed.request.id), []);
        assert.ok(filed.request.result);
        assert.equal(Object.hasOwn(filed.request, "leaseToken"), false);
      },
      { gates: 0 },
    );
  },
);

test(
  "every configured tenant gate completes before the correction is released",
  { skip: !DB },
  async () => {
    await withFixture(
      async (ctx) => {
        await seedCustomerAndSubscription(ctx);
        const before = await seedV0Month(ctx);
        const filed = await fileRequest(ctx);
        const gates = await normalizationGateIds(ctx, filed.request.id);
        assert.equal(gates.length, 10);
        for (const gateId of gates.slice(0, -1))
          await decideGate({ gateId, userId: ctx.approver, decision: "approved" });
        assert.equal(
          (await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id }))
            .status,
          "pending",
        );
        assert.equal((await correctionAuditEvents(ctx.org.orgId)).length, 0);
        const stored = await withOrgTransaction(ctx.org.orgId, () =>
          db.execute<{ hash: string }>(
            sql`select inputs_hash as hash
      from saas_metrics_monthly where org_id=${ctx.org.orgId} and month=${MONTH}`,
            "objects",
          ),
        );
        assert.equal(stored[0]?.hash, before.legacyHash);
        await decideGate({ gateId: gates.at(-1)!, userId: ctx.approver, decision: "approved" });
        const done = await getNormalizationRequest({
          orgId: ctx.org.orgId,
          requestId: filed.request.id,
        });
        assert.equal(done.status, "succeeded");
        assert.equal(done.attemptCount, 1);
      },
      { gates: 10 },
    );
  },
);

test(
  "the tenant may explicitly allow its requester to decide the correction gate",
  { skip: !DB },
  async () => {
    await withFixture(
      async (ctx) => {
        await seedCustomerAndSubscription(ctx);
        await seedV0Month(ctx);
        const filed = await fileRequest(ctx);
        const done = await completeNormalizationFlowFixture(ctx, filed.request.id, ctx.requester);
        assert.equal(done.request.status, "succeeded");
        assert.equal(done.request.approvedBy, ctx.requester);
      },
      { allowSelfApproval: true },
    );
  },
);

test(
  "a direct release claim cannot replace the correction's native Flow decisions",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      const filed = await fileRequest(ctx);
      for (const outcome of ["approved", "rejected"] as const)
        await expectRefusal(
          releaseNormalizationApproval({
            subjectId: filed.request.id,
            outcome,
            ctx: { orgId: ctx.org.orgId, userId: ctx.approver },
          }),
          "saas_normalization_approval_required",
          "pending correction Flow gate",
        );
      await expectRefusal(
        approveAndExecuteNormalizationRequest({
          orgId: ctx.org.orgId,
          requestId: filed.request.id,
          approverId: ctx.approver,
        }),
        "saas_normalization_approval_required",
        "Approvals",
      );
      assert.equal(
        (await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id }))
          .status,
        "pending",
      );
      assert.equal((await correctionAuditEvents(ctx.org.orgId)).length, 0);
    });
  },
);

test(
  "concurrent decisions release one correction and preserve its recorded replay",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      const filed = await fileRequest(ctx);
      const [gateId] = await normalizationGateIds(ctx, filed.request.id);
      assert.ok(gateId);
      const decisions = await Promise.allSettled(
        [1, 2].map(() => decideGate({ gateId, userId: ctx.approver, decision: "approved" })),
      );
      assert.equal(decisions.filter((r) => r.status === "fulfilled").length, 1);
      const done = await completeNormalizationFlowFixture(ctx, filed.request.id);
      assert.equal(done.request.attemptCount, 1);
      assert.deepEqual(
        (await completeNormalizationFlowFixture(ctx, filed.request.id)).result,
        done.result,
      );
      assert.equal(
        (await requestAuditEvents(ctx.org.orgId, filed.request.id)).filter(
          (e) => e.action === "saas_normalization_succeeded",
        ).length,
        1,
      );
    });
  },
);

test(
  "replayed creation and completion require the actor's current organization-wide authority",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      const key = randomUUID();
      const filed = await fileRequest(ctx, { idempotencyKey: key });
      await completeNormalizationFlowFixture(ctx, filed.request.id);
      await withOrgTransaction(ctx.org.orgId, () =>
        db.execute(sql`update user_permission_overrides set effect='deny'
      where org_id=${ctx.org.orgId} and user_id in (${ctx.requester},${ctx.approver}) and permission='usage.manage'`),
      );
      await assert.rejects(fileRequest(ctx, { idempotencyKey: key }), /not found/);
      await assert.rejects(completeNormalizationFlowFixture(ctx, filed.request.id), /not found/);
      const scoped = await createScratchUser(
        ctx.org.orgId,
        "Scoped metrics operator",
        "scoped_metrics_operator",
      );
      await grantScratchPermissions(ctx.org.orgId, scoped, ["usage.manage"]);
      await withOrgTransaction(ctx.org.orgId, () =>
        db.execute(sql`update app_roles set subsidiary_restriction=
      ${JSON.stringify({ mode: "list", subsidiaryIds: [ctx.org.subsidiaryId] })}::jsonb where org_id=${ctx.org.orgId} and key='scoped_metrics_operator'`),
      );
      await assert.rejects(
        fileRequest(ctx, { requestedBy: scoped, idempotencyKey: randomUUID() }),
        /not found/,
      );
    });
  },
);

test(
  "requester cancellation also withdraws pending native Flow work and retains its audit",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      await seedV0Month(ctx);
      const filed = await fileRequest(ctx);
      await expectRefusal(
        cancelNormalizationRequest({
          orgId: ctx.org.orgId,
          requestId: filed.request.id,
          actorId: ctx.approver,
        }),
        "saas_normalization_cancel_forbidden",
        "requester",
      );
      const cancelled = await cancelNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
        actorId: ctx.requester,
      });
      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(await normalizationGateIds(ctx, filed.request.id), []);
      assert.equal(
        (await requestAuditEvents(ctx.org.orgId, filed.request.id)).filter(
          (e) => e.action === "saas_normalization_cancelled",
        ).length,
        1,
      );
      const replacement = await fileRequest(ctx);
      assert.notEqual(replacement.request.id, filed.request.id);
    });
  },
);

test(
  "a refused decision leaves the original gate retryable and reruns the complete financial proof",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx, "EUR");
      await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
      await seedV0Month(ctx);
      const filed = await fileRequest(ctx);
      const originalGates = await normalizationGateIds(ctx, filed.request.id);
      await withOrgTransaction(ctx.org.orgId, () =>
        db.execute(
          sql`delete from fx_rates where org_id=${ctx.org.orgId} and from_currency='EUR' and to_currency='CAD'`,
        ),
      );
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, filed.request.id),
        "saas_metrics_fx_rate_missing",
        "FX rates",
      );
      assert.deepEqual(await normalizationGateIds(ctx, filed.request.id), originalGates);
      const pending = await getNormalizationRequest({
        orgId: ctx.org.orgId,
        requestId: filed.request.id,
      });
      assert.equal(pending.status, "pending");
      assert.equal(pending.attemptCount, 0);
      assert.equal(pending.approvedBy, null);
      await seedFxRate(ctx, "EUR", "CAD", "2026-07-31", "1.5000000000");
      const done = await completeNormalizationFlowFixture(ctx, filed.request.id);
      assert.equal(done.request.attemptCount, 1);
    });
  },
);

test(
  "feature-off refusal rolls the decision back and preserves the original correction for retry",
  { skip: !DB },
  async () => {
    await withFixture(async (ctx) => {
      await seedCustomerAndSubscription(ctx);
      const before = await seedV0Month(ctx);
      const filed = await fileRequest(ctx);
      await setSaaSMetricsFeature(ctx, false);
      await expectRefusal(
        executeNormalizationFlowFixture(ctx, filed.request.id),
        "feature_off",
        "Company Settings → Features",
      );
      await setSaaSMetricsFeature(ctx, true);
      assert.equal(
        (await getNormalizationRequest({ orgId: ctx.org.orgId, requestId: filed.request.id }))
          .status,
        "pending",
      );
      const done = await completeNormalizationFlowFixture(ctx, filed.request.id);
      assert.deepEqual(done.result.sourceV0Hashes, [before.legacyHash]);
    });
  },
);
