import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  SubscriptionError,
  billSubscriptionNow,
  changeSubscription,
  monthlyRecurringRevenue,
  prorateFirstInvoice,
  type Interval,
} from "@openbooks/engine/src/subscription-billing.ts";
import { add } from "@openbooks/engine/src/money.ts";
import { requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";

export const runtime = "nodejs";

const INTERVALS = ["weekly", "monthly", "quarterly", "annually"];

/**
 * Subscription billing API — plans + subscriptions. Gated by the
 * subscriptionBilling feature (404 when off). The engine runner bills due
 * subscriptions automatically; this is the management + bill-now surface.
 */
export async function GET() {
  const authz = await requirePermission("ar.read");
  if (!(await isFeatureEnabled(authz.user.orgId, "subscriptionBilling"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = authz.user.orgId;
  const [plans, subs] = await Promise.all([
    db.execute(sql`
      select id, name, description, amount, currency_code as "currency", interval,
             interval_count as "intervalCount", income_account_id as "incomeAccountId",
             item_id as "itemId", tax_code_id as "taxCodeId", is_active as "isActive"
        from subscription_plans where org_id = ${orgId} order by name
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select s.id, s.customer_id as "customerId", s.plan_id as "planId", s.quantity,
             s.price_override as "priceOverride", s.status, s.start_on as "startOn",
             s.next_bill_on as "nextBillOn", s.auto_post as "autoPost", s.run_count as "runCount",
             s.last_invoice_id as "lastInvoiceId", s.last_error as "lastError",
             exists(select 1 from subscription_lifecycles l where l.subscription_id = s.id and l.org_id = s.org_id) as "advancedLifecycle",
             c.display_name as "customerName", p.name as "planName", p.amount as "planAmount",
             p.interval, p.interval_count as "intervalCount", p.currency_code as "planCurrency"
        from subscriptions s
        join subscription_plans p on p.id = s.plan_id and p.org_id = s.org_id
        left join parties c on c.id = s.customer_id and c.org_id = s.org_id
       where s.org_id = ${orgId} order by s.created_at desc
    `) as unknown as Promise<{ rows: any[] }>,
  ]);

  let mrr = "0.0000";
  const subscriptions = subs.rows.map((s) => {
    const m =
      s.status === "active"
        ? monthlyRecurringRevenue(String(s.priceOverride ?? s.planAmount ?? "0"), s.interval as Interval, Number(s.intervalCount ?? 1), String(s.quantity ?? "1"))
        : "0.0000";
    if (s.status === "active") mrr = add(mrr, m);
    return { ...s, mrr: m };
  });
  return NextResponse.json({ plans: plans.rows, subscriptions, mrr });
}

export async function POST(req: Request) {
  const authz = await requirePermission("ar.create");
  if (!(await isFeatureEnabled(authz.user.orgId, "subscriptionBilling"))) {
    return NextResponse.json({ error: "feature disabled" }, { status: 404 });
  }
  const orgId = authz.user.orgId;
  const userId = authz.user.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;

  try {
    switch (body.action) {
      case "addPlan": {
        if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
        if (!INTERVALS.includes(body.interval)) return NextResponse.json({ error: "invalid interval" }, { status: 400 });
        const r = (await db.execute(sql`
          insert into subscription_plans (org_id, name, description, amount, currency_code, interval,
                                          interval_count, income_account_id, item_id, tax_code_id, created_by, updated_by)
          values (${orgId}, ${body.name}, ${body.description ?? null}, ${String(body.amount ?? "0")},
                  ${body.currency ?? null}, ${body.interval}, ${Number(body.intervalCount ?? 1)},
                  ${body.incomeAccountId ?? null}, ${body.itemId ?? null}, ${body.taxCodeId ?? null}, ${userId}, ${userId})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        return NextResponse.json({ id: r.rows[0]!.id }, { status: 201 });
      }
      case "updatePlan": {
        await db.execute(sql`
          update subscription_plans set name = ${body.name}, description = ${body.description ?? null},
                 amount = ${String(body.amount ?? "0")}, currency_code = ${body.currency ?? null},
                 interval = ${body.interval}, interval_count = ${Number(body.intervalCount ?? 1)},
                 income_account_id = ${body.incomeAccountId ?? null}, item_id = ${body.itemId ?? null},
                 tax_code_id = ${body.taxCodeId ?? null}, is_active = ${body.isActive ?? true},
                 updated_at = now(), updated_by = ${userId}
           where id = ${body.id} and org_id = ${orgId}
        `);
        return NextResponse.json({ ok: true });
      }
      case "deletePlan": {
        const inUse = (await db.execute(sql`select 1 from subscriptions where plan_id = ${body.id} and org_id = ${orgId} limit 1`)) as unknown as { rows: unknown[] };
        if (inUse.rows.length) return NextResponse.json({ error: "plan has subscriptions — archive it instead" }, { status: 422 });
        await db.execute(sql`delete from subscription_plans where id = ${body.id} and org_id = ${orgId}`);
        return NextResponse.json({ ok: true });
      }
      case "addSubscription": {
        if (!body.customerId || !body.planId) return NextResponse.json({ error: "customer and plan required" }, { status: 400 });
        const startOn = body.startOn || new Date().toISOString().slice(0, 10);
        // firstBillOn is when the first FULL cycle bills; if it's after the start
        // and proration is requested, we bill the partial [start, firstBillOn] now.
        const firstBillOn = body.firstBillOn || startOn;
        const r = (await db.execute(sql`
          insert into subscriptions (org_id, customer_id, plan_id, quantity, price_override, start_on,
                                     next_bill_on, current_period_start, auto_post, memo, created_by, updated_by)
          values (${orgId}, ${body.customerId}, ${body.planId}, ${String(body.quantity ?? "1")},
                  ${body.priceOverride != null && body.priceOverride !== "" ? String(body.priceOverride) : null},
                  ${startOn}, ${firstBillOn}, ${startOn}, ${body.autoPost ?? false}, ${body.memo ?? null}, ${userId}, ${userId})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        const id = r.rows[0]!.id;
        let proration: unknown = null;
        if (body.prorateFirstPeriod && firstBillOn > startOn) {
          proration = await prorateFirstInvoice(id, firstBillOn);
        }
        return NextResponse.json({ id, proration }, { status: 201 });
      }
      case "changeSubscription": {
        const owned = (await db.execute(sql`select 1 from subscriptions where id = ${body.id} and org_id = ${orgId}`)) as unknown as { rows: unknown[] };
        if (!owned.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
        const result = await changeSubscription(body.id, {
          quantity: body.quantity != null ? String(body.quantity) : undefined,
          priceOverride: "priceOverride" in body ? (body.priceOverride != null && body.priceOverride !== "" ? String(body.priceOverride) : null) : undefined,
        });
        return NextResponse.json(result);
      }
      case "updateSubscription": {
        const sets = [];
        if ("status" in body) sets.push(sql`status = ${body.status}`);
        if (body.status === "canceled") sets.push(sql`canceled_on = ${new Date().toISOString().slice(0, 10)}`);
        if ("quantity" in body) sets.push(sql`quantity = ${String(body.quantity)}`);
        if ("priceOverride" in body) sets.push(sql`price_override = ${body.priceOverride != null && body.priceOverride !== "" ? String(body.priceOverride) : null}`);
        if ("autoPost" in body) sets.push(sql`auto_post = ${Boolean(body.autoPost)}`);
        if ("nextBillOn" in body) sets.push(sql`next_bill_on = ${body.nextBillOn}`);
        if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
        await db.execute(sql`update subscriptions set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${userId} where id = ${body.id} and org_id = ${orgId}`);
        return NextResponse.json({ ok: true });
      }
      case "billNow": {
        const owned = (await db.execute(sql`select 1 from subscriptions where id = ${body.id} and org_id = ${orgId}`)) as unknown as { rows: unknown[] };
        if (!owned.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
        const gen = await billSubscriptionNow(body.id);
        return NextResponse.json(gen);
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
