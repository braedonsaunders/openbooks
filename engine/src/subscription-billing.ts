import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { add, mul, mulRatio, neg, toUnits } from "./money.ts";
import { computeLineTaxes } from "./tax.ts";
import { loadTaxComponentConfig, persistLineTaxComponents } from "./tax-persist.ts";
import { postDocument, type PostingDeps } from "./posting.ts";

/**
 * Subscription billing engine. Each active subscription is billed when its
 * next_bill_on comes due: the runner generates a customer_invoice for the plan
 * price × quantity, optionally posts it, and advances next_bill_on by the plan
 * interval. Billing is claimed with the scheduler's advance-and-guard trick so
 * it can never double-bill. Gated by the org's `subscriptionBilling` feature —
 * disabling the feature stops automated billing without touching any data.
 */

export type Interval = "weekly" | "monthly" | "quarterly" | "annually";

export class SubscriptionError extends Error {}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Advance an ISO date by one billing interval (× intervalCount). Month/quarter/
 * year steps clamp to the end of a shorter target month (Jan 31 +1mo → Feb 28).
 * Pure — unit-tested.
 */
export function advanceSubscription(isoDate: string, interval: Interval, intervalCount = 1): string {
  const n = Math.max(1, intervalCount);
  const [y, m, d] = isoDate.split("-").map(Number);
  if (interval === "weekly") {
    const base = new Date(Date.UTC(y!, m! - 1, d!));
    base.setUTCDate(base.getUTCDate() + 7 * n);
    return toIso(base);
  }
  const monthStep = (interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12) * n;
  const targetMonthIndex = m! - 1 + monthStep;
  const targetYear = y! + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(d!, lastDay))}`;
}

/** Normalize a subscription's charge to a monthly figure (analytics only). */
export function monthlyRecurringRevenue(
  amount: string,
  interval: Interval,
  intervalCount: number,
  quantity: string,
): number {
  const perPeriod = Number(mul(amount, quantity));
  const months = (interval === "weekly" ? 12 / 52 : interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12) * Math.max(1, intervalCount);
  return months > 0 ? perPeriod / months : 0;
}

async function nextNumber(orgId: string, kind: string, subsidiaryId: string | null, prefix: string): Promise<string> {
  const configured = subsidiaryId
    ? ((await db.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`)) as unknown as { rows: unknown[] }).rows.length > 0
    : false;
  const seqSub = configured ? subsidiaryId : null;
  const r = (await db.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${seqSub}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
  const s = r.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

async function controlDeps(orgId: string): Promise<PostingDeps> {
  const r = (await db.execute(
    sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { c: Record<string, string> | null }[] };
  const c = r.rows[0]?.c ?? {};
  return {
    control: { ar: c.ar!, ap: c.ap!, bank: c.bank!, taxCollected: c.taxCollected, taxPaid: c.taxPaid, employeePayable: c.employeePayable },
  };
}

interface SubRow {
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
}

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

async function resolveIncomeAccount(orgId: string, incomeAccountId: string | null): Promise<string> {
  if (incomeAccountId) return incomeAccountId;
  const def = (await db.execute(sql`
    select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
     order by number nulls last limit 1
  `)) as unknown as { rows: { id: string }[] };
  const id = def.rows[0]?.id;
  if (!id) throw new SubscriptionError("no income account configured for the plan");
  return id;
}

interface InvoiceSpec {
  orgId: string;
  actorId: string;
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
  autoPost: boolean;
  /** When false, tax is skipped even if a tax code is present (proration credits). */
  applyTax?: boolean;
}

/**
 * Create a single-line customer_invoice for a subscription charge, computing and
 * persisting tax the same way the interactive path does (so it can be posted).
 */
async function createSubscriptionInvoice(
  spec: InvoiceSpec,
): Promise<{ invoiceId: string; documentNumber: string; posted: boolean; total: string }> {
  const netAmount = mul(spec.quantity, spec.unitPrice);
  const applyTax = spec.applyTax !== false && spec.taxCodeId && toUnits(netAmount) > 0n;

  let taxTotal = "0.0000";
  let components: Awaited<ReturnType<typeof computeLineTaxes>>["components"] = [];
  if (applyTax) {
    const cfg = await loadTaxComponentConfig(spec.orgId, spec.taxCodeId!, spec.invoiceDate);
    if (cfg.length) {
      const res = computeLineTaxes(netAmount, cfg, {});
      taxTotal = res.taxTotal;
      components = res.components;
    }
  }
  const total = add(netAmount, taxTotal);
  const incomeAccountId = await resolveIncomeAccount(spec.orgId, spec.incomeAccountId);

  const documentNumber = await nextNumber(spec.orgId, "customer_invoice", spec.subsidiaryId, "INV-");
  const created = (await db.execute(sql`
    insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                           subsidiary_id, memo, subtotal, tax_total, total, created_by)
    values (${spec.orgId}, 'customer_invoice', ${documentNumber}, ${spec.customerId}, ${spec.invoiceDate},
            ${spec.currency}, 'draft', ${spec.subsidiaryId}, ${spec.memo}, ${netAmount}, ${taxTotal}, ${total}, ${spec.actorId})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const invoiceId = created.rows[0]!.id;

  const line = (await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity,
          unit_price, amount, tax_code_id, tax_amount, is_billable, created_by)
    values (${spec.orgId}, ${invoiceId}, 1, ${spec.itemId}, ${incomeAccountId}, ${spec.description},
          ${spec.quantity}, ${spec.unitPrice}, ${netAmount}, ${applyTax ? spec.taxCodeId : null}, ${taxTotal}, true, ${spec.actorId})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  if (components.length) {
    await persistLineTaxComponents(spec.orgId, line.rows[0]!.id, components, spec.actorId);
  }

  let posted = false;
  if (spec.autoPost) {
    await postDocument(invoiceId, await controlDeps(spec.orgId));
    posted = true;
  }
  return { invoiceId, documentNumber, posted, total };
}

async function billOne(sub: SubRow, invoiceDate: string): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  const price = sub.priceOverride ?? sub.planAmount;
  return createSubscriptionInvoice({
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
  });
}

const SUB_SELECT = sql`
  select s.id, s.org_id as "orgId", s.customer_id as "customerId", s.quantity,
         s.price_override as "priceOverride", s.auto_post as "autoPost",
         p.name as "planName", p.amount as "planAmount", p.currency_code as "planCurrency",
         p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
         p.interval, p.interval_count as "intervalCount",
         (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "subsidiaryId",
         o.base_currency as "baseCurrency"
    from subscriptions s
    join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
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
  const today = asOf ?? toIso(new Date());
  const result: SubscriptionRunResult = { billed: 0, posted: 0, failed: 0 };

  const due = await withBypass(async () =>
    (await db.execute(sql`
      select s.id, s.org_id as "orgId", s.next_bill_on as "nextBillOn",
             p.interval, p.interval_count as "intervalCount"
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        join orgs o on o.id = s.org_id
       where s.status = 'active' and s.next_bill_on <= ${today}
         and coalesce((o.settings->'features'->>'subscriptionBilling')::boolean, false)
    `)) as unknown as {
      rows: { id: string; orgId: string; nextBillOn: string; interval: Interval; intervalCount: number }[];
    },
  );

  for (const row of due.rows) {
    const advanced = advanceSubscription(row.nextBillOn, row.interval, row.intervalCount);
    const claimed = await withBypass(async () =>
      (await db.execute(sql`
        update subscriptions
           set next_bill_on = ${advanced}, current_period_start = ${row.nextBillOn}, last_billed_at = now()
         where id = ${row.id} and next_bill_on = ${row.nextBillOn} and status = 'active'
        returning id
      `)) as unknown as { rows: { id: string }[] },
    );
    if (!claimed.rows.length) continue;

    try {
      const sub = await withOrg(row.orgId, async () => {
        const r = (await db.execute(sql`${SUB_SELECT} where s.id = ${row.id} limit 1`)) as unknown as { rows: SubRow[] };
        const s = r.rows[0];
        if (!s) throw new SubscriptionError("subscription vanished");
        return billOne(s, row.nextBillOn);
      });
      result.billed += 1;
      if (sub.posted) result.posted += 1;
      await withBypass(async () => {
        await db.execute(sql`
          update subscriptions set run_count = run_count + 1, last_invoice_id = ${sub.invoiceId}, last_error = null
           where id = ${row.id}
        `);
      });
    } catch (e) {
      result.failed += 1;
      const message = e instanceof Error ? e.message : String(e);
      await withBypass(async () => {
        await db.execute(sql`update subscriptions set last_error = ${message} where id = ${row.id}`);
      });
    }
  }
  return result;
}

/** Bill one subscription immediately (the "bill now" button), no date advance. */
export async function billSubscriptionNow(subscriptionId: string, asOf?: string): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  const today = asOf ?? toIso(new Date());
  const meta = await withBypass(async () =>
    (await db.execute(sql`select org_id as "orgId" from subscriptions where id = ${subscriptionId}`)) as unknown as {
      rows: { orgId: string }[];
    },
  );
  const orgId = meta.rows[0]?.orgId;
  if (!orgId) throw new SubscriptionError("subscription not found");
  const gen = await withOrg(orgId, async () => {
    const r = (await db.execute(sql`${SUB_SELECT} where s.id = ${subscriptionId} limit 1`)) as unknown as { rows: SubRow[] };
    const s = r.rows[0];
    if (!s) throw new SubscriptionError("subscription not found");
    return billOne(s, today);
  });
  await withBypass(async () => {
    await db.execute(sql`
      update subscriptions set run_count = run_count + 1, last_invoice_id = ${gen.invoiceId},
             last_billed_at = now(), last_error = null
       where id = ${subscriptionId}
    `);
  });
  return gen;
}

interface SubDetail extends SubRow {
  nextBillOn: string;
  currentPeriodStart: string | null;
  startOn: string;
  status: string;
}

async function loadSubDetail(subscriptionId: string): Promise<{ orgId: string; row: SubDetail }> {
  const meta = await withBypass(async () =>
    (await db.execute(sql`select org_id as "orgId" from subscriptions where id = ${subscriptionId}`)) as unknown as {
      rows: { orgId: string }[];
    },
  );
  const orgId = meta.rows[0]?.orgId;
  if (!orgId) throw new SubscriptionError("subscription not found");
  const row = await withOrg(orgId, async () => {
    const r = (await db.execute(sql`
      select s.id, s.org_id as "orgId", s.customer_id as "customerId", s.quantity,
             s.price_override as "priceOverride", s.auto_post as "autoPost",
             p.name as "planName", p.amount as "planAmount", p.currency_code as "planCurrency",
             p.income_account_id as "incomeAccountId", p.item_id as "itemId", p.tax_code_id as "taxCodeId",
             p.interval, p.interval_count as "intervalCount",
             (select id from subsidiaries where org_id = s.org_id and parent_id is null limit 1) as "subsidiaryId",
             o.base_currency as "baseCurrency", s.next_bill_on as "nextBillOn",
             s.current_period_start as "currentPeriodStart", s.start_on as "startOn", s.status
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        join orgs o on o.id = s.org_id
       where s.id = ${subscriptionId} limit 1
    `)) as unknown as { rows: SubDetail[] };
    const d = r.rows[0];
    if (!d) throw new SubscriptionError("subscription not found");
    return d;
  });
  return { orgId, row };
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
  const today = asOf ?? toIso(new Date());
  const { orgId, row } = await loadSubDetail(subscriptionId);
  if (row.status === "canceled") throw new SubscriptionError("subscription is canceled");

  const oldQty = row.quantity;
  const oldPrice = row.priceOverride ?? row.planAmount;
  const newQty = changes.quantity ?? oldQty;
  const newPrice = changes.priceOverride !== undefined ? (changes.priceOverride ?? row.planAmount) : oldPrice;
  const oldFull = mul(oldQty, oldPrice);
  const newFull = mul(newQty, newPrice);

  const periodStart = row.currentPeriodStart ?? row.startOn;
  const periodEnd = row.nextBillOn;
  // Prorated value of each configuration for the remaining slice of the period.
  const oldRemaining = prorate(oldFull, periodStart, periodEnd, today);
  const newRemaining = prorate(newFull, periodStart, periodEnd, today);
  const adjustment = add(newRemaining, neg(oldRemaining)); // >0 upgrade charge, <0 credit

  let invoiceId: string | null = null;
  let documentNumber: string | null = null;
  if (toUnits(adjustment) !== 0n) {
    const gen = await withOrg(orgId, () =>
      createSubscriptionInvoice({
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
        unitPrice: adjustment,
        memo: "Subscription proration",
        invoiceDate: today,
        autoPost: false,
        applyTax: false,
      }),
    );
    invoiceId = gen.invoiceId;
    documentNumber = gen.documentNumber;
  }

  await withBypass(async () => {
    await db.execute(sql`
      update subscriptions set quantity = ${newQty},
             price_override = ${changes.priceOverride !== undefined ? (changes.priceOverride ?? null) : row.priceOverride},
             last_invoice_id = coalesce(${invoiceId}, last_invoice_id), updated_at = now()
       where id = ${subscriptionId}
    `);
  });
  return { invoiceId, documentNumber, adjustment };
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
  const today = asOf ?? toIso(new Date());
  const { orgId, row } = await loadSubDetail(subscriptionId);
  const price = row.priceOverride ?? row.planAmount;
  const full = mul(row.quantity, price);
  // Prorate the partial period [startOn, firstBillOn] for the days from start.
  const amount = prorate(full, row.startOn, firstBillOn, row.startOn > today ? row.startOn : today);
  if (toUnits(amount) <= 0n) throw new SubscriptionError("nothing to prorate for the first period");

  const gen = await withOrg(orgId, () =>
    createSubscriptionInvoice({
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
    }),
  );
  await withBypass(async () => {
    await db.execute(sql`
      update subscriptions set next_bill_on = ${firstBillOn}, current_period_start = ${row.startOn},
             run_count = run_count + 1, last_invoice_id = ${gen.invoiceId}, last_billed_at = now()
       where id = ${subscriptionId}
    `);
  });
  return { ...gen, amount };
}
