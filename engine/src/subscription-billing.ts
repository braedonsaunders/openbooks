import { sql } from "drizzle-orm";
import { db, withBypass, withOrg } from "./db.ts";
import { mul } from "./money.ts";
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

async function billOne(sub: SubRow, invoiceDate: string): Promise<{ invoiceId: string; documentNumber: string; posted: boolean }> {
  const price = sub.priceOverride ?? sub.planAmount;
  const lineAmount = mul(price, sub.quantity);
  const currency = sub.planCurrency ?? sub.baseCurrency;

  let incomeAccountId = sub.incomeAccountId;
  if (!incomeAccountId) {
    const def = (await db.execute(sql`
      select id from accounts where org_id = ${sub.orgId} and type in ('income', 'income_other') and is_active
       order by number nulls last limit 1
    `)) as unknown as { rows: { id: string }[] };
    incomeAccountId = def.rows[0]?.id ?? null;
  }
  if (!incomeAccountId) throw new SubscriptionError("no income account configured for the plan");

  const documentNumber = await nextNumber(sub.orgId, "customer_invoice", sub.subsidiaryId, "INV-");
  const created = (await db.execute(sql`
    insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                           subsidiary_id, memo, subtotal, tax_total, total, created_by)
    values (${sub.orgId}, 'customer_invoice', ${documentNumber}, ${sub.customerId}, ${invoiceDate}, ${currency},
            'draft', ${sub.subsidiaryId}, ${sub.planName}, ${lineAmount}, '0', ${lineAmount}, ${sub.id})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const invoiceId = created.rows[0]!.id;

  await db.execute(sql`
    insert into document_lines (org_id, document_id, line_number, item_id, account_id, description, quantity,
          unit_price, amount, tax_code_id, is_billable, created_by)
    values (${sub.orgId}, ${invoiceId}, 1, ${sub.itemId}, ${incomeAccountId}, ${sub.planName}, ${sub.quantity},
          ${price}, ${lineAmount}, ${sub.taxCodeId}, true, ${sub.id})
  `);

  let posted = false;
  if (sub.autoPost) {
    await postDocument(invoiceId, await controlDeps(sub.orgId));
    posted = true;
  }
  return { invoiceId, documentNumber, posted };
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
        update subscriptions set next_bill_on = ${advanced}, last_billed_at = now()
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
