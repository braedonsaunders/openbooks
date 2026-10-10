import { sql } from "drizzle-orm";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { moneyRefusal } from "../money/decimal-refusal.ts";
import { db, orgContext, withBypass, withOrg, withOrgContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { addCalendarDays, businessToday, calendarDaysBetween } from "../platform/business-date.ts";
import { now } from "../platform/clock.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { add, mul, mulDecimalFactors, mulRatio, neg, normalizeMoney, toUnits } from "../money/money.ts";
import { computeLineTaxes } from "../tax/tax.ts";
import { loadTaxComponentConfig, persistLineTaxComponents } from "../tax/persist.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { resolveDocumentLineDefaults } from "../ledger/document-defaults.ts";
import { type PostingDeps } from "../journal/posting-contracts.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { resolveSubscriptionBillingTarget } from "./consolidated-billing.ts";
import { advanceAnchoredMonth, retreatAnchoredMonth } from "./cadence.ts";
import { daysInCivilMonth } from "../platform/civil-date.ts";
import {
  advancedBillingSnapshot,
  prepareAdvancedSubscriptionBilling,
  unbilledBoundary,
  type AdvancedBillingLine,
} from "./advanced-subscriptions.ts";
import { inventoryFeatureEnabled } from "../inventory/profile-policy.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";

/**
 * Subscription billing engine. Each active subscription is billed when its
 * next_bill_on comes due: the runner generates a customer_invoice for the plan
 * price × quantity, optionally posts it, and advances next_bill_on by the plan
 * interval. Claiming uses the scheduler's advance-and-guard trick — the
 * UPDATE … WHERE next_bill_on = $old lets only one tick win an occurrence — but
 * it runs INSIDE the billing transaction: the claim and the invoice commit
 * atomically. An earlier design claimed first in its own transaction and rolled
 * back on failure, which a hard process kill between the two commits could not
 * do — the claim stayed advanced with nothing billed, permanently losing the
 * billable period. Sharing one transaction closes that window: a crash rolls
 * both back, the schedule stays due, and the next tick retries. Never silently
 * lost. Every billed period — advanced lifecycle or plain plan — commits a
 * `subscription_period_invoices` guard row next to its invoice, so a retried
 * tick replays the committed invoice instead of cutting a second one.
 * Success bookkeeping (run_count/last_invoice_id) runs outside the billing
 * transaction for the same reason. Gated by the org's `subscriptionBilling`
 * feature — disabling the feature stops automated billing without touching any
 * data.
 */

export type Interval = "weekly" | "monthly" | "quarterly" | "annually";

export const SUBSCRIPTION_INTERVALS = ["weekly", "monthly", "quarterly", "annually"] as const;

const SUBSCRIPTION_INTERVAL_SET = new Set<string>(SUBSCRIPTION_INTERVALS);
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const POSTGRES_MONEY_MAX_UNITS = 9_999_999_999_999_999_999n;

export class SubscriptionError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
    this.name = "SubscriptionError";
  }
}

/** Lock and scope-check the customer whose entity determines subscription billing. */
export async function lockCustomerForScope(
  tx: SqlExecutor,
  orgId: string,
  customerId: string,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const allowed = scope === null
    ? sql``
    : scope.size
      ? sql`and (c.subsidiary_id is null or c.subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[]))`
      : sql`and c.subsidiary_id is null`;
  const customer = await tx.execute(sql`
    select c.id
      from parties c
     where c.org_id = ${orgId} and c.id = ${customerId}
       ${allowed}
     for share of c
  `);
  if (!customer.rows[0]) throw new ScopeNotFoundError();
}

/** Lock and scope-check the customer whose entity determines subscription billing. */
export async function lockSubscriptionCustomerForScope(
  tx: SqlExecutor,
  orgId: string,
  subscriptionId: string,
  scope: ReadonlySet<string> | null,
): Promise<void> {
  const allowed = scope === null
    ? sql``
    : scope.size
      ? sql`and (c.subsidiary_id is null or c.subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[]))`
      : sql`and c.subsidiary_id is null`;
  const customer = await tx.execute(sql`
    select c.id
      from subscriptions s
      join parties c on c.id = s.customer_id and c.org_id = s.org_id
     where s.org_id = ${orgId} and s.id = ${subscriptionId}
       ${allowed}
     for share of c
  `);
  if (!customer.rows[0]) throw new ScopeNotFoundError();
}

/**
 * Canonicalize base-subscription money without crossing the IEEE-754 boundary.
 * The range mirrors numeric(19,4); callers choose whether zero is meaningful.
 */
export function normalizeSubscriptionMoney(
  value: unknown,
  label: string,
  requirement: "nonnegative" | "positive",
): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new SubscriptionError(moneyRefusal(label, value));
  let normalized: string;
  try {
    normalized = normalizeMoney(exact);
  } catch {
    throw new SubscriptionError(moneyRefusal(label, value));
  }
  const units = toUnits(normalized);
  if (units > POSTGRES_MONEY_MAX_UNITS || units < -POSTGRES_MONEY_MAX_UNITS) {
    throw new SubscriptionError(`${label} is outside the supported money range`);
  }
  if (requirement === "positive" ? units <= 0n : units < 0n) {
    throw new SubscriptionError(
      requirement === "positive"
        ? `${label} must be greater than zero`
        : `${label} must be nonnegative`,
    );
  }
  return normalized;
}

/** Parse one supported base-plan cadence without Number coercion or fallback. */
export function normalizeSubscriptionCadence(
  interval: unknown,
  intervalCount: unknown,
): { interval: Interval; intervalCount: number } {
  if (typeof interval !== "string" || !SUBSCRIPTION_INTERVAL_SET.has(interval)) {
    throw new SubscriptionError("interval must be weekly, monthly, quarterly, or annually");
  }
  const count =
    typeof intervalCount === "number"
      ? intervalCount
      : typeof intervalCount === "string" && /^[1-9]\d*$/.test(intervalCount)
        ? Number(intervalCount)
        : Number.NaN;
  if (!Number.isSafeInteger(count) || count <= 0 || count > POSTGRES_INTEGER_MAX) {
    throw new SubscriptionError("interval count must be a positive integer");
  }
  return { interval: interval as Interval, intervalCount: count };
}

/** Persist a subscription quantity or price through the shared domain rules. */
function persistSubscriptionMoney(
  value: unknown,
  label: string,
  requirement: "nonnegative" | "positive",
): string {
  return normalizeSubscriptionMoney(value, label, requirement);
}

function persistRatedQuantity(value: unknown): string {
  const exact = canonicalDecimal(value, 8);
  if (exact === null || compareDecimal(exact, "0") <= 0) {
    throw new SubscriptionError("rated invoice quantity must be a positive decimal with no more than 8 decimal places");
  }
  if (exact.split(".", 1)[0]!.replace(/^0+/, "").length > 20) {
    throw new SubscriptionError("rated invoice quantity is outside the supported numeric(28,8) range");
  }
  return exact;
}

function persistRatedUnitPrice(value: unknown): string {
  const exact = canonicalDecimal(value, 8);
  if (exact === null || compareDecimal(exact, "0") < 0) {
    throw new SubscriptionError("rated invoice unit price must be a nonnegative decimal with no more than 8 decimal places");
  }
  if (exact.split(".", 1)[0]!.replace(/^0+/, "").length > 20) {
    throw new SubscriptionError("rated invoice unit price is outside the supported numeric(28,8) range");
  }
  return exact;
}

const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toIso(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function subscriptionDate(isoDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || isoDate.startsWith("0000-")) {
    throw new SubscriptionError("billing date must be a valid ISO date");
  }
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toIso(date) !== isoDate) {
    throw new SubscriptionError("billing date must be a valid ISO date");
  }
  return date;
}

/**
 * Advance an ISO date by one billing interval (× intervalCount). Month/quarter/
 * year steps pin the day to the anchor (default: the source date's own day),
 * clamped to the target month's length — so Jan 31 +1mo → Feb 28, then
 * Feb 28 +1mo → Mar 31 with the anchor, never Mar 28. Pure — unit-tested.
 */
export function advanceSubscription(
  isoDate: string, interval: Interval, intervalCount = 1, anchorDay?: number | null,
): string {
  const cadence = normalizeSubscriptionCadence(interval, intervalCount);
  const n = cadence.intervalCount;
  const sourceDate = subscriptionDate(isoDate);
  const [y, m, d] = isoDate.split("-").map(Number);
  if (cadence.interval === "weekly") {
    const base = new Date(sourceDate);
    base.setUTCDate(base.getUTCDate() + 7 * n);
    if (Number.isNaN(base.getTime()) || base.getUTCFullYear() > 9999) {
      throw new SubscriptionError("billing cadence advances outside the supported date range");
    }
    return toIso(base);
  }
  // The DAY comes from the stored anchor, not the already-clamped date.
  // The anchor is pre-validated here so the shared helper below can only
  // fail on the target year, keeping the refusal messages stable.
  const anchor = anchorDay ?? d!;
  if (!Number.isSafeInteger(anchor) || anchor < 1 || anchor > 31) {
    throw new SubscriptionError("billing anchor day must be between 1 and 31");
  }
  const monthStep = (cadence.interval === "monthly" ? 1 : cadence.interval === "quarterly" ? 3 : 12) * n;
  try {
    return advanceAnchoredMonth(y!, m!, monthStep, anchor);
  } catch {
    throw new SubscriptionError("billing cadence advances outside the supported date range");
  }
}

/**
 * The anchor day of the billing cycle that passes through `billOn`. A stored
 * anchor is honoured when it lands on that date (anchor 31 lands on Feb 28);
 * an anchor that does not land on it cannot describe a cycle through it, and
 * the bill date's own day is the only cycle that does.
 */
function cycleAnchorThrough(billOn: string, interval: Interval, anchorDay: number | null | undefined): number {
  const [y, m, d] = billOn.split("-").map(Number);
  if (interval === "weekly" || anchorDay == null) return d!;
  if (!Number.isSafeInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new SubscriptionError("billing anchor day must be between 1 and 31");
  }
  return Math.min(anchorDay, daysInCivilMonth(y!, m!)) === d ? anchorDay : d!;
}

/**
 * Start of the full billing period that ends on `periodEnd`: one interval
 * (× intervalCount) back, with month-based steps pinned to the cycle's
 * anchor exactly as advanceSubscription pins them forward, so advancing the
 * returned date reproduces `periodEnd`. Pure — unit-tested.
 */
export function billingPeriodStartBefore(
  periodEnd: string, interval: Interval, intervalCount = 1, anchorDay?: number | null,
): string {
  const cadence = normalizeSubscriptionCadence(interval, intervalCount);
  const n = cadence.intervalCount;
  const endDate = subscriptionDate(periodEnd);
  if (cadence.interval === "weekly") {
    const base = new Date(endDate);
    base.setUTCDate(base.getUTCDate() - 7 * n);
    if (Number.isNaN(base.getTime()) || base.getUTCFullYear() < 1) {
      throw new SubscriptionError("billing cadence steps outside the supported date range");
    }
    return toIso(base);
  }
  const anchor = cycleAnchorThrough(periodEnd, cadence.interval, anchorDay);
  const [y, m] = periodEnd.split("-").map(Number);
  const monthStep = (cadence.interval === "monthly" ? 1 : cadence.interval === "quarterly" ? 3 : 12) * n;
  try {
    return retreatAnchoredMonth(y!, m!, monthStep, anchor);
  } catch {
    throw new SubscriptionError("billing cadence steps outside the supported date range");
  }
}

/**
 * The first-period stub [startOn, firstBillOn) and the FULL billing period
 * that ends on firstBillOn, whose length prices the stub. A stub longer than
 * one billing period is refused by name: pricing it as one period would
 * silently discount the earlier service, and pricing it above one period
 * would bill a cycle the schedule never shows. Pure — unit-tested.
 */
export function firstPeriodStub(
  startOn: string,
  firstBillOn: string,
  interval: Interval,
  intervalCount = 1,
  anchorDay?: number | null,
): { periodStart: string; stubDays: number; periodDays: number } {
  subscriptionDate(startOn);
  if (firstBillOn <= startOn) throw new SubscriptionError("nothing to prorate for the first period");
  const periodStart = billingPeriodStartBefore(firstBillOn, interval, intervalCount, anchorDay);
  if (startOn < periodStart) {
    throw new SubscriptionError(
      `the first period ${startOn} → ${firstBillOn} is longer than one billing period ` +
        `(${periodStart} → ${firstBillOn}); choose a first bill date no more than one billing period after the start date`,
    );
  }
  return {
    periodStart,
    stubDays: calendarDaysBetween(startOn, firstBillOn),
    periodDays: calendarDaysBetween(periodStart, firstBillOn),
  };
}

/**
 * Charge for a first-period stub: the stub's days over the length of the
 * full billing period it belongs to, so six days of a 300.00 monthly plan
 * billing on Aug 1 charge 300 × 6/31. Pure — unit-tested.
 */
export function firstPeriodProration(
  fullAmount: string,
  startOn: string,
  firstBillOn: string,
  interval: Interval,
  intervalCount = 1,
  anchorDay?: number | null,
): string {
  const stub = firstPeriodStub(startOn, firstBillOn, interval, intervalCount, anchorDay);
  return mulRatio(fullAmount, BigInt(stub.stubDays), BigInt(stub.periodDays));
}

/**
 * Value of `fullAmount` for the unused remainder of the current period
 * ending on periodEnd, from max(asOf, serviceStart): the remaining days over
 * the FULL billing period length. During a prorated first stub the
 * denominator is still the full period, so a mid-stub change is priced at the
 * same daily rate the stub was billed at; days before service started are
 * never counted. Pure — unit-tested.
 */
export function remainingPeriodProration(
  fullAmount: string,
  serviceStart: string,
  periodEnd: string,
  asOf: string,
  interval: Interval,
  intervalCount = 1,
  anchorDay?: number | null,
): string {
  if (periodEnd <= serviceStart) return "0.0000";
  const periodStart = billingPeriodStartBefore(periodEnd, interval, intervalCount, anchorDay);
  const total = calendarDaysBetween(periodStart, periodEnd);
  const from = asOf > serviceStart ? asOf : serviceStart;
  const remaining = Math.max(0, Math.min(total, calendarDaysBetween(from, periodEnd)));
  return mulRatio(fullAmount, BigInt(remaining), BigInt(total));
}

/**
 * Resolve a next_bill_on edit against the unbilled boundary (m47's shared
 * helper — the later of the subscription cursor and the latest guarded
 * period end). Moving the cursor earlier than billed service would rewind
 * into posted periods and bill them twice (period guards dedupe only exact
 * period end + revision); moving it forward past unbilled service would
 * silently skip service the scheduler then never bills. Both are refused by
 * name: the backward move has no opt-in, and the forward move requires an
 * explicit skip with a reason, returned as the auditable skipped window.
 * A no-op write of the current cursor is not a move and stays allowed.
 * Unbilled subscriptions keep the legacy period check. Pure.
 */
export interface NextBillOnUpdateInput {
  startOn: string;
  currentPeriodStart: string | null;
  currentNextBillOn: string;
  /** Latest subscription_period_invoices end, or null when none exists. */
  guardedThrough: string | null;
  /** True once any invoice (or guard row) exists for the subscription. */
  billed: boolean;
  newNextBillOn: string;
  skipUnbilledService?: boolean;
  skipReason?: string | null;
}

export interface NextBillOnUpdate {
  nextBillOn: string;
  skippedWindow: { from: string; to: string } | null;
}

export function resolveNextBillOnUpdate(input: NextBillOnUpdateInput): NextBillOnUpdate {
  const boundary = unbilledBoundary(input.currentNextBillOn, input.guardedThrough);
  if (input.newNextBillOn === input.currentNextBillOn || input.newNextBillOn === boundary) {
    return { nextBillOn: input.newNextBillOn, skippedWindow: null };
  }
  if (input.newNextBillOn < boundary) {
    if (!input.billed) {
      if (
        input.newNextBillOn < input.startOn ||
        (input.currentPeriodStart !== null && input.newNextBillOn < input.currentPeriodStart)
      ) {
        throw new SubscriptionError("next bill date cannot precede the subscription period");
      }
      return { nextBillOn: input.newNextBillOn, skippedWindow: null };
    }
    throw new SubscriptionError(
      `next bill date ${input.newNextBillOn} overlaps already-billed service through ${boundary} — ` +
        `set it to ${boundary}, the end of the last billed period`,
    );
  }
  const reason = (input.skipReason ?? "").trim();
  if (input.skipUnbilledService !== true || !reason) {
    throw new SubscriptionError(
      `next bill date ${input.newNextBillOn} skips unbilled service from ${boundary} to ${input.newNextBillOn} — ` +
        `repeat with skipUnbilledService and a skip reason to skip that window explicitly`,
    );
  }
  return { nextBillOn: input.newNextBillOn, skippedWindow: { from: boundary, to: input.newNextBillOn } };
}

/** Normalize a subscription's charge to a monthly figure (analytics only). */
export function monthlyRecurringRevenue(
  amount: string,
  interval: Interval,
  intervalCount: number,
  quantity: string,
): string {
  const cadence = normalizeSubscriptionCadence(interval, intervalCount);
  const normalizedAmount = normalizeSubscriptionMoney(amount, "amount", "nonnegative");
  const normalizedQuantity = normalizeSubscriptionMoney(quantity, "quantity", "positive");
  const perPeriod = mul(normalizedAmount, normalizedQuantity);
  const count = BigInt(cadence.intervalCount);
  if (cadence.interval === "weekly") return mulRatio(perPeriod, 52n, 12n * count);
  const months = cadence.interval === "monthly" ? 1n : cadence.interval === "quarterly" ? 3n : 12n;
  return mulRatio(perPeriod, 1n, months * count);
}

async function nextNumber(orgId: string, kind: string, prefix: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, kind, prefix);
}

/**
 * Posting deps with ar/ap/bank fail-closed: an org missing control accounts
 * refuses to post (ControlAccountsIncompleteError) instead of letting undefined
 * account ids reach the kernel. Auto-post failures surface through the billing
 * runner's existing per-subscription failure path.
 */
async function controlDeps(orgId: string): Promise<PostingDeps> {
  return { control: await loadRequiredControlAccounts(orgId) };
}
type SubRow = {
  id: string;
  orgId: string;
  customerId: string;
  /** Per-subscription bill-to/payer overrides (null = hierarchy or self). */
  billToOverride: string | null;
  payerOverride: string | null;
  quantity: string;
  priceOverride: string | null;
  autoPost: boolean;
  planName: string;
  planAmount: string;
  /**
   * The currency invoices post in: the pinned plan version's currency when
   * the subscription has an advanced lifecycle (falling back to the base
   * plan only when the version carries none), else the base plan's.
   */
  planCurrency: string | null;
  incomeAccountId: string | null;
  itemId: string | null;
  taxCodeId: string | null;
  interval: Interval;
  intervalCount: number;
  /**
   * The customer's own legal entity when it resolves to an active subsidiary
   * of this organization; null when the customer carries no entity or its
   * entity cannot be trusted (see resolveBillingSubsidiary).
   */
  trustedSubsidiaryId: string | null;
  /** The customer's raw entity assignment (parties.subsidiary_id). */
  customerSubsidiaryId: string | null;
  /** The org root, used only for org-wide (entity-less) customers. */
  rootSubsidiaryId: string | null;
  baseCurrency: string;
  nextBillOn: string;
  currentPeriodStart: string | null;
  /** Stored anchor day, else the start date's day (see SUB_SELECT). */
  anchorDay: number;
};

/**
 * Exact prorated amount of `fullAmount` for the slice [asOf, periodEnd] of the
 * period [periodStart, periodEnd] — full × remainingDays / totalDays, rounded to
 * ledger precision. Pure — unit-tested. Zero when the period is degenerate.
 */
export function prorate(fullAmount: string, periodStart: string, periodEnd: string, asOf: string): string {
  const total = calendarDaysBetween(periodStart, periodEnd);
  if (total <= 0) return "0.0000";
  const remaining = Math.max(0, Math.min(total, calendarDaysBetween(asOf, periodEnd)));
  return mulRatio(fullAmount, BigInt(remaining), BigInt(total));
}

/**
 * Map a signed proration adjustment to the native AR document it must become:
 * an upgrade charge stays a customer_invoice at its own sign; a downgrade must
 * NEVER persist a negative invoice — credit memos are their own document kind,
 * posted as DR income / CR AR off a positive total (every AR surface flips the
 * sign by kind), so a negative adjustment becomes a customer_credit carrying
 * the absolute amount. Zero stays an invoice; callers skip zero anyway.
 * Pure — unit-tested.
 */
export function prorationDocument(adjustment: string): { kind: "customer_invoice" | "customer_credit"; amount: string } {
  return toUnits(adjustment) < 0n
    ? { kind: "customer_credit", amount: neg(adjustment) }
    : { kind: "customer_invoice", amount: normalizeMoney(adjustment) };
}

async function resolveIncomeAccount(orgId: string, incomeAccountId: string | null): Promise<string> {
  if (!incomeAccountId) {
    throw new SubscriptionError("Configure the income account on the billing plan or charge component before creating an invoice");
  }
  // The generator pins one tenant transaction, retaining this lock through
  // invoice creation and optional posting. Explicit non-income accounts remain
  // valid for configured deferral/other accounting policies.
  const account = (await db.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and id = ${incomeAccountId}
      and is_active and not is_summary for share
  `)).rows[0];
  if (!account) {
    throw new SubscriptionError("The configured billing income account must be an active, non-summary account in this organization");
  }
  return account.id;
}

export interface InvoiceSpec {
  orgId: string;
  /**
   * The authenticated caller, or null for engine-initiated writes — the
   * repository-wide system identity (null created_by means system). Callers
   * stamp their own provenance into `custom`.
   */
  actorId: string | null;
  customerId: string;
  subsidiaryId: string | null;
  currency: string;
  incomeAccountId: string | null;
  itemId: string | null;
  taxCodeId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  memo: string;
  invoiceDate: string;
  dueDate?: string | null;
  locationId?: string | null;
  autoPost: boolean;
  /** When false, tax is skipped even if a tax code is present (proration credits). */
  applyTax?: boolean;
  /** Advanced lifecycle supplies an immutable component snapshot. */
  lines?: AdvancedBillingLine[];
  /** Source-owned provenance retained on the native invoice header. */
  custom?: Record<string, unknown>;
  /**
   * When this spec auto-posts, records the posting's transaction-audit source
   * (audit_log.changes.source / request_id) alongside `actorId`, so automated
   * postings carry the same durable evidence interactive ones do.
   */
  postingAuditSource?: string;
  /** Property CAM true-ups may issue a native customer credit. */
  documentKind?: "customer_invoice" | "customer_credit";
  /**
   * The service-to party stamped on every line (the child the line is for).
   * Null writes a null service party (the line is for the header party).
   */
  servicePartyId?: string | null;
  /**
   * The lines' legal entity when it differs from the header subsidiary
   * (cross-entity consolidated billing). Null defaults to the header.
   */
  lineSubsidiaryId?: string | null;
  /** The bill-to recipient recorded on the header for delivery and display. */
  billToPartyId?: string | null;
  /**
   * When set, the invoice is a consolidation-eligible draft: it stays draft
   * and is marked pending for the group's run instead of posting.
   */
  consolidation?: { groupId: string; periodStart: string; periodEnd: string } | null;
}

/**
 * Who a subscription billing write is attributed to. A subscription is never
 * an actor: interactive paths pass the authenticated caller's user id, and
 * engine-initiated runs pass explicit null — the repository-wide system
 * identity (null actor columns mean system) — while `source` records, durably
 * on the invoice header and in the posting audit, which path cut the invoice.
 */
export interface SubscriptionBillingActor {
  actorId: string | null;
  source: "scheduler" | "bill_now" | "change_proration" | "first_proration" | "catch_up";
}

/** Actor options for the public entry points; omitted actor means system. */
export interface SubscriptionBillingActorOptions {
  actorId?: string | null;
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
}

/** Transaction-audit source (audit_log.changes.source / request_id) per path. */
const POSTING_AUDIT_SOURCES: Record<SubscriptionBillingActor["source"], string> = {
  scheduler: "subscription_billing_schedule",
  bill_now: "subscription_bill_now",
  change_proration: "subscription_change_proration",
  first_proration: "subscription_first_proration",
  catch_up: "subscription_catch_up",
};

/** Why the engine itself acted, recorded next to the explicit system marker. */
const SYSTEM_ACTOR_REASONS: Record<SubscriptionBillingActor["source"], string> = {
  scheduler: "subscription billing schedule",
  bill_now: "subscription bill-now billing",
  change_proration: "subscription change proration",
  first_proration: "subscription first-period proration",
  catch_up: "subscription catch-up run",
};

/** Durable invoice-header provenance: the path, the subscription, and — for an
 *  engine-initiated write — the explicit system-actor markers. */
function subscriptionBillingProvenance(
  subscriptionId: string,
  actor: SubscriptionBillingActor,
  occurrenceOn?: string,
): Record<string, unknown> {
  return {
    subscriptionBillingRunSource: actor.source,
    subscriptionId,
    ...(occurrenceOn === undefined ? {} : { occurrenceOn }),
    ...(actor.actorId === null
      ? { actorKind: "system", actorReason: SYSTEM_ACTOR_REASONS[actor.source] }
      : {}),
  };
}

/**
 * Create a customer invoice or credit for a subscription charge. Subscriptions
 * without lifecycle configuration supply scalar fields and remain one line;
 * lifecycle-managed subscriptions supply
 * the effective-dated component snapshot and receive an itemized invoice.
 */
export async function createSubscriptionInvoice(
  spec: InvoiceSpec,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; total: string }> {
  // Reuse an existing tenant transaction (subscription/property billing), and
  // give direct callers the same atomic account validation + numbering + write
  // boundary. withOrg refuses switching tenants inside an active transaction.
  return withOrg(spec.orgId, () => createSubscriptionInvoiceInTransaction(spec));
}

async function createSubscriptionInvoiceInTransaction(
  spec: InvoiceSpec,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; total: string }> {
  const invoiceLines: AdvancedBillingLine[] = spec.lines?.length ? spec.lines : [{
    description: spec.description,
    quantity: spec.quantity,
    unitPrice: spec.unitPrice,
    incomeAccountId: spec.incomeAccountId,
    itemId: spec.itemId,
    taxCodeId: spec.taxCodeId,
  }];
  // Stored subscriptions and existing invoices stay. Turning Inventory off
  // must refuse a generate that would persist inventory / assembly / kit.
  if (!(await inventoryFeatureEnabled(db, spec.orgId))) {
    const itemIds = [...new Set(
      invoiceLines.map((line) => line.itemId).filter((itemId): itemId is string => Boolean(itemId)),
    )];
    for (const itemId of itemIds) {
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${itemId} and org_id = ${spec.orgId}`));
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        throw new SubscriptionError("Inventory is disabled", 404);
      }
    }
  }
  // Stored subscriptions and existing invoices stay. Turning Equipment off
  // must refuse a generate that would persist equipment_charge.
  // Canonical switchboard read (::boolean casts threw on non-boolean imports).
  const equipmentOn = await orgFeatureEnabled(spec.orgId, "equipment");
  if (!equipmentOn) {
    const itemIds = [...new Set(
      invoiceLines.map((line) => line.itemId).filter((itemId): itemId is string => Boolean(itemId)),
    )];
    for (const itemId of itemIds) {
      const item = (await db.execute<{ kind: string }>(sql`
        select kind from items where id = ${itemId} and org_id = ${spec.orgId}`));
      if (item.rows[0] && item.rows[0].kind === "equipment_charge") {
        throw new SubscriptionError("Equipment is disabled", 404);
      }
    }
  }
  let netAmount = "0.0000";
  let taxTotal = "0.0000";
  const prepared: Array<{
    input: AdvancedBillingLine;
    amount: string;
    taxInputAmount: string | null;
    taxAmount: string;
    accountId: string;
    taxComponents: Awaited<ReturnType<typeof computeLineTaxes>>["components"];
  }> = [];
  for (const input of invoiceLines) {
    const carriesRatedAmount = input.amount !== undefined;
    const quantity = carriesRatedAmount
      ? persistRatedQuantity(input.quantity)
      : persistSubscriptionMoney(input.quantity, "quantity", "positive");
    const unitPrice = carriesRatedAmount
      ? persistRatedUnitPrice(input.unitPrice)
      : persistSubscriptionMoney(input.unitPrice, "unit price", "nonnegative");
    const exactAmount = carriesRatedAmount ? canonicalDecimal(input.amount, 4) : null;
    if (carriesRatedAmount && exactAmount === null) {
      throw new SubscriptionError("rated invoice amount must be an exact money amount");
    }
    const amount = carriesRatedAmount ? normalizeMoney(exactAmount!) : mul(quantity, unitPrice);
    if (carriesRatedAmount && (compareDecimal(amount, "0") < 0 || toUnits(amount) > POSTGRES_MONEY_MAX_UNITS)) {
      throw new SubscriptionError("rated invoice amount is outside the supported nonnegative numeric(19,4) range");
    }
    if (carriesRatedAmount && compareDecimal(amount, mulDecimalFactors("1", [unitPrice, quantity])) !== 0) {
      throw new SubscriptionError("rated invoice amount does not reproduce from its quantity and unit price");
    }
    const applyTax = spec.applyTax !== false && input.taxCodeId && toUnits(amount) > 0n;
    let lineTax = "0.0000";
    // The line's net (revenue) amount. A price-includes-tax code carves the
    // tax out of the charged amount, so the stored line amount is the net
    // and the charged amount is kept as the tax input, exactly as recurring
    // documents and entered invoices store inclusive lines.
    let lineAmount = amount;
    let taxInputAmount: string | null = null;
    let taxComponents: Awaited<ReturnType<typeof computeLineTaxes>>["components"] = [];
    if (applyTax) {
      const taxCodeId = input.taxCodeId!;
      const cfg = await loadTaxComponentConfig(spec.orgId, taxCodeId, spec.invoiceDate);
      if (!cfg.length) {
        // An inactive or missing code resolves to no config row, which is
        // distinct from a configured statutory zero rate. Fail closed before
        // any document/line/evidence write rather than invoicing taxed work
        // as 0% tax. An active code with no rate on the invoice date already
        // refuses inside loadTaxComponentConfig; that refusal is preserved.
        const meta = (await db.execute<{ code: string; isActive: boolean }>(sql`
          select code, is_active as "isActive" from tax_codes
           where id = ${taxCodeId} and org_id = ${spec.orgId}`)).rows[0];
        if (meta && !meta.isActive) {
          throw new SubscriptionError(
            `tax code ${meta.code} is inactive on ${spec.invoiceDate}; refusing to invoice it as 0% tax — ` +
            `reactivate the tax code under Company Settings or point the billing plan/charge at a live tax code before generating`,
          );
        }
        throw new SubscriptionError(
          `tax code ${meta?.code ?? taxCodeId} is not configured in this organization on ${spec.invoiceDate}; ` +
          `refusing to invoice it as 0% tax — point the billing plan/charge at a live tax code before generating`,
        );
      }
      const res = computeLineTaxes(amount, cfg, {});
      lineAmount = res.netAmount;
      taxInputAmount = res.inputAmount;
      lineTax = res.taxTotal;
      taxComponents = res.components;
    }
    netAmount = add(netAmount, lineAmount);
    taxTotal = add(taxTotal, lineTax);
    prepared.push({ input: { ...input, quantity, unitPrice }, amount: lineAmount, taxInputAmount, taxAmount: lineTax, accountId: await resolveIncomeAccount(spec.orgId, input.incomeAccountId), taxComponents });
  }
  const total = add(netAmount, taxTotal);

  const kind = spec.documentKind ?? "customer_invoice";
  const documentNumber = await nextNumber(spec.orgId, kind, kind === "customer_credit" ? "CM-" : "INV-");
  // A consolidation-eligible charge collects as a pending draft for the
  // group's run: it never auto-posts standalone, and the run supersedes it
  // with links instead of deleting it. The bill-to recipient rides the
  // header for delivery and display; AR follows the header party (payer).
  const headerCustom: Record<string, unknown> = { ...(spec.custom ?? {}) };
  if (spec.billToPartyId && spec.billToPartyId !== spec.customerId) {
    headerCustom.billToPartyId = spec.billToPartyId;
  }
  if (spec.consolidation) {
    headerCustom.consolidationGroupId = spec.consolidation.groupId;
    headerCustom.consolidationPeriodStart = spec.consolidation.periodStart;
    headerCustom.consolidationPeriodEnd = spec.consolidation.periodEnd;
    headerCustom.consolidationStatus = "pending_consolidation";
  }
  const created = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, party_id, document_date, due_date, currency, status,
                           subsidiary_id, location_id, memo, subtotal, tax_total, total, custom, created_by)
    values (${spec.orgId}, ${kind}, ${documentNumber}, ${spec.customerId}, ${spec.invoiceDate}, ${spec.dueDate ?? null},
            ${spec.currency}, 'draft', ${spec.subsidiaryId}, ${spec.locationId ?? null}, ${spec.memo}, ${netAmount}, ${taxTotal}, ${total},
            ${JSON.stringify(headerCustom)}::jsonb, ${spec.actorId})
    returning id
  `));
  const invoiceId = created.rows[0]!.id;

  for (const [index, preparedLine] of prepared.entries()) {
    // The line-level subledger entity is the service party: a service-entity
    // leg posts against the child that earned it, so the kernel's per-leg
    // party check passes and per-entity books stay attributable. AR still
    // follows the header party (payer).
    const linePartyId = spec.servicePartyId ?? null;
    const line = await db.execute<{ id: string }>(sql`
      insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity,
            unit_price, amount, tax_code_id, tax_input_amount, tax_amount, subsidiary_id, party_id, service_party_id, custom, is_billable, created_by)
      values (${spec.orgId}, ${invoiceId}, ${index + 1}, ${preparedLine.input.itemId}, ${preparedLine.accountId},
            ${preparedLine.input.description}, ${preparedLine.input.quantity}, ${preparedLine.input.unitPrice},
            ${preparedLine.amount}, ${preparedLine.input.taxCodeId}, ${preparedLine.taxInputAmount}, ${preparedLine.taxAmount},
            ${preparedLine.input.subsidiaryId ?? spec.lineSubsidiaryId ?? null},
            ${linePartyId},
            ${linePartyId},
            ${JSON.stringify(preparedLine.input.custom ?? {})}::jsonb, true, ${spec.actorId})
      returning id
    `);
    if (preparedLine.taxComponents.length) {
      await persistLineTaxComponents(spec.orgId, line.rows[0]!.id, preparedLine.taxComponents, spec.actorId);
    }
  }

  let posted = false;
  if (spec.autoPost && !spec.consolidation) {
    const submission = await submitAndReleaseIfUngated(
      kind,
      invoiceId,
      spec.actorId,
    );
    if (submission.flowError) {
      throw new SubscriptionError(`approval could not be routed: ${submission.flowError}`);
    }
    if (!submission.gated) {
      await postDocument(invoiceId, await controlDeps(spec.orgId), spec.postingAuditSource
        ? { audit: { actorId: spec.actorId, source: spec.postingAuditSource } }
        : {});
      posted = true;
    }
  }
  return { invoiceId, documentNumber, posted, total };
}

export type SubscriptionLineTaxSource = "plan" | "party" | "item";

/**
 * The sales-tax code for a plain plan-generated subscription line. The
 * plan's own code is the explicit subscription term and wins when usable;
 * otherwise the native line-default resolution applies (the payer's default
 * tax code first, then the item's), usability-checked against active codes.
 * A named-but-unusable code anywhere in that chain refuses explicitly —
 * tax that applies but cannot be resolved must never invoice as silent
 * zero. No code named at any level resolves to null, which legitimately
 * invoices untaxed. Advanced contract lines keep their own component codes
 * and never pass through here.
 */
export async function resolveSubscriptionLineTax(
  runner: SqlExecutor,
  orgId: string,
  input: { planTaxCodeId: string | null; customerId: string; itemId: string | null },
): Promise<{ taxCodeId: string | null; source: SubscriptionLineTaxSource | null }> {
  if (input.planTaxCodeId) {
    const usable = (await runner.execute<{ id: string }>(sql`
      select id from tax_codes where id = ${input.planTaxCodeId} and org_id = ${orgId} and is_active`)).rows[0];
    if (!usable) {
      throw new SubscriptionError(
        "the billing plan names a tax code that is not active in this organization; " +
        "reactivate it under Company Settings or clear the plan's tax code before billing",
      );
    }
    return { taxCodeId: input.planTaxCodeId, source: "plan" };
  }
  const resolved = (await resolveDocumentLineDefaults(runner, orgId, {
    kind: "customer_invoice",
    partyId: input.customerId,
    itemIds: input.itemId ? [input.itemId] : [],
  }))[0];
  if (resolved?.taxCodeId) return { taxCodeId: resolved.taxCodeId, source: resolved.taxSource };
  if (!input.itemId) {
    // The native helper resolves through named items, so an item-less line
    // checks the payer default directly — same precedence, same usability
    // bar. A named-but-unusable payer code falls through to the explicit
    // refusal below, never to silent zero.
    const partyCode = (await runner.execute<{ tax_code_id: string | null }>(sql`
      select tax_code_id from customer_roles
       where org_id = ${orgId} and party_id = ${input.customerId} and is_active`)).rows[0]?.tax_code_id ?? null;
    if (partyCode) {
      const usable = (await runner.execute<{ id: string }>(sql`
        select id from tax_codes where id = ${partyCode} and org_id = ${orgId} and is_active`)).rows[0];
      if (usable) return { taxCodeId: partyCode, source: "party" };
    }
  }
  const named = (await runner.execute<{ named: boolean }>(sql`
    select (exists(select 1 from customer_roles
                    where org_id = ${orgId} and party_id = ${input.customerId} and tax_code_id is not null)
            or exists(select 1 from items
                       where org_id = ${orgId} and id = ${input.itemId} and tax_code_id is not null)) as named`)).rows[0]?.named === true;
  if (named) {
    throw new SubscriptionError(
      "the customer or item names tax that cannot be resolved to an active tax code in this organization; " +
      "correct the customer's default tax or the item's tax code before billing",
    );
  }
  return { taxCodeId: null, source: null };
}

async function billOne(
  sub: SubRow,
  invoiceDate: string,
  billingDate = invoiceDate,
  periodStartOverride?: string | null,
  actor: SubscriptionBillingActor = { actorId: null, source: "scheduler" },
  opts?: { autoPost?: boolean },
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; created: boolean }> {
  // Serialize every invoice attempt for one subscription. This makes the
  // period/revision lookup + document creation + guard insert one atomic claim;
  // a concurrent caller waits, then replays the committed invoice instead of
  // leaving an orphan duplicate document.
  await db.execute(sql`select id from subscriptions where id = ${sub.id} and org_id = ${sub.orgId} for update`);
  // Re-read status UNDER the lock: the caller's SubRow was loaded before the
  // lock and is stale — a subscription canceled (or vanished) between that
  // read and this claim must refuse instead of cutting a new invoice.
  const live = (await db.execute<{ status: string }>(sql`
    select status from subscriptions where id = ${sub.id} and org_id = ${sub.orgId}
  `)).rows[0];
  if (!live) throw new SubscriptionError("subscription not found");
  if (live.status === "canceled") {
    throw new SubscriptionError("subscription is canceled — set its status back to active before billing");
  }
  const price = sub.priceOverride ?? sub.planAmount;
  const advanced = await advancedBillingSnapshot(sub.orgId, sub.id, billingDate, periodStartOverride);
  if (advanced && !advanced.lines.length) throw new SubscriptionError("subscription has no billable components for this period");
  // ONE occurrence key per billed invoice, lifecycle-managed or not, recorded
  // through the same subscription_period_invoices guard (single source of
  // truth). Advanced lifecycles use their frozen period window + contract
  // revision; plain plan-based subs derive the same shape deterministically
  // from the occurrence itself — the service period that starts on the billed
  // date, at revision 1 (plain plans have no amendments). Without this, a tick
  // whose success bookkeeping failed after posting rolled its claim back and
  // the retry re-cut a second invoice for the same period.
  const guard = advanced
    ? { startsOn: advanced.periodStartsOn, endsOn: advanced.periodEndsOn, revision: advanced.contractRevision }
    : {
        startsOn: billingDate,
        endsOn: advanceSubscription(billingDate, sub.interval, sub.intervalCount, sub.anchorDay),
        revision: 1,
      };
  const prior = (await db.execute<{ invoiceId: string; documentNumber: string; status: string }>(sql`
    select d.id as "invoiceId", d.document_number as "documentNumber", d.status
      from subscription_period_invoices pi join documents d on d.id = pi.invoice_id and d.org_id = pi.org_id
     where pi.org_id = ${sub.orgId} and pi.subscription_id = ${sub.id}
       and pi.period_starts_on = ${guard.startsOn}
       and pi.period_ends_on = ${guard.endsOn} and pi.contract_revision = ${guard.revision}
     limit 1
  `));
  if (prior.rows[0]) return { invoiceId: prior.rows[0].invoiceId, documentNumber: prior.rows[0].documentNumber, posted: prior.rows[0].status === "posted", created: false };
  // The charge bills through the payer hierarchy on the billing date: the
  // header carries the payer (AR) and the billing entity, the lines carry
  // the service party (and the service entity across legal entities), and a
  // group-held charge collects as an unposted pending draft. Without a
  // relationship this resolves to the service customer itself, preserving
  // the historical header, entity and posting behaviour exactly.
  const target = await resolveSubscriptionBillingTarget(sub.orgId, sub.customerId, billingDate, {
    billToPartyId: sub.billToOverride,
    payerPartyId: sub.payerOverride,
  });
  // The plain plan line carries no tax of its own: resolve it through the
  // native defaults (plan, then payer, then item) so a taxable customer is
  // never invoiced at silent zero. Advanced contract lines keep the codes
  // their components declare.
  const lineTax = advanced?.lines?.length
    ? null
    : await resolveSubscriptionLineTax(db, sub.orgId, {
        planTaxCodeId: sub.taxCodeId,
        customerId: target.payerPartyId,
        itemId: sub.itemId,
      });
  const generated = await createSubscriptionInvoice({
    orgId: sub.orgId,
    actorId: actor.actorId,
    customerId: target.payerPartyId,
    subsidiaryId: target.headerSubsidiaryId,
    servicePartyId: target.servicePartyId,
    lineSubsidiaryId: target.lineSubsidiaryId,
    billToPartyId: target.billToPartyId,
    consolidation: target.consolidation,
    currency: sub.planCurrency ?? sub.baseCurrency,
    incomeAccountId: sub.incomeAccountId,
    itemId: sub.itemId,
    taxCodeId: lineTax?.taxCodeId ?? null,
    description: sub.planName,
    quantity: sub.quantity,
    unitPrice: price,
    memo: sub.planName,
    invoiceDate,
    autoPost: opts?.autoPost ?? sub.autoPost,
    lines: advanced?.lines,
    custom: subscriptionBillingProvenance(sub.id, actor, billingDate),
    postingAuditSource: POSTING_AUDIT_SOURCES[actor.source],
  });
  await db.execute(sql`
    insert into subscription_period_invoices
      (org_id, subscription_id, period_starts_on, period_ends_on, contract_revision, invoice_id, created_by, updated_by)
    values (${sub.orgId}, ${sub.id}, ${guard.startsOn}, ${guard.endsOn},
            ${guard.revision}, ${generated.invoiceId}, ${actor.actorId}, ${actor.actorId})
  `);
  return { ...generated, created: true };
}

const SUB_SELECT = sql`
  select s.id, s.org_id as "orgId", s.customer_id as "customerId",
         s.bill_to_party_id as "billToOverride", s.payer_party_id as "payerOverride", s.quantity,
         s.price_override as "priceOverride", s.auto_post as "autoPost",
         p.name as "planName", p.amount as "planAmount", coalesce(v.currency_code, p.currency_code) as "planCurrency",
         p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
         coalesce(v.interval, p.interval) as interval, coalesce(v.interval_count, p.interval_count) as "intervalCount",
         -- The invoice follows the customer entity (parties.subsidiary_id),
         -- the same boundary subscriptionScopeSql authorizes by; the org root
         -- below is only the null-customer (org-wide) fallback. Never select
         -- a caller-supplied entity: both legs are same-org lookups.
         (select sub.id from subsidiaries sub
           where sub.id = c.subsidiary_id and sub.org_id = s.org_id and sub.is_active) as "trustedSubsidiaryId",
         c.subsidiary_id as "customerSubsidiaryId",
         (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "rootSubsidiaryId",
         o.base_currency as "baseCurrency", s.next_bill_on as "nextBillOn", s.current_period_start as "currentPeriodStart",
         coalesce(s.anchor_day, extract(day from s.start_on)::int) as "anchorDay"
    from subscriptions s
    join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
    join parties c on c.id = s.customer_id and c.org_id = s.org_id
    left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
    left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
    join orgs o on o.id = s.org_id`;

export interface SubscriptionRunResult {
  billed: number;
  posted: number;
  failed: number;
}

/**
 * Surface one subscription's tick failure through last_error (the operator's
 * signal). Recording the failure must never itself abort the tick: if the
 * write fails, the failure is logged and the loop continues.
 */
async function recordSubscriptionTickFailure(orgId: string, subscriptionId: string, message: string): Promise<void> {
  try {
    await withOrgTransaction(orgId, async () => db.execute(sql`
      update subscriptions set last_error = ${message} where id = ${subscriptionId} and org_id = ${orgId}
    `));
  } catch (recordError) {
    console.error(`[subscriptions] failure recording failed for subscription ${subscriptionId}:`, recordError);
  }
}

/**
 * Bill every active subscription that is due as of `asOf` — but only for orgs
 * that have the subscriptionBilling feature on.
 */
export async function runDueSubscriptions(asOf?: string): Promise<SubscriptionRunResult> {
  // This is only a bounded cross-org candidate horizon. The exact due gate is
  // evaluated per tenant below; UTC+14 requires tomorrow's UTC date to be in
  // the candidate set even though tenants west of UTC may still be on today.
  const scanCutoff = asOf ?? addCalendarDays(toIso(now()), 1);
  const result: SubscriptionRunResult = { billed: 0, posted: 0, failed: 0 };
  const orgBusinessDates = new Map<string, string>();
  // Simulation (and other tenant-scoped callers) run this helper while an
  // ambient org context is active. Keep that context as a hard candidate
  // boundary even though the scheduler's unscoped invocation legitimately
  // scans every production tenant under bypass. Without this predicate, a SaaS
  // simulation on a shared database would bill unrelated live subscriptions.
  const scopedOrgId = orgContext.getStore()?.orgId;
  const orgScope = scopedOrgId ? sql`and s.org_id = ${scopedOrgId}` : sql``;

  // bypass: scheduler-tick — the unscoped scan finds due subscriptions across every production organization.
  const due = await withBypass(async () =>
    (await db.execute<{
      id: string;
      orgId: string;
      nextBillOn: string;
      currentPeriodStart: string | null;
      interval: Interval;
      intervalCount: number;
      quantity: string;
      priceOverride: string | null;
      planAmount: string;
      anchorDay: number;
    }>(sql`
      select s.id, s.org_id as "orgId", s.next_bill_on as "nextBillOn",
             s.current_period_start as "currentPeriodStart",
             s.quantity, s.price_override as "priceOverride", p.amount as "planAmount",
             coalesce(s.anchor_day, extract(day from s.start_on)::int) as "anchorDay",
             coalesce(v.interval, p.interval) as interval, coalesce(v.interval_count, p.interval_count) as "intervalCount"
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
        left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
        join orgs o on o.id = s.org_id
       where s.status = 'active' and s.next_bill_on <= ${scanCutoff}
         and o.env_kind = 'production'
         -- Registry fallback shape (non-boolean stored values fall back to the
         -- default instead of throwing 22P02); the explicit conjunction is
         -- the advancedSubscriptions requiresAll ['subscriptionBilling'] chain.
         and case (o.settings->'features'->>'subscriptionBilling') when 'true' then true when 'false' then false else false end
         and (l.id is null or case (o.settings->'features'->>'advancedSubscriptions') when 'true' then true when 'false' then false else false end)
         ${orgScope}
    `)),
  );

  // Orgs whose business day cannot be read (a misconfigured calendar) fail
  // per org, not per tick: their subscriptions surface the failure through
  // last_error and the loop continues with the next tenant.
  const orgDateFailures = new Map<string, string>();
  for (const row of due.rows) {
    let today = asOf ?? orgBusinessDates.get(row.orgId);
    if (!today) {
      const dateFailure = orgDateFailures.get(row.orgId);
      if (dateFailure !== undefined) {
        result.failed += 1;
        await recordSubscriptionTickFailure(row.orgId, row.id, `business day unavailable: ${dateFailure}`);
        continue;
      }
      try {
        today = await withOrg(row.orgId, () => businessToday(row.orgId));
        orgBusinessDates.set(row.orgId, today);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        orgDateFailures.set(row.orgId, message);
        console.error(`[subscriptions] org ${row.orgId} business day failed:`, e);
        result.failed += 1;
        await recordSubscriptionTickFailure(row.orgId, row.id, `business day unavailable: ${message}`);
        continue;
      }
    }
    if (row.nextBillOn > today) continue;

    let advanced: string;
    try {
      // Validate every stored base value before an advanced-lifecycle helper or
      // billing transaction can write. The same checks run again at invoice
      // persistence, so a bypassed or residual row cannot become a charge.
      normalizeSubscriptionMoney(row.quantity, "stored quantity", "positive");
      normalizeSubscriptionMoney(row.priceOverride ?? row.planAmount, "stored price", "nonnegative");
      // Month-end starts keep their anchor day (stored, else the start date's
      // day): Jan 31 steps Feb 28 → Mar 31, never Mar 28.
      advanced = advanceSubscription(row.nextBillOn, row.interval, row.intervalCount, row.anchorDay);
      const canBill = await prepareAdvancedSubscriptionBilling(row.orgId, row.id, row.nextBillOn);
      if (!canBill) {
        await withOrgTransaction(row.orgId, async () => db.execute(sql`
          update subscriptions set last_error = 'Contract term ended — renewal required' where id = ${row.id} and org_id = ${row.orgId}
        `));
        continue;
      }
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await recordSubscriptionTickFailure(row.orgId, row.id, message);
      continue;
    }
    // Claim the occurrence INSIDE the billing transaction: the tick that flips
    // next_bill_on off its current value and billOne's invoice commit
    // atomically, so no crash window can strand an advanced next_bill_on with
    // nothing billed — a killed process rolls back to "still due" and the next
    // tick retries. Only one tick can win the compare-and-swap: a concurrent
    // tick blocks on this row lock and, when the winner commits, re-evaluates
    // the WHERE against the advanced value and claims zero rows.
    let sub: { invoiceId: string; documentNumber: string; posted: boolean } | null = null;
    try {
      sub = await withOrg(row.orgId, async () => {
        const claimed = (await db.execute<{ id: string }>(sql`
          update subscriptions
             set next_bill_on = ${advanced}, current_period_start = ${row.nextBillOn}, last_billed_at = now()
           where id = ${row.id} and org_id = ${row.orgId} and next_bill_on = ${row.nextBillOn} and status = 'active'
          returning id
        `));
        if (!claimed.rows.length) return null; // another tick won it
        const r = (await db.execute<SubRow>(sql`${SUB_SELECT} where s.id = ${row.id} and s.org_id = ${row.orgId} limit 1`));
        const s = r.rows[0];
        if (!s) throw new SubscriptionError("subscription vanished");
        // Engine-initiated: explicit null (the repository system identity)
        // plus the scheduler source marker — never a row id, never a historic
        // creator.
        return billOne(s, row.nextBillOn, row.nextBillOn, row.currentPeriodStart, { actorId: null, source: "scheduler" });
      });
    } catch (e) {
      // Billing threw — withOrg already rolled the whole unit back, claim
      // included, so there is nothing to restore. A persistently failing
      // subscription stays due and retries every tick, surfacing through
      // last_error (the operator's signal — there is no failure counter in
      // the schema). That is preferable to silently losing the occurrence,
      // which is what a durable claim without an invoice would do.
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await recordSubscriptionTickFailure(row.orgId, row.id, message);
      continue;
    }
    if (!sub) continue; // another tick won it
    // Non-null alias for the bookkeeping block below: a mutable let's narrowing
    // does not survive into callbacks.
    const gen = sub;
    result.billed += 1;
    if (gen.posted) result.posted += 1;
    // Success bookkeeping deliberately lives OUTSIDE the catch above. By this
    // point billOne durably committed exactly one invoice for this period —
    // together with its subscription_period_invoices guard row — so a transient
    // bookkeeping failure must NOT roll the claim back: restoring next_bill_on
    // after a posted invoice is precisely how a tick used to double-bill.
    // Surface through last_error instead; the claim stays advanced. A replayed
    // period (a rewound cursor meeting its own guard row) keeps the original
    // run's count.
    if (!gen.created) continue;
    try {
      await withOrgTransaction(row.orgId, async () => {
        await db.execute(sql`
          update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_error = null
           where id = ${row.id} and org_id = ${row.orgId}
        `);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[subscriptions] success bookkeeping failed for subscription ${row.id}:`, message);
      await withOrgTransaction(row.orgId, async () => {
        await db.execute(sql`
          update subscriptions set last_error = ${`invoiced ${gen.documentNumber} but bookkeeping failed: ${message}`}
           where id = ${row.id} and org_id = ${row.orgId}
        `);
      });
    }
  }
  return result;
}

/**
 * Bill one subscription immediately (the "bill now" button) for its due
 * period, no date advance. The invoice carries the scheduled bill date —
 * never today — so a back-dated start bills each period on its own date and
 * a prior-period bill lands in the right fiscal year. `actor.actorId` is the
 * authenticated caller threading their identity through every audit surface
 * the invoice leaves; omitted means engine-initiated (system provenance) —
 * a subscription id is never accepted as an actor.
 */
export async function billSubscriptionNow(
  orgId: string,
  subscriptionId: string,
  actor: SubscriptionBillingActorOptions | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  const actorId = actor?.actorId ?? null;
  // Both flags use the registry fallback shape (non-boolean stored values
  // fall back to the default instead of throwing 22P02); the conjunction is
  // the advancedSubscriptions requiresAll ['subscriptionBilling'] chain.
  const meta = await withOrgContext(orgId, async () =>
    (await db.execute<{ advancedLifecycle: boolean; advancedEnabled: boolean }>(sql`
      select l.id is not null as "advancedLifecycle",
             (case (o.settings->'features'->>'advancedSubscriptions') when 'true' then true when 'false' then false else false end
              and case (o.settings->'features'->>'subscriptionBilling') when 'true' then true when 'false' then false else false end) as "advancedEnabled"
        from subscriptions s join orgs o on o.id = s.org_id
        left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
       where s.id = ${subscriptionId} and s.org_id = ${orgId}
    `)),
  );
  if (!meta.rows[0]) throw new SubscriptionError("subscription not found");
  if (meta.rows[0].advancedLifecycle && !meta.rows[0].advancedEnabled) throw new SubscriptionError("advanced subscription lifecycle is disabled");
  const gen = await withOrg(orgId, async () => {
    await lockSubscriptionCustomerForScope(db, orgId, subscriptionId, allowedSubsidiaryIds);
    const r = (await db.execute<SubRow>(sql`${SUB_SELECT} where s.id = ${subscriptionId} and s.org_id = ${orgId} limit 1`));
    const s = r.rows[0];
    if (!s) throw new SubscriptionError("subscription not found");
    return billOne(s, s.nextBillOn, s.nextBillOn, s.currentPeriodStart, { actorId, source: "bill_now" });
  });
  // A double-click replays the first invoice through billOne's guard row and
  // keeps its count; only a newly created invoice advances the counter.
  if (gen.created) {
    await withOrgTransaction(orgId, async () => {
      await db.execute(sql`
        update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId},
               last_billed_at = now(), last_error = null
         where id = ${subscriptionId} and org_id = ${orgId}
      `);
    });
  }
  return { invoiceId: gen.invoiceId, documentNumber: gen.documentNumber, posted: gen.posted };
}
export interface SubscriptionCatchUpPreview {
  periods: string[];
  truncated: boolean;
}

const SUBSCRIPTION_CATCH_UP_WALK_LIMIT = 1000;

/**
 * The full billing period starts from nextBillOn through asOf, stepping the
 * plan cadence — the one walk behind activation previews, resume gates, and
 * catch-up runs, so all three agree exactly. Caps at a thousand pending
 * periods with truncated set instead of walking forever.
 */
export function pendingSubscriptionPeriods(
  input: { interval: Interval; intervalCount: number; anchorDay: number | null; nextBillOn: string },
  asOf: string,
): SubscriptionCatchUpPreview {
  const periods: string[] = [];
  let date = input.nextBillOn;
  for (let i = 0; i < SUBSCRIPTION_CATCH_UP_WALK_LIMIT; i++) {
    if (date > asOf) return { periods, truncated: false };
    periods.push(date);
    date = advanceSubscription(date, input.interval, input.intervalCount, input.anchorDay);
  }
  return { periods, truncated: true };
}

/**
 * The full billing periods from nextBillOn through asOf, deterministic and
 * shared by the preview and the run: what the preview lists is exactly what
 * the run bills, drafts, or skips. Advanced lifecycles bill through contract
 * amendments, not stepped periods, so they refuse here with their remedy.
 */
export async function previewSubscriptionCatchUp(
  orgId: string,
  subscriptionId: string,
  asOf?: string,
): Promise<SubscriptionCatchUpPreview> {
  const row = await withOrg(orgId, () => loadSubRow(subscriptionId, orgId));
  if (row.advancedLifecycle) {
    throw new SubscriptionError("advanced lifecycles bill through contract amendments, not catch-up runs");
  }
  const today = asOf ?? (await businessToday(orgId));
  return pendingSubscriptionPeriods(
    { interval: row.interval, intervalCount: row.intervalCount, anchorDay: row.anchorDay, nextBillOn: row.nextBillOn },
    today,
  );
}

export type SubscriptionCatchUpMode = "post_all" | "drafts" | "skip" | "selected";

export interface SubscriptionCatchUpResultRow {
  periodStart: string;
  status: "posted" | "draft" | "skipped" | "replayed";
  invoiceId: string | null;
  documentNumber: string | null;
}

export interface SubscriptionCatchUpOutcome {
  results: SubscriptionCatchUpResultRow[];
  stopped: "caught_up" | "canceled" | "paused" | "suspended" | "failed";
  error?: string;
}

/**
 * Run a subscription's pending catch-up with an explicit choice, one full
 * period at a time through the same claim-and-bill unit the scheduler tick
 * uses — same dates, same guards, same replay. post_all posts every missed
 * period; drafts creates them unposted; skip advances past them without
 * generating; selected bills exactly the listed preview periods (posted
 * unless postSelected is false) and advances past every other pending
 * period with an explicit skipped outcome. Each invoice carries its
 * period's date, never today. The first failure stops the run with every
 * period's outcome explicit; retrying replays committed periods instead of
 * duplicating them. The outcome names where generation stopped and why —
 * caught up, the subscription's status, or the failure — so a run that
 * ends early is never silent.
 */
export async function runSubscriptionCatchUp(
  orgId: string,
  subscriptionId: string,
  input: {
    mode: SubscriptionCatchUpMode;
    /** Exact pending period starts to bill; required for the selected choice. */
    selectedPeriods?: string[];
    /** Post the selected periods (default) or create them as drafts. */
    postSelected?: boolean;
    asOf?: string;
    actorId: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<SubscriptionCatchUpOutcome> {
  // The selected choice names its periods up front: it needs at least one
  // calendar date, and dates outside it never reach billing — a stray list
  // on any other choice refuses instead of being silently ignored.
  const selectedList = [...new Set(input.selectedPeriods ?? [])];
  if (input.mode === "selected") {
    if (selectedList.length === 0) {
      throw new SubscriptionError("selected catch-up needs at least one period date — choose from the preview list");
    }
    for (const selected of selectedList) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(selected)) {
        throw new SubscriptionError(`selected catch-up period ${selected} is not a calendar date (YYYY-MM-DD)`);
      }
    }
  } else if (selectedList.length > 0) {
    throw new SubscriptionError("selected periods apply only to the selected catch-up choice");
  }
  const selectedSet = new Set(selectedList);
  const postSelected = input.postSelected ?? true;
  const asOf = input.asOf ?? (await businessToday(orgId));
  const results: SubscriptionCatchUpResultRow[] = [];
  const finish = (
    stopped: SubscriptionCatchUpOutcome["stopped"],
    error?: string,
  ): SubscriptionCatchUpOutcome => ({ results, stopped, ...(error ? { error } : {}) });
  let outcome: SubscriptionCatchUpOutcome | null = null;
  let selectedValidated = false;
  for (;;) {
    const row = await withOrg(orgId, async () => {
      await lockSubscriptionCustomerForScope(db, orgId, subscriptionId, input.allowedSubsidiaryIds);
      return loadSubRow(subscriptionId, orgId);
    });
    if (row.advancedLifecycle) {
      throw new SubscriptionError("advanced lifecycles bill through contract amendments, not catch-up runs");
    }
    if (row.status !== "active") {
      const stopped = row.status === "canceled" ? "canceled" : row.status === "suspended" ? "suspended" : "paused";
      outcome = finish(stopped);
      break;
    }
    // The selected periods must be pending billing periods from this run's
    // own preview: anything else refuses by name instead of billing a
    // period the operator never saw listed.
    if (input.mode === "selected" && !selectedValidated) {
      selectedValidated = true;
      const pendingSet = new Set(pendingSubscriptionPeriods(
        { interval: row.interval, intervalCount: row.intervalCount, anchorDay: row.anchorDay, nextBillOn: row.nextBillOn },
        asOf,
      ).periods);
      for (const selected of selectedList) {
        if (!pendingSet.has(selected)) {
          throw new SubscriptionError(`selected catch-up period ${selected} is not a pending billing period — choose from the preview list`);
        }
      }
    }
    if (row.nextBillOn > asOf) {
      outcome = finish("caught_up");
      break;
    }
    const periodStart = row.nextBillOn;
    const advanced = advanceSubscription(periodStart, row.interval, row.intervalCount, row.anchorDay);
    // Advancing past one period without billing: the skip-all choice and
    // every unlisted period of a selected run share this unit.
    const advancePast = async (): Promise<boolean> => {
      const moved = await withOrg(orgId, async () => (await db.execute<{ id: string }>(sql`
        update subscriptions
           set next_bill_on = ${advanced}, current_period_start = ${periodStart}, last_billed_at = now()
         where id = ${subscriptionId} and org_id = ${orgId} and next_bill_on = ${periodStart} and status = 'active'
        returning id
      `)));
      return moved.rows.length > 0;
    };
    const billThis =
      input.mode === "post_all" ||
      input.mode === "drafts" ||
      (input.mode === "selected" && selectedSet.has(periodStart));
    const postThis = input.mode === "post_all" || (input.mode === "selected" && postSelected);
    if (!billThis) {
      if (!(await advancePast())) continue; // another worker advanced it; recompute
      results.push({ periodStart, status: "skipped", invoiceId: null, documentNumber: null });
      continue;
    }
    // An already-billed period replays instead of billing again — the retry
    // path after a crash between billing and advancing, or a rewound
    // cursor — and the cursor still advances past it.
    const already = await withOrgContext(orgId, async () => (await db.execute<{ invoiceId: string; documentNumber: string }>(sql`
      select d.id as "invoiceId", d.document_number as "documentNumber"
        from subscription_period_invoices pi
        join documents d on d.id = pi.invoice_id and d.org_id = pi.org_id
       where pi.org_id = ${orgId} and pi.subscription_id = ${subscriptionId}
         and pi.period_starts_on = ${periodStart}
       order by d.created_at desc limit 1
    `)).rows[0]);
    if (already) {
      if (!(await advancePast())) continue; // another worker advanced it; recompute
      results.push({
        periodStart,
        status: "replayed",
        invoiceId: already.invoiceId,
        documentNumber: already.documentNumber,
      });
      continue;
    }
    try {
      const gen = await withOrg(orgId, async () => {
        const claimed = (await db.execute<{ id: string }>(sql`
          update subscriptions
             set next_bill_on = ${advanced}, current_period_start = ${periodStart}, last_billed_at = now()
           where id = ${subscriptionId} and org_id = ${orgId} and next_bill_on = ${periodStart} and status = 'active'
          returning id
        `));
        if (!claimed.rows.length) return null; // another worker won it
        const r = (await db.execute<SubRow>(sql`${SUB_SELECT} where s.id = ${subscriptionId} and s.org_id = ${orgId} limit 1`));
        const s = r.rows[0];
        if (!s) throw new SubscriptionError("subscription vanished");
        return billOne(s, periodStart, periodStart, periodStart, { actorId: input.actorId, source: "catch_up" }, {
          autoPost: postThis,
        });
      });
      if (!gen) {
        // Another worker won this period: replay whatever it committed.
        const replay = await withOrgContext(orgId, async () => (await db.execute<{ invoiceId: string; documentNumber: string; posted: boolean }>(sql`
          select d.id as "invoiceId", d.document_number as "documentNumber", (d.status = 'posted') as "posted"
            from subscription_period_invoices pi
            join documents d on d.id = pi.invoice_id and d.org_id = pi.org_id
           where pi.org_id = ${orgId} and pi.subscription_id = ${subscriptionId}
             and pi.period_starts_on = ${periodStart}
           order by d.created_at desc limit 1
        `)).rows[0]);
        results.push({
          periodStart,
          status: "replayed",
          invoiceId: replay?.invoiceId ?? null,
          documentNumber: replay?.documentNumber ?? null,
        });
        continue;
      }
      // A replayed race keeps the creator's count; only an invoice this run
      // created advances the counter.
      if (!gen.created) {
        results.push({
          periodStart,
          status: "replayed",
          invoiceId: gen.invoiceId,
          documentNumber: gen.documentNumber,
        });
        continue;
      }
      try {
        await withOrgTransaction(orgId, async () => {
          await db.execute(sql`
            update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_error = null
             where id = ${subscriptionId} and org_id = ${orgId}
          `);
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[subscriptions] success bookkeeping failed for subscription ${subscriptionId}:`, message);
        await recordSubscriptionTickFailure(orgId, subscriptionId, `invoiced ${gen.documentNumber} but bookkeeping failed: ${message}`);
      }
      results.push({
        periodStart,
        status: gen.posted ? "posted" : "draft",
        invoiceId: gen.invoiceId,
        documentNumber: gen.documentNumber,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await recordSubscriptionTickFailure(orgId, subscriptionId, message);
      outcome = finish("failed", message);
      break;
    }
  }
  // The choice itself is audited on the subscription with its per-period
  // outcomes: a bulk post-all or skip-all stays attributable after the run.
  // A no-op run (nothing pending) writes nothing.
  if (results.length > 0) {
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'subscriptions', ${subscriptionId}, 'update',
              ${JSON.stringify({ mode: "catch_up", choice: input.mode, results, stopped: outcome!.stopped, ...(outcome!.error ? { error: outcome!.error } : {}) })}::jsonb,
              ${input.actorId})
    `);
  }
  return outcome!;
}

type SubDetail = SubRow & {
  nextBillOn: string;
  currentPeriodStart: string | null;
  startOn: string;
  status: string;
  advancedLifecycle: boolean;
  lastInvoiceId: string | null;
  runCount: number;
};

/** Refuse a subscription id the caller's organization does not own. */
async function requireSubscriptionInOrg(orgId: string, subscriptionId: string): Promise<void> {
  const meta = await withOrgContext(orgId, async () =>
    (await db.execute<{ id: string }>(sql`select id from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`)),
  );
  if (!meta.rows[0]) throw new SubscriptionError("subscription not found");
}

/**
 * Read the full subscription detail. Must run inside the caller's org
 * transaction (see withOrg) — mutation paths call this after taking the
 * subscription row lock so they price from locked, current state.
 */
export async function loadSubRow(subscriptionId: string, orgId: string): Promise<SubDetail> {
  const r = (await db.execute<SubDetail>(sql`
    select s.id, s.org_id as "orgId", s.customer_id as "customerId",
           s.bill_to_party_id as "billToOverride", s.payer_party_id as "payerOverride", s.quantity,
           s.price_override as "priceOverride", s.auto_post as "autoPost",
           p.name as "planName", p.amount as "planAmount", coalesce(v.currency_code, p.currency_code) as "planCurrency",
           p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
           p.interval, p.interval_count as "intervalCount",
           -- Same customer-entity derivation as SUB_SELECT: the invoice
           -- follows parties.subsidiary_id; the root is only the org-wide
           -- (null customer entity) fallback.
           (select entity.id from subsidiaries entity
             where entity.id = c.subsidiary_id and entity.org_id = s.org_id and entity.is_active) as "trustedSubsidiaryId",
           c.subsidiary_id as "customerSubsidiaryId",
           (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "rootSubsidiaryId",
           o.base_currency as "baseCurrency", s.next_bill_on as "nextBillOn",
           s.current_period_start as "currentPeriodStart", s.start_on as "startOn", s.status,
           coalesce(s.anchor_day, extract(day from s.start_on)::int) as "anchorDay",
           s.last_invoice_id as "lastInvoiceId", s.run_count as "runCount",
           exists(select 1 from subscription_lifecycles l where l.subscription_id = s.id and l.org_id = s.org_id) as "advancedLifecycle"
      from subscriptions s
      join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
      join parties c on c.id = s.customer_id and c.org_id = s.org_id
      left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
      left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
      join orgs o on o.id = s.org_id
     where s.id = ${subscriptionId} and s.org_id = ${orgId} limit 1
  `));
  const d = r.rows[0];
  if (!d) throw new SubscriptionError("subscription not found");
  return d;
}

/**
 * Change a subscription's quantity and/or price mid-period and bill (or credit)
 * the prorated difference for the remaining days of the current period. The
 * proration line carries the plan/item tax policy exactly like a first-period
 * proration or a full invoice: a mid-cycle upgrade collects tax on the
 * remaining slice, and a downgrade credits it back. The next full invoice
 * uses the new quantity/price. The proration invoice is
 * attributed to `actor.actorId` (the authenticated caller; omitted means
 * engine-initiated system provenance) — never to the subscription itself.
 */
export async function changeSubscription(
  orgId: string,
  subscriptionId: string,
  changes: { quantity?: string; priceOverride?: string | null },
  asOf: string | undefined,
  actor: SubscriptionBillingActorOptions | undefined,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ invoiceId: string | null; documentNumber: string | null; adjustment: string }> {
  const actorId = actor?.actorId ?? null;
  await requireSubscriptionInOrg(orgId, subscriptionId);
  const today = asOf ?? (await businessToday(orgId));
  // Serialize the whole change (read → proration → invoice → subscription
  // update) on the subscription row lock, the same way billOne serializes
  // invoice attempts: two concurrent changes must not both price from the
  // same pre-change state and each cut a proration invoice (double billing).
  // One transaction also commits the invoice and the configuration change
  // together or not at all.
  return withOrg(orgId, async () => {
    await lockSubscriptionCustomerForScope(db, orgId, subscriptionId, allowedSubsidiaryIds);
    await db.execute(sql`select id from subscriptions where id = ${subscriptionId} and org_id = ${orgId} for update`);
    const row = await loadSubRow(subscriptionId, orgId);
    if (row.status === "canceled") throw new SubscriptionError("subscription is canceled");
    if (row.advancedLifecycle) throw new SubscriptionError("use an advanced contract amendment to change subscription components");

    const oldQty = row.quantity;
    const oldPrice = row.priceOverride ?? row.planAmount;
    const persistedOldQty = persistSubscriptionMoney(oldQty, "stored quantity", "positive");
    const persistedOldPrice = persistSubscriptionMoney(oldPrice, "stored price", "nonnegative");
    const newQty = persistSubscriptionMoney(changes.quantity ?? persistedOldQty, "quantity", "positive");
    const persistedPriceOverride = changes.priceOverride == null
      ? null
      : persistSubscriptionMoney(changes.priceOverride, "price override", "nonnegative");
    const newPrice = changes.priceOverride !== undefined
      ? (persistedPriceOverride ?? row.planAmount)
      : persistedOldPrice;
    const persistedNewPrice = persistSubscriptionMoney(newPrice, "price", "nonnegative");
    const oldFull = mul(persistedOldQty, persistedOldPrice);
    const newFull = mul(newQty, persistedNewPrice);

    const periodStart = row.currentPeriodStart ?? row.startOn;
    const periodEnd = row.nextBillOn;
    // Prorated value of each configuration for the remaining slice of the
    // period, at the full billing period's daily rate (a prorated first stub
    // is shorter than the period but billed at that same rate).
    const oldRemaining = remainingPeriodProration(oldFull, periodStart, periodEnd, today, row.interval, row.intervalCount, row.anchorDay);
    const newRemaining = remainingPeriodProration(newFull, periodStart, periodEnd, today, row.interval, row.intervalCount, row.anchorDay);
    const adjustment = add(newRemaining, neg(oldRemaining)); // >0 upgrade charge, <0 credit

    let invoiceId: string | null = null;
    let documentNumber: string | null = null;
    if (toUnits(adjustment) !== 0n) {
      const doc = prorationDocument(adjustment);
      const target = await resolveSubscriptionBillingTarget(orgId, row.customerId, today, {
        billToPartyId: row.billToOverride,
        payerPartyId: row.payerOverride,
      });
      const gen = await createSubscriptionInvoice({
        orgId,
        actorId,
        customerId: target.payerPartyId,
        subsidiaryId: target.headerSubsidiaryId,
        servicePartyId: target.servicePartyId,
        lineSubsidiaryId: target.lineSubsidiaryId,
        billToPartyId: target.billToPartyId,
        consolidation: target.consolidation,
        currency: row.planCurrency ?? row.baseCurrency,
        incomeAccountId: row.incomeAccountId,
        itemId: row.itemId,
        taxCodeId: row.taxCodeId,
        description: `Proration — plan change (${periodStart} → ${periodEnd})`,
        quantity: "1",
        unitPrice: doc.amount,
        memo: "Subscription proration",
        invoiceDate: today,
        autoPost: false,
        documentKind: doc.kind,
        custom: subscriptionBillingProvenance(subscriptionId, { actorId, source: "change_proration" }),
        postingAuditSource: POSTING_AUDIT_SOURCES.change_proration,
      });
      invoiceId = gen.invoiceId;
      documentNumber = gen.documentNumber;
    }

    await db.execute(sql`
      update subscriptions set quantity = ${newQty},
             price_override = ${changes.priceOverride !== undefined ? persistedPriceOverride : row.priceOverride},
             last_invoice_id = coalesce(${invoiceId}, last_invoice_id), updated_at = now()
       where id = ${subscriptionId} and org_id = ${orgId}
    `);
    return { invoiceId, documentNumber, adjustment };
  });
}

/**
 * Bill a prorated first invoice for the partial period [startOn, firstBillOn)
 * and set the subscription's period tracking. Used when a subscription starts
 * mid-period and the customer should pay only for the days used before the first
 * full cycle: the stub's share of the full billing period ending on
 * firstBillOn (see firstPeriodProration). Positive charge → taxed like a normal invoice. The invoice is
 * attributed to `actor.actorId` (the authenticated caller; omitted means
 * engine-initiated system provenance) — never to the subscription itself.
 */
export async function prorateFirstInvoice(
  orgId: string,
  subscriptionId: string,
  firstBillOn: string,
  asOf?: string,
  actor?: SubscriptionBillingActorOptions,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; amount: string }> {
  const actorId = actor?.actorId ?? null;
  await requireSubscriptionInOrg(orgId, subscriptionId);
  const today = asOf ?? (await businessToday(orgId));
  // Same single-transaction row lock as changeSubscription: a double-click
  // must not cut two prorated first invoices from the same pre-bill state.
  return withOrg(orgId, async () => {
    // A route may commit the subscription before requesting first proration.
    // Recheck its customer under the shared party lock in this transaction so
    // a rehome in that gap cannot authorize an invoice in another subsidiary.
    await lockSubscriptionCustomerForScope(
      db,
      orgId,
      subscriptionId,
      actor?.allowedSubsidiaryIds ?? null,
    );
    await db.execute(sql`select id from subscriptions where id = ${subscriptionId} and org_id = ${orgId} for update`);
    const row = await loadSubRow(subscriptionId, orgId);
    // loadSubRow reads under the row lock, so this status is current — a
    // canceled subscription must refuse instead of cutting a first invoice.
    if (row.status === "canceled") {
      throw new SubscriptionError("subscription is canceled — set its status back to active before billing");
    }
    // Single-fire: create inserts next_bill_on = firstBillOn and
    // current_period_start = startOn — the same two columns a successful
    // proration writes. The real post-proration evidence is the invoice
    // itself (run_count / last_invoice_id). A concurrent twin that waited
    // on the lock sees those after the winner commits and must not bill again.
    if (row.lastInvoiceId != null || Number(row.runCount) > 0) {
      throw new SubscriptionError("the first invoice has already been prorated");
    }
    const price = row.priceOverride ?? row.planAmount;
    const full = mul(row.quantity, price);
    // The stub [startOn, firstBillOn) is priced against the full billing
    // period that ends on firstBillOn, and the cycle is anchored on that
    // period so the scheduler's next advance from firstBillOn continues the
    // same cadence the stub was priced against.
    const anchorDay = row.interval === "weekly"
      ? row.anchorDay
      : cycleAnchorThrough(firstBillOn, row.interval, row.anchorDay);
    const amount = firstPeriodProration(full, row.startOn, firstBillOn, row.interval, row.intervalCount, anchorDay);
    if (toUnits(amount) <= 0n) throw new SubscriptionError("nothing to prorate for the first period");

    const target = await resolveSubscriptionBillingTarget(orgId, row.customerId, today, {
      billToPartyId: row.billToOverride,
      payerPartyId: row.payerOverride,
    });
    const gen = await createSubscriptionInvoice({
      orgId,
      actorId,
      customerId: target.payerPartyId,
      subsidiaryId: target.headerSubsidiaryId,
      servicePartyId: target.servicePartyId,
      lineSubsidiaryId: target.lineSubsidiaryId,
      billToPartyId: target.billToPartyId,
      consolidation: target.consolidation,
      currency: row.planCurrency ?? row.baseCurrency,
      incomeAccountId: row.incomeAccountId,
      itemId: row.itemId,
      taxCodeId: row.taxCodeId,
      description: `${row.planName} (prorated ${row.startOn} → ${firstBillOn})`,
      quantity: "1",
      unitPrice: amount,
      memo: row.planName,
      // The stub covers [startOn, firstBillOn): date it at its period start,
      // never today, so a back-dated activation bills its stub in-period.
      invoiceDate: row.startOn,
      autoPost: row.autoPost,
      custom: subscriptionBillingProvenance(subscriptionId, { actorId, source: "first_proration" }),
      postingAuditSource: POSTING_AUDIT_SOURCES.first_proration,
    });
    await db.execute(sql`
      update subscriptions set next_bill_on = ${firstBillOn}, current_period_start = ${row.startOn},
             anchor_day = ${anchorDay},
             run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_billed_at = now()
       where id = ${subscriptionId} and org_id = ${orgId}
    `);
    return { ...gen, amount };
  });
}
