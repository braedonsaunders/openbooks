import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { add, mul, normalizeMoney, toUnits } from "./money.ts";

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

export class AdvancedSubscriptionError extends Error {}

function pad(n: number): string { return String(n).padStart(2, "0"); }

export function advanceLifecycleDate(isoDate: string, interval: Interval, intervalCount = 1): string {
  const n = Math.max(1, Math.trunc(intervalCount));
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) throw new AdvancedSubscriptionError("invalid billing date");
  if (interval === "weekly") {
    const result = new Date(Date.UTC(y, m - 1, d + 7 * n));
    return `${result.getUTCFullYear()}-${pad(result.getUTCMonth() + 1)}-${pad(result.getUTCDate())}`;
  }
  const monthStep = (interval === "monthly" ? 1 : interval === "quarterly" ? 3 : 12) * n;
  const idx = m - 1 + monthStep;
  const targetYear = y + Math.floor(idx / 12);
  const targetMonth = ((idx % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(Math.min(d, lastDay))}`;
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

function validDate(value: string | null | undefined, label: string): string | null {
  if (value == null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AdvancedSubscriptionError(`${label} must be an ISO date`);
  }
  return value;
}

function positiveMoney(value: string | undefined, label: string): string {
  let normalized: string;
  try {
    normalized = normalizeMoney(value ?? "");
  } catch {
    throw new AdvancedSubscriptionError(`${label} must be greater than zero`);
  }
  if (toUnits(normalized) <= 0n) throw new AdvancedSubscriptionError(`${label} must be greater than zero`);
  return normalized;
}

function nonNegativeMoney(value: string | undefined, label: string): string {
  let normalized: string;
  try {
    normalized = normalizeMoney(value ?? "");
  } catch {
    throw new AdvancedSubscriptionError(`${label} cannot be negative`);
  }
  if (toUnits(normalized) < 0n) throw new AdvancedSubscriptionError(`${label} cannot be negative`);
  return normalized;
}

export function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day || months < 1) throw new AdvancedSubscriptionError("invalid renewal date or term");
  const idx = month - 1 + months;
  const y = year + Math.floor(idx / 12);
  const m = ((idx % 12) + 12) % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** First invoice date for a trial-aware advance/arrears contract. */
export function firstLifecycleBillOn(input: {
  termStartsOn: string;
  trialEndsOn?: string | null;
  billingTiming: BillingTiming;
  interval: Interval;
  intervalCount: number;
}): string {
  const serviceStartsOn = input.trialEndsOn && input.trialEndsOn > input.termStartsOn ? input.trialEndsOn : input.termStartsOn;
  return input.billingTiming === "advance"
    ? serviceStartsOn
    : advanceLifecycleDate(serviceStartsOn, input.interval, input.intervalCount);
}

export function assertPlanVersionMutable(status: string): void {
  if (status !== "draft") throw new AdvancedSubscriptionError("published plan versions are immutable; create a new version");
}

export function assertIdempotentReplay(existingSubscriptionId: string, requestedSubscriptionId: string): void {
  if (existingSubscriptionId !== requestedSubscriptionId) {
    throw new AdvancedSubscriptionError("idempotency key already belongs to another subscription");
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

async function ownedPlan(orgId: string, planId: string) {
  const result = (await db.execute<any>(sql`
    select id, name, description, amount, currency_code as currency, interval,
           interval_count as "intervalCount", income_account_id as "incomeAccountId",
           item_id as "itemId", tax_code_id as "taxCodeId"
      from subscription_plans where id = ${planId} and org_id = ${orgId} for update
  `));
  const row = result.rows[0];
  if (!row) throw new AdvancedSubscriptionError("plan not found");
  return row;
}

async function assertCommercialRefs(orgId: string, input: { incomeAccountId?: string | null; itemId?: string | null; taxCodeId?: string | null }): Promise<void> {
  if (input.incomeAccountId) {
    const row = (await db.execute(sql`select 1 from accounts where id = ${input.incomeAccountId} and org_id = ${orgId} and type in ('income','income_other') and is_active`));
    if (!row.rows.length) throw new AdvancedSubscriptionError("income account does not belong to this organization");
  }
  if (input.itemId) {
    const row = (await db.execute(sql`select 1 from items where id = ${input.itemId} and org_id = ${orgId} and is_active`));
    if (!row.rows.length) throw new AdvancedSubscriptionError("item does not belong to this organization");
  }
  if (input.taxCodeId) {
    const row = (await db.execute(sql`select 1 from tax_codes where id = ${input.taxCodeId} and org_id = ${orgId} and is_active`));
    if (!row.rows.length) throw new AdvancedSubscriptionError("tax code does not belong to this organization");
  }
}

async function subscriptionContext(orgId: string, subscriptionId: string) {
  const result = (await db.execute<any>(sql`
    select s.id, s.customer_id as "customerId", s.plan_id as "planId", s.status,
           l.id as "lifecycleId", l.plan_version_id as "planVersionId",
           l.contract_revision as "contractRevision", l.term_starts_on as "termStartsOn",
           l.term_ends_on as "termEndsOn", l.trial_ends_on as "trialEndsOn",
           l.billing_timing as "billingTiming", l.renewal_policy as "renewalPolicy",
           l.renewal_term_months as "renewalTermMonths", l.renewal_on as "renewalOn"
      from subscriptions s
      left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
     where s.id = ${subscriptionId} and s.org_id = ${orgId}
  `));
  const row = result.rows[0];
  if (!row) throw new AdvancedSubscriptionError("subscription not found");
  return row;
}

export async function createPlanVersion(orgId: string, actorId: string, input: CreatePlanVersionInput): Promise<string> {
  return withOrg(orgId, async () => {
    const plan = await ownedPlan(orgId, input.planId);
    const effectiveFrom = validDate(input.effectiveFrom, "effective date")!;
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
             ${input.interval ?? plan.interval}, ${Math.max(1, Math.trunc(input.intervalCount ?? plan.intervalCount))},
             ${input.billingTiming ?? "advance"}, ${input.changeSummary ?? null}, ${actorId}, ${actorId}
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
    const found = (await db.execute<any>(sql`
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

export async function activateLifecycle(orgId: string, actorId: string, input: ActivateLifecycleInput): Promise<void> {
  await withOrg(orgId, async () => {
    await db.execute(sql`select id from subscriptions where id = ${input.subscriptionId} and org_id = ${orgId} for update`);
    const sub = await subscriptionContext(orgId, input.subscriptionId);
    if (sub.status === "canceled") throw new AdvancedSubscriptionError("a canceled subscription cannot be activated");
    if (sub.lifecycleId) throw new AdvancedSubscriptionError("advanced lifecycle is already active");
    const versionResult = (await db.execute<any>(sql`
      select id, plan_id as "planId", interval, interval_count as "intervalCount", billing_timing as "billingTiming", status,
             effective_from as "effectiveFrom", effective_to as "effectiveTo"
        from subscription_plan_versions where id = ${input.planVersionId} and org_id = ${orgId}
    `));
    const version = versionResult.rows[0];
    if (!version || version.status !== "published") throw new AdvancedSubscriptionError("a published plan version is required");
    if (version.planId !== sub.planId) throw new AdvancedSubscriptionError("plan version does not belong to the subscription plan");
    const termStartsOn = validDate(input.termStartsOn, "term start")!;
    const termEndsOn = validDate(input.termEndsOn, "term end");
    const trialEndsOn = validDate(input.trialEndsOn, "trial end");
    if (termEndsOn && termEndsOn < termStartsOn) throw new AdvancedSubscriptionError("term end cannot precede term start");
    if (trialEndsOn && (trialEndsOn < termStartsOn || (termEndsOn && trialEndsOn > termEndsOn))) {
      throw new AdvancedSubscriptionError("trial must fall inside the contract term");
    }
    if (version.effectiveFrom > termStartsOn || (version.effectiveTo && version.effectiveTo < termStartsOn)) {
      throw new AdvancedSubscriptionError("plan version is not effective on the contract start date");
    }
    const renewalTermMonths = input.renewalTermMonths == null ? null : Math.trunc(input.renewalTermMonths);
    if (renewalTermMonths != null && renewalTermMonths < 1) throw new AdvancedSubscriptionError("renewal term must be positive");
    const firstBillOn = firstLifecycleBillOn({ termStartsOn, trialEndsOn, billingTiming: version.billingTiming, interval: version.interval, intervalCount: version.intervalCount });
    await db.execute(sql`
      insert into subscription_lifecycles
        (org_id, subscription_id, plan_version_id, term_starts_on, term_ends_on, trial_ends_on,
         billing_timing, renewal_policy, renewal_term_months, renewal_on, created_by, updated_by)
      values (${orgId}, ${input.subscriptionId}, ${input.planVersionId}, ${termStartsOn}, ${termEndsOn}, ${trialEndsOn},
              ${version.billingTiming}, ${input.renewalPolicy ?? "auto"}, ${renewalTermMonths}, ${termEndsOn}, ${actorId}, ${actorId})
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
      update subscriptions set next_bill_on = ${firstBillOn}, current_period_start = ${trialEndsOn ?? termStartsOn},
             updated_at = now(), updated_by = ${actorId}
       where id = ${input.subscriptionId} and org_id = ${orgId}
    `);
  });
}

async function snapshot(orgId: string, subscriptionId: string) {
  const lifecycle = await subscriptionContext(orgId, subscriptionId);
  if (!lifecycle.lifecycleId) throw new AdvancedSubscriptionError("advanced lifecycle is not active");
  const components = (await db.execute<any>(sql`
    select component_key as "componentKey", name, description, quantity, unit_price as "unitPrice",
           income_account_id as "incomeAccountId", item_id as "itemId", tax_code_id as "taxCodeId",
           effective_from as "effectiveFrom", effective_to as "effectiveTo"
      from subscription_components where org_id = ${orgId} and subscription_id = ${subscriptionId}
     order by effective_from, sort_order, component_key
  `));
  return { lifecycle, components: components.rows };
}

export async function applyAmendment(orgId: string, actorId: string, request: AmendmentRequest): Promise<{ id: string; replayed: boolean }> {
  return withOrg(orgId, async () => {
    if (!request.idempotencyKey.trim()) throw new AdvancedSubscriptionError("idempotency key is required");
    const lock = (await db.execute(sql`select id from subscriptions where id = ${request.subscriptionId} and org_id = ${orgId} for update`));
    if (!lock.rows.length) throw new AdvancedSubscriptionError("subscription not found");
    const replay = (await db.execute<any>(sql`
      select id, subscription_id as "subscriptionId" from subscription_amendments
       where org_id = ${orgId} and idempotency_key = ${request.idempotencyKey}
    `));
    if (replay.rows[0]) {
      assertIdempotentReplay(replay.rows[0].subscriptionId, request.subscriptionId);
      return { id: replay.rows[0].id, replayed: true };
    }
    const effectiveOn = validDate(request.effectiveOn, "effective date")!;
    const before = await snapshot(orgId, request.subscriptionId);
    if (before.lifecycle.status === "canceled") throw new AdvancedSubscriptionError("a canceled subscription cannot be amended");
    const currentComponent = request.componentKey
      ? before.components.find((c) => c.componentKey === request.componentKey && c.effectiveFrom <= effectiveOn && (!c.effectiveTo || c.effectiveTo >= effectiveOn))
      : null;
    if (["remove_component", "change_component"].includes(request.type) && !currentComponent) {
      throw new AdvancedSubscriptionError("active component not found");
    }
    const quantity = request.type === "add_component" || (request.type === "change_component" && request.quantity != null)
      ? positiveMoney(request.quantity ?? "1", "component quantity")
      : null;
    const unitPrice = request.type === "add_component" || (request.type === "change_component" && request.unitPrice != null)
      ? nonNegativeMoney(request.unitPrice, "component price")
      : null;
    if (request.type === "add_component") {
      if (!request.componentKey?.trim() || !request.name?.trim()) throw new AdvancedSubscriptionError("component key and name are required");
      if (currentComponent) throw new AdvancedSubscriptionError("component key is already active");
      await assertCommercialRefs(orgId, request);
    }
    if (request.type === "change_component") {
      await assertCommercialRefs(orgId, request);
    }
    if (request.type === "change_timing" && !["advance", "arrears"].includes(request.billingTiming ?? "")) {
      throw new AdvancedSubscriptionError("billing timing must be advance or arrears");
    }
    if (["remove_component", "change_component"].includes(request.type)) {
      await db.execute(sql`
        update subscription_components set effective_to = (${effectiveOn}::date - interval '1 day')::date,
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and subscription_id = ${request.subscriptionId}
           and component_key = ${request.componentKey!} and effective_from <= ${effectiveOn}
           and (effective_to is null or effective_to >= ${effectiveOn})
      `);
    }
    if (["add_component", "change_component"].includes(request.type)) {
      const source = currentComponent ?? {};
      await db.execute(sql`
        insert into subscription_components
          (org_id, subscription_id, component_key, name, description, quantity, unit_price,
           income_account_id, item_id, tax_code_id, effective_from, sort_order, created_by, updated_by)
        values (${orgId}, ${request.subscriptionId}, ${request.componentKey!}, ${request.name ?? source.name},
                ${request.description !== undefined ? request.description : source.description ?? null},
                ${quantity ?? source.quantity ?? "1"}, ${unitPrice ?? source.unitPrice ?? "0"},
                ${request.incomeAccountId !== undefined ? request.incomeAccountId : source.incomeAccountId ?? null},
                ${request.itemId !== undefined ? request.itemId : source.itemId ?? null}, ${request.taxCodeId !== undefined ? request.taxCodeId : source.taxCodeId ?? null},
                ${effectiveOn}, ${before.components.length}, ${actorId}, ${actorId})
      `);
    }
    if (request.type === "change_term") {
      const termEndsOn = validDate(request.termEndsOn, "term end");
      if (termEndsOn && termEndsOn < before.lifecycle.termStartsOn) throw new AdvancedSubscriptionError("term end cannot precede term start");
      await db.execute(sql`update subscription_lifecycles set term_ends_on = ${termEndsOn}, renewal_on = ${termEndsOn}, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "change_timing") {
      await db.execute(sql`update subscription_lifecycles set billing_timing = ${request.billingTiming!}, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "renew") {
      const months = Math.trunc(request.renewalTermMonths ?? before.lifecycle.renewalTermMonths ?? 12);
      if (months < 1 || !before.lifecycle.termEndsOn) throw new AdvancedSubscriptionError("renewal requires a current term end and positive renewal term");
      const nextEnd = addMonths(before.lifecycle.termEndsOn, months);
      await db.execute(sql`update subscription_lifecycles set term_starts_on = ${before.lifecycle.termEndsOn}, term_ends_on = ${nextEnd}, renewal_on = ${nextEnd}, renewal_term_months = ${months}, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    if (request.type === "coterm") {
      if (!request.anchorSubscriptionId) throw new AdvancedSubscriptionError("an anchor subscription is required");
      const anchor = await subscriptionContext(orgId, request.anchorSubscriptionId);
      if (!anchor.lifecycleId || !anchor.termEndsOn) throw new AdvancedSubscriptionError("anchor subscription needs an advanced term end");
      assertCotermAllowed({ subscriptionId: request.subscriptionId, anchorSubscriptionId: request.anchorSubscriptionId, customerId: before.lifecycle.customerId, anchorCustomerId: anchor.customerId });
      await db.execute(sql`update subscription_lifecycles set term_ends_on = ${anchor.termEndsOn}, renewal_on = ${anchor.termEndsOn}, coterm_anchor_subscription_id = ${request.anchorSubscriptionId}, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    }
    await db.execute(sql`update subscription_lifecycles set contract_revision = contract_revision + 1, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId} and subscription_id = ${request.subscriptionId}`);
    const after = await snapshot(orgId, request.subscriptionId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into subscription_amendments
        (org_id, subscription_id, amendment_number, amendment_type, effective_on, status, idempotency_key,
         reason, request, before_snapshot, after_snapshot, applied_at, applied_by, created_by, updated_by)
      select ${orgId}, ${request.subscriptionId}, coalesce(max(amendment_number), 0) + 1, ${request.type}, ${effectiveOn},
             'applied', ${request.idempotencyKey}, ${request.reason ?? null}, ${JSON.stringify(request)}::jsonb,
             ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, now(), ${actorId}, ${actorId}, ${actorId}
        from subscription_amendments where subscription_id = ${request.subscriptionId}
      returning id
    `));
    return { id: inserted.rows[0]!.id, replayed: false };
  });
}

export async function advancedSubscriptionWorkspace(orgId: string) {
  const [versions, lifecycles, amendments] = await Promise.all([
    db.execute<any>(sql`
      select v.id, v.plan_id as "planId", v.version_number as "versionNumber", v.status, v.effective_from as "effectiveFrom",
             v.effective_to as "effectiveTo", v.name, v.currency_code as currency, v.interval,
             v.interval_count as "intervalCount", v.billing_timing as "billingTiming", v.change_summary as "changeSummary",
             coalesce(jsonb_agg(jsonb_build_object('componentKey', c.component_key, 'name', c.name, 'quantity', c.quantity,
               'unitPrice', c.unit_price, 'isOptional', c.is_optional) order by c.sort_order) filter (where c.id is not null), '[]'::jsonb) as components
        from subscription_plan_versions v left join subscription_plan_version_components c on c.version_id = v.id and c.org_id = v.org_id
       where v.org_id = ${orgId} group by v.id order by v.plan_id, v.version_number desc
    `),
    db.execute<any>(sql`
      select l.subscription_id as "subscriptionId", l.plan_version_id as "planVersionId", l.contract_revision as "contractRevision",
             l.term_starts_on as "termStartsOn", l.term_ends_on as "termEndsOn", l.trial_ends_on as "trialEndsOn",
             l.billing_timing as "billingTiming", l.renewal_policy as "renewalPolicy", l.renewal_term_months as "renewalTermMonths",
             l.renewal_on as "renewalOn", l.coterm_anchor_subscription_id as "cotermAnchorSubscriptionId",
             coalesce(jsonb_agg(jsonb_build_object('componentKey', c.component_key, 'name', c.name, 'quantity', c.quantity,
               'unitPrice', c.unit_price, 'effectiveFrom', c.effective_from, 'effectiveTo', c.effective_to) order by c.sort_order)
               filter (where c.id is not null), '[]'::jsonb) as components
        from subscription_lifecycles l left join subscription_components c on c.subscription_id = l.subscription_id and c.org_id = l.org_id
       where l.org_id = ${orgId} group by l.id order by l.created_at desc
    `),
    db.execute<any>(sql`
      select id, subscription_id as "subscriptionId", amendment_number as "amendmentNumber", amendment_type as "amendmentType",
             effective_on as "effectiveOn", status, reason, applied_at as "appliedAt", request
        from subscription_amendments where org_id = ${orgId} order by applied_at desc, amendment_number desc
    `),
  ]);
  return { versions: versions.rows, lifecycles: lifecycles.rows, amendments: amendments.rows };
}

/**
 * Called by the recurring runner before it claims a due row. Subscriptions
 * without contract lifecycle configuration return true. Manual/no-renew
 * contracts stop at the boundary;
 * auto-renew contracts append the same immutable amendment as an interactive
 * renewal, using a deterministic idempotency key.
 */
export async function prepareAdvancedSubscriptionBilling(orgId: string, subscriptionId: string, dueOn: string): Promise<boolean> {
  return withOrg(orgId, async () => {
    const result = (await db.execute<any>(sql`
      select l.billing_timing as "billingTiming", l.term_ends_on as "termEndsOn",
             l.renewal_policy as "renewalPolicy", l.renewal_term_months as "renewalTermMonths",
             s.created_by as "createdBy"
        from subscriptions s left join subscription_lifecycles l on l.subscription_id = s.id and l.org_id = s.org_id
       where s.id = ${subscriptionId} and s.org_id = ${orgId}
    `));
    const row = result.rows[0];
    if (!row?.billingTiming) return true;
    const action = renewalAction({ billingTiming: row.billingTiming, dueOn, termEndsOn: row.termEndsOn, policy: row.renewalPolicy });
    if (action === "bill") return true;
    if (action === "stop") return false;
    if (!row.createdBy) throw new AdvancedSubscriptionError("automatic renewal needs an owning user");
    await applyAmendment(orgId, row.createdBy, {
      subscriptionId,
      type: "renew",
      effectiveOn: row.termEndsOn,
      renewalTermMonths: row.renewalTermMonths ?? 12,
      idempotencyKey: `auto-renew:${subscriptionId}:${row.termEndsOn}`,
      reason: "Automatic renewal",
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

/** Snapshot used by the invoice engine; null means single-plan billing. */
export async function advancedBillingSnapshot(subscriptionId: string, billOn: string, periodStartOverride?: string | null): Promise<{
  contractRevision: number;
  billingTiming: BillingTiming;
  periodStartsOn: string;
  periodEndsOn: string;
  lines: AdvancedBillingLine[];
  total: string;
} | null> {
  const lifecycle = (await db.execute<any>(sql`
    select l.contract_revision as "contractRevision", l.billing_timing as "billingTiming",
           s.current_period_start as "currentPeriodStart", s.next_bill_on as "nextBillOn",
           v.interval, v.interval_count as "intervalCount"
      from subscription_lifecycles l join subscriptions s on s.id = l.subscription_id and s.org_id = l.org_id
      join subscription_plan_versions v on v.id = l.plan_version_id and v.org_id = l.org_id
     where l.subscription_id = ${subscriptionId}
  `));
  const row = lifecycle.rows[0];
  if (!row) return null;
  const serviceAnchor = periodStartOverride ?? row.currentPeriodStart ?? billOn;
  const { periodStartsOn, periodEndsOn } = lifecycleBillingPeriod({ billOn, serviceAnchor, billingTiming: row.billingTiming, interval: row.interval, intervalCount: row.intervalCount });
  const activeOn = row.billingTiming === "advance" ? periodStartsOn : periodEndsOn;
  const components = (await db.execute<AdvancedBillingLine>(sql`
    select name as description, quantity, unit_price as "unitPrice", income_account_id as "incomeAccountId",
           item_id as "itemId", tax_code_id as "taxCodeId"
      from subscription_components
     where subscription_id = ${subscriptionId} and effective_from <= ${activeOn}
       and (effective_to is null or effective_to >= ${activeOn})
     order by sort_order, component_key
  `));
  const total = subscriptionComponentTotal(components.rows);
  return { contractRevision: row.contractRevision, billingTiming: row.billingTiming, periodStartsOn, periodEndsOn, lines: components.rows, total };
}
