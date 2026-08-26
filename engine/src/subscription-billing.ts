import { sql } from "drizzle-orm";
import { canonicalDecimal } from "./exact-decimal.ts";
import { db, withBypass, withOrg } from "./db.ts";
import { addCalendarDays, businessToday } from "./business-date.ts";
import { now } from "./clock.ts";
import { loadRequiredControlAccounts } from "./control-accounts.ts";
import { add, mul, mulRatio, neg, normalizeMoney, toUnits } from "./money.ts";
import { computeLineTaxes } from "./tax.ts";
import { loadTaxComponentConfig, persistLineTaxComponents } from "./tax-persist.ts";
import { postDocument, type PostingDeps } from "./posting.ts";
import { submitAndReleaseIfUngated } from "./flows/submit.ts";
import {
  advancedBillingSnapshot,
  prepareAdvancedSubscriptionBilling,
  type AdvancedBillingLine,
} from "./advanced-subscriptions.ts";
import { inventoryFeatureEnabled } from "./inventory.ts";

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
  if (exact === null) throw new SubscriptionError(`${label} must be an exact decimal`);
  let normalized: string;
  try {
    normalized = normalizeMoney(exact);
  } catch {
    throw new SubscriptionError(`${label} must be an exact decimal`);
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
 * year steps clamp to the end of a shorter target month (Jan 31 +1mo → Feb 28).
 * Pure — unit-tested.
 */
export function advanceSubscription(isoDate: string, interval: Interval, intervalCount = 1): string {
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
  const monthStep = (cadence.interval === "monthly" ? 1 : cadence.interval === "quarterly" ? 3 : 12) * n;
  const targetMonthIndex = m! - 1 + monthStep;
  const targetYear = y! + Math.floor(targetMonthIndex / 12);
  if (!Number.isSafeInteger(targetYear) || targetYear > 9999) {
    throw new SubscriptionError("billing cadence advances outside the supported date range");
  }
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDayDate = new Date(0);
  lastDayDate.setUTCHours(0, 0, 0, 0);
  lastDayDate.setUTCFullYear(targetYear, targetMonth + 1, 0);
  const lastDay = lastDayDate.getUTCDate();
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(d!, lastDay))}`;
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

async function nextNumber(orgId: string, kind: string, subsidiaryId: string | null, prefix: string): Promise<string> {
  const configured = subsidiaryId
    ? ((await db.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`))).rows.length > 0
    : false;
  const seqSub = configured ? subsidiaryId : null;
  const r = (await db.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${seqSub}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `));
  const s = r.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
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
  quantity: string;
  priceOverride: string | null;
  autoPost: boolean;
  planName: string;
  planAmount: string;
  planCurrency: string | null;
  incomeAccountId: string | null;
  itemId: string | null;
  taxCodeId: string | null;
  interval: Interval;
  intervalCount: number;
  subsidiaryId: string | null;
  baseCurrency: string;
  nextBillOn: string;
  currentPeriodStart: string | null;
  createdBy: string | null;
};

/** Whole-day count b − a (both ISO). */
function dayDiff(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

/**
 * Exact prorated amount of `fullAmount` for the slice [asOf, periodEnd] of the
 * period [periodStart, periodEnd] — full × remainingDays / totalDays, rounded to
 * ledger precision. Pure — unit-tested. Zero when the period is degenerate.
 */
export function prorate(fullAmount: string, periodStart: string, periodEnd: string, asOf: string): string {
  const total = dayDiff(periodStart, periodEnd);
  if (total <= 0) return "0.0000";
  const remaining = Math.max(0, Math.min(total, dayDiff(asOf, periodEnd)));
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
  if (incomeAccountId) return incomeAccountId;
  const def = (await db.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
     order by number nulls last limit 1
  `));
  const id = def.rows[0]?.id;
  if (!id) throw new SubscriptionError("no income account configured for the plan");
  return id;
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
  const equipmentOn = (await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'equipment')::boolean, true) as enabled
      from orgs where id = ${spec.orgId}
  `)).rows[0]?.enabled === true;
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
    taxAmount: string;
    accountId: string;
    taxComponents: Awaited<ReturnType<typeof computeLineTaxes>>["components"];
  }> = [];
  for (const input of invoiceLines) {
    const quantity = persistSubscriptionMoney(input.quantity, "quantity", "positive");
    const unitPrice = persistSubscriptionMoney(input.unitPrice, "unit price", "nonnegative");
    const amount = mul(quantity, unitPrice);
    const applyTax = spec.applyTax !== false && input.taxCodeId && toUnits(amount) > 0n;
    let lineTax = "0.0000";
    let taxComponents: Awaited<ReturnType<typeof computeLineTaxes>>["components"] = [];
    if (applyTax) {
      const cfg = await loadTaxComponentConfig(spec.orgId, input.taxCodeId!, spec.invoiceDate);
      if (cfg.length) {
        const res = computeLineTaxes(amount, cfg, {});
        lineTax = res.taxTotal;
        taxComponents = res.components;
      }
    }
    netAmount = add(netAmount, amount);
    taxTotal = add(taxTotal, lineTax);
    prepared.push({ input: { ...input, quantity, unitPrice }, amount, taxAmount: lineTax, accountId: await resolveIncomeAccount(spec.orgId, input.incomeAccountId), taxComponents });
  }
  const total = add(netAmount, taxTotal);

  const kind = spec.documentKind ?? "customer_invoice";
  const documentNumber = await nextNumber(spec.orgId, kind, spec.subsidiaryId, kind === "customer_credit" ? "CM-" : "INV-");
  const created = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, party_id, document_date, due_date, currency, status,
                           subsidiary_id, location_id, memo, subtotal, tax_total, total, custom, created_by)
    values (${spec.orgId}, ${kind}, ${documentNumber}, ${spec.customerId}, ${spec.invoiceDate}, ${spec.dueDate ?? null},
            ${spec.currency}, 'draft', ${spec.subsidiaryId}, ${spec.locationId ?? null}, ${spec.memo}, ${netAmount}, ${taxTotal}, ${total},
            ${JSON.stringify(spec.custom ?? {})}::jsonb, ${spec.actorId})
    returning id
  `));
  const invoiceId = created.rows[0]!.id;

  for (const [index, preparedLine] of prepared.entries()) {
    const line = (await db.execute<{ id: string }>(sql`
      insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity,
            unit_price, amount, tax_code_id, tax_amount, is_billable, created_by)
      values (${spec.orgId}, ${invoiceId}, ${index + 1}, ${preparedLine.input.itemId}, ${preparedLine.accountId},
            ${preparedLine.input.description}, ${preparedLine.input.quantity}, ${preparedLine.input.unitPrice},
            ${preparedLine.amount}, ${preparedLine.input.taxCodeId}, ${preparedLine.taxAmount}, true, ${spec.actorId})
      returning id
    `));
    if (preparedLine.taxComponents.length) {
      await persistLineTaxComponents(spec.orgId, line.rows[0]!.id, preparedLine.taxComponents, spec.actorId);
    }
  }

  let posted = false;
  if (spec.autoPost) {
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

async function billOne(
  sub: SubRow,
  invoiceDate: string,
  billingDate = invoiceDate,
  periodStartOverride?: string | null,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  // Serialize every invoice attempt for one subscription. This makes the
  // period/revision lookup + document creation + guard insert one atomic claim;
  // a concurrent caller waits, then replays the committed invoice instead of
  // leaving an orphan duplicate document.
  await db.execute(sql`select id from subscriptions where id = ${sub.id} and org_id = ${sub.orgId} for update`);
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
        endsOn: advanceSubscription(billingDate, sub.interval, sub.intervalCount),
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
  if (prior.rows[0]) return { invoiceId: prior.rows[0].invoiceId, documentNumber: prior.rows[0].documentNumber, posted: prior.rows[0].status === "posted" };
  const generated = await createSubscriptionInvoice({
    orgId: sub.orgId,
    actorId: sub.id,
    customerId: sub.customerId,
    subsidiaryId: sub.subsidiaryId,
    currency: sub.planCurrency ?? sub.baseCurrency,
    incomeAccountId: sub.incomeAccountId,
    itemId: sub.itemId,
    taxCodeId: sub.taxCodeId,
    description: sub.planName,
    quantity: sub.quantity,
    unitPrice: price,
    memo: sub.planName,
    invoiceDate,
    autoPost: sub.autoPost,
    lines: advanced?.lines,
  });
  await db.execute(sql`
    insert into subscription_period_invoices
      (org_id, subscription_id, period_starts_on, period_ends_on, contract_revision, invoice_id, created_by, updated_by)
    values (${sub.orgId}, ${sub.id}, ${guard.startsOn}, ${guard.endsOn},
            ${guard.revision}, ${generated.invoiceId}, ${sub.createdBy}, ${sub.createdBy})
  `);
  return generated;
}

const SUB_SELECT = sql`
  select s.id, s.org_id as "orgId", s.customer_id as "customerId", s.quantity,
         s.price_override as "priceOverride", s.auto_post as "autoPost",
         p.name as "planName", p.amount as "planAmount", p.currency_code as "planCurrency",
         p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
         coalesce(v.interval, p.interval) as interval, coalesce(v.interval_count, p.interval_count) as "intervalCount",
         (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "subsidiaryId",
         o.base_currency as "baseCurrency", s.next_bill_on as "nextBillOn", s.current_period_start as "currentPeriodStart",
         s.created_by as "createdBy"
    from subscriptions s
    join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
    left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
    left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
    join orgs o on o.id = s.org_id`;

export interface SubscriptionRunResult {
  billed: number;
  posted: number;
  failed: number;
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
    }>(sql`
      select s.id, s.org_id as "orgId", s.next_bill_on as "nextBillOn",
             s.current_period_start as "currentPeriodStart",
             s.quantity, s.price_override as "priceOverride", p.amount as "planAmount",
             coalesce(v.interval, p.interval) as interval, coalesce(v.interval_count, p.interval_count) as "intervalCount"
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
        left join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = s.org_id
        join orgs o on o.id = s.org_id
       where s.status = 'active' and s.next_bill_on <= ${scanCutoff}
         and o.env_kind = 'production'
         and coalesce((o.settings->'features'->>'subscriptionBilling')::boolean, false)
         and (l.id is null or coalesce((o.settings->'features'->>'advancedSubscriptions')::boolean, false))
    `)),
  );

  for (const row of due.rows) {
    let today = asOf ?? orgBusinessDates.get(row.orgId);
    if (!today) {
      today = await withOrg(row.orgId, () => businessToday(row.orgId));
      orgBusinessDates.set(row.orgId, today);
    }
    if (row.nextBillOn > today) continue;

    let advanced: string;
    try {
      // Validate every stored base value before an advanced-lifecycle helper or
      // billing transaction can write. The same checks run again at invoice
      // persistence, so a bypassed or residual row cannot become a charge.
      normalizeSubscriptionMoney(row.quantity, "stored quantity", "positive");
      normalizeSubscriptionMoney(row.priceOverride ?? row.planAmount, "stored price", "nonnegative");
      advanced = advanceSubscription(row.nextBillOn, row.interval, row.intervalCount);
      const canBill = await prepareAdvancedSubscriptionBilling(row.orgId, row.id, row.nextBillOn);
      if (!canBill) {
        await withBypass(async () => db.execute(sql`
          update subscriptions set last_error = 'Contract term ended — renewal required' where id = ${row.id} and org_id = ${row.orgId}
        `));
        continue;
      }
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await withBypass(async () => db.execute(sql`update subscriptions set last_error = ${message} where id = ${row.id} and org_id = ${row.orgId}`));
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
        return billOne(s, row.nextBillOn, row.nextBillOn, row.currentPeriodStart);
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
      await withBypass(async () => {
        await db.execute(sql`update subscriptions set last_error = ${message} where id = ${row.id} and org_id = ${row.orgId}`);
      });
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
    // Surface through last_error instead; the claim stays advanced.
    try {
      await withBypass(async () => {
        await db.execute(sql`
          update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_error = null
           where id = ${row.id} and org_id = ${row.orgId}
        `);
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[subscriptions] success bookkeeping failed for subscription ${row.id}:`, message);
      await withBypass(async () => {
        await db.execute(sql`
          update subscriptions set last_error = ${`invoiced ${gen.documentNumber} but bookkeeping failed: ${message}`}
           where id = ${row.id} and org_id = ${row.orgId}
        `);
      });
    }
  }
  return result;
}

/** Bill one subscription immediately (the "bill now" button), no date advance. */
export async function billSubscriptionNow(subscriptionId: string, asOf?: string): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  const meta = await withBypass(async () =>
    (await db.execute<{ orgId: string; advancedLifecycle: boolean; advancedEnabled: boolean }>(sql`
      select s.org_id as "orgId", l.id is not null as "advancedLifecycle",
             coalesce((o.settings->'features'->>'advancedSubscriptions')::boolean, false) as "advancedEnabled"
        from subscriptions s join orgs o on o.id = s.org_id
        left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
       where s.id = ${subscriptionId}
    `)),
  );
  const orgId = meta.rows[0]?.orgId;
  if (!orgId) throw new SubscriptionError("subscription not found");
  if (meta.rows[0]!.advancedLifecycle && !meta.rows[0]!.advancedEnabled) throw new SubscriptionError("advanced subscription lifecycle is disabled");
  const today = asOf ?? (await businessToday(orgId));
  const gen = await withOrg(orgId, async () => {
    const r = (await db.execute<SubRow>(sql`${SUB_SELECT} where s.id = ${subscriptionId} and s.org_id = ${orgId} limit 1`));
    const s = r.rows[0];
    if (!s) throw new SubscriptionError("subscription not found");
    return billOne(s, today, s.nextBillOn, s.currentPeriodStart);
  });
  await withBypass(async () => {
    await db.execute(sql`
      update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId},
             last_billed_at = now(), last_error = null
       where id = ${subscriptionId} and org_id = ${orgId}
    `);
  });
  return gen;
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

/** Resolve the owning org — the tenant must be known before any scoped read. */
async function loadSubOrgId(subscriptionId: string): Promise<string> {
  const meta = await withBypass(async () =>
    (await db.execute<{ orgId: string }>(sql`select org_id as "orgId" from subscriptions where id = ${subscriptionId}`)),
  );
  const orgId = meta.rows[0]?.orgId;
  if (!orgId) throw new SubscriptionError("subscription not found");
  return orgId;
}

/**
 * Read the full subscription detail. Must run inside the caller's org
 * transaction (see withOrg) — mutation paths call this after taking the
 * subscription row lock so they price from locked, current state.
 */
async function loadSubRow(subscriptionId: string, orgId: string): Promise<SubDetail> {
  const r = (await db.execute<SubDetail>(sql`
    select s.id, s.org_id as "orgId", s.customer_id as "customerId", s.quantity,
           s.price_override as "priceOverride", s.auto_post as "autoPost",
           p.name as "planName", p.amount as "planAmount", p.currency_code as "planCurrency",
           p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
           p.interval, p.interval_count as "intervalCount",
           (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "subsidiaryId",
           o.base_currency as "baseCurrency", s.next_bill_on as "nextBillOn",
           s.current_period_start as "currentPeriodStart", s.start_on as "startOn", s.status, s.created_by as "createdBy",
           s.last_invoice_id as "lastInvoiceId", s.run_count as "runCount",
           exists(select 1 from subscription_lifecycles l where l.subscription_id = s.id and l.org_id = s.org_id) as "advancedLifecycle"
      from subscriptions s
      join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
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
 * proration line is a pre-tax net adjustment left as a draft for review; the
 * next full invoice uses the new quantity/price.
 */
export async function changeSubscription(
  subscriptionId: string,
  changes: { quantity?: string; priceOverride?: string | null },
  asOf?: string,
): Promise<{ invoiceId: string | null; documentNumber: string | null; adjustment: string }> {
  const orgId = await loadSubOrgId(subscriptionId);
  const today = asOf ?? (await businessToday(orgId));
  // Serialize the whole change (read → proration → invoice → subscription
  // update) on the subscription row lock, the same way billOne serializes
  // invoice attempts: two concurrent changes must not both price from the
  // same pre-change state and each cut a proration invoice (double billing).
  // One transaction also commits the invoice and the configuration change
  // together or not at all.
  return withOrg(orgId, async () => {
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
    // Prorated value of each configuration for the remaining slice of the period.
    const oldRemaining = prorate(oldFull, periodStart, periodEnd, today);
    const newRemaining = prorate(newFull, periodStart, periodEnd, today);
    const adjustment = add(newRemaining, neg(oldRemaining)); // >0 upgrade charge, <0 credit

    let invoiceId: string | null = null;
    let documentNumber: string | null = null;
    if (toUnits(adjustment) !== 0n) {
      const doc = prorationDocument(adjustment);
      const gen = await createSubscriptionInvoice({
        orgId,
        actorId: subscriptionId,
        customerId: row.customerId,
        subsidiaryId: row.subsidiaryId,
        currency: row.planCurrency ?? row.baseCurrency,
        incomeAccountId: row.incomeAccountId,
        itemId: null,
        taxCodeId: null,
        description: `Proration — plan change (${periodStart} → ${periodEnd})`,
        quantity: "1",
        unitPrice: doc.amount,
        memo: "Subscription proration",
        invoiceDate: today,
        autoPost: false,
        applyTax: false,
        documentKind: doc.kind,
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
 * Bill a prorated first invoice for the partial period [startOn, firstBillOn]
 * and set the subscription's period tracking. Used when a subscription starts
 * mid-period and the customer should pay only for the days used before the first
 * full cycle. Positive charge → taxed like a normal invoice.
 */
export async function prorateFirstInvoice(
  subscriptionId: string,
  firstBillOn: string,
  asOf?: string,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; amount: string }> {
  const orgId = await loadSubOrgId(subscriptionId);
  const today = asOf ?? (await businessToday(orgId));
  // Same single-transaction row lock as changeSubscription: a double-click
  // must not cut two prorated first invoices from the same pre-bill state.
  return withOrg(orgId, async () => {
    await db.execute(sql`select id from subscriptions where id = ${subscriptionId} and org_id = ${orgId} for update`);
    const row = await loadSubRow(subscriptionId, orgId);
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
    // Prorate the partial period [startOn, firstBillOn] for the days from start.
    const amount = prorate(full, row.startOn, firstBillOn, row.startOn > today ? row.startOn : today);
    if (toUnits(amount) <= 0n) throw new SubscriptionError("nothing to prorate for the first period");

    const gen = await createSubscriptionInvoice({
      orgId,
      actorId: subscriptionId,
      customerId: row.customerId,
      subsidiaryId: row.subsidiaryId,
      currency: row.planCurrency ?? row.baseCurrency,
      incomeAccountId: row.incomeAccountId,
      itemId: row.itemId,
      taxCodeId: row.taxCodeId,
      description: `${row.planName} (prorated ${row.startOn} → ${firstBillOn})`,
      quantity: "1",
      unitPrice: amount,
      memo: row.planName,
      invoiceDate: today,
      autoPost: row.autoPost,
    });
    await db.execute(sql`
      update subscriptions set next_bill_on = ${firstBillOn}, current_period_start = ${row.startOn},
             run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_billed_at = now()
       where id = ${subscriptionId} and org_id = ${orgId}
    `);
    return { ...gen, amount };
  });
}
