import { canonicalDecimal, fixedDecimal } from "../money/exact-decimal.ts";
import { fromMinorUnits } from "../payments/acceptance.ts";
import { addMonthsClamped, endOfMonth } from "../platform/civil-date.ts";

/**
 * Billing-platform history import — the canonical model, provider adapters,
 * preflight and reconciliation.
 *
 * Companies arrive from Chargebee, Recurly, Maxio and Zuora with years of
 * subscription history the ERP syncs never carried (metered sync windows,
 * capped jobs, dropped usage). This module maps each platform's objects onto
 * one provider-neutral history — customers, plans, subscriptions with their
 * effective-dated change history, invoices, credit notes, payments, usage,
 * coupons and revenue schedules — so the import runner (billing-history-import.ts)
 * can persist them into native records idempotently and reconcile them.
 *
 * This is deliberately not a MigrationSource. That contract centers on
 * accounting periods and trial-balance parity for general ledgers; a billing
 * platform has no GL, so TB parity against it is meaningless, and forcing
 * period streams onto subscription payloads would be shape-fitting. The
 * reconciliation here is the billing equivalent: MRR by month, open AR by
 * customer and deferred revenue at cut-over.
 */

export const BILLING_HISTORY_PROVIDERS = ["chargebee", "recurly", "maxio", "zuora"] as const;
export type BillingHistoryProvider = (typeof BILLING_HISTORY_PROVIDERS)[number];

export function isBillingHistoryProvider(value: unknown): value is BillingHistoryProvider {
  return typeof value === "string" && (BILLING_HISTORY_PROVIDERS as readonly string[]).includes(value);
}

/** A refusal computed during mapping, preflight or reconciliation. It is always raised, never swallowed. */
export class BillingHistoryError extends Error {
  readonly code: string;
  readonly remedy: string;
  readonly status: 422 | 409;
  constructor(code: string, message: string, remedy: string, status: 422 | 409 = 422) {
    super(message);
    this.name = "BillingHistoryError";
    this.code = code;
    this.remedy = remedy;
    this.status = status;
  }
}

function refuse(code: string, message: string, remedy: string, status: 422 | 409 = 422): never {
  throw new BillingHistoryError(code, message, remedy, status);
}

// --- Canonical model ----------------------------------------------------------
// Money is exact major-unit decimal text (canonicalDecimal); dates are ISO
// YYYY-MM-DD. Adapters normalize every provider spelling into this shape so
// the runner, preflight and reconciliation never branch on a provider.

export interface CanonicalCustomer {
  externalId: string;
  name: string;
  email: string | null;
  currency: string | null;
  updatedAt: string | null;
}

export interface CanonicalPlan {
  externalId: string;
  name: string;
  /** Exact major-unit amount per billing period (e.g. "29.00"). */
  amountMajor: string;
  currency: string;
  interval: "weekly" | "monthly" | "quarterly" | "annually";
  intervalCount: number;
  updatedAt: string | null;
}

export type SubscriptionChangeKind =
  | "plan_change"
  | "quantity_change"
  | "pause"
  | "resume"
  | "cancel"
  | "renew"
  | "term_change";

export interface CanonicalSubscriptionChange {
  seq: number;
  effectiveOn: string;
  kind: SubscriptionChangeKind;
  planExternalId: string | null;
  quantity: string | null;
  /** Exact major-unit unit price when the change restates it. */
  unitAmountMajor: string | null;
  /** True when derived from invoice sequences rather than stated by the source. */
  derived: boolean;
}

export interface CanonicalSubscription {
  externalId: string;
  customerExternalId: string;
  planExternalId: string;
  quantity: string;
  unitAmountMajor: string | null;
  currency: string;
  status: "active" | "paused" | "canceled" | "trial";
  startOn: string;
  canceledOn: string | null;
  trialEndOn: string | null;
  currentTermEndOn: string | null;
  updatedAt: string | null;
  changes: CanonicalSubscriptionChange[];
}

export interface CanonicalInvoiceLine {
  description: string;
  quantity: string;
  unitPriceMajor: string;
  amountMajor: string;
  taxAmountMajor: string;
  planExternalId: string | null;
}

export interface CanonicalInvoice {
  externalId: string;
  number: string | null;
  customerExternalId: string;
  subscriptionExternalId: string | null;
  date: string;
  dueDate: string | null;
  currency: string;
  lines: CanonicalInvoiceLine[];
  taxTotalMajor: string;
  totalMajor: string;
  balanceMajor: string;
  status: "paid" | "open" | "void" | "past_due";
  updatedAt: string | null;
}

export interface CanonicalCreditNote {
  externalId: string;
  number: string | null;
  customerExternalId: string;
  invoiceExternalId: string | null;
  date: string;
  currency: string;
  totalMajor: string;
  balanceMajor: string;
  reason: string | null;
  updatedAt: string | null;
}

export interface CanonicalPaymentApplication {
  invoiceExternalId: string;
  amountMajor: string;
}

export interface CanonicalPayment {
  externalId: string;
  customerExternalId: string;
  date: string;
  currency: string;
  amountMajor: string;
  method: string | null;
  applications: CanonicalPaymentApplication[];
  updatedAt: string | null;
}

export interface CanonicalUsage {
  externalId: string;
  subscriptionExternalId: string;
  meterKey: string;
  quantityMajor: string;
  date: string;
  updatedAt: string | null;
}

export interface CanonicalCoupon {
  externalId: string;
  code: string;
  name: string;
  kind: "percent" | "amount";
  percentValue: string | null;
  amountMajor: string | null;
  currency: string | null;
  durationMonths: number | null;
  active: boolean;
  updatedAt: string | null;
}

export interface CanonicalRevenueSchedule {
  externalId: string;
  invoiceExternalId: string | null;
  subscriptionExternalId: string | null;
  periodStart: string;
  periodEnd: string;
  amountMajor: string;
  currency: string;
  recognized: boolean;
  updatedAt: string | null;
}

export interface CanonicalBillingHistory {
  customers: CanonicalCustomer[];
  plans: CanonicalPlan[];
  subscriptions: CanonicalSubscription[];
  invoices: CanonicalInvoice[];
  creditNotes: CanonicalCreditNote[];
  payments: CanonicalPayment[];
  usage: CanonicalUsage[];
  coupons: CanonicalCoupon[];
  revenueSchedules: CanonicalRevenueSchedule[];
}

export function emptyBillingHistory(): CanonicalBillingHistory {
  return {
    customers: [],
    plans: [],
    subscriptions: [],
    invoices: [],
    creditNotes: [],
    payments: [],
    usage: [],
    coupons: [],
    revenueSchedules: [],
  };
}

// --- Normalization helpers -----------------------------------------------------

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isoDay(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const day = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function epochToDay(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return isoDateOfEpoch(value);
}

function isoDateOfEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Exact major-unit decimal text from a provider amount.
 *
 * `denomination` states what the provider's contract says the value is:
 * Chargebee and Maxio state integer minor units (`*_in_cents` JSON numbers),
 * which convert exactly through the currency exponent; Recurly and Zuora
 * state major-unit decimals, which must already be exact spellings — a float
 * that crossed IEEE-754 is refused by name rather than stored as a number
 * nobody typed. The call site names the denomination so "29" can never drift
 * between twenty-nine dollars and twenty-nine cents.
 */
export function billingMajorAmount(
  value: unknown,
  currency: string,
  label: string,
  remedy: string,
  denomination: "minor" | "major",
): string {
  const code = currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    refuse("billing_history_currency_invalid", `Billing amount currency "${currency}" is not an ISO code.`, remedy);
  }
  if (denomination === "minor") {
    const source = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
    if (typeof source !== "string" || !/^\d+$/.test(source.trim())) {
      refuse(
        "billing_history_amount_invalid",
        `Billing ${label} must be a non-negative whole minor-unit amount.`,
        remedy,
      );
    }
    const major = canonicalDecimal(fromMinorUnits(BigInt(source.trim()), code), 4);
    if (major === null) {
      refuse(
        "billing_history_amount_precision",
        `Billing ${label} carries more precision than four decimals support.`,
        remedy,
      );
    }
    // Canonical amounts are fixed four-decimal spellings, so downstream
    // zero and equality checks compare text, never floats.
    return fixedDecimal(major, 4);
  }
  const source = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const exact = canonicalDecimal(source, 4);
  if (exact === null || exact.startsWith("-")) {
    refuse(
      "billing_history_amount_invalid",
      `Billing ${label} must be a non-negative amount with at most four decimals.`,
      remedy,
    );
  }
  return fixedDecimal(exact, 4);
}

function currencyOf(value: unknown, fallback: string | null): string | null {
  const code = text(value)?.trim().toUpperCase() ?? null;
  if (code && /^[A-Z]{3}$/.test(code)) return code;
  return fallback;
}

/** Exact 4-decimal add/sub on canonical major-unit spellings — bigint, never float. */
function majorToMinor4(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const padded = (fraction + "0000").slice(0, 4);
  const units = BigInt(whole === "" ? "0" : whole) * 10000n + BigInt(padded === "" ? "0" : padded);
  return negative ? -units : units;
}

function minor4ToMajor(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  return `${negative ? "-" : ""}${abs / 10000n}.${String(abs % 10000n).padStart(4, "0")}`;
}

function addMajor(left: string, right: string): string {
  return minor4ToMajor(majorToMinor4(left) + majorToMinor4(right));
}

function subtractMajor(left: string, right: string): string {
  return minor4ToMajor(majorToMinor4(left) - majorToMinor4(right));
}

/** Exact quantity spelling. Quantities are plain decimals, never minor units. */
export function billingQuantity(value: unknown, label: string, remedy: string): string {
  const source = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const canonical = canonicalDecimal(source, 4);
  if (canonical === null || canonical.startsWith("-")) {
    refuse("billing_history_quantity_invalid", `Billing ${label} must be a non-negative quantity.`, remedy);
  }
  return canonical;
}

/** Exact percent spelling (10 means ten percent) — percentages are never minor units. */
export function billingPercent(value: unknown, label: string, remedy: string): string {
  const source = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  const canonical = canonicalDecimal(source, 4);
  if (canonical === null || canonical.startsWith("-") || canonical === "0.0000" || canonical === "0") {
    refuse("billing_history_percent_invalid", `Billing ${label} must be a positive percent.`, remedy);
  }
  return canonical;
}

function planInterval(value: unknown): CanonicalPlan["interval"] {
  const raw = text(value)?.toLowerCase() ?? "";
  if (raw.includes("week")) return "weekly";
  if (raw.includes("quarter") || raw === "3 months" || raw === "3months") return "quarterly";
  if (raw.includes("year") || raw.includes("annual")) return "annually";
  return "monthly";
}

// --- Chargebee (API v2) --------------------------------------------------------
// Amounts are integer minor units; datetimes are epoch seconds. Change
// history is stated by the events API — the subscription snapshot alone
// cannot tell an upgrade from a first purchase.

const CHARGEBEE_EVENT_KINDS: Record<string, SubscriptionChangeKind> = {
  subscription_changed: "plan_change",
  subscription_renewed: "renew",
  subscription_cancelled: "cancel",
  subscription_reactivated: "resume",
  subscription_paused: "pause",
  subscription_resumed: "resume",
};

export function mapChargebeeCustomer(payload: JsonObject): CanonicalCustomer {
  const externalId = text(payload.id);
  if (!externalId) refuseChargebee("customer", "missing id", "Correct the customer in Chargebee and import again.");
  const first = text(payload.first_name) ?? "";
  const last = text(payload.last_name) ?? "";
  const company = text(payload.company);
  const name = `${first} ${last}`.trim() || company || externalId;
  return {
    externalId,
    name,
    email: text(payload.email),
    currency: currencyOf(payload.currency_code, null),
    updatedAt: epochToDay(payload.updated_at),
  };
}

function refuseChargebee(objectType: string, problem: string, remedy: string): never {
  refuse(
    "chargebee_object_invalid",
    `Chargebee ${objectType} is unusable: ${problem}.`,
    remedy,
  );
}

export function mapChargebeePlan(payload: JsonObject): CanonicalPlan {
  const externalId = text(payload.id);
  if (!externalId) refuseChargebee("plan", "missing id", "Correct the plan in Chargebee and import again.");
  const currency = currencyOf(payload.currency_code, null)
    ?? refuseChargebee("plan", `plan ${externalId} names no currency`, "Set a currency on the plan in Chargebee and import again.") as string;
  const unit = text(payload.period_unit)?.toLowerCase() ?? "month";
  const count = typeof payload.period === "number" && Number.isSafeInteger(payload.period) && payload.period > 0
    ? payload.period
    : 1;
  return {
    externalId,
    name: text(payload.name) ?? externalId,
    amountMajor: billingMajorAmount(payload.price ?? 0, currency, `plan ${externalId} price`, "Correct the plan price in Chargebee and import again.", "minor"),
    currency,
    interval: planInterval(unit),
    intervalCount: count,
    updatedAt: epochToDay(payload.updated_at),
  };
}

export function mapChargebeeSubscription(payload: JsonObject): CanonicalSubscription {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.customer_id);
  const planExternalId = text(payload.plan_id);
  if (!externalId || !customerExternalId || !planExternalId) {
    refuseChargebee("subscription", "missing id, customer or plan", "Correct the subscription in Chargebee and import again.");
  }
  const currency = currencyOf(payload.currency_code, null)
    ?? refuseChargebee("subscription", `subscription ${externalId} names no currency`, "Set a currency on the subscription in Chargebee and import again.") as string;
  const status = chargebeeSubscriptionStatus(text(payload.status));
  return {
    externalId,
    customerExternalId,
    planExternalId,
    quantity: String(typeof payload.plan_quantity === "number" && Number.isSafeInteger(payload.plan_quantity) && payload.plan_quantity > 0 ? payload.plan_quantity : 1),
    unitAmountMajor: payload.plan_unit_price == null ? null
      : billingMajorAmount(payload.plan_unit_price, currency, `subscription ${externalId} unit price`, "Correct the subscription price in Chargebee and import again.", "minor"),
    currency,
    status,
    startOn: epochToDay(payload.started_at ?? payload.created_at)
      ?? refuseChargebee("subscription", `subscription ${externalId} has no start date`, "Correct the subscription dates in Chargebee and import again.") as string,
    canceledOn: status === "canceled" ? (epochToDay(payload.cancelled_at) ?? epochToDay(payload.updated_at)) : null,
    trialEndOn: epochToDay(payload.trial_end),
    currentTermEndOn: epochToDay(payload.current_term_end),
    updatedAt: epochToDay(payload.updated_at),
    changes: [],
  };
}

function chargebeeSubscriptionStatus(status: string | null): CanonicalSubscription["status"] {
  switch (status) {
    case "active": return "active";
    case "in_trial": return "trial";
    case "paused": case "pause_scheduled": return "paused";
    case "cancelled": case "non_renewing": return "canceled";
    default: return "active";
  }
}

/** Stated change history from one Chargebee subscription event's embedded snapshot. */
export function mapChargebeeEvent(payload: JsonObject): CanonicalSubscriptionChange | null {
  const kind = CHARGEBEE_EVENT_KINDS[text(payload.event_type) ?? ""];
  if (!kind) return null;
  const occurred = epochToDay(payload.occurred_at);
  if (!occurred) return null;
  const content = record(payload.content);
  const snapshot = content ? record(content.subscription) : null;
  const seq = typeof payload.event_seq === "number" && Number.isSafeInteger(payload.event_seq) ? payload.event_seq : 0;
  return {
    seq,
    effectiveOn: occurred,
    kind,
    planExternalId: snapshot ? text(snapshot.plan_id) : null,
    quantity: snapshot && typeof snapshot.plan_quantity === "number" ? String(snapshot.plan_quantity) : null,
    unitAmountMajor: null,
    derived: false,
  };
}

export function mapChargebeeInvoice(payload: JsonObject): CanonicalInvoice {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.customer_id);
  if (!externalId || !customerExternalId) {
    refuseChargebee("invoice", "missing id or customer", "Correct the invoice in Chargebee and import again.");
  }
  const currency = currencyOf(payload.currency_code, null)
    ?? refuseChargebee("invoice", `invoice ${externalId} names no currency`, "Set a currency on the invoice in Chargebee and import again.") as string;
  const remedy = "Correct the invoice amounts in Chargebee and import again.";
  const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
  const date = epochToDay(payload.date)
    ?? refuseChargebee("invoice", `invoice ${externalId} has no date`, remedy) as string;
  const total = billingMajorAmount(payload.total ?? 0, currency, `invoice ${externalId} total`, remedy, "minor");
  const paid = billingMajorAmount(payload.amount_paid ?? 0, currency, `invoice ${externalId} paid amount`, remedy, "minor");
  const credited = billingMajorAmount(payload.credits_applied ?? 0, currency, `invoice ${externalId} credits`, remedy, "minor");
  const writtenOff = billingMajorAmount(payload.write_off_amount ?? 0, currency, `invoice ${externalId} write-off`, remedy, "minor");
  return {
    externalId,
    number: text(payload.number),
    customerExternalId,
    subscriptionExternalId: text(payload.subscription_id),
    date,
    dueDate: epochToDay(payload.due_date),
    currency,
    lines: lines.map((line) => mapChargebeeInvoiceLine(record(line) ?? {}, currency, externalId)),
    taxTotalMajor: billingMajorAmount(payload.tax ?? 0, currency, `invoice ${externalId} tax`, remedy, "minor"),
    totalMajor: total,
    balanceMajor: subtractMajor(subtractMajor(total, paid), addMajor(credited, writtenOff)),
    status: chargebeeInvoiceStatus(text(payload.status)),
    updatedAt: epochToDay(payload.updated_at),
  };
}

function mapChargebeeInvoiceLine(line: JsonObject, currency: string, invoiceId: string): CanonicalInvoiceLine {
  const remedy = `Correct invoice ${invoiceId} in Chargebee and import again.`;
  return {
    description: text(line.description) ?? text(line.entity_id) ?? invoiceId,
    quantity: String(typeof line.quantity === "number" && Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1),
    unitPriceMajor: billingMajorAmount(line.unit_amount ?? 0, currency, `invoice ${invoiceId} line price`, remedy, "minor"),
    amountMajor: billingMajorAmount(line.amount ?? 0, currency, `invoice ${invoiceId} line amount`, remedy, "minor"),
    taxAmountMajor: billingMajorAmount(line.tax_amount ?? 0, currency, `invoice ${invoiceId} line tax`, remedy, "minor"),
    planExternalId: text(line.entity_id),
  };
}

function chargebeeInvoiceStatus(status: string | null): CanonicalInvoice["status"] {
  switch (status) {
    case "paid": return "paid";
    case "voided": return "void";
    case "payment_due": case "pending": case "not_paid": return "past_due";
    default: return "open";
  }
}

export function mapChargebeeCreditNote(payload: JsonObject): CanonicalCreditNote {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.customer_id);
  if (!externalId || !customerExternalId) {
    refuseChargebee("credit note", "missing id or customer", "Correct the credit note in Chargebee and import again.");
  }
  const currency = currencyOf(payload.currency_code, null)
    ?? refuseChargebee("credit note", `credit note ${externalId} names no currency`, "Set a currency on the credit note in Chargebee and import again.") as string;
  const remedy = "Correct the credit note amounts in Chargebee and import again.";
  const total = billingMajorAmount(payload.total ?? 0, currency, `credit note ${externalId} total`, remedy, "minor");
  const adjusted = billingMajorAmount(payload.amount_adjusted ?? 0, currency, `credit note ${externalId} adjustments`, remedy, "minor");
  const refunded = billingMajorAmount(payload.amount_refunded ?? 0, currency, `credit note ${externalId} refunds`, remedy, "minor");
  return {
    externalId,
    number: text(payload.credit_note_number),
    customerExternalId,
    invoiceExternalId: text(payload.invoice_id),
    date: epochToDay(payload.date) ?? epochToDay(payload.updated_at) ?? "1970-01-01",
    currency,
    totalMajor: total,
    balanceMajor: subtractMajor(total, addMajor(adjusted, refunded)),
    reason: text(payload.reason_code),
    updatedAt: epochToDay(payload.updated_at),
  };
}

export function mapChargebeePayment(payload: JsonObject): CanonicalPayment | null {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.customer_id);
  if (!externalId || !customerExternalId) {
    refuseChargebee("transaction", "missing id or customer", "Correct the transaction in Chargebee and import again.");
  }
  // Only cash collections import as receipts; refunds ride their credit note
  // or invoice adjustment instead of a second payment row.
  if (text(payload.type) !== "payment") return null;
  const currency = currencyOf(payload.currency_code ?? payload.currency, null)
    ?? refuseChargebee("transaction", `transaction ${externalId} names no currency`, "Set a currency on the transaction in Chargebee and import again.") as string;
  const remedy = "Correct the transaction in Chargebee and import again.";
  const linked = Array.isArray(payload.linked_invoices) ? payload.linked_invoices : [];
  return {
    externalId,
    customerExternalId,
    date: epochToDay(payload.date) ?? epochToDay(payload.updated_at) ?? "1970-01-01",
    currency,
    amountMajor: billingMajorAmount(payload.amount ?? 0, currency, `transaction ${externalId} amount`, remedy, "minor"),
    method: text(payload.payment_method),
    applications: linked.map((link) => {
      const entry = record(link) ?? {};
      const invoiceId = text(entry.invoice_id);
      if (!invoiceId) refuseChargebee("transaction", `transaction ${externalId} links an unnamed invoice`, remedy);
      return {
        invoiceExternalId: invoiceId,
        amountMajor: billingMajorAmount(entry.applied_amount ?? 0, currency, `transaction ${externalId} application`, remedy, "minor"),
      };
    }),
    updatedAt: epochToDay(payload.updated_at),
  };
}

export function mapChargebeeCoupon(payload: JsonObject): CanonicalCoupon {
  const externalId = text(payload.id);
  const code = text(payload.id);
  if (!externalId || !code) refuseChargebee("coupon", "missing id", "Correct the coupon in Chargebee and import again.");
  const discountType = text(payload.discount_type);
  const currency = currencyOf(payload.currency_code, discountType === "fixed" ? null : "USD");
  if (discountType === "fixed" && !currency) {
    refuseChargebee("coupon", `coupon ${externalId} names no currency`, "Set a currency on the coupon in Chargebee and import again.");
  }
  return {
    externalId,
    code,
    name: text(payload.name) ?? code,
    kind: discountType === "percentage" ? "percent" : "amount",
    percentValue: discountType === "percentage"
      ? billingPercent(payload.discount_percentage, `coupon ${externalId} percent`, "Correct the coupon in Chargebee and import again.")
      : null,
    amountMajor: discountType === "fixed"
      ? billingMajorAmount(payload.discount_amount ?? 0, currency!, `coupon ${externalId} amount`, "Correct the coupon in Chargebee and import again.", "minor")
      : null,
    currency: discountType === "fixed" ? currency : null,
    durationMonths: text(payload.duration_type) === "limited_period" && typeof payload.duration_month === "number"
      ? payload.duration_month
      : null,
    active: text(payload.status) === "active",
    updatedAt: epochToDay(payload.updated_at),
  };
}

// --- Recurly (API v2021-02-25) ---------------------------------------------------
// Money is major-unit decimal text. The REST subscription snapshot carries no
// version history, so plan changes derive from consecutive invoices on
// different plans for one subscription (see deriveChangesFromInvoices) while
// pending changes and pauses map directly.

function refuseRecurly(objectType: string, problem: string, remedy: string): never {
  refuse("recurly_object_invalid", `Recurly ${objectType} is unusable: ${problem}.`, remedy);
}

export function mapRecurlyCustomer(payload: JsonObject): CanonicalCustomer {
  const account = record(payload.account) ?? payload;
  const externalId = text(payload.id) ?? text(account.id);
  if (!externalId) refuseRecurly("account", "missing id", "Correct the account in Recurly and import again.");
  const email = text(payload.email) ?? text(account.email);
  const company = text(payload.company) ?? text(account.company);
  const name = [text(payload.first_name) ?? text(account.first_name), text(payload.last_name) ?? text(account.last_name)]
    .filter((part): part is string => part !== null).join(" ").trim() || company || email || externalId;
  return {
    externalId,
    name,
    email,
    currency: currencyOf(payload.preferred_currency ?? account.preferred_currency, null),
    updatedAt: isoDay(payload.updated_at ?? account.updated_at),
  };
}

export function mapRecurlyPlan(payload: JsonObject): CanonicalPlan {
  const externalId = text(payload.code) ?? text(payload.id);
  if (!externalId) refuseRecurly("plan", "missing code", "Correct the plan in Recurly and import again.");
  const currencies = Array.isArray(payload.currencies) ? payload.currencies : [];
  const first = record(currencies[0]);
  const currency = first ? currencyOf(first.currency, null) : null;
  if (!currency || !first) {
    refuseRecurly("plan", `plan ${externalId} names no priced currency`, "Price the plan in a currency in Recurly and import again.");
  }
  const unit = text(payload.interval_unit) ?? "months";
  const length = typeof payload.interval_length === "number" && Number.isSafeInteger(payload.interval_length) && payload.interval_length > 0
    ? payload.interval_length
    : 1;
  return {
    externalId,
    name: text(payload.name) ?? externalId,
    amountMajor: billingMajorAmount(
      first.unit_amount ?? 0,
      currency!,
      `plan ${externalId} unit amount`,
      "Correct the plan price in Recurly and import again.",
      "major",
    ),
    currency: currency!,
    interval: planInterval(unit),
    intervalCount: length,
    updatedAt: isoDay(payload.updated_at),
  };
}

export function mapRecurlySubscription(payload: JsonObject): CanonicalSubscription {
  const externalId = text(payload.uuid) ?? text(payload.id);
  const account = record(payload.account);
  const plan = record(payload.plan);
  const customerExternalId = account ? (text(account.id) ?? text(account.code)) : null;
  const planExternalId = plan ? (text(plan.code) ?? text(plan.id)) : null;
  if (!externalId || !customerExternalId || !planExternalId) {
    refuseRecurly("subscription", "missing id, account or plan", "Correct the subscription in Recurly and import again.");
  }
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const remedy = "Correct the subscription in Recurly and import again.";
  const changes: CanonicalSubscriptionChange[] = [];
  const pending = record(payload.pending_change);
  if (pending) {
    changes.push({
      seq: 0,
      effectiveOn: isoDay(pending.activates_at) ?? isoDay(payload.updated_at) ?? "1970-01-01",
      kind: "plan_change",
      planExternalId: record(pending.plan) ? (text(record(pending.plan)!.code) ?? text(record(pending.plan)!.id)) : planExternalId,
      quantity: typeof pending.quantity === "number" ? String(pending.quantity) : null,
      unitAmountMajor: pending.unit_amount == null ? null : billingMajorAmount(pending.unit_amount, currency, `subscription ${externalId} pending price`, remedy, "major"),
      derived: false,
    });
  }
  return {
    externalId,
    customerExternalId,
    planExternalId,
    quantity: String(typeof payload.quantity === "number" && Number.isSafeInteger(payload.quantity) && payload.quantity > 0 ? payload.quantity : 1),
    unitAmountMajor: payload.unit_amount == null ? null : billingMajorAmount(payload.unit_amount, currency, `subscription ${externalId} unit price`, remedy, "major"),
    currency,
    status: recurlySubscriptionStatus(text(payload.state), text(payload.paused_at) !== null),
    startOn: isoDay(payload.current_term_started_at) ?? isoDay(payload.activated_at) ?? isoDay(payload.created_at)
      ?? refuseRecurly("subscription", `subscription ${externalId} has no start date`, remedy) as string,
    canceledOn: text(payload.state) === "canceled" ? (isoDay(payload.expires_at) ?? isoDay(payload.updated_at)) : null,
    trialEndOn: isoDay(payload.trial_ends_at),
    currentTermEndOn: isoDay(payload.current_term_ends_at),
    updatedAt: isoDay(payload.updated_at),
    changes,
  };
}

function recurlySubscriptionStatus(state: string | null, paused: boolean): CanonicalSubscription["status"] {
  if (paused) return "paused";
  switch (state) {
    case "active": return "active";
    case "trial": return "trial";
    case "canceled": case "expired": case "failed": return "canceled";
    default: return "active";
  }
}

export function mapRecurlyUsage(payload: JsonObject, subscriptionExternalId: string): CanonicalUsage {
  const externalId = text(payload.id);
  if (!externalId) refuseRecurly("usage record", "missing id", "Correct the usage record in Recurly and import again.");
  return {
    externalId,
    subscriptionExternalId,
    meterKey: text(payload.measured_unit_id) ?? text(payload.merchant_tag) ?? "usage",
    quantityMajor: billingQuantity(payload.quantity ?? 0, `usage ${externalId} quantity`, "Correct the usage quantity in Recurly and import again."),
    date: isoDay(payload.usage_timestamp) ?? isoDay(payload.recording_timestamp) ?? isoDay(payload.created_at) ?? "1970-01-01",
    updatedAt: isoDay(payload.updated_at),
  };
}

export function mapRecurlyInvoice(payload: JsonObject): CanonicalInvoice {
  const externalId = text(payload.id);
  const account = record(payload.account);
  const customerExternalId = account ? (text(account.id) ?? text(account.code)) : null;
  if (!externalId || !customerExternalId) {
    refuseRecurly("invoice", "missing id or account", "Correct the invoice in Recurly and import again.");
  }
  const remedy = "Correct the invoice amounts in Recurly and import again.";
  const totalRaw = text(payload.total) ?? "0";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const lines = Array.isArray(payload.line_items) ? payload.line_items : [];
  const date = isoDay(payload.created_at) ?? isoDay(payload.updated_at) ?? "1970-01-01";
  const total = billingMajorAmount(totalRaw, currency, `invoice ${externalId} total`, remedy, "major");
  const balance = billingMajorAmount(text(payload.balance) ?? "0", currency, `invoice ${externalId} balance`, remedy, "major");
  const subscriptionIds = Array.isArray(payload.subscription_ids) ? payload.subscription_ids : [];
  return {
    externalId,
    number: text(payload.number),
    customerExternalId,
    subscriptionExternalId: typeof subscriptionIds[0] === "string" ? subscriptionIds[0] as string : null,
    date,
    dueDate: isoDay(payload.due_at),
    currency,
    lines: lines.map((line) => mapRecurlyInvoiceLine(record(line) ?? {}, currency, externalId)),
    taxTotalMajor: billingMajorAmount(text(payload.tax) ?? "0", currency, `invoice ${externalId} tax`, remedy, "major"),
    totalMajor: total,
    balanceMajor: balance,
    status: recurlyInvoiceStatus(text(payload.status)),
    updatedAt: isoDay(payload.updated_at),
  };
}

function mapRecurlyInvoiceLine(line: JsonObject, currency: string, invoiceId: string): CanonicalInvoiceLine {
  const remedy = `Correct invoice ${invoiceId} in Recurly and import again.`;
  const amount = billingMajorAmount(text(line.subtotal) ?? "0", currency, `invoice ${invoiceId} line amount`, remedy, "major");
  const quantityRaw = text(line.quantity) ?? "1";
  const quantity = canonicalDecimal(quantityRaw, 4) ?? "1";
  return {
    description: text(line.description) ?? text(line.product_code) ?? invoiceId,
    quantity,
    unitPriceMajor: billingMajorAmount(text(line.unit_amount) ?? "0", currency, `invoice ${invoiceId} line price`, remedy, "major"),
    amountMajor: amount,
    taxAmountMajor: "0.0000",
    planExternalId: text(line.product_code),
  };
}

function recurlyInvoiceStatus(status: string | null): CanonicalInvoice["status"] {
  switch (status) {
    case "paid": return "paid";
    case "voided": return "void";
    case "past_due": return "past_due";
    default: return "open";
  }
}

/** Recurly's tax element is a nested object without a stated total, so the line rate is informational and the header carries tax. */
export function mapRecurlyCredit(payload: JsonObject): CanonicalCreditNote {
  const externalId = text(payload.id);
  const account = record(payload.account);
  const customerExternalId = account ? (text(account.id) ?? text(account.code)) : null;
  if (!externalId || !customerExternalId) {
    refuseRecurly("credit invoice", "missing id or account", "Correct the credit invoice in Recurly and import again.");
  }
  const remedy = "Correct the credit invoice in Recurly and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const total = billingMajorAmount(text(payload.total) ?? "0", currency, `credit ${externalId} total`, remedy, "major");
  return {
    externalId,
    number: text(payload.number),
    customerExternalId,
    invoiceExternalId: text(payload.invoice_id),
    date: isoDay(payload.created_at) ?? isoDay(payload.updated_at) ?? "1970-01-01",
    currency,
    totalMajor: total,
    balanceMajor: billingMajorAmount(text(payload.balance) ?? "0", currency, `credit ${externalId} balance`, remedy, "major"),
    reason: text(payload.origin),
    updatedAt: isoDay(payload.updated_at),
  };
}

export function mapRecurlyPayment(payload: JsonObject): CanonicalPayment | null {
  const externalId = text(payload.id);
  const account = record(payload.account);
  const customerExternalId = account ? (text(account.id) ?? text(account.code)) : null;
  if (!externalId || !customerExternalId) {
    refuseRecurly("transaction", "missing id or account", "Correct the transaction in Recurly and import again.");
  }
  // Only settled collections import as receipts; failures and verifications
  // carry no money and would fake the AR balance.
  if (text(payload.status) !== "successful" || text(payload.type) === "verify") return null;
  const remedy = "Correct the transaction in Recurly and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const invoiceId = text(payload.invoice_id);
  const amount = billingMajorAmount(text(payload.amount) ?? "0", currency, `transaction ${externalId} amount`, remedy, "major");
  return {
    externalId,
    customerExternalId,
    date: isoDay(payload.created_at) ?? isoDay(payload.updated_at) ?? "1970-01-01",
    currency,
    amountMajor: amount,
    method: record(payload.payment_method) ? text(record(payload.payment_method)!.object_type) : text(payload.type),
    applications: text(payload.type) === "refund" || !invoiceId ? [] : [{ invoiceExternalId: invoiceId, amountMajor: amount }],
    updatedAt: isoDay(payload.updated_at),
  };
}

export function mapRecurlyCoupon(payload: JsonObject): CanonicalCoupon {
  const externalId = text(payload.code) ?? text(payload.id);
  if (!externalId) refuseRecurly("coupon", "missing code", "Correct the coupon in Recurly and import again.");
  const discount = record(payload.discount);
  const kind = text(discount?.type) === "percent" ? "percent" : "amount";
  const remedy = "Correct the coupon in Recurly and import again.";
  let percentValue: string | null = null;
  let amountMajor: string | null = null;
  let currency: string | null = null;
  if (kind === "percent") {
    percentValue = billingPercent(discount?.percent, `coupon ${externalId} percent`, remedy);
  } else {
    const currencies = discount && Array.isArray(discount.currencies) ? discount.currencies : [];
    const first = record(currencies[0]);
    currency = first ? currencyOf(first.currency, null) : null;
    if (!currency || !first) {
      refuseRecurly("coupon", `coupon ${externalId} names no priced currency`, "Price the coupon in a currency in Recurly and import again.");
    }
    amountMajor = billingMajorAmount(first.discount, currency!, `coupon ${externalId} amount`, remedy, "major");
  }
  return {
    externalId,
    code: externalId,
    name: text(payload.name) ?? externalId,
    kind,
    percentValue,
    amountMajor,
    currency,
    durationMonths: text(payload.duration) === "temporal" && typeof payload.temporal_amount === "number" && text(payload.temporal_unit) === "months"
      ? payload.temporal_amount
      : null,
    active: text(payload.state) === "redeemable",
    updatedAt: isoDay(payload.updated_at),
  };
}

/**
 * Plan changes derived from consecutive invoices on different plans for one
 * subscription. Recurly states no version history over REST, so the invoice
 * sequence is the history: when invoice N+1 bills plan B after invoice N
 * billed plan A, the change took effect when N+1's service started. Derived
 * markers carry `derived: true` so the preflight shows them as estimates.
 */
export function deriveChangesFromInvoices(
  subscriptionExternalId: string,
  invoices: CanonicalInvoice[],
): CanonicalSubscriptionChange[] {
  const ordered = invoices
    .filter((invoice) => invoice.subscriptionExternalId === subscriptionExternalId && invoice.status !== "void")
    .sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : 0));
  const changes: CanonicalSubscriptionChange[] = [];
  let seq = 0;
  let current: string | null = null;
  for (const invoice of ordered) {
    const plans = [...new Set(invoice.lines.map((line) => line.planExternalId).filter((plan): plan is string => plan !== null))];
    if (!plans.length) continue;
    const first = plans[0]!;
    if (current === null) {
      current = first;
      continue;
    }
    if (first !== current) {
      changes.push({
        seq: seq++,
        effectiveOn: invoice.date,
        kind: "plan_change",
        planExternalId: first,
        quantity: null,
        unitAmountMajor: null,
        derived: true,
      });
      current = first;
    }
  }
  return changes;
}

// --- Maxio Advanced Billing (Chargify API) ----------------------------------------
// Amounts are integer minor units (`*_in_cents`); datetimes are ISO strings.
// Most lists wrap rows (`{ subscription: {...} }`) — unwrap unwraps one
// level. The API states no version history, so plan changes derive from the
// statement sequence exactly like Recurly.

/** Unwrap one Chargify envelope level (`{ subscription: {...} }` → the inner row). */
export function unwrapMaxio<T>(row: unknown): T {
  const obj = record(row);
  if (!obj) return row as T;
  const keys = Object.keys(obj);
  if (keys.length === 1 && record(obj[keys[0]!])) return obj[keys[0]!] as T;
  return obj as T;
}

function refuseMaxio(objectType: string, problem: string, remedy: string): never {
  refuse("maxio_object_invalid", `Maxio ${objectType} is unusable: ${problem}.`, remedy);
}

/** Chargify ids are JSON numbers; every other source uses strings. */
function maxioId(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

export function mapMaxioCustomer(payload: JsonObject): CanonicalCustomer {
  const row = unwrapMaxio<JsonObject>(payload);
  const externalId = maxioId(row.id);
  if (!externalId) refuseMaxio("customer", "missing id", "Correct the customer in Maxio and import again.");
  const name = [text(row.first_name), text(row.last_name)].filter((part): part is string => part !== null).join(" ").trim()
    || text(row.organization) || text(row.email) || externalId;
  return {
    externalId,
    name,
    email: text(row.email),
    currency: currencyOf(row.currency, null),
    updatedAt: isoDay(row.updated_at),
  };
}

export function mapMaxioPlan(payload: JsonObject): CanonicalPlan {
  const row = unwrapMaxio<JsonObject>(payload);
  const product = text(row.product_handle ?? row.handle) ?? maxioId(row.product_id);
  const pricePoint = maxioId(row.price_point_id);
  const externalId = product && pricePoint ? `${product}:${pricePoint}` : (maxioId(row.id) ?? maxioId(row.api_id));
  if (!externalId) refuseMaxio("price point", "missing product and price point", "Correct the product catalog in Maxio and import again.");
  const currency = currencyOf(row.currency, null)
    ?? refuseMaxio("price point", `price point ${externalId} names no currency`, "Set a currency on the price point in Maxio and import again.") as string;
  const intervalUnit = text(row.interval_unit) ?? text(row.interval) ?? "month";
  const intervalLength = typeof row.interval === "number" && Number.isSafeInteger(row.interval) && row.interval > 0 ? row.interval : 1;
  return {
    externalId,
    name: text(row.name) ?? externalId,
    amountMajor: billingMajorAmount(row.unit_price_in_cents ?? row.price_in_cents ?? 0, currency, `price point ${externalId} price`, "Correct the price point in Maxio and import again.", "minor"),
    currency,
    interval: planInterval(intervalUnit),
    intervalCount: intervalLength,
    updatedAt: isoDay(row.updated_at),
  };
}

export function mapMaxioSubscription(payload: JsonObject): CanonicalSubscription {
  const row = unwrapMaxio<JsonObject>(payload);
  const externalId = maxioId(row.id);
  const customer = record(row.customer) ?? row;
  const customerExternalId = maxioId(customer.id) ?? maxioId(row.customer_id);
  const product = record(row.product);
  const planExternalId = maxioId(row.product_price_point_id)
    ? `${text(row.product_handle) ?? (product ? text(product.handle) : null) ?? "product"}:${maxioId(row.product_price_point_id)}`
    : (text(row.product_handle) ?? (product ? text(product.handle) : null));
  if (!externalId || !customerExternalId || !planExternalId) {
    refuseMaxio("subscription", "missing id, customer or product", "Correct the subscription in Maxio and import again.");
  }
  const currency = currencyOf(row.currency, "USD") ?? "USD";
  const remedy = "Correct the subscription in Maxio and import again.";
  const state = text(row.state);
  return {
    externalId,
    customerExternalId,
    planExternalId,
    quantity: String(typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) && row.quantity > 0 ? row.quantity : 1),
    unitAmountMajor: row.unit_price_in_cents == null ? null
      : billingMajorAmount(row.unit_price_in_cents, currency, `subscription ${externalId} unit price`, remedy, "minor"),
    currency,
    status: state === "canceled" || state === "expired" ? "canceled" : state === "on_hold" || state === "paused" ? "paused" : state === "trialing" ? "trial" : "active",
    startOn: isoDay(row.activated_at) ?? isoDay(row.created_at)
      ?? refuseMaxio("subscription", `subscription ${externalId} has no start date`, remedy) as string,
    canceledOn: state === "canceled" ? (isoDay(row.canceled_at) ?? isoDay(row.updated_at)) : null,
    trialEndOn: isoDay(row.trial_ended_at),
    currentTermEndOn: isoDay(row.current_period_ends_at),
    updatedAt: isoDay(row.updated_at),
    changes: [],
  };
}

export function mapMaxioInvoice(payload: JsonObject): CanonicalInvoice {
  const row = unwrapMaxio<JsonObject>(payload);
  const externalId = maxioId(row.uid) ?? maxioId(row.id);
  const customerExternalId = maxioId(row.customer_id) ?? maxioId(record(row.customer)?.id);
  if (!externalId || !customerExternalId) {
    refuseMaxio("invoice", "missing id or customer", "Correct the invoice in Maxio and import again.");
  }
  const currency = currencyOf(row.currency, "USD") ?? "USD";
  const remedy = "Correct the invoice amounts in Maxio and import again.";
  const lines = Array.isArray(row.line_items) ? row.line_items : [];
  const total = billingMajorAmount(row.total_amount_in_cents ?? row.total_in_cents ?? 0, currency, `invoice ${externalId} total`, remedy, "minor");
  const paid = billingMajorAmount(row.paid_amount_in_cents ?? 0, currency, `invoice ${externalId} paid amount`, remedy, "minor");
  const credited = billingMajorAmount(row.credited_amount_in_cents ?? row.credit_amount_in_cents ?? 0, currency, `invoice ${externalId} credits`, remedy, "minor");
  return {
    externalId,
    number: text(row.number),
    customerExternalId,
    subscriptionExternalId: text(row.subscription_id),
    date: isoDay(row.issue_date) ?? isoDay(row.created_at) ?? "1970-01-01",
    dueDate: isoDay(row.due_date),
    currency,
    lines: lines.map((line) => mapMaxioInvoiceLine(unwrapMaxio<JsonObject>(line), currency, externalId)),
    taxTotalMajor: billingMajorAmount(row.tax_amount_in_cents ?? 0, currency, `invoice ${externalId} tax`, remedy, "minor"),
    totalMajor: total,
    balanceMajor: subtractMajor(subtractMajor(total, paid), credited),
    status: maxioInvoiceStatus(text(row.status)),
    updatedAt: isoDay(row.updated_at),
  };
}

function mapMaxioInvoiceLine(line: JsonObject, currency: string, invoiceId: string): CanonicalInvoiceLine {
  const remedy = `Correct invoice ${invoiceId} in Maxio and import again.`;
  return {
    description: text(line.title) ?? text(line.description) ?? invoiceId,
    quantity: String(typeof line.quantity === "number" && Number.isSafeInteger(line.quantity) && line.quantity > 0 ? line.quantity : 1),
    unitPriceMajor: billingMajorAmount(line.unit_price_in_cents ?? line.price_in_cents ?? 0, currency, `invoice ${invoiceId} line price`, remedy, "minor"),
    amountMajor: billingMajorAmount(line.total_in_cents ?? line.amount_in_cents ?? 0, currency, `invoice ${invoiceId} line amount`, remedy, "minor"),
    taxAmountMajor: billingMajorAmount(line.tax_amount_in_cents ?? 0, currency, `invoice ${invoiceId} line tax`, remedy, "minor"),
    planExternalId: text(line.product_handle) ?? maxioId(line.price_point_id),
  };
}

function maxioInvoiceStatus(status: string | null): CanonicalInvoice["status"] {
  switch (status) {
    case "paid": return "paid";
    case "voided": case "void": return "void";
    case "past_due": case "overdue": return "past_due";
    default: return "open";
  }
}

export function mapMaxioPayment(payload: JsonObject): CanonicalPayment | null {
  const row = unwrapMaxio<JsonObject>(payload);
  if (text(row.type) !== null && !["payment", "charge", "external_payment"].includes(text(row.type)!)) return null;
  const externalId = maxioId(row.id);
  const customerExternalId = maxioId(row.customer_id);
  if (!externalId || !customerExternalId) {
    refuseMaxio("payment", "missing id or customer", "Correct the payment in Maxio and import again.");
  }
  const remedy = "Correct the payment in Maxio and import again.";
  const currency = currencyOf(row.currency, "USD") ?? "USD";
  const amount = billingMajorAmount(row.amount_in_cents ?? 0, currency, `payment ${externalId} amount`, remedy, "minor");
  const invoiceId = text(row.invoice_id) ?? text(row.applied_to_invoice_id);
  return {
    externalId,
    customerExternalId,
    date: isoDay(row.created_at) ?? isoDay(row.updated_at) ?? "1970-01-01",
    currency,
    amountMajor: amount,
    method: text(row.payment_type) ?? text(row.type),
    applications: invoiceId ? [{ invoiceExternalId: invoiceId, amountMajor: amount }] : [],
    updatedAt: isoDay(row.updated_at),
  };
}

export function mapMaxioCoupon(payload: JsonObject): CanonicalCoupon {
  const row = unwrapMaxio<JsonObject>(payload);
  const externalId = maxioId(row.id);
  const code = text(row.code) ?? externalId;
  if (!externalId || !code) refuseMaxio("coupon", "missing id or code", "Correct the coupon in Maxio and import again.");
  const remedy = "Correct the coupon in Maxio and import again.";
  const percentage = text(row.percentage) ?? (typeof row.percentage === "number" ? String(row.percentage) : null);
  const kind = percentage !== null ? "percent" : "amount";
  const currency = kind === "amount" ? (currencyOf(row.currency, null) ?? refuseMaxio("coupon", `coupon ${externalId} names no currency`, remedy) as string) : null;
  return {
    externalId,
    code,
    name: text(row.name) ?? code,
    kind,
    percentValue: kind === "percent" ? billingPercent(percentage, `coupon ${externalId} percent`, remedy) : null,
    amountMajor: kind === "amount" ? billingMajorAmount(row.amount_in_cents ?? 0, currency!, `coupon ${externalId} amount`, remedy, "minor") : null,
    currency,
    durationMonths: typeof row.duration_period_count === "number" && text(row.duration_interval_unit) === "month" ? row.duration_period_count : null,
    active: text(row.archived_at) === null && text(row.state) !== "expired",
    updatedAt: isoDay(row.updated_at),
  };
}

export function mapMaxioUsage(payload: JsonObject, subscriptionExternalId: string): CanonicalUsage {
  const row = unwrapMaxio<JsonObject>(payload);
  const externalId = maxioId(row.id);
  if (!externalId) refuseMaxio("usage", "missing id", "Correct the usage record in Maxio and import again.");
  return {
    externalId,
    subscriptionExternalId,
    meterKey: text(row.metric_name) ?? text(row.component_handle) ?? "usage",
    quantityMajor: billingQuantity(row.quantity ?? 0, `usage ${externalId} quantity`, "Correct the usage record in Maxio and import again."),
    date: isoDay(row.recorded_at) ?? isoDay(row.created_at) ?? "1970-01-01",
    updatedAt: isoDay(row.updated_at),
  };
}

// --- Zuora (REST + AQuA/Data Query) ------------------------------------------------
// Money is major-unit decimal text with an explicit currency. Amendments are
// the stated, effective-dated change history — the richest of the four
// sources — so Zuora never derives changes from invoices. Revenue schedules
// ride the Finance objects; usage rides the Usage objects.

function refuseZuora(objectType: string, problem: string, remedy: string): never {
  refuse("zuora_object_invalid", `Zuora ${objectType} is unusable: ${problem}.`, remedy);
}

export function mapZuoraCustomer(payload: JsonObject): CanonicalCustomer {
  const externalId = text(payload.id) ?? text(payload.accountNumber);
  if (!externalId) refuseZuora("account", "missing id", "Correct the account in Zuora and import again.");
  const contact = record(payload.billToContact) ?? record(payload.soldToContact);
  const contactName = contact
    ? [text(contact.firstName), text(contact.lastName)].filter((part): part is string => part !== null).join(" ").trim()
    : "";
  const name = text(payload.name) ?? (contactName !== "" ? contactName : null) ?? (contact ? text(contact.workEmail) : null) ?? externalId;
  return {
    externalId,
    name,
    email: contact ? text(contact.workEmail) : null,
    currency: currencyOf(payload.currency, null),
    updatedAt: isoDay(payload.updatedDate),
  };
}

export function mapZuoraPlan(payload: JsonObject): CanonicalPlan {
  const externalId = text(payload.id);
  if (!externalId) refuseZuora("rate plan charge", "missing id", "Correct the product catalog in Zuora and import again.");
  const pricing = Array.isArray(payload.pricing) ? payload.pricing : [];
  const first = record(pricing[0]);
  const currency = first ? currencyOf(first.currency, null) : null;
  if (!currency || !first) {
    refuseZuora("rate plan charge", `charge ${externalId} names no priced currency`, "Price the charge in a currency in Zuora and import again.");
  }
  return {
    externalId,
    name: text(payload.name) ?? externalId,
    amountMajor: billingMajorAmount(first.price ?? 0, currency!, `charge ${externalId} price`, "Correct the charge price in Zuora and import again.", "major"),
    currency: currency!,
    interval: planInterval(text(payload.billingPeriod)),
    intervalCount: 1,
    updatedAt: isoDay(payload.updatedDate),
  };
}

export function mapZuoraSubscription(payload: JsonObject): CanonicalSubscription {
  const externalId = text(payload.id) ?? text(payload.subscriptionNumber);
  const customerExternalId = text(payload.accountId) ?? text(payload.accountNumber);
  if (!externalId || !customerExternalId) {
    refuseZuora("subscription", "missing id or account", "Correct the subscription in Zuora and import again.");
  }
  const ratePlans = Array.isArray(payload.subscribeToRatePlans) ? payload.subscribeToRatePlans : [];
  const firstPlan = record(ratePlans[0]);
  const planExternalId = firstPlan ? (text(firstPlan.productRatePlanChargeId) ?? text(firstPlan.productRatePlanId)) : null;
  if (!planExternalId) {
    refuseZuora("subscription", `subscription ${externalId} names no rate plan`, "Correct the subscription rate plans in Zuora and import again.");
  }
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const quantity = firstPlan && typeof firstPlan.quantity === "number" && firstPlan.quantity > 0 ? String(firstPlan.quantity) : "1";
  const status = text(payload.status);
  return {
    externalId,
    customerExternalId,
    planExternalId,
    quantity,
    unitAmountMajor: null,
    currency,
    status: status === "Cancelled" ? "canceled" : status === "Suspended" ? "paused" : status === "Draft" ? "trial" : "active",
    startOn: isoDay(payload.contractEffectiveDate) ?? isoDay(payload.serviceActivationDate)
      ?? refuseZuora("subscription", `subscription ${externalId} has no start date`, "Correct the subscription dates in Zuora and import again.") as string,
    canceledOn: status === "Cancelled" ? (isoDay(payload.cancelledDate) ?? isoDay(payload.termEndDate) ?? isoDay(payload.updatedDate)) : null,
    trialEndOn: null,
    currentTermEndOn: isoDay(payload.termEndDate),
    updatedAt: isoDay(payload.updatedDate),
    changes: [],
  };
}

/** One Zuora amendment → one canonical change. Unmappable types (owner transfer) return null and are skipped, never guessed. */
export function mapZuoraAmendment(payload: JsonObject): CanonicalSubscriptionChange | null {
  const type = text(payload.type);
  const effectiveOn = isoDay(payload.effectiveDate);
  if (!effectiveOn) return null;
  const seq = typeof payload.sequence === "number" && Number.isSafeInteger(payload.sequence) ? payload.sequence : 0;
  switch (type) {
    case "NewProduct":
    case "UpdateProduct":
      return {
        seq,
        effectiveOn,
        kind: "plan_change",
        planExternalId: text(payload.productRatePlanChargeId) ?? text(payload.productRatePlanId),
        quantity: typeof payload.quantity === "number" ? String(payload.quantity) : null,
        unitAmountMajor: null,
        derived: false,
      };
    case "RemoveProduct":
      return { seq, effectiveOn, kind: "quantity_change", planExternalId: null, quantity: "0", unitAmountMajor: null, derived: false };
    case "TermsAndConditions":
    case "Renewal":
      return { seq, effectiveOn, kind: "renew", planExternalId: null, quantity: null, unitAmountMajor: null, derived: false };
    case "SuspendSubscription":
      return { seq, effectiveOn, kind: "pause", planExternalId: null, quantity: null, unitAmountMajor: null, derived: false };
    case "ResumeSubscription":
      return { seq, effectiveOn, kind: "resume", planExternalId: null, quantity: null, unitAmountMajor: null, derived: false };
    case "CancelSubscription":
      return { seq, effectiveOn, kind: "cancel", planExternalId: null, quantity: null, unitAmountMajor: null, derived: false };
    default:
      return null;
  }
}

export function mapZuoraInvoice(payload: JsonObject): CanonicalInvoice {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.accountId) ?? text(payload.accountNumber);
  if (!externalId || !customerExternalId) {
    refuseZuora("invoice", "missing id or account", "Correct the invoice in Zuora and import again.");
  }
  if (text(payload.status) === "Canceled") {
    return {
      externalId, number: text(payload.invoiceNumber), customerExternalId,
      subscriptionExternalId: null, date: isoDay(payload.invoiceDate) ?? "1970-01-01", dueDate: isoDay(payload.dueDate),
      currency: currencyOf(payload.currency, "USD") ?? "USD", lines: [],
      taxTotalMajor: "0.0000", totalMajor: "0.0000", balanceMajor: "0.0000",
      status: "void", updatedAt: isoDay(payload.updatedDate),
    };
  }
  const remedy = "Correct the invoice amounts in Zuora and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const items = Array.isArray(payload.invoiceItems) ? payload.invoiceItems : [];
  const total = billingMajorAmount(text(payload.amount) ?? "0", currency, `invoice ${externalId} total`, remedy, "major");
  const balance = billingMajorAmount(text(payload.balance) ?? "0", currency, `invoice ${externalId} balance`, remedy, "major");
  return {
    externalId,
    number: text(payload.invoiceNumber),
    customerExternalId,
    subscriptionExternalId: items.length ? text(record(items[0])?.subscriptionId) : null,
    date: isoDay(payload.invoiceDate) ?? isoDay(payload.updatedDate) ?? "1970-01-01",
    dueDate: isoDay(payload.dueDate),
    currency,
    lines: items.map((item) => mapZuoraInvoiceLine(record(item) ?? {}, currency, externalId)),
    taxTotalMajor: billingMajorAmount(text(payload.taxAmount) ?? "0", currency, `invoice ${externalId} tax`, remedy, "major"),
    totalMajor: total,
    balanceMajor: balance,
    status: zuoraInvoiceStatus(text(payload.status), balance),
    updatedAt: isoDay(payload.updatedDate),
  };
}

function mapZuoraInvoiceLine(item: JsonObject, currency: string, invoiceId: string): CanonicalInvoiceLine {
  const remedy = `Correct invoice ${invoiceId} in Zuora and import again.`;
  const quantityRaw = text(item.quantity) ?? "1";
  return {
    description: text(item.chargeName) ?? text(item.productName) ?? invoiceId,
    quantity: canonicalDecimal(quantityRaw, 4) ?? "1",
    unitPriceMajor: billingMajorAmount(text(item.unitPrice) ?? "0", currency, `invoice ${invoiceId} line price`, remedy, "major"),
    amountMajor: billingMajorAmount(text(item.amount) ?? text(item.chargeAmount) ?? "0", currency, `invoice ${invoiceId} line amount`, remedy, "major"),
    taxAmountMajor: billingMajorAmount(text(item.taxAmount) ?? "0", currency, `invoice ${invoiceId} line tax`, remedy, "major"),
    planExternalId: text(item.chargeId) ?? text(item.productRatePlanChargeId),
  };
}

function zuoraInvoiceStatus(status: string | null, balanceMajor: string): CanonicalInvoice["status"] {
  if (status === "Canceled") return "void";
  // Zuora states no paid status — a posted invoice with zero balance is paid.
  if (status === "Posted" && balanceMajor === "0.0000") return "paid";
  return "open";
}

export function mapZuoraCreditMemo(payload: JsonObject): CanonicalCreditNote {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.accountId) ?? text(payload.accountNumber);
  if (!externalId || !customerExternalId) {
    refuseZuora("credit memo", "missing id or account", "Correct the credit memo in Zuora and import again.");
  }
  const remedy = "Correct the credit memo in Zuora and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const total = billingMajorAmount(text(payload.amount) ?? "0", currency, `credit memo ${externalId} total`, remedy, "major");
  return {
    externalId,
    number: text(payload.creditMemoNumber),
    customerExternalId,
    invoiceExternalId: null,
    date: isoDay(payload.creditMemoDate) ?? isoDay(payload.updatedDate) ?? "1970-01-01",
    currency,
    totalMajor: total,
    balanceMajor: billingMajorAmount(text(payload.balance) ?? "0", currency, `credit memo ${externalId} balance`, remedy, "major"),
    reason: text(payload.reasonCode),
    updatedAt: isoDay(payload.updatedDate),
  };
}

export function mapZuoraPayment(payload: JsonObject): CanonicalPayment | null {
  const externalId = text(payload.id);
  const customerExternalId = text(payload.accountId) ?? text(payload.accountNumber);
  if (!externalId || !customerExternalId) {
    refuseZuora("payment", "missing id or account", "Correct the payment in Zuora and import again.");
  }
  // Only settled payments import as receipts; voided or errored rows carry no
  // money and would fake the AR balance.
  if (text(payload.status) !== "Processed") return null;
  const remedy = "Correct the payment in Zuora and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const amount = billingMajorAmount(text(payload.amount) ?? "0", currency, `payment ${externalId} amount`, remedy, "major");
  const applied = Array.isArray(payload.appliedInvoices) ? payload.appliedInvoices : [];
  return {
    externalId,
    customerExternalId,
    date: isoDay(payload.effectiveDate) ?? isoDay(payload.updatedDate) ?? "1970-01-01",
    currency,
    amountMajor: amount,
    method: text(payload.paymentMethodType) ?? text(payload.type),
    applications: applied.map((entry) => {
      const link = record(entry) ?? {};
      const invoiceId = text(link.invoiceId);
      if (!invoiceId) refuseZuora("payment", `payment ${externalId} links an unnamed invoice`, remedy);
      return {
        invoiceExternalId: invoiceId,
        amountMajor: billingMajorAmount(text(link.appliedPaymentAmount) ?? "0", currency, `payment ${externalId} application`, remedy, "major"),
      };
    }),
    updatedAt: isoDay(payload.updatedDate),
  };
}

export function mapZuoraUsage(payload: JsonObject): CanonicalUsage {
  const externalId = text(payload.id);
  const subscriptionExternalId = text(payload.subscriptionId);
  if (!externalId || !subscriptionExternalId) {
    refuseZuora("usage", "missing id or subscription", "Correct the usage record in Zuora and import again.");
  }
  return {
    externalId,
    subscriptionExternalId,
    meterKey: text(payload.unitOfMeasure) ?? text(payload.chargeId) ?? "usage",
    quantityMajor: billingQuantity(text(payload.quantity) ?? "0", `usage ${externalId} quantity`, "Correct the usage record in Zuora and import again."),
    date: (isoDay(payload.startDateTime) ?? isoDay(payload.updatedDate) ?? "1970-01-01"),
    updatedAt: isoDay(payload.updatedDate),
  };
}

export interface BillingHistoryCounts {
  customers: number;
  plans: number;
  subscriptions: number;
  invoices: number;
  creditNotes: number;
  payments: number;
  usage: number;
  coupons: number;
  revenueSchedules: number;
}

export function historyObjectCounts(history: CanonicalBillingHistory): BillingHistoryCounts {
  return {
    customers: history.customers.length,
    plans: history.plans.length,
    subscriptions: history.subscriptions.length,
    invoices: history.invoices.length,
    creditNotes: history.creditNotes.length,
    payments: history.payments.length,
    usage: history.usage.length,
    coupons: history.coupons.length,
    revenueSchedules: history.revenueSchedules.length,
  };
}

export function mapZuoraRevenueSchedule(payload: JsonObject): CanonicalRevenueSchedule {
  const externalId = text(payload.id) ?? text(payload.revenueScheduleNumber);
  if (!externalId) refuseZuora("revenue schedule", "missing id", "Correct the revenue schedule in Zuora and import again.");
  const remedy = "Correct the revenue schedule in Zuora and import again.";
  const currency = currencyOf(payload.currency, "USD") ?? "USD";
  const items = Array.isArray(payload.revenueItems) ? payload.revenueItems : [];
  const first = record(items[0]);
  return {
    externalId,
    invoiceExternalId: text(payload.invoiceId),
    subscriptionExternalId: text(payload.subscriptionId),
    periodStart: isoDay(payload.revenueScheduleDate) ?? (first ? isoDay(first.accountingPeriodStartDate) : null) ?? "1970-01-01",
    periodEnd: isoDay(payload.revenueScheduleDate) ?? (first ? isoDay(first.accountingPeriodEndDate) : null) ?? "1970-01-01",
    amountMajor: billingMajorAmount(text(payload.amount) ?? text(payload.undistributedAmount) ?? "0", currency, `revenue schedule ${externalId} amount`, remedy, "major"),
    currency,
    recognized: text(payload.status) === "Distributed" || text(payload.distributionType) === "manual",
    updatedAt: isoDay(payload.updatedDate),
  };
}

// --- Preflight -------------------------------------------------------------------
// The import proposes a complete working configuration; the operator reviews
// and accepts. Anything the history needs that OpenBooks cannot resolve — an
// unknown plan, a currency the org cannot post, tax with no code — lands on
// the Needs-attention list with a suggested mapping, never a silent fallback.

export interface NativePlanCatalogRow {
  id: string;
  name: string;
  amountMajor: string;
  currency: string | null;
  interval: CanonicalPlan["interval"];
}

export interface PreflightCatalog {
  plans: NativePlanCatalogRow[];
  baseCurrency: string;
  multiCurrency: boolean;
  defaultTaxCode: { id: string; name: string } | null;
}

export interface PreflightAttentionItem {
  kind: "plan" | "currency" | "tax_code" | "customer";
  externalRef: string;
  label: string;
  suggestion: { nativeId: string | null; label: string } | null;
  remedy: string;
}

export interface BillingPreflight {
  counts: BillingHistoryCounts;
  attention: PreflightAttentionItem[];
  /** True when nothing needs a person — the import can proceed unattended. */
  ready: boolean;
}

export function planBillingPreflight(history: CanonicalBillingHistory, catalog: PreflightCatalog): BillingPreflight {
  const attention: PreflightAttentionItem[] = [];
  for (const plan of history.plans) {
    const match = suggestPlanMapping(plan, catalog.plans);
    if (!match) {
      attention.push({
        kind: "plan",
        externalRef: plan.externalId,
        label: `Plan ${plan.name} (${plan.amountMajor} ${plan.currency} ${plan.interval}) has no OpenBooks plan.`,
        suggestion: null,
        remedy: "Create an OpenBooks plan for it, or map it to an existing plan on the preflight list.",
      });
    }
  }
  const currencies = new Set<string>();
  for (const invoice of history.invoices) currencies.add(invoice.currency);
  for (const payment of history.payments) currencies.add(payment.currency);
  for (const sub of history.subscriptions) currencies.add(sub.currency);
  for (const currency of [...currencies].sort()) {
    if (currency !== catalog.baseCurrency && !catalog.multiCurrency) {
      attention.push({
        kind: "currency",
        externalRef: currency,
        label: `History bills in ${currency}, but the org posts in ${catalog.baseCurrency} with multi-currency off.`,
        suggestion: null,
        remedy: "Enable multi-currency in Company Settings → Features, or restrict the history depth to single-currency periods.",
      });
    }
  }
  const taxedInvoices = history.invoices.filter((invoice) => invoice.taxTotalMajor !== "0.0000");
  if (taxedInvoices.length && !catalog.defaultTaxCode) {
    attention.push({
      kind: "tax_code",
      externalRef: taxedInvoices[0]!.externalId,
      label: `${taxedInvoices.length} historical invoice(s) carry tax, but no default sales tax code is set.`,
      suggestion: null,
      remedy: "Choose the sales tax code historical tax posts against in the import settings.",
    });
  }
  const customerless = history.subscriptions.filter((sub) => !history.customers.some((customer) => customer.externalId === sub.customerExternalId));
  for (const sub of customerless.slice(0, 20)) {
    attention.push({
      kind: "customer",
      externalRef: sub.externalId,
      label: `Subscription ${sub.externalId} names customer ${sub.customerExternalId}, which is not in the imported customers.`,
      suggestion: null,
      remedy: "Widen the history pull to include the missing customers, or map the subscription to an existing customer.",
    });
  }
  return { counts: historyObjectCounts(history), attention, ready: attention.length === 0 };
}

/** Suggest the native plan whose price, currency and cadence match the source plan. */
export function suggestPlanMapping(
  plan: CanonicalPlan,
  catalog: NativePlanCatalogRow[],
): NativePlanCatalogRow | null {
  const byName = catalog.find((row) => row.name.trim().toLowerCase() === plan.name.trim().toLowerCase());
  if (byName) return byName;
  return catalog.find((row) =>
    row.amountMajor === plan.amountMajor
    && (row.currency ?? plan.currency) === plan.currency
    && row.interval === plan.interval,
  ) ?? null;
}

// --- MRR --------------------------------------------------------------------------
// Monthly recurring revenue normalizes every subscription to its monthly
// equivalent through the billing module's own normalizer, so the source side
// and the OpenBooks side of the reconciliation can never drift apart.

export interface PricedPlan {
  amountMajor: string;
  interval: CanonicalPlan["interval"];
  intervalCount: number;
}

export interface MrrMonth {
  month: string;
  mrrMajor: string;
}

export function monthRange(fromMonth: string, toMonth: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(fromMonth) || !/^\d{4}-\d{2}$/.test(toMonth) || fromMonth > toMonth) {
    refuse("billing_history_month_invalid", `Month range ${fromMonth} to ${toMonth} is invalid.`, "Import months in YYYY-MM order with the first month before the last.");
  }
  const months: string[] = [];
  let cursor = `${fromMonth}-01`;
  const end = `${toMonth}-01`;
  for (let guard = 0; guard < 600; guard++) {
    months.push(cursor.slice(0, 7));
    if (cursor === end) return months;
    cursor = addMonthsClamped(cursor, 1);
  }
  refuse("billing_history_month_invalid", `Month range ${fromMonth} to ${toMonth} spans too many months.`, "Narrow the reconciliation window to under fifty years.");
}

/** The effective (plan, unit price, quantity, status) of a subscription at month end, folding its change history in order. */
export function subscriptionStateAtEndOfMonth(
  sub: CanonicalSubscription,
  plans: Map<string, PricedPlan>,
  month: string,
): { plan: PricedPlan | null; unitAmountMajor: string | null; quantity: string; status: CanonicalSubscription["status"] } {
  const monthEnd = endOfMonth(`${month}-01`);
  let planExternalId: string | null = sub.planExternalId;
  let unitAmountMajor: string | null = sub.unitAmountMajor;
  let quantity = sub.quantity;
  // Historical months start from the contracted state and fold forward: the
  // current status describes today, not last January. A subscription with no
  // timeline at all keeps its current state — it is all anyone knows.
  let status: CanonicalSubscription["status"] = sub.changes.length || sub.canceledOn ? "active" : sub.status;
  if (sub.status === "trial" && sub.trialEndOn && monthEnd < sub.trialEndOn) status = "trial";
  const ordered = [...sub.changes].sort((left, right) => (
    left.effectiveOn < right.effectiveOn ? -1 : left.effectiveOn > right.effectiveOn ? 1 : left.seq - right.seq
  ));
  for (const change of ordered) {
    if (change.effectiveOn > monthEnd) break;
    switch (change.kind) {
      case "plan_change":
        if (change.planExternalId) {
          planExternalId = change.planExternalId;
          // A restated price belongs to the new plan; otherwise the new
          // plan's catalog price governs from the change date. A change
          // that names no plan restates the current plan's price only.
          unitAmountMajor = change.unitAmountMajor;
        } else if (change.unitAmountMajor) {
          unitAmountMajor = change.unitAmountMajor;
        }
        if (change.quantity) quantity = change.quantity;
        if (status === "canceled") status = "active";
        break;
      case "quantity_change":
        if (change.quantity) quantity = change.quantity;
        if (change.unitAmountMajor) unitAmountMajor = change.unitAmountMajor;
        break;
      case "pause": status = "paused"; break;
      case "resume": status = status === "paused" ? "active" : status; break;
      case "cancel": status = "canceled"; break;
      case "renew": if (status === "canceled") status = "active"; break;
      case "term_change": break;
    }
  }
  if (sub.startOn > monthEnd) return { plan: null, unitAmountMajor, quantity, status };
  if (sub.canceledOn && sub.canceledOn <= monthEnd && !ordered.some((change) => change.effectiveOn > sub.canceledOn! && (change.kind === "resume" || change.kind === "renew"))) {
    status = "canceled";
  }
  const plan = planExternalId ? (plans.get(planExternalId) ?? null) : null;
  return { plan, unitAmountMajor, quantity, status };
}

export function subscriptionMrrAt(
  sub: CanonicalSubscription,
  plans: Map<string, PricedPlan>,
  month: string,
  normalize: (amount: string, interval: CanonicalPlan["interval"], intervalCount: number, quantity: string) => string,
): string {
  const state = subscriptionStateAtEndOfMonth(sub, plans, month);
  // Trials and paused or canceled subscriptions carry no contracted MRR —
  // counting them would overstate the book the same months churn understates.
  if (!state.plan || state.status !== "active") return "0.0000";
  return normalize(state.unitAmountMajor ?? state.plan.amountMajor, state.plan.interval, state.plan.intervalCount, state.quantity);
}

/** MRR by month for a canonical subscription set — the same function prices the source side and the OpenBooks side. */
export function mrrByMonth(
  subscriptions: CanonicalSubscription[],
  plans: Map<string, PricedPlan>,
  months: string[],
  normalize: (amount: string, interval: CanonicalPlan["interval"], intervalCount: number, quantity: string) => string,
): MrrMonth[] {
  return months.map((month) => ({
    month,
    mrrMajor: subscriptions.reduce(
      (total, sub) => addMajor(total, subscriptionMrrAt(sub, plans, month, normalize)),
      "0.0000",
    ),
  }));
}

// --- Reconciliation ----------------------------------------------------------------
// Three legs, each with the objects causing any difference: MRR by month
// (source history vs native subscriptions), open AR by customer (source
// balances vs native documents) and deferred revenue at cut-over (source
// schedules vs native unearned). The report must tie before cut-over.

export interface MrrComparison {
  month: string;
  sourceMrrMajor: string;
  openbooksMrrMajor: string;
  diffMajor: string;
  causingSubscriptions: string[];
}

export interface OpenArComparison {
  customerExternalId: string;
  sourceOpenMajor: string;
  openbooksOpenMajor: string;
  diffMajor: string;
}

export interface BillingReconciliationDifference {
  kind: "mrr" | "open_ar" | "deferred_revenue";
  ref: string;
  sourceMajor: string;
  openbooksMajor: string;
  explanation: string;
}

export interface BillingReconciliation {
  mrr: MrrComparison[];
  openAr: OpenArComparison[];
  sourceDeferredMajor: string;
  openbooksDeferredMajor: string;
  deferredDiffMajor: string;
  differences: BillingReconciliationDifference[];
  ties: boolean;
}

export interface ReconciliationOpenbooksSide {
  /** Native subscription MRR states keyed by source subscription external id. */
  subscriptions: CanonicalSubscription[];
  plans: Map<string, PricedPlan>;
  /** Native open AR by source customer external id. */
  openArByCustomer: Map<string, string>;
  /** Native unearned revenue at cut-over. */
  deferredMajor: string;
}

export function reconcileBillingHistory(
  source: CanonicalBillingHistory,
  openbooks: ReconciliationOpenbooksSide,
  months: string[],
  normalize: (amount: string, interval: CanonicalPlan["interval"], intervalCount: number, quantity: string) => string,
): BillingReconciliation {
  const sourcePlans = new Map(source.plans.map((plan) => [plan.externalId, {
    amountMajor: plan.amountMajor,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
  }]));
  const sourceMrr = mrrByMonth(source.subscriptions, sourcePlans, months, normalize);
  const nativeMrr = mrrByMonth(openbooks.subscriptions, openbooks.plans, months, normalize);
  const mrr: MrrComparison[] = months.map((month, index) => {
    const sourceRow = sourceMrr[index]!;
    const nativeRow = nativeMrr[index]!;
    const causing = source.subscriptions
      .filter((sub) => subscriptionMrrAt(sub, sourcePlans, month, normalize) !== "0.0000")
      .map((sub) => sub.externalId)
      .filter((externalId) => !openbooks.subscriptions.some((native) => native.externalId === externalId))
      .slice(0, 10);
    return {
      month,
      sourceMrrMajor: sourceRow.mrrMajor,
      openbooksMrrMajor: nativeRow.mrrMajor,
      diffMajor: subtractMajor(sourceRow.mrrMajor, nativeRow.mrrMajor),
      causingSubscriptions: causing,
    };
  });
  const sourceAr = sourceOpenArByCustomer(source);
  const customers = [...new Set([...sourceAr.keys(), ...openbooks.openArByCustomer.keys()])].sort();
  const openAr: OpenArComparison[] = customers.map((customerExternalId) => {
    const sourceOpen = sourceAr.get(customerExternalId) ?? "0.0000";
    const nativeOpen = openbooks.openArByCustomer.get(customerExternalId) ?? "0.0000";
    return {
      customerExternalId,
      sourceOpenMajor: sourceOpen,
      openbooksOpenMajor: nativeOpen,
      diffMajor: subtractMajor(sourceOpen, nativeOpen),
    };
  });
  const sourceDeferred = sourceDeferredRevenue(source);
  const deferredDiff = subtractMajor(sourceDeferred, openbooks.deferredMajor);
  const differences: BillingReconciliationDifference[] = [];
  for (const row of mrr) {
    if (row.diffMajor !== "0.0000") {
      differences.push({
        kind: "mrr",
        ref: row.month,
        sourceMajor: row.sourceMrrMajor,
        openbooksMajor: row.openbooksMrrMajor,
        explanation: row.causingSubscriptions.length
          ? `Missing native subscriptions: ${row.causingSubscriptions.join(", ")}.`
          : "Native amendments price the month differently — review the subscription change history.",
      });
    }
  }
  for (const row of openAr) {
    if (row.diffMajor !== "0.0000") {
      differences.push({
        kind: "open_ar",
        ref: row.customerExternalId,
        sourceMajor: row.sourceOpenMajor,
        openbooksMajor: row.openbooksOpenMajor,
        explanation: "Source and native open balances disagree — compare the customer's invoices, credits and payments.",
      });
    }
  }
  if (deferredDiff !== "0.0000") {
    differences.push({
      kind: "deferred_revenue",
      ref: "cut-over",
      sourceMajor: sourceDeferred,
      openbooksMajor: openbooks.deferredMajor,
      explanation: "Unrecognized revenue schedules exceed (or trail) the native unearned balance — compare revenue schedules.",
    });
  }
  return {
    mrr: mrr.slice(-36),
    openAr: openAr.filter((row) => row.diffMajor !== "0.0000").slice(0, 200),
    sourceDeferredMajor: sourceDeferred,
    openbooksDeferredMajor: openbooks.deferredMajor,
    deferredDiffMajor: deferredDiff,
    differences: differences.slice(0, 200),
    ties: differences.length === 0,
  };
}

/** Source open AR by customer: invoice balances minus open credit balances, voided documents excluded. */
export function sourceOpenArByCustomer(source: CanonicalBillingHistory): Map<string, string> {
  const open = new Map<string, string>();
  for (const invoice of source.invoices) {
    if (invoice.status === "void" || invoice.balanceMajor === "0.0000") continue;
    open.set(invoice.customerExternalId, addMajor(open.get(invoice.customerExternalId) ?? "0.0000", invoice.balanceMajor));
  }
  for (const credit of source.creditNotes) {
    if (credit.balanceMajor === "0.0000") continue;
    open.set(credit.customerExternalId, subtractMajor(open.get(credit.customerExternalId) ?? "0.0000", credit.balanceMajor));
  }
  return open;
}

/** Source deferred revenue at cut-over: unrecognized schedule amounts. */
export function sourceDeferredRevenue(source: CanonicalBillingHistory): string {
  return source.revenueSchedules.reduce(
    (total, schedule) => (schedule.recognized ? total : addMajor(total, schedule.amountMajor)),
    "0.0000",
  );
}
