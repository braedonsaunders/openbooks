import { sql, type SQL } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { civilDayIndex, isoFromCivilDayIndex } from "../platform/business-date.ts";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import { inventoryFeatureEnabled } from "../inventory/profile-policy.ts";
import { add, mul, normalizeMoney, prorateDays, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";

export type Interval = "weekly" | "monthly" | "quarterly" | "annually";

export type BillingTiming = "advance" | "arrears";
export type RenewalPolicy = "auto" | "manual" | "none";
export type AmendmentType =
  | "add_component"
  | "remove_component"
  | "change_component"
  | "change_term"
  | "change_timing"
  | "renew"
  | "coterm";

export class AdvancedSubscriptionError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "AdvancedSubscriptionError";
  }
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

async function assertEnabled(orgId: string): Promise<void> {
  const result = await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'subscriptionBilling')::boolean, false)
           and coalesce((settings->'features'->>'advancedSubscriptions')::boolean, false) as enabled
      from orgs where id = ${orgId}
  `);
  if (!result.rows[0]?.enabled) throw new AdvancedSubscriptionError("Advanced subscriptions feature is disabled");
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

/** Exact positive integer at the persisted PostgreSQL integer boundary. */
export function subscriptionPeriodCount(value: unknown, label = "interval count"): number {
  const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > 2147483647) {
    throw new AdvancedSubscriptionError(`${label} must be a positive whole number`);
  }
  return count;
}

function assertBillingTiming(value: unknown): asserts value is BillingTiming {
  if (value !== "advance" && value !== "arrears") throw new AdvancedSubscriptionError("billing timing must be advance or arrears");
}

function assertRenewalPolicy(value: unknown): asserts value is RenewalPolicy {
  if (value !== "auto" && value !== "manual" && value !== "none") throw new AdvancedSubscriptionError("invalid renewal policy");
}

export function advanceLifecycleDate(isoDate: string, interval: Interval, intervalCount = 1): string {
  validDate(isoDate, "billing date", true);
  const n = subscriptionPeriodCount(intervalCount);
  if (!["weekly", "monthly", "quarterly", "annually"].includes(interval)) {
    throw new AdvancedSubscriptionError("invalid billing interval");
  }
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (interval === "weekly") {
    date.setUTCDate(date.getUTCDate() + 7 * n);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) {
      throw new AdvancedSubscriptionError("billing date exceeds the supported calendar");
    }
    return date.toISOString().slice(0, 10);
  }
  const monthStep = (interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12) * n;
  const idx = date.getUTCMonth() + monthStep;
  const targetYear = date.getUTCFullYear() + Math.floor(idx / 12);
  if (targetYear > 9999) throw new AdvancedSubscriptionError("billing date exceeds the supported calendar");
  const targetMonth = idx % 12;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(targetYear, targetMonth + 1, 0);
  return `${String(targetYear).padStart(4, "0")}-${pad(targetMonth + 1)}-${pad(Math.min(date.getUTCDate(), lastDay.getUTCDate()))}`;
}

export interface CatalogComponentInput {
  componentKey: string;
  name: string;
  description?: string | null;
  quantity?: string;
  unitPrice: string;
  incomeAccountId?: string | null;
  itemId?: string | null;
  taxCodeId?: string | null;
  isOptional?: boolean;
}

export interface CreatePlanVersionInput {
  planId: string;
  effectiveFrom: string;
  name?: string;
  description?: string | null;
  currency?: string | null;
  interval?: Interval;
  intervalCount?: number;
  billingTiming?: BillingTiming;
  changeSummary?: string | null;
  components: CatalogComponentInput[];
}

export interface ActivateLifecycleInput {
  subscriptionId: string;
  planVersionId: string;
  termStartsOn: string;
  termEndsOn?: string | null;
  trialEndsOn?: string | null;
  renewalPolicy?: RenewalPolicy;
  renewalTermMonths?: number | null;
  /**
   * Explicit, controlled transition onto already-billed service: the contract
   * keeps the given term dates, but billing cursors start at the unbilled
   * boundary instead of rewinding into posted periods. Without it, a
   * termStartsOn inside billed service is refused.
   */
  billFromUnbilledBoundary?: boolean;
}

/**
 * Resolve the billing cursors an activation writes. A termStartsOn inside
 * already-billed service would rewind next_bill_on into posted periods and
 * bill them twice (period guards dedupe only exact period end + revision),
 * so it is refused by name — naming the unbilled boundary and the opt-in —
 * unless the caller explicitly takes the controlled transition, which bills
 * only from the boundary. Pure.
 */
export function activationBillingCursors(input: {
  termStartsOn: string;
  firstBillOn: string;
  anchor: string;
  boundary: string | null;
  billed: boolean;
  billFromUnbilledBoundary?: boolean;
}): { nextBillOn: string; currentPeriodStart: string } {
  if (!input.billed || !input.boundary || input.termStartsOn >= input.boundary) {
    return { nextBillOn: input.firstBillOn, currentPeriodStart: input.anchor };
  }
  if (!input.billFromUnbilledBoundary) {
    throw new AdvancedSubscriptionError(
      `term start ${input.termStartsOn} overlaps already-billed service through ${input.boundary} — ` +
      `start the term on or after ${input.boundary}, or repeat with billFromUnbilledBoundary to bill only from ${input.boundary}`,
    );
  }
  return {
    nextBillOn: input.firstBillOn > input.boundary ? input.firstBillOn : input.boundary,
    currentPeriodStart: input.anchor > input.boundary ? input.anchor : input.boundary,
  };
}

export interface AmendmentRequest {
  subscriptionId: string;
  type: AmendmentType;
  effectiveOn: string;
  idempotencyKey: string;
  reason?: string | null;
  componentKey?: string;
  name?: string;
  description?: string | null;
  quantity?: string;
  unitPrice?: string;
  incomeAccountId?: string | null;
  itemId?: string | null;
  taxCodeId?: string | null;
  termEndsOn?: string | null;
  billingTiming?: BillingTiming;
  renewalTermMonths?: number;
  anchorSubscriptionId?: string;
}

interface OwnedPlanRow extends Record<string, unknown> {
  id: string; name: string; description: string | null; amount: string; currency: string; interval: Interval;
  intervalCount: number; incomeAccountId: string | null; itemId: string | null; taxCodeId: string | null;
}
interface SubscriptionContextRow extends Record<string, unknown> {
  id: string; customerId: string; planId: string; status: string; lifecycleId: string | null;
  planVersionId: string | null; contractRevision: number | null; termStartsOn: string | null;
  termEndsOn: string | null; trialEndsOn: string | null; billingTiming: BillingTiming | null;
  renewalPolicy: RenewalPolicy | null; renewalTermMonths: number | null; renewalOn: string | null;
}
interface PlanVersionRow extends Record<string, unknown> {
  id: string; planId: string; interval: Interval; intervalCount: number; billingTiming: BillingTiming;
  status: string; effectiveFrom: string; effectiveTo: string | null;
  versionCurrency: string | null; planCurrency: string | null;
}
interface SubscriptionComponentRow extends Record<string, unknown> {
  componentKey: string; name: string; description: string | null; quantity: string; unitPrice: string;
  incomeAccountId: string | null; itemId: string | null; taxCodeId: string | null;
  effectiveFrom: string; effectiveTo: string | null;
}
interface AmendmentReplayRow extends Record<string, unknown> {
  id: string;
  subscriptionId: string;
  request: Record<string, unknown>;
}
interface BillingPreparationRow extends Record<string, unknown> {
  billingTiming: BillingTiming | null; termEndsOn: string | null; renewalPolicy: RenewalPolicy | null;
  renewalTermMonths: number | null;
}
interface BillingLifecycleRow extends Record<string, unknown> {
  contractRevision: number; billingTiming: BillingTiming; currentPeriodStart: string | null;
  nextBillOn: string; interval: Interval; intervalCount: number;
}

function validDate(value: string | null | undefined, label: string, required = false): string | null {
  if (!required && (value == null || value === "")) return null;
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || value.startsWith("0000-") || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AdvancedSubscriptionError(`${label} must be an ISO date`);
  }
  return value;
}

/** Whole-digit width of a canonical decimal: numeric(19,4) holds 15. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length;
}

function exactMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new AdvancedSubscriptionError(`${label} must be an exact decimal`);
  }
  // Component quantity/unit_price are numeric(19,4): a wider figure would die
  // in Postgres as a raw storage failure (HTTP 500 — the route rethrows
  // unknown errors), so refuse it here with a named 422 and nothing written.
  if (wholeDigits(exact) > 15) {
    throw new AdvancedSubscriptionError(`${label} is out of range — at most 15 whole digits fit the ledger`);
  }
  try {
    return normalizeMoney(exact);
  } catch {
    throw new AdvancedSubscriptionError(`${label} must be an exact decimal`);
  }
}

function positiveMoney(value: string | undefined, label: string): string {
  const normalized = exactMoney(value, label);
  if (toUnits(normalized) <= 0n) throw new AdvancedSubscriptionError(`${label} must be greater than zero`);
  return normalized;
}

function nonNegativeMoney(value: string | undefined, label: string): string {
  const normalized = exactMoney(value, label);
  if (toUnits(normalized) < 0n) throw new AdvancedSubscriptionError(`${label} cannot be negative`);
  return normalized;
}

export function addMonths(isoDate: string, months: number): string {
  return advanceLifecycleDate(isoDate, "monthly", months);
}

/** First invoice date for a trial-aware advance/arrears contract. */
export function firstLifecycleBillOn(input: {
  termStartsOn: string;
  trialEndsOn?: string | null;
  billingTiming: BillingTiming;
  interval: Interval;
  intervalCount: number;
}): string {
  validDate(input.termStartsOn, "term start", true);
  validDate(input.trialEndsOn, "trial end");
  assertBillingTiming(input.billingTiming);
  const serviceStartsOn = input.trialEndsOn && input.trialEndsOn > input.termStartsOn ? input.trialEndsOn : input.termStartsOn;
  const nextDate = advanceLifecycleDate(serviceStartsOn, input.interval, input.intervalCount);
  return input.billingTiming === "advance" ? serviceStartsOn : nextDate;
}

export function assertPlanVersionMutable(status: string): void {
  if (status !== "draft") throw new AdvancedSubscriptionError("published plan versions are immutable; create a new version");
}

function canonicalRequest(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    }
    return nested;
  });
}

export function assertIdempotentReplay(
  existingSubscriptionId: string,
  requestedSubscriptionId: string,
  existingRequest?: unknown,
  requestedRequest?: unknown,
): void {
  if (existingSubscriptionId !== requestedSubscriptionId) {
    throw new AdvancedSubscriptionError("idempotency key already belongs to another subscription");
  }
  if (existingRequest !== undefined && requestedRequest !== undefined && canonicalRequest(existingRequest) !== canonicalRequest(requestedRequest)) {
    throw new AdvancedSubscriptionError("idempotency key already belongs to a different amendment request");
  }
}

export function assertCotermAllowed(input: { subscriptionId: string; anchorSubscriptionId: string; customerId: string; anchorCustomerId: string }): void {
  if (input.subscriptionId === input.anchorSubscriptionId) throw new AdvancedSubscriptionError("a different anchor subscription is required");
  if (input.customerId !== input.anchorCustomerId) throw new AdvancedSubscriptionError("co-termed subscriptions must belong to the same customer");
}

export function renewalAction(input: { billingTiming: BillingTiming; dueOn: string; termEndsOn: string | null; policy: RenewalPolicy }): "bill" | "renew" | "stop" {
  if (!input.termEndsOn) return "bill";
  const beyondTerm = input.billingTiming === "advance" ? input.dueOn >= input.termEndsOn : input.dueOn > input.termEndsOn;
  if (!beyondTerm) return "bill";
  return input.policy === "auto" ? "renew" : "stop";
}

export function lifecycleBillingPeriod(input: { billOn: string; serviceAnchor: string; billingTiming: BillingTiming; interval: Interval; intervalCount: number }) {
  return input.billingTiming === "advance"
    ? { periodStartsOn: input.billOn, periodEndsOn: advanceLifecycleDate(input.billOn, input.interval, input.intervalCount) }
    : { periodStartsOn: input.serviceAnchor, periodEndsOn: input.billOn };
}

export function subscriptionComponentTotal(lines: Array<{ quantity: string; unitPrice: string }>): string {
  let total = "0.0000";
  for (const line of lines) total = add(total, mul(line.quantity, line.unitPrice));
  return total;
}

/**
 * One lifecycle-affecting amendment projected from the amendment ledger.
 * Values are extracted defensively from the stored request/snapshot JSON:
 * anything unusable is reported as unknown and ignored by the resolver, so a
 * corrupt ledger row degrades to the surrounding known state instead of
 * refusing billing.
 */
export interface EffectiveLifecycleAmendment {
  type: string;
  effectiveOn: string;
  /** Application order; breaks ties between amendments effective the same day. */
  seq: number;
  /** change_timing target; null when absent or unusable. */
  timing: BillingTiming | null;
  /** Term end this amendment sets: change_term carries it in the request
   * (null clears an open end); renew/coterm carry their computed end in the
   * after-snapshot. */
  term: string | null;
  termKnown: boolean;
  /** Activation-time base from the before-snapshot; null/unknown when absent. */
  baseTiming: BillingTiming | null;
  baseTerm: string | null;
  baseTermKnown: boolean;
}

/** ISO calendar day from a driver date, datetime string, or ISO string. */
function toIsoDay(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const day = value.slice(0, 10);
    const parsed = new Date(`${day}T00:00:00Z`);
    if (!day.startsWith("0000-") && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day) {
      return day;
    }
  }
  return null;
}

function asBillingTiming(value: unknown): BillingTiming | null {
  return value === "advance" || value === "arrears" ? value : null;
}

function snapshotLifecycle(value: unknown): { billingTiming: unknown; termEndsOn: unknown } {
  if (typeof value !== "object" || value === null) return { billingTiming: undefined, termEndsOn: undefined };
  const lifecycle = (value as { lifecycle?: unknown }).lifecycle;
  if (typeof lifecycle !== "object" || lifecycle === null) return { billingTiming: undefined, termEndsOn: undefined };
  const record = lifecycle as Record<string, unknown>;
  return { billingTiming: record.billingTiming, termEndsOn: record.termEndsOn };
}

function requestRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Project one ledger row into resolver input; unknown fields stay unknown. */
export function toEffectiveLifecycleAmendment(row: {
  type: string;
  effectiveOn: string;
  seq: number;
  request: unknown;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}): EffectiveLifecycleAmendment {
  const request = requestRecord(row.request);
  const before = snapshotLifecycle(row.beforeSnapshot);
  const after = snapshotLifecycle(row.afterSnapshot);
  const requestTerm = request.termEndsOn === null ? null : toIsoDay(request.termEndsOn);
  const afterTerm = after.termEndsOn === null ? null : toIsoDay(after.termEndsOn);
  const beforeTerm = before.termEndsOn === null ? null : toIsoDay(before.termEndsOn);
  // Each amendment moves only what it changes: a timing row's incidental
  // after-snapshot term (and any other type's) must not overwrite the term
  // fold, just as a term row never moves the timing fold.
  const movesTerm = row.type === "change_term" || row.type === "renew" || row.type === "coterm";
  return {
    type: row.type,
    effectiveOn: row.effectiveOn,
    seq: row.seq,
    timing: row.type === "change_timing" ? asBillingTiming(request.billingTiming) : null,
    term: !movesTerm ? null : row.type === "change_term" ? requestTerm : afterTerm,
    termKnown: !movesTerm
      ? false
      : row.type === "change_term"
        ? requestTerm !== null || request.termEndsOn === null
        : afterTerm !== null || after.termEndsOn === null,
    baseTiming: asBillingTiming(before.billingTiming),
    baseTerm: beforeTerm,
    baseTermKnown: beforeTerm !== null || before.termEndsOn === null,
  };
}

/**
 * Resolve the lifecycle state (billing timing + term end) in force on `asOf`
 * from the amendment ledger. Amendments fold in effective-date order
 * (application order breaks same-day ties), so a future-dated change never
 * governs a bill dated before it arrives; the activation base comes from the
 * earliest APPLIED amendment's before-snapshot, which is the pre-change
 * state no matter what effective dates were later backdated. Pure.
 */
export function resolveEffectiveLifecycleState(input: {
  asOf: string;
  fallbackTiming: BillingTiming;
  fallbackTermEndsOn: string | null;
  amendments: EffectiveLifecycleAmendment[];
}): { billingTiming: BillingTiming; termEndsOn: string | null } {
  const ordered = input.amendments
    .filter((amendment) => toIsoDay(amendment.effectiveOn) !== null)
    .sort((left, right) => (
      left.effectiveOn < right.effectiveOn ? -1 : left.effectiveOn > right.effectiveOn ? 1 : left.seq - right.seq
    ));
  let base: EffectiveLifecycleAmendment | null = null;
  for (const amendment of ordered) {
    if (!base || amendment.seq < base.seq) base = amendment;
  }
  let billingTiming = base?.baseTiming ?? input.fallbackTiming;
  let termEndsOn = base?.baseTermKnown ? base.baseTerm : input.fallbackTermEndsOn;
  for (const amendment of ordered) {
    if (amendment.effectiveOn > input.asOf) break;
    if (amendment.type === "change_timing" && amendment.timing) billingTiming = amendment.timing;
    if ((amendment.type === "change_term" || amendment.type === "renew" || amendment.type === "coterm") && amendment.termKnown) {
      termEndsOn = amendment.term;
    }
  }
  return { billingTiming, termEndsOn };
}

interface AmendmentLedgerRow extends Record<string, unknown> {
  amendmentType: string;
  effectiveOn: string;
  seq: number;
  request: unknown;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

/**
 * Billing must read lifecycle state as-of the bill date, never the row's
 * latest intent: a change_term or change_timing dated in the future is
 * already written to subscription_lifecycles when it is recorded, and reading
 * that row directly would let it govern invoices dated before it arrives.
 */
async function effectiveLifecycleState(
  orgId: string,
  subscriptionId: string,
  asOf: string,
  fallback: { billingTiming: BillingTiming; termEndsOn: string | null },
): Promise<{ billingTiming: BillingTiming; termEndsOn: string | null }> {
  const ledger = await db.execute<AmendmentLedgerRow>(sql`
    select amendment_type as "amendmentType", effective_on::text as "effectiveOn",
           amendment_number as "seq", request, before_snapshot as "beforeSnapshot",
           after_snapshot as "afterSnapshot"
      from subscription_amendments
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
       and amendment_type in ('change_timing', 'change_term', 'renew', 'coterm')
     order by amendment_number
  `);
  return resolveEffectiveLifecycleState({
    asOf,
    fallbackTiming: fallback.billingTiming,
    fallbackTermEndsOn: fallback.termEndsOn,
    amendments: ledger.rows.map((row) => toEffectiveLifecycleAmendment({
      type: row.amendmentType,
      effectiveOn: toIsoDay(row.effectiveOn) ?? row.effectiveOn,
      seq: row.seq,
      request: row.request,
      beforeSnapshot: row.beforeSnapshot,
      afterSnapshot: row.afterSnapshot,
    })),
  });
}

async function ownedPlan(orgId: string, planId: string) {
  const result = (await db.execute<OwnedPlanRow>(sql`
    select id, name, description, amount, currency_code as currency, interval,
           interval_count as "intervalCount", income_account_id as "incomeAccountId",
           item_id as "itemId", tax_code_id as "taxCodeId"
      from subscription_plans where id = ${planId} and org_id = ${orgId} for update
  `));
  const row = result.rows[0];
  if (!row) throw new AdvancedSubscriptionError("plan not found");
  return row;
}

async function assertCommercialRefs(
  orgId: string,
  input: { incomeAccountId?: string | null; itemId?: string | null; taxCodeId?: string | null },
  storedItemId?: string | null,
): Promise<void> {
  if (input.incomeAccountId) {
    const row = (await db.execute(sql`select 1 from accounts where id = ${input.incomeAccountId} and org_id = ${orgId} and type in ('income','income_other') and is_active`));
    if (!row.rows.length) throw new AdvancedSubscriptionError("income account does not belong to this organization");
  }
  // Stored components stay when itemId is omitted. Re-sending the stored item
  // is allowed. A new inventory / assembly / kit item is Inventory
  // configuration. A new equipment_charge item is Equipment configuration.
  if (input.itemId) {
    const row = (await db.execute<{ kind: string }>(sql`
      select kind from items where id = ${input.itemId} and org_id = ${orgId} and is_active`));
    if (!row.rows[0]) throw new AdvancedSubscriptionError("item does not belong to this organization");
    if (storedItemId !== input.itemId && !(await inventoryFeatureEnabled(db, orgId))) {
      if (INVENTORY_ITEM_KINDS.has(row.rows[0].kind)) {
        throw new AdvancedSubscriptionError("Inventory is disabled", 404);
      }
    }
    if (storedItemId !== input.itemId) {
      const equipmentOn = (await db.execute<{ enabled: boolean }>(sql`
        select coalesce((settings->'features'->>'equipment')::boolean, true) as enabled
          from orgs where id = ${orgId}
      `)).rows[0]?.enabled === true;
      if (!equipmentOn && row.rows[0].kind === "equipment_charge") {
        throw new AdvancedSubscriptionError("Equipment is disabled", 404);
      }
    }
  }
  if (input.taxCodeId) {
    const row = (await db.execute(sql`select 1 from tax_codes where id = ${input.taxCodeId} and org_id = ${orgId} and is_active`));
    if (!row.rows.length) throw new AdvancedSubscriptionError("tax code does not belong to this organization");
  }
}

/** Shared customer identities remain usable; empty visibility grants nothing. */
function subscriptionScopeSql(orgId: string, subscriptionId: SQL, allowed?: ReadonlySet<string> | null): SQL {
  if (allowed == null) return sql``;
  if (allowed.size === 0) return sql`and false`;
  return sql`and exists (
    select 1 from subscriptions scoped_subscription
    join parties scoped_customer on scoped_customer.id = scoped_subscription.customer_id and scoped_customer.org_id = scoped_subscription.org_id
    where scoped_subscription.id = ${subscriptionId} and scoped_subscription.org_id = ${orgId}
      and (scoped_customer.subsidiary_id is null or scoped_customer.subsidiary_id = any(${`{${[...allowed].join(',')}}`}::uuid[]))
  )`;
}

async function subscriptionContext(orgId: string, subscriptionId: string, allowed?: ReadonlySet<string> | null) {
  const result = (await db.execute<SubscriptionContextRow>(sql`
    select s.id, s.customer_id as "customerId", s.plan_id as "planId", s.status,
           l.id as "lifecycleId", l.plan_version_id as "planVersionId",
           l.contract_revision as "contractRevision", l.term_starts_on as "termStartsOn",
           l.term_ends_on as "termEndsOn", l.trial_ends_on as "trialEndsOn",
           l.billing_timing as "billingTiming", l.renewal_policy as "renewalPolicy",
           l.renewal_term_months as "renewalTermMonths", l.renewal_on as "renewalOn"
      from subscriptions s
      left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
     where s.id = ${subscriptionId} and s.org_id = ${orgId}
       ${subscriptionScopeSql(orgId, sql`s.id`, allowed)}
  `));
  const row = result.rows[0];
  if (!row) throw new AdvancedSubscriptionError("subscription not found", 404);
  return row;
}

export async function createPlanVersion(orgId: string, actorId: string, input: CreatePlanVersionInput): Promise<string> {
  return withOrg(orgId, async () => {
    await assertEnabled(orgId);
    const plan = await ownedPlan(orgId, input.planId);
    const effectiveFrom = validDate(input.effectiveFrom, "effective date", true)!;
    const interval = input.interval ?? plan.interval;
    const intervalCount = subscriptionPeriodCount(input.intervalCount ?? plan.intervalCount);
    const billingTiming = input.billingTiming ?? "advance";
    assertBillingTiming(billingTiming);
    advanceLifecycleDate(effectiveFrom, interval, intervalCount);
    if (!input.components.length) throw new AdvancedSubscriptionError("at least one component is required");
    const seen = new Set<string>();
    const components = input.components.map((component) => {
      const key = component.componentKey.trim();
      if (!key || seen.has(key)) throw new AdvancedSubscriptionError("component keys must be unique and non-empty");
      seen.add(key);
      if (!component.name.trim()) throw new AdvancedSubscriptionError("component name is required");
      return {
        ...component,
        quantity: positiveMoney(component.quantity ?? "1", "component quantity"),
        unitPrice: nonNegativeMoney(component.unitPrice, "component price"),
      };
    });
    for (const component of components) await assertCommercialRefs(orgId, component);
    const version = (await db.execute<{ id: string }>(sql`
      insert into subscription_plan_versions
        (org_id, plan_id, version_number, effective_from, name, description, currency_code,
         interval, interval_count, billing_timing, change_summary, created_by, updated_by)
      select ${orgId}, ${input.planId}, coalesce(max(version_number), 0) + 1, ${effectiveFrom},
             ${input.name?.trim() || plan.name}, ${input.description ?? plan.description}, ${input.currency ?? plan.currency},
             ${interval}, ${intervalCount},
             ${billingTiming}, ${input.changeSummary ?? null}, ${actorId}, ${actorId}
        from subscription_plan_versions where org_id = ${orgId} and plan_id = ${input.planId}
      returning id
    `));
    const versionId = version.rows[0]!.id;
    for (const [sortOrder, component] of components.entries()) {
      await db.execute(sql`
        insert into subscription_plan_version_components
          (org_id, version_id, component_key, name, description, quantity, unit_price,
           income_account_id, item_id, tax_code_id, is_optional, sort_order, created_by, updated_by)
        values (${orgId}, ${versionId}, ${component.componentKey.trim()}, ${component.name.trim()}, ${component.description ?? null},
                ${component.quantity}, ${component.unitPrice}, ${component.incomeAccountId ?? null},
                ${component.itemId ?? null}, ${component.taxCodeId ?? null}, ${component.isOptional ?? false},
                ${sortOrder}, ${actorId}, ${actorId})
      `);
    }
    return versionId;
  });
}

export async function publishPlanVersion(orgId: string, actorId: string, versionId: string): Promise<void> {
  await withOrg(orgId, async () => {
    await assertEnabled(orgId);
    const found = (await db.execute<Pick<PlanVersionRow, "id" | "planId" | "effectiveFrom" | "status"> & Record<string, unknown>>(sql`
      select id, plan_id as "planId", effective_from as "effectiveFrom", status
        from subscription_plan_versions where id = ${versionId} and org_id = ${orgId} for update
    `));
    const version = found.rows[0];
    if (!version) throw new AdvancedSubscriptionError("plan version not found");
    assertPlanVersionMutable(version.status);
    await ownedPlan(orgId, version.planId);
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from subscription_plan_version_components
       where version_id = ${versionId} and org_id = ${orgId}
    `));
    if (!count.rows[0]?.n) throw new AdvancedSubscriptionError("a published version needs at least one component");
    // Activation copies only required components, so an all-optional
    // version would activate into a subscription with zero components that
    // every invoice then refuses. Refuse the catalog error here, by name,
    // instead of surfacing it at billing time.
    const required = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from subscription_plan_version_components
       where version_id = ${versionId} and org_id = ${orgId} and not is_optional
    `));
    if (!required.rows[0]?.n) {
      throw new AdvancedSubscriptionError("a published version needs at least one required component — mark a component as required before publishing");
    }
    const sameDate = (await db.execute(sql`
      select 1 from subscription_plan_versions where org_id = ${orgId} and plan_id = ${version.planId}
       and status = 'published' and effective_from = ${version.effectiveFrom} and id <> ${versionId} limit 1
    `));
    if (sameDate.rows.length) throw new AdvancedSubscriptionError("another published version already starts on that date");
    await db.execute(sql`
      update subscription_plan_versions
         set status = 'published', published_at = now(), published_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${versionId} and org_id = ${orgId}
    `);
  });
}

export async function activateLifecycle(orgId: string, actorId: string, input: ActivateLifecycleInput, allowed?: ReadonlySet<string> | null): Promise<void> {
  await withOrg(orgId, async () => {
    await assertEnabled(orgId);
    await db.execute(sql`select id from subscriptions where id = ${input.subscriptionId} and org_id = ${orgId} for update`);
    const sub = await subscriptionContext(orgId, input.subscriptionId, allowed);
    if (sub.status === "canceled") throw new AdvancedSubscriptionError("a canceled subscription cannot be activated");
    if (sub.lifecycleId) throw new AdvancedSubscriptionError("advanced lifecycle is already active");
    const versionResult = (await db.execute<PlanVersionRow>(sql`
      select v.id, v.plan_id as "planId", v.interval, v.interval_count as "intervalCount", v.billing_timing as "billingTiming", v.status,
             v.effective_from as "effectiveFrom", v.effective_to as "effectiveTo",
             v.currency_code as "versionCurrency", p.currency_code as "planCurrency"
        from subscription_plan_versions v join subscription_plans p on p.id = v.plan_id and p.org_id = v.org_id
       where v.id = ${input.planVersionId} and v.org_id = ${orgId}
    `));
    const version = versionResult.rows[0];
    if (!version || version.status !== "published") throw new AdvancedSubscriptionError("a published plan version is required");
    if (version.planId !== sub.planId) throw new AdvancedSubscriptionError("plan version does not belong to the subscription plan");
    const termStartsOn = validDate(input.termStartsOn, "term start", true)!;
    const termEndsOn = validDate(input.termEndsOn, "term end");
    const trialEndsOn = validDate(input.trialEndsOn, "trial end");
    if (termEndsOn && termEndsOn < termStartsOn) throw new AdvancedSubscriptionError("term end cannot precede term start");
    if (trialEndsOn && (trialEndsOn < termStartsOn || (termEndsOn && trialEndsOn > termEndsOn))) {
      throw new AdvancedSubscriptionError("trial must fall inside the contract term");
    }
    if (version.effectiveFrom > termStartsOn || (version.effectiveTo && version.effectiveTo < termStartsOn)) {
      throw new AdvancedSubscriptionError("plan version is not effective on the contract start date");
    }
    // Backstop for versions published before the required-component publish
    // guard: only required components are copied below, so activating a
    // version with none would leave an unbillable subscription.
    const requiredComponents = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from subscription_plan_version_components
       where org_id = ${orgId} and version_id = ${input.planVersionId} and not is_optional
    `));
    if (!requiredComponents.rows[0]?.n) {
      throw new AdvancedSubscriptionError("plan version has no required components — mark a component as required before activating");
    }
    // Billing posts in the pinned version's currency, so pinning a version
    // whose currency differs from already-posted invoices would split one
    // contract across two currencies. Refuse the mid-contract change by name
    // instead of silently billing the old currency — or the new one.
    const effectiveCurrency = version.versionCurrency ?? version.planCurrency;
    if (effectiveCurrency) {
      const billed = (await db.execute<{ currency: string }>(sql`
        select distinct d.currency from documents d
         where d.org_id = ${orgId}
           and (d.id = (select last_invoice_id from subscriptions where id = ${input.subscriptionId} and org_id = ${orgId})
             or d.id in (select invoice_id from subscription_period_invoices where org_id = ${orgId} and subscription_id = ${input.subscriptionId}))
      `));
      const foreign = [...new Set(billed.rows.map((row) => row.currency).filter((currency) => currency.toUpperCase() !== effectiveCurrency.toUpperCase()))];
      if (foreign.length) {
        throw new AdvancedSubscriptionError(
          `subscription already has invoices in ${foreign.join(", ")} — billing currency cannot change mid-contract to ${effectiveCurrency}; ` +
          `create a new subscription for the ${effectiveCurrency} contract instead`,
        );
      }
    }
    const renewalTermMonths = input.renewalTermMonths == null ? null : subscriptionPeriodCount(input.renewalTermMonths, "renewal term");
    const renewalPolicy = input.renewalPolicy ?? "auto";
    assertRenewalPolicy(renewalPolicy);
    const firstBillOn = firstLifecycleBillOn({ termStartsOn, trialEndsOn, billingTiming: version.billingTiming, interval: version.interval, intervalCount: version.intervalCount });
    // Never rewind into posted service: the unbilled boundary is the later
    // of the subscription's own cursor (advanced atomically with every
    // billed invoice) and the latest guarded period end (bill-now invoices
    // post guards without moving the cursor).
    const prior = (await db.execute<{ nextBillOn: string; lastInvoiceId: string | null; guardedThrough: string | null }>(sql`
      select s.next_bill_on as "nextBillOn", s.last_invoice_id as "lastInvoiceId",
             (select max(pi.period_ends_on)::text from subscription_period_invoices pi
               where pi.org_id = ${orgId} and pi.subscription_id = ${input.subscriptionId}) as "guardedThrough"
        from subscriptions s where s.id = ${input.subscriptionId} and s.org_id = ${orgId}
    `)).rows[0];
    const boundary = prior && prior.guardedThrough && prior.guardedThrough > prior.nextBillOn ? prior.guardedThrough : prior?.nextBillOn ?? null;
    const billed = Boolean(prior?.lastInvoiceId ?? prior?.guardedThrough);
    const cursors = activationBillingCursors({
      termStartsOn,
      firstBillOn,
      anchor: trialEndsOn ?? termStartsOn,
      boundary,
      billed,
      billFromUnbilledBoundary: input.billFromUnbilledBoundary,
    });
    await db.execute(sql`
      insert into subscription_lifecycles
        (org_id, subscription_id, plan_version_id, term_starts_on, term_ends_on, trial_ends_on,
         billing_timing, renewal_policy, renewal_term_months, renewal_on, created_by, updated_by)
      values (${orgId}, ${input.subscriptionId}, ${input.planVersionId}, ${termStartsOn}, ${termEndsOn}, ${trialEndsOn},
              ${version.billingTiming}, ${renewalPolicy}, ${renewalTermMonths}, ${termEndsOn}, ${actorId}, ${actorId})
    `);
    await db.execute(sql`
      insert into subscription_components
        (org_id, subscription_id, source_version_component_id, component_key, name, description,
         quantity, unit_price, income_account_id, item_id, tax_code_id, effective_from, sort_order, created_by, updated_by)
      select org_id, ${input.subscriptionId}, id, component_key, name, description, quantity, unit_price,
             income_account_id, item_id, tax_code_id, ${termStartsOn}, sort_order, ${actorId}, ${actorId}
        from subscription_plan_version_components
       where org_id = ${orgId} and version_id = ${input.planVersionId} and not is_optional
    `);
    await db.execute(sql`
      update subscriptions set next_bill_on = ${cursors.nextBillOn}, current_period_start = ${cursors.currentPeriodStart},
             updated_at = now(), updated_by = ${actorId}
       where id = ${input.subscriptionId} and org_id = ${orgId}
    `);
  });
}

async function snapshot(orgId: string, subscriptionId: string) {
  const lifecycle = await subscriptionContext(orgId, subscriptionId);
  if (!lifecycle.lifecycleId || !lifecycle.termStartsOn || !lifecycle.billingTiming || !lifecycle.renewalPolicy) {
    throw new AdvancedSubscriptionError("advanced lifecycle is not active");
  }
  const components = (await db.execute<SubscriptionComponentRow>(sql`
    select component_key as "componentKey", name, description, quantity, unit_price as "unitPrice",
           income_account_id as "incomeAccountId", item_id as "itemId", tax_code_id as "taxCodeId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo"
      from subscription_components where org_id = ${orgId} and subscription_id = ${subscriptionId}
     order by effective_from, sort_order, component_key
  `));
  return { lifecycle, components: components.rows };
}

/**
 * Provenance of an engine-initiated amendment (today, the scheduler's
 * auto-renewal). The origin and run context are persisted inside the
 * amendment's immutable request snapshot, so a background contract change is
 * auditable from the amendment row itself — never attributed to whatever
 * historic user happened to create the subscription.
 */
export interface SystemAmendmentSource {
  origin: string;
  detail?: Record<string, unknown>;
}

interface AmendmentCallOptions { system?: SystemAmendmentSource; allowedSubsidiaryIds?: ReadonlySet<string> | null }

export async function applyAmendment(orgId: string, actorId: string | null, request: AmendmentRequest, opts?: AmendmentCallOptions) {
  return withOrg(orgId, async () => { await assertEnabled(orgId);
    if (!request.idempotencyKey.trim()) throw new AdvancedSubscriptionError("idempotency key is required");
    // Every applied amendment names its actor on the row itself (the applied
    // status constraint refuses NULL attribution). An interactive call needs a
    // real authenticated gate user and may never borrow the engine's identity;
    // a scheduler-generated renewal carries {@link SYSTEM_ACTOR_ID} plus its
    // persisted source marker instead of a historic creator or a placeholder —
    // coalescing with the recurring-schedule provenance contract (0777424f).
    const systemSource = opts?.system ?? null;
    let attributedBy: string;
    if (systemSource) {
      attributedBy = SYSTEM_ACTOR_ID;
    } else if (actorId) {
      if (actorId === SYSTEM_ACTOR_ID) throw new AdvancedSubscriptionError("an interactive amendment cannot carry the engine system actor");
      attributedBy = actorId;
    } else {
      throw new AdvancedSubscriptionError("an authenticated amendment actor is required");
    }
    const requestSnapshot = systemSource
      ? { ...request, source: { kind: "system", origin: systemSource.origin, ...(systemSource.detail ?? {}) } }
      : request;
    const lock = (await db.execute(sql`select id from subscriptions where id = ${request.subscriptionId} and org_id = ${orgId} for update`));
    if (!lock.rows.length) throw new AdvancedSubscriptionError("subscription not found");
    await subscriptionContext(orgId, request.subscriptionId, opts?.allowedSubsidiaryIds);
    const replay = (await db.execute<AmendmentReplayRow>(sql`
      select id, subscription_id as "subscriptionId", request from subscription_amendments
       where org_id = ${orgId} and idempotency_key = ${request.idempotencyKey}
    `));
    if (replay.rows[0]) {
      assertIdempotentReplay(replay.rows[0].subscriptionId, request.subscriptionId, replay.rows[0].request, requestSnapshot);
      return { id: replay.rows[0].id, replayed: true };
    }
    if (!["add_component", "remove_component", "change_component", "change_term", "change_timing", "renew", "coterm"].includes(request.type)) {
      throw new AdvancedSubscriptionError("invalid amendment type");
    }
    const effectiveOn = validDate(request.effectiveOn, "effective date", true)!;
    const before = await snapshot(orgId, request.subscriptionId);
    if (before.lifecycle.status === "canceled") throw new AdvancedSubscriptionError("a canceled subscription cannot be amended");
    const currentComponent = request.componentKey
      ? before.components.find((c) => c.componentKey === request.componentKey && c.effectiveFrom <= effectiveOn && (!c.effectiveTo || c.effectiveTo >= effectiveOn))
      : null;
    if (["remove_component", "change_component"].includes(request.type) && !currentComponent) {
      throw new AdvancedSubscriptionError("active component not found");
    }
    // Inclusive windows cannot end before their first day. Preserve the original
    // contract history and reject an amendment that would create an empty window.
    if (["remove_component", "change_component"].includes(request.type) && currentComponent?.effectiveFrom === effectiveOn) {
      throw new AdvancedSubscriptionError("component changes must take effect after the current component start date");
    }
    const quantity = request.type === "add_component" || (request.type === "change_component" && request.quantity != null)
      ? positiveMoney(request.quantity ?? "1", "component quantity")
      : null;
    const unitPrice = request.type === "add_component" || (request.type === "change_component" && request.unitPrice != null)
      ? nonNegativeMoney(request.unitPrice, "component price")
      : null;
    if (request.type === "add_component") {
      if (!request.componentKey?.trim() || !request.name?.trim()) throw new AdvancedSubscriptionError("component key and name are required");
      if (before.components.some((component) => component.componentKey === request.componentKey
          && (!component.effectiveTo || component.effectiveTo >= effectiveOn))) {
        throw new AdvancedSubscriptionError("component key overlaps an existing or scheduled component");
      }
      await assertCommercialRefs(orgId, request);
    }
    if (request.type === "change_component") {
      await assertCommercialRefs(orgId, request, currentComponent?.itemId);
    }
    if (request.type === "change_timing" && !["advance", "arrears"].includes(request.billingTiming ?? "")) {
      throw new AdvancedSubscriptionError("billing timing must be advance or arrears");
    }
    if (["remove_component", "change_component"].includes(request.type)) {
      await db.execute(sql`
        update subscription_components set effective_to = (${effectiveOn}::date - interval '1 day')::date,
               updated_at = now(), updated_by = ${attributedBy}
         where org_id = ${orgId} and subscription_id = ${request.subscriptionId}
           and component_key = ${request.componentKey!} and effective_from <= ${effectiveOn}
           and (effective_to is null or effective_to >= ${effectiveOn})
      `);
    }
    if (["add_component", "change_component"].includes(request.type)) {
      const source: Partial<SubscriptionComponentRow> = currentComponent ?? {};
      await db.execute(sql`
        insert into subscription_components
          (org_id, subscription_id, component_key, name, description, quantity, unit_price,
           income_account_id, item_id, tax_code_id, effective_from, effective_to, sort_order, created_by, updated_by)
        values (${orgId}, ${request.subscriptionId}, ${request.componentKey!}, ${request.name ?? source.name},
                ${request.description !== undefined ? request.description : source.description ?? null},
                ${quantity ?? source.quantity ?? "1"}, ${unitPrice ?? source.unitPrice ?? "0"},
                ${request.incomeAccountId !== undefined ? request.incomeAccountId : source.incomeAccountId ?? null},
                ${request.itemId !== undefined ? request.itemId : source.itemId ?? null}, ${request.taxCodeId !== undefined ? request.taxCodeId : source.taxCodeId ?? null},
                ${effectiveOn}, ${source.effectiveTo ?? null}, ${before.components.length}, ${attributedBy}, ${attributedBy})
      `);
    }
    if (request.type === "change_term") {
      const termEndsOn = validDate(request.termEndsOn, "term end");
      const termStartsOn = before.lifecycle.termStartsOn;
      if (!termStartsOn) throw new AdvancedSubscriptionError("advanced lifecycle is not active");
      if (termEndsOn && termEndsOn < termStartsOn) throw new AdvancedSubscriptionError("term end cannot precede term start");
      await db.execute(sql`update subscription_lifecycles set term_ends_on = ${termEndsOn}, renewal_on = ${termEndsOn}, updated_at = now(), updated_by = ${attributedBy} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "change_timing") {
      await db.execute(sql`update subscription_lifecycles set billing_timing = ${request.billingTiming!}, updated_at = now(), updated_by = ${attributedBy} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "renew") {
      const months = subscriptionPeriodCount(request.renewalTermMonths ?? before.lifecycle.renewalTermMonths ?? 12, "renewal term");
      if (months < 1 || !before.lifecycle.termEndsOn) throw new AdvancedSubscriptionError("renewal requires a current term end and positive renewal term");
      const nextEnd = addMonths(before.lifecycle.termEndsOn, months);
      await db.execute(sql`update subscription_lifecycles set term_starts_on = ${before.lifecycle.termEndsOn}, term_ends_on = ${nextEnd}, renewal_on = ${nextEnd}, renewal_term_months = ${months}, updated_at = now(), updated_by = ${attributedBy} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "coterm") {
      if (!request.anchorSubscriptionId) throw new AdvancedSubscriptionError("an anchor subscription is required");
      const anchor = await subscriptionContext(orgId, request.anchorSubscriptionId, opts?.allowedSubsidiaryIds);
      if (!anchor.lifecycleId || !anchor.termEndsOn) throw new AdvancedSubscriptionError("anchor subscription needs an advanced term end");
      assertCotermAllowed({ subscriptionId: request.subscriptionId, anchorSubscriptionId: request.anchorSubscriptionId, customerId: before.lifecycle.customerId, anchorCustomerId: anchor.customerId });
      await db.execute(sql`update subscription_lifecycles set term_ends_on = ${anchor.termEndsOn}, renewal_on = ${anchor.termEndsOn}, coterm_anchor_subscription_id = ${request.anchorSubscriptionId}, updated_at = now(), updated_by = ${attributedBy} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    await db.execute(sql`update subscription_lifecycles set contract_revision = contract_revision + 1, updated_at = now(), updated_by = ${attributedBy} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    const after = await snapshot(orgId, request.subscriptionId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into subscription_amendments
        (org_id, subscription_id, amendment_number, amendment_type, effective_on, status, idempotency_key,
         reason, request, before_snapshot, after_snapshot, applied_at, applied_by, created_by, updated_by)
      select ${orgId}, ${request.subscriptionId}, coalesce(max(amendment_number), 0) + 1, ${request.type}, ${effectiveOn},
             'applied', ${request.idempotencyKey}, ${request.reason ?? null}, ${JSON.stringify(requestSnapshot)}::jsonb,
             ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, now(), ${attributedBy}, ${attributedBy}, ${attributedBy}
        from subscription_amendments where org_id = ${orgId} and subscription_id = ${request.subscriptionId}
      returning id
    `));
    return { id: inserted.rows[0]!.id, replayed: false };
  });
}

export async function advancedSubscriptionWorkspace(orgId: string, allowed?: ReadonlySet<string> | null) {
  const [versions, lifecycles, amendments] = await Promise.all([
    db.execute(sql`
      select v.id, v.plan_id as "planId", v.version_number as "versionNumber", v.status, v.effective_from as "effectiveFrom",
             v.effective_to as "effectiveTo", v.name, v.currency_code as currency, v.interval,
             v.interval_count as "intervalCount", v.billing_timing as "billingTiming", v.change_summary as "changeSummary",
             coalesce(jsonb_agg(jsonb_build_object('componentKey', c.component_key, 'name', c.name, 'quantity', c.quantity,
               'unitPrice', c.unit_price, 'isOptional', c.is_optional) order by c.sort_order) filter (where c.id is not null), '[]'::jsonb) as components
        from subscription_plan_versions v left join subscription_plan_version_components c on c.version_id = v.id and c.org_id = v.org_id
       where v.org_id = ${orgId} group by v.id order by v.plan_id, v.version_number desc
    `),
    db.execute(sql`
      select l.subscription_id as "subscriptionId", l.plan_version_id as "planVersionId", l.contract_revision as "contractRevision",
             l.term_starts_on as "termStartsOn", l.term_ends_on as "termEndsOn", l.trial_ends_on as "trialEndsOn",
             l.billing_timing as "billingTiming", l.renewal_policy as "renewalPolicy", l.renewal_term_months as "renewalTermMonths",
             l.renewal_on as "renewalOn", l.coterm_anchor_subscription_id as "cotermAnchorSubscriptionId",
             coalesce(jsonb_agg(jsonb_build_object('componentKey', c.component_key, 'name', c.name, 'quantity', c.quantity,
               'unitPrice', c.unit_price, 'effectiveFrom', c.effective_from, 'effectiveTo', c.effective_to) order by c.sort_order)
               filter (where c.id is not null), '[]'::jsonb) as components
        from subscription_lifecycles l left join subscription_components c on c.subscription_id = l.subscription_id and c.org_id = l.org_id
       where l.org_id = ${orgId} ${subscriptionScopeSql(orgId, sql`l.subscription_id`, allowed)} group by l.id order by l.created_at desc
    `),
    db.execute(sql`
      select id, subscription_id as "subscriptionId", amendment_number as "amendmentNumber", amendment_type as "amendmentType",
             effective_on as "effectiveOn", status, reason, applied_at as "appliedAt", request
        from subscription_amendments where org_id = ${orgId} ${subscriptionScopeSql(orgId, sql`subscription_amendments.subscription_id`, allowed)} order by applied_at desc, amendment_number desc
    `),
  ]);
  return { versions: versions.rows, lifecycles: lifecycles.rows, amendments: amendments.rows };
}

/**
 * Called by the recurring runner before it claims a due row. Subscriptions
 * without contract lifecycle configuration return true. Manual/no-renew
 * contracts stop at the boundary; auto-renew contracts append the same
 * immutable amendment an interactive renewal would, attributed to the
 * documented engine system actor with a durable scheduler source marker in
 * the amendment's request snapshot — never to the subscription's historic
 * creator, and never refused when an imported subscription has no author —
 * using a deterministic idempotency key.
 */
export async function prepareAdvancedSubscriptionBilling(orgId: string, subscriptionId: string, dueOn: string): Promise<boolean> {
  return withOrg(orgId, async () => {
    const result = (await db.execute<BillingPreparationRow>(sql`
      select l.billing_timing as "billingTiming", l.term_ends_on as "termEndsOn",
             l.renewal_policy as "renewalPolicy", l.renewal_term_months as "renewalTermMonths"
        from subscriptions s left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
       where s.id = ${subscriptionId} and s.org_id = ${orgId}
    `));
    const row = result.rows[0];
    if (!row?.billingTiming) return true;
    await assertEnabled(orgId);
    // The boundary decision uses the term and timing in force on the due
    // date: a future-dated reduction or timing change must neither stop nor
    // renew billing before its date arrives.
    const effective = await effectiveLifecycleState(orgId, subscriptionId, dueOn, { billingTiming: row.billingTiming, termEndsOn: row.termEndsOn });
    const action = renewalAction({ billingTiming: effective.billingTiming, dueOn, termEndsOn: effective.termEndsOn, policy: row.renewalPolicy ?? "none" });
    if (action === "bill") return true;
    if (action === "stop") return false;
    if (!row.termEndsOn) return true;
    await applyAmendment(orgId, null, {
      subscriptionId,
      type: "renew",
      effectiveOn: row.termEndsOn,
      renewalTermMonths: row.renewalTermMonths ?? 12,
      idempotencyKey: `auto-renew:${subscriptionId}:${row.termEndsOn}`,
      reason: "Automatic renewal",
    }, {
      system: { origin: "subscription-billing-scheduler", detail: { dueOn } },
    });
    return true;
  });
}

export type AdvancedBillingLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  incomeAccountId: string | null;
  itemId: string | null;
  taxCodeId: string | null;
};

/** A billable component together with its inclusive effective window. */
export interface ComponentWindow extends AdvancedBillingLine, Record<string, unknown> {
  componentKey: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Window overlap arithmetic goes through the single civil-date definition in
 * platform/business-date.ts (civilDayIndex / isoFromCivilDayIndex), which
 * keeps literal years 0001-0099 instead of remapping them onto 1900-1999.
 */
function dayIndex(isoDate: string): number {
  return civilDayIndex(isoDate);
}

function isoFromDayIndex(day: number): string {
  return isoFromCivilDayIndex(day);
}

/**
 * Price arrears components over the actual SERVICE interval
 * [periodStartsOn, periodEndsOn), end-exclusive. Stored component windows are
 * inclusive on both ends (an amendment closes the prior window on
 * effectiveOn − 1 day), so a window overlaps the interval exactly when
 * effectiveFrom < periodEndsOn and (effectiveTo is null or
 * effectiveTo >= periodStartsOn). A component unchanged inside the interval
 * bills one line at its interval price, verbatim; a component whose price or
 * row changes inside the interval bills one prorated line per effective
 * window via the shared {@link prorateDays} helper — the same full ×
 * coveredDays / totalDays proration the subscription engine uses for
 * mid-period changes — with quantity "1" and the slice amount as the unit
 * price, matching the module's prorated-charge convention. Pure.
 */
export function arrearsLinesForInterval(
  periodStartsOn: string,
  periodEndsOn: string,
  windows: ComponentWindow[],
): AdvancedBillingLine[] {
  const totalDays = dayIndex(periodEndsOn) - dayIndex(periodStartsOn);
  if (!(totalDays > 0)) return [];
  const byKey = new Map<string, ComponentWindow[]>();
  for (const window of windows) {
    const keyed = byKey.get(window.componentKey);
    if (keyed) keyed.push(window);
    else byKey.set(window.componentKey, [window]);
  }
  const lines: AdvancedBillingLine[] = [];
  for (const rows of byKey.values()) {
    const ordered = [...rows].sort((left, right) => (left.effectiveFrom < right.effectiveFrom ? -1 : left.effectiveFrom > right.effectiveFrom ? 1 : 0));
    const overlaps = ordered.flatMap((row) => {
      const windowStartsOn = row.effectiveFrom > periodStartsOn ? row.effectiveFrom : periodStartsOn;
      const rowEndsExclusive = row.effectiveTo === null ? periodEndsOn : isoFromDayIndex(dayIndex(row.effectiveTo) + 1);
      const windowEndsOn = rowEndsExclusive < periodEndsOn ? rowEndsExclusive : periodEndsOn;
      const coveredDays = dayIndex(windowEndsOn) - dayIndex(windowStartsOn);
      return coveredDays > 0 ? [{ row, windowStartsOn, windowEndsOn, coveredDays }] : [];
    });
    // No change inside the interval (a successor starting exactly on the
    // end-exclusive boundary serves nothing here): one verbatim line.
    const unchanged = overlaps.length === 1 && overlaps[0]!.coveredDays === totalDays;
    for (const overlap of overlaps) {
      const { row, windowStartsOn, windowEndsOn, coveredDays } = overlap;
      if (unchanged) {
        lines.push({
          description: row.description,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          incomeAccountId: row.incomeAccountId,
          itemId: row.itemId,
          taxCodeId: row.taxCodeId,
        });
      } else {
        const windowEndsInclusive = isoFromDayIndex(dayIndex(windowEndsOn) - 1);
        lines.push({
          description: `${row.description} (${windowStartsOn} → ${windowEndsInclusive})`,
          quantity: "1",
          unitPrice: prorateDays(mul(row.quantity, row.unitPrice), coveredDays, totalDays),
          incomeAccountId: row.incomeAccountId,
          itemId: row.itemId,
          taxCodeId: row.taxCodeId,
        });
      }
    }
  }
  return lines;
}

/** Snapshot used by the invoice engine; null means single-plan billing. */
export async function advancedBillingSnapshot(orgId: string, subscriptionId: string, billOn: string, periodStartOverride?: string | null): Promise<{
  contractRevision: number;
  billingTiming: BillingTiming;
  periodStartsOn: string;
  periodEndsOn: string;
  lines: AdvancedBillingLine[];
  total: string;
} | null> {
  const lifecycle = (await db.execute<BillingLifecycleRow>(sql`
    select l.contract_revision as "contractRevision", l.billing_timing as "billingTiming",
           s.current_period_start as "currentPeriodStart", s.next_bill_on as "nextBillOn",
           v.interval, v.interval_count as "intervalCount"
      from subscription_lifecycles l join subscriptions s on s.id = l.subscription_id and s.org_id = l.org_id
      join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = l.org_id
     where l.org_id = ${orgId} and l.subscription_id = ${subscriptionId}
  `));
  const row = lifecycle.rows[0];
  if (!row) return null;
  // The period is priced under the timing in force on the bill date: a
  // timing change dated after billOn must not rewrite this invoice.
  const effective = await effectiveLifecycleState(orgId, subscriptionId, billOn, { billingTiming: row.billingTiming, termEndsOn: null });
  const serviceAnchor = periodStartOverride ?? row.currentPeriodStart ?? billOn;
  const { periodStartsOn, periodEndsOn } = lifecycleBillingPeriod({ billOn, serviceAnchor, billingTiming: effective.billingTiming, interval: row.interval, intervalCount: row.intervalCount });
  // One fetch covers both timings: a stored window overlaps the service
  // interval exactly when it starts before the end-exclusive boundary and
  // ends on or after the start (open-ended counts as overlapping). Advance
  // billing then prices the window open on the period's first day — the price
  // known when the upcoming period is billed — while arrears prices every
  // window over the service interval it actually served (see
  // arrearsLinesForInterval). The in-advance path has no boundary confusion:
  // periodStartsOn is the inclusive first service day, so "active on start"
  // is the price in force when the period begins.
  const components = (await db.execute<ComponentWindow>(sql`
    select component_key as "componentKey", name as description, quantity, unit_price as "unitPrice",
           income_account_id as "incomeAccountId", item_id as "itemId", tax_code_id as "taxCodeId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo"
      from subscription_components
     where org_id = ${orgId} and subscription_id = ${subscriptionId} and effective_from < ${periodEndsOn}
       and (effective_to is null or effective_to >= ${periodStartsOn})
     order by sort_order, component_key
  `));
  const lines = effective.billingTiming === "advance"
    ? components.rows
      .filter((component) => component.effectiveFrom <= periodStartsOn && (component.effectiveTo === null || component.effectiveTo >= periodStartsOn))
      .map(({ description, quantity, unitPrice, incomeAccountId, itemId, taxCodeId }): AdvancedBillingLine => ({
        description, quantity, unitPrice, incomeAccountId, itemId, taxCodeId,
      }))
    : arrearsLinesForInterval(periodStartsOn, periodEndsOn, components.rows);
  const total = subscriptionComponentTotal(lines);
  return { contractRevision: row.contractRevision, billingTiming: effective.billingTiming, periodStartsOn, periodEndsOn, lines, total };
}
