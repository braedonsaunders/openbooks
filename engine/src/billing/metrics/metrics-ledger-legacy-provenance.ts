import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../../platform/db.ts";
import { UsageBillingError } from "../usage/errors.ts";
import { refusal } from "./metrics-ledger-calculation.ts";

/** Reproduces legacy normalization evidence for audited corrections without writing metrics or audit data. */
export type LegacyRevenueRow = { subscription_id: string; revenue: string };
export type LegacyDeferredRow = {
  subscription_id: string;
  deferred_delta: string;
  deferred_balance: string;
};
export type LegacyLedgerRow = { subsidiary_id: string; revenue: string; cogs: string };
export type LegacyBillingRow = { subsidiary_id: string; billings: string };
export type LegacyHistoryRow = {
  subscription_id: string;
  customer_id: string;
  subsidiary_id: string;
  month: string;
  cohort_month: string;
  mrr_end: string;
  reporting_currency: string | null;
};
export type LegacyCohortStartRow = {
  subsidiary_id: string;
  cohort_month: string;
  start_mrr: string;
  start_customers: number;
  reporting_currency: string | null;
};

export async function legacySpotRate(
  executor: SqlExecutor,
  orgId: string,
  fromCurrency: string,
  toCurrency: string,
  onDate: string,
): Promise<string> {
  if (fromCurrency === toCurrency) return "1.0000000000";
  const result = await executor.execute<{ rate: string; as_of: string }>(
    sql`
    select rate::text, as_of::text from (
      select rate, as_of, 0 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${fromCurrency}
         and to_currency = ${toCurrency} and rate_type = 'spot' and as_of <= ${onDate}
      union all
      select (1 / rate)::numeric(19,10) as rate, as_of, 1 as priority from fx_rates
       where org_id = ${orgId} and from_currency = ${toCurrency}
         and to_currency = ${fromCurrency} and rate_type = 'spot' and as_of <= ${onDate}
    ) rates order by as_of desc, priority asc limit 1
  `,
    "objects",
  );
  const rate = result[0]?.rate;
  if (!rate) {
    throw refusal(
      "saas_metrics_fx_rate_missing",
      `No spot FX rate is available for subscription MRR ${fromCurrency}→${toCurrency} on or before ${onDate}.`,
      `Enable Multi-currency in Company Settings → Features if needed, add the dated spot rate ${fromCurrency}→${toCurrency} on or before ${onDate} under Company Settings → Setup → FX rates, then recompute the month.`,
      { field: "plan_currency" },
    );
  }
  return rate;
}

/** Corrected legacy inputs come only from audited before-images joined to their successful request. */
export interface ProvenanceRequestResult {
  month: string;
  monthHash: string;
  replacedMonthly: number;
  replacedFacts: number;
  replacedCohorts: number;
  sourceV0Hashes: string[];
}

export interface ProvenanceRequest {
  id: string;
  month: string;
  idempotencyKey: string;
  approvedBy: string | null;
  status: string;
  attemptCount: number;
  result: ProvenanceRequestResult | null;
}

export interface ProvenanceEvent {
  table: string;
  rowId: string;
  month: string;
  naturalKey: Record<string, unknown>;
  event: unknown;
  change: unknown;
  actor: unknown;
  requestId: unknown;
  /** Canonical audit_log.request_id column: the idempotency key, never JSON. */
  columnRequestKey: unknown;
  /** Canonical audit_log.actor_id column as text, never JSON. */
  columnActorId: unknown;
  attempt: unknown;
  sourceV0Hash: unknown;
  v1Hash: unknown;
  before: unknown;
  after: unknown;
}

export function provenanceRefusal(
  code: "missing" | "incomplete" | "ambiguous" | "tampered",
  label: string,
  month: string,
): UsageBillingError {
  if (code === "missing") {
    return refusal(
      "saas_normalization_v0_provenance_missing",
      `Month ${month} depends on ${label} whose legacy evidence was rewritten outside the audited correction.`,
      "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; only months corrected through the audited normalization workflow preserve reproducible legacy evidence, and derived metrics rows are never edited by hand.",
      { field: "month", status: 409 },
    );
  }
  if (code === "incomplete") {
    return refusal(
      "saas_normalization_provenance_incomplete",
      `Month ${month} depends on ${label}, whose preserved correction evidence is incomplete.`,
      "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
      { field: "month", status: 409 },
    );
  }
  if (code === "ambiguous") {
    return refusal(
      "saas_normalization_provenance_ambiguous",
      `Month ${month} depends on ${label}, which has more than one preserved correction record.`,
      "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
      { field: "month", status: 409 },
    );
  }
  return refusal(
    "saas_normalization_provenance_tampered",
    `Month ${month} depends on ${label}, whose preserved correction evidence fails its identity check.`,
    "Have an administrator investigate the month's recorded evidence in Company Setup → SaaS Metrics and escalate with the request id; derived metrics rows are never edited by hand.",
    { field: "month", status: 409 },
  );
}

/** Requires exact per-table event counts from the recorded correction result. */
export function validateProvenanceCounts(
  counts: Record<string, number>,
  result: ProvenanceRequestResult,
  month: string,
): void {
  const expected: Record<string, number> = {
    saas_metrics_monthly: result.replacedMonthly,
    saas_metrics_facts_monthly: result.replacedFacts,
    saas_metrics_cohort_monthly: result.replacedCohorts,
  };
  for (const [table, want] of Object.entries(expected)) {
    const got = counts[table] ?? 0;
    if (!Number.isInteger(want) || want < 0 || !Number.isInteger(got) || got < 0) {
      throw provenanceRefusal("tampered", `${table} for ${month}`, month);
    }
    if (got < want) throw provenanceRefusal("incomplete", `${table} for ${month}`, month);
    if (got > want) throw provenanceRefusal("tampered", `${table} for ${month}`, month);
  }
}

/** Verifies an event against its request, audit columns, hashes, and row identity before returning its before-image. */
export function validateProvenanceEvent(
  event: ProvenanceEvent,
  request: ProvenanceRequest,
  expectedTable:
    "saas_metrics_monthly" | "saas_metrics_facts_monthly" | "saas_metrics_cohort_monthly",
  expectedMonth: string,
): Record<string, unknown> {
  const keySummary =
    expectedTable === "saas_metrics_monthly"
      ? String(event.naturalKey.subscriptionId ?? "?")
      : expectedTable === "saas_metrics_facts_monthly"
        ? String(event.naturalKey.subsidiaryId ?? "?")
        : `${String(event.naturalKey.subsidiaryId ?? "?")}:${String(event.naturalKey.cohortMonth ?? "?")}`;
  const label = `${expectedTable}:${keySummary}:${expectedMonth}`;
  const fail = (): never => {
    throw provenanceRefusal("tampered", label, expectedMonth);
  };
  if (event.table !== expectedTable) fail();
  if (event.event !== "saas_normalization_corrected" || event.change !== "corrected") fail();
  if (event.month !== expectedMonth) fail();
  if (request.status !== "succeeded" || !request.result) return fail();
  if (request.month !== expectedMonth || request.result.month !== expectedMonth) fail();
  if (event.requestId !== request.id) fail();
  if (event.columnRequestKey !== request.idempotencyKey) fail();
  if (event.columnActorId !== request.approvedBy) fail();
  if (event.actor !== event.columnActorId) fail();
  if (event.attempt !== request.attemptCount) fail();
  const before =
    event.before !== null && typeof event.before === "object" && !Array.isArray(event.before)
      ? (event.before as Record<string, unknown>)
      : null;
  const after =
    event.after !== null && typeof event.after === "object" && !Array.isArray(event.after)
      ? (event.after as Record<string, unknown>)
      : null;
  if (!before || !after) fail();
  if (typeof event.sourceV0Hash !== "string" || event.sourceV0Hash !== before!.inputsHash) fail();
  if (!/^[0-9a-f]{64}$/.test(event.sourceV0Hash as string)) fail();
  if (!Array.isArray(request.result!.sourceV0Hashes)) fail();
  if (!request.result!.sourceV0Hashes.includes(event.sourceV0Hash as string)) fail();
  if (
    event.v1Hash !== request.result!.monthHash ||
    !/^[0-9a-f]{64}$/.test(request.result!.monthHash)
  )
    fail();
  if (typeof after!.inputsHash !== "string" || after!.inputsHash !== request.result!.monthHash)
    fail();
  if (typeof after!.id !== "string" || after!.id !== event.rowId) fail();
  if (event.naturalKey.month !== expectedMonth) fail();
  if (expectedTable === "saas_metrics_monthly") {
    if (typeof event.naturalKey.subscriptionId !== "string") fail();
    if (after!.subscriptionId !== event.naturalKey.subscriptionId) fail();
    if (after!.month !== expectedMonth) fail();
  } else if (expectedTable === "saas_metrics_facts_monthly") {
    if (typeof event.naturalKey.subsidiaryId !== "string") fail();
    if (after!.subsidiaryId !== event.naturalKey.subsidiaryId) fail();
    if (after!.month !== expectedMonth) fail();
  } else {
    if (
      typeof event.naturalKey.subsidiaryId !== "string" ||
      typeof event.naturalKey.cohortMonth !== "string"
    )
      fail();
    if (after!.subsidiaryId !== event.naturalKey.subsidiaryId) fail();
    if (after!.cohortMonth !== event.naturalKey.cohortMonth) fail();
    if (after!.month !== expectedMonth) fail();
  }
  return before!;
}

/** Legacy history fields extracted from a validated before-image. */
export function historyRowFromProvenance(
  before: Record<string, unknown>,
  subscriptionId: string,
  priorMonth: string,
  month: string,
): LegacyHistoryRow {
  const label = `saas_metrics_monthly:${subscriptionId}:${priorMonth}`;
  const text = (field: string): string | null =>
    typeof before[field] === "string" ? (before[field] as string) : null;
  if (
    text("subscriptionId") !== subscriptionId ||
    text("month") !== priorMonth ||
    text("customerId") === null ||
    text("subsidiaryId") === null ||
    text("cohortMonth") === null ||
    text("mrrEnd") === null ||
    before.reportingCurrency !== null ||
    before.denominationVersion !== null
  ) {
    throw provenanceRefusal("tampered", label, month);
  }
  return {
    subscription_id: subscriptionId,
    customer_id: text("customerId")!,
    subsidiary_id: text("subsidiaryId")!,
    month: priorMonth,
    cohort_month: text("cohortMonth")!,
    mrr_end: text("mrrEnd")!,
    reporting_currency: null,
  };
}

/** Legacy cohort-start fields extracted from a validated before-image. */
export function startRowFromProvenance(
  before: Record<string, unknown>,
  subsidiaryId: string,
  cohortMonth: string,
  month: string,
): LegacyCohortStartRow {
  const label = `saas_metrics_cohort_monthly:${subsidiaryId}:${cohortMonth}`;
  const startMrr = typeof before.startMrr === "string" ? before.startMrr : null;
  const startCustomers = typeof before.startCustomers === "number" ? before.startCustomers : null;
  if (
    before.subsidiaryId !== subsidiaryId ||
    before.cohortMonth !== cohortMonth ||
    startMrr === null ||
    startCustomers === null ||
    !Number.isInteger(startCustomers) ||
    startCustomers < 0 ||
    before.reportingCurrency !== null ||
    before.denominationVersion !== null
  ) {
    throw provenanceRefusal("tampered", label, month);
  }
  return {
    subsidiary_id: subsidiaryId,
    cohort_month: cohortMonth,
    start_mrr: startMrr,
    start_customers: startCustomers,
    reporting_currency: null,
  };
}

export type ValidatedPriorMonth = {
  monthly: Map<string, LegacyHistoryRow>;
  starts: Map<string, LegacyCohortStartRow>;
};

/** Validates a complete correction set, then indexes its history and cohort before-images. */
export async function legacyPriorProvenance(
  executor: SqlExecutor,
  orgId: string,
  priorMonth: string,
  month: string,
): Promise<ValidatedPriorMonth> {
  const rows = await executor.execute<{
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
     where org_id = ${orgId} and action = 'saas_normalization_corrected'
       and table_name in ('saas_metrics_monthly', 'saas_metrics_facts_monthly', 'saas_metrics_cohort_monthly')
       and changes->>'month' = ${priorMonth}
     order by at
  `,
    "objects",
  );
  const label = `prior month ${priorMonth}`;
  if (rows.length === 0) throw provenanceRefusal("missing", label, month);
  const requestIds = [
    ...new Set(rows.map((row) => row.changes.requestId).filter((id) => typeof id === "string")),
  ] as string[];
  if (requestIds.length === 0) throw provenanceRefusal("missing", label, month);
  if (requestIds.length > 1) throw provenanceRefusal("ambiguous", label, month);
  const requestUuid = requestIds[0]!;
  const stored = (
    await executor.execute<{
      id: string;
      month: string;
      idempotency_key: string;
      approved_by: string | null;
      status: string;
      attempt_count: number;
      result: ProvenanceRequestResult | null;
    }>(
      sql`
    select id::text as id, month::text as month, idempotency_key::text as idempotency_key,
           approved_by::text as approved_by, status, attempt_count,
           result as result
      from saas_metrics_normalization_requests
     where org_id = ${orgId} and id = ${requestUuid}
  `,
      "objects",
    )
  )[0];
  if (!stored) throw provenanceRefusal("tampered", `${label} request ${requestUuid}`, month);
  const request: ProvenanceRequest = {
    id: stored.id,
    month: stored.month.slice(0, 10),
    idempotencyKey: stored.idempotency_key,
    approvedBy: stored.approved_by,
    status: stored.status,
    attemptCount: stored.attempt_count,
    result: stored.result,
  };
  if (request.status !== "succeeded" || !request.result || request.month !== priorMonth) {
    throw provenanceRefusal("tampered", `${label} request ${request.id}`, month);
  }
  // Malformed recorded results fail closed here, never as an undefined
  // read or a skipped check downstream.
  const recorded = request.result;
  const resultOk =
    typeof recorded.month === "string" &&
    typeof recorded.monthHash === "string" &&
    Number.isInteger(recorded.replacedMonthly) &&
    recorded.replacedMonthly >= 0 &&
    Number.isInteger(recorded.replacedFacts) &&
    recorded.replacedFacts >= 0 &&
    Number.isInteger(recorded.replacedCohorts) &&
    recorded.replacedCohorts >= 0 &&
    Array.isArray(recorded.sourceV0Hashes) &&
    recorded.sourceV0Hashes.every((hash) => typeof hash === "string");
  if (!resultOk) {
    throw provenanceRefusal("tampered", `${label} request ${request.id}`, month);
  }
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.table] = (counts[row.table] ?? 0) + 1;
  validateProvenanceCounts(counts, request.result, priorMonth);
  const monthly = new Map<string, LegacyHistoryRow>();
  const starts = new Map<string, LegacyCohortStartRow>();
  const toEvent = (
    row: (typeof rows)[number],
    naturalKey: Record<string, unknown>,
  ): ProvenanceEvent => ({
    table: row.table,
    rowId: row.row_id,
    month: row.changes.month as string,
    naturalKey,
    event: row.changes.event,
    change: row.changes.change,
    actor: row.changes.actor,
    requestId: row.changes.requestId,
    columnRequestKey: row.request_key,
    columnActorId: row.actor_id,
    attempt: row.changes.attempt,
    sourceV0Hash: row.changes.sourceV0Hash,
    v1Hash: row.changes.v1Hash,
    before: row.changes.before,
    after: row.changes.after,
  });
  const naturalKeyOf = (changes: Record<string, unknown>): Record<string, unknown> =>
    changes.naturalKey !== null &&
    typeof changes.naturalKey === "object" &&
    !Array.isArray(changes.naturalKey)
      ? (changes.naturalKey as Record<string, unknown>)
      : {};
  for (const row of rows) {
    const naturalKey = naturalKeyOf(row.changes);
    if (row.table === "saas_metrics_monthly") {
      const before = validateProvenanceEvent(
        toEvent(row, naturalKey),
        request,
        "saas_metrics_monthly",
        priorMonth,
      );
      const sub = naturalKey.subscriptionId;
      if (typeof sub !== "string" || monthly.has(sub)) {
        throw provenanceRefusal(
          "tampered",
          `saas_metrics_monthly:${String(sub)}:${priorMonth}`,
          month,
        );
      }
      monthly.set(sub, historyRowFromProvenance(before, sub, priorMonth, month));
    } else if (row.table === "saas_metrics_facts_monthly") {
      // Facts rows are not v0 inputs, but their events are authenticated
      // with the same contract before counts can establish a complete set.
      validateProvenanceEvent(
        toEvent(row, naturalKey),
        request,
        "saas_metrics_facts_monthly",
        priorMonth,
      );
    } else if (row.table === "saas_metrics_cohort_monthly") {
      const before = validateProvenanceEvent(
        toEvent(row, naturalKey),
        request,
        "saas_metrics_cohort_monthly",
        priorMonth,
      );
      const sub = naturalKey.subsidiaryId;
      const cmon = naturalKey.cohortMonth;
      if (typeof sub !== "string" || typeof cmon !== "string") {
        throw provenanceRefusal(
          "tampered",
          `saas_metrics_cohort_monthly:${String(sub)}:${String(cmon)}`,
          month,
        );
      }
      if (cmon === priorMonth) {
        if (starts.has(sub)) {
          throw provenanceRefusal("tampered", `saas_metrics_cohort_monthly:${sub}:${cmon}`, month);
        }
        starts.set(sub, startRowFromProvenance(before, sub, cmon, month));
      }
    }
  }
  return { monthly, starts };
}
