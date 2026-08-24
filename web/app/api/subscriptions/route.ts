import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  SubscriptionError,
  billSubscriptionNow,
  changeSubscription,
  monthlyRecurringRevenue,
  prorateFirstInvoice,
  type Interval,
} from "@openbooks/engine/src/subscription-billing.ts";
import { add, normalizeMoney } from "@openbooks/engine/src/money.ts";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { requirePermission } from "../../../lib/authz";
import { isFeatureEnabled } from "../../../lib/features";
import { businessToday } from "@openbooks/engine/src/business-date.ts";

export const runtime = "nodejs";

const INTERVALS = ["weekly", "monthly", "quarterly", "annually"];
const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

/** Stored plans stay when item_id is omitted. A new inventory / assembly / kit
 *  item is Inventory configuration — refuse it when that switch is off. A new
 *  equipment_charge item is Equipment configuration — refuse it when that
 *  switch is off. */
async function refuseInventoryPlanItem(
  orgId: string,
  itemId: unknown,
  storedItemId?: string | null,
): Promise<NextResponse | null> {
  if (itemId === undefined || itemId === null || itemId === "") return null;
  const nextId = String(itemId);
  if (storedItemId && nextId === storedItemId) return null;
  const item = (await db.execute<{ kind: string }>(sql`
    select kind from items where id = ${nextId} and org_id = ${orgId}`));
  if (!(await isFeatureEnabled(orgId, "inventory"))) {
    if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  if (item.rows[0] && item.rows[0].kind === "equipment_charge") {
    if (!(await isFeatureEnabled(orgId, "equipment"))) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  return null;
}

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
    `),
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
    `),
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = ((parsedBody.data));

  try {
    switch (body.action) {
      case "addPlan": {
        // Plan currency is Multi-currency configuration. Turning that switch
        // off must refuse a new write; omitted currency leaves the column
        // unset so turning the feature back on does not invent a code.
        if (body.currency !== undefined && !(await isFeatureEnabled(orgId, "multiCurrency"))) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        if (!body.name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });
        if (!INTERVALS.includes(body.interval)) return NextResponse.json({ error: "invalid interval" }, { status: 400 });
        const amount = canonicalDecimal(body.amount ?? "0", 4);
        if (amount === null) return NextResponse.json({ error: "invalid amount" }, { status: 422 });
        const refusedItem = await refuseInventoryPlanItem(orgId, body.itemId);
        if (refusedItem) return refusedItem;
        const created = await db.transaction(async (tx) => {
          const row = (await tx.execute<Record<string, unknown>>(sql`
            insert into subscription_plans (org_id, name, description, amount, currency_code, interval,
                                            interval_count, income_account_id, item_id, tax_code_id, created_by, updated_by)
            values (${orgId}, ${body.name}, ${body.description ?? null}, ${normalizeMoney(amount)},
                    ${body.currency ?? null}, ${body.interval}, ${Number(body.intervalCount ?? 1)},
                    ${body.incomeAccountId ?? null}, ${body.itemId ?? null}, ${body.taxCodeId ?? null}, ${userId}, ${userId})
            returning *
          `));
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id)
            values
              (${orgId}, 'subscription_plans', ${(row.rows[0] as any).id as string}, 'insert',
               ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${userId})
          `);
          return row.rows[0]!;
        });
        return NextResponse.json({ id: ((created)).id }, { status: 201 });
      }
      case "updatePlan": {
        // Plan currency is Multi-currency configuration. Turning that switch
        // off must refuse a new write; the stored code stays so turning the
        // feature back on restores the same currency.
        if (body.currency !== undefined && !(await isFeatureEnabled(orgId, "multiCurrency"))) {
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        const amount = canonicalDecimal(body.amount ?? "0", 4);
        if (amount === null) return NextResponse.json({ error: "invalid amount" }, { status: 422 });
        let storedItemId: string | null | undefined;
        if (body.itemId !== undefined) {
          const stored = (await db.execute<{ item_id: string | null }>(sql`
            select item_id from subscription_plans where id = ${body.id} and org_id = ${orgId}`));
          storedItemId = stored.rows[0]?.item_id;
          const refusedItem = await refuseInventoryPlanItem(orgId, body.itemId, storedItemId);
          if (refusedItem) return refusedItem;
        }
        const missingPlan = await db.transaction(async (tx) => {
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from subscription_plans where id = ${body.id} and org_id = ${orgId}
          `));
          if (!before.rows[0]) return true;
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update subscription_plans set name = ${body.name}, description = ${body.description ?? null},
                   amount = ${normalizeMoney(amount)},
                   currency_code = ${body.currency !== undefined ? body.currency : sql`currency_code`},
                   interval = ${body.interval}, interval_count = ${Number(body.intervalCount ?? 1)},
                   income_account_id = ${body.incomeAccountId ?? null},
                   item_id = ${body.itemId !== undefined ? body.itemId ?? null : sql`item_id`},
                   tax_code_id = ${body.taxCodeId ?? null}, is_active = ${body.isActive ?? true},
                   updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId}
            returning *
          `));
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id)
            values
              (${orgId}, 'subscription_plans', ${String(body.id)}, 'update',
               ${JSON.stringify({ before: before.rows[0], after: updated.rows[0] })}::jsonb, ${userId})
          `);
          return false;
        });
        if (missingPlan) return NextResponse.json({ error: "not found" }, { status: 404 });
        return NextResponse.json({ ok: true });
      }
      case "deletePlan": {
        const deleted = await db.transaction(async (tx) => {
          // Re-check "in use" inside the transaction so a subscription created
          // between check and delete cannot orphan onto a vanished plan.
          const inUse = (await tx.execute(sql`select 1 from subscriptions where plan_id = ${body.id} and org_id = ${orgId} limit 1`));
          if (inUse.rows.length) return { inUse: true as const };
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from subscription_plans where id = ${body.id} and org_id = ${orgId}
          `));
          if (!before.rows[0]) return { inUse: false as const };
          await tx.execute(sql`delete from subscription_plans where id = ${body.id} and org_id = ${orgId}`);
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id)
            values
              (${orgId}, 'subscription_plans', ${String(body.id)}, 'delete',
               ${JSON.stringify({ before: before.rows[0] })}::jsonb, ${userId})
          `);
          return { inUse: false as const };
        });
        if (deleted.inUse) {
          return NextResponse.json({ error: "plan has subscriptions — archive it instead" }, { status: 422 });
        }
        return NextResponse.json({ ok: true });
      }
      case "addSubscription": {
        if (!body.customerId || !body.planId) return NextResponse.json({ error: "customer and plan required" }, { status: 400 });
        const startOn = body.startOn || await businessToday(orgId);
        // firstBillOn is when the first FULL cycle bills; if it's after the start
        // and proration is requested, we bill the partial [start, firstBillOn] now.
        const firstBillOn = body.firstBillOn || startOn;
        const quantityRaw = canonicalDecimal(body.quantity ?? "1", 4);
        if (quantityRaw === null) return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
        let quantity: string;
        try {
          quantity = normalizeMoney(quantityRaw);
        } catch {
          return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
        }
        const priceOverride =
          body.priceOverride != null && body.priceOverride !== ""
            ? canonicalDecimal(body.priceOverride, 4)
            : null;
        if (body.priceOverride != null && body.priceOverride !== "" && priceOverride === null) {
          return NextResponse.json({ error: "invalid price override" }, { status: 422 });
        }
        const created = await db.transaction(async (tx) => {
          const row = (await tx.execute<Record<string, unknown>>(sql`
            insert into subscriptions (org_id, customer_id, plan_id, quantity, price_override, start_on,
                                       next_bill_on, current_period_start, auto_post, memo, created_by, updated_by)
            values (${orgId}, ${body.customerId}, ${body.planId}, ${quantity},
                    ${priceOverride != null ? normalizeMoney(priceOverride) : null},
                    ${startOn}, ${firstBillOn}, ${startOn}, ${body.autoPost ?? false}, ${body.memo ?? null}, ${userId}, ${userId})
            returning *
          `));
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id)
            values
              (${orgId}, 'subscriptions', ${(row.rows[0] as any).id as string}, 'insert',
               ${JSON.stringify({ after: row.rows[0] })}::jsonb, ${userId})
          `);
          return row.rows[0]!;
        });
        const id = ((created)).id as string;
        let proration: unknown = null;
        if (body.prorateFirstPeriod && firstBillOn > startOn) {
          proration = await prorateFirstInvoice(id, firstBillOn);
        }
        return NextResponse.json({ id, proration }, { status: 201 });
      }
      case "changeSubscription": {
        const owned = (await db.execute(sql`select 1 from subscriptions where id = ${body.id} and org_id = ${orgId}`));
        if (!owned.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
        let quantity: string | undefined;
        if (body.quantity != null) {
          const exact = canonicalDecimal(body.quantity, 4);
          if (exact === null) return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
          try {
            quantity = normalizeMoney(exact);
          } catch {
            return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
          }
        }
        let priceOverride: string | null | undefined;
        if ("priceOverride" in body) {
          if (body.priceOverride != null && body.priceOverride !== "") {
            const exact = canonicalDecimal(body.priceOverride, 4);
            if (exact === null) return NextResponse.json({ error: "invalid price override" }, { status: 422 });
            priceOverride = normalizeMoney(exact);
          } else {
            priceOverride = null;
          }
        }
        const result = await changeSubscription(body.id, {
          quantity,
          priceOverride,
        });
        return NextResponse.json(result);
      }
      case "updateSubscription": {
        const sets: SQL[] = [];
        if ("status" in body) sets.push(sql`status = ${body.status}`);
        if (body.status === "canceled") sets.push(sql`canceled_on = ${await businessToday(orgId)}`);
        if ("quantity" in body) {
          const quantityRaw = canonicalDecimal(body.quantity, 4);
          if (quantityRaw === null) return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
          let quantity: string;
          try {
            quantity = normalizeMoney(quantityRaw);
          } catch {
            return NextResponse.json({ error: "invalid quantity" }, { status: 422 });
          }
          sets.push(sql`quantity = ${quantity}`);
        }
        if ("priceOverride" in body) {
          if (body.priceOverride != null && body.priceOverride !== "") {
            const exact = canonicalDecimal(body.priceOverride, 4);
            if (exact === null) return NextResponse.json({ error: "invalid price override" }, { status: 422 });
            sets.push(sql`price_override = ${normalizeMoney(exact)}`);
          } else {
            sets.push(sql`price_override = null`);
          }
        }
        if ("autoPost" in body) sets.push(sql`auto_post = ${Boolean(body.autoPost)}`);
        if ("nextBillOn" in body) sets.push(sql`next_bill_on = ${body.nextBillOn}`);
        if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
        const missing = await db.transaction(async (tx) => {
          const before = (await tx.execute<Record<string, unknown>>(sql`
            select * from subscriptions where id = ${body.id} and org_id = ${orgId}
          `));
          if (!before.rows[0]) return true;
          const updated = (await tx.execute<Record<string, unknown>>(sql`
            update subscriptions set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId}
            returning *
          `));
          await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id)
            values
              (${orgId}, 'subscriptions', ${String(body.id)}, 'update',
               ${JSON.stringify({ before: before.rows[0], after: updated.rows[0] })}::jsonb, ${userId})
          `);
          return false;
        });
        if (missing) return NextResponse.json({ error: "not found" }, { status: 404 });
        return NextResponse.json({ ok: true });
      }
      case "billNow": {
        const owned = (await db.execute(sql`select 1 from subscriptions where id = ${body.id} and org_id = ${orgId}`));
        if (!owned.rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
        const gen = await billSubscriptionNow(body.id);
        return NextResponse.json(gen);
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof SubscriptionError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
