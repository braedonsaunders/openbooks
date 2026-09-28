import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createPrepaidGrant } from "../billing/usage/prepaid.ts";
import { commitRateRun, previewRateRun } from "../billing/usage/rate-run.ts";
import { createUsageMeter, ingestUsageRecords, type IngestUsageRecordInput } from "../billing/usage/records.ts";
import {
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
} from "../billing/usage/rating-plans.ts";
import { recomputeOpenSaasMetrics } from "../billing/metrics/metrics-ledger.ts";
import { createSubscriptionInvoice } from "../billing/subscription-billing.ts";
import { add, cmp, neg } from "../money/money.ts";
import { parseMoney, parseQuantity } from "../money/brands.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { db } from "../platform/db.ts";
import { issueInvoice } from "./ops.ts";
import { Rng } from "./rng.ts";
import type { Profile, UsageSubscriptionSpec } from "./profiles/types.ts";
import type { SimOrg } from "./world.ts";

const QUANTITY_SCALE = 100_000_000n;

type SubscriptionUsageRow = {
  id: string;
  customerId: string;
  customerName: string;
  startOn: string;
  status: string;
  pausedOn: string | null;
  resumeOn: string | null;
  linkId: string;
  productKey: string;
  meterId: string;
  effectiveFrom: string;
};

function quantityUnits(value: string): bigint {
  const canonical = parseQuantity(value);
  const negative = canonical.startsWith("-");
  const [whole = "0", fraction = ""] = canonical.replace(/^-/, "").split(".");
  const units = BigInt(whole) * QUANTITY_SCALE + BigInt((fraction + "00000000").slice(0, 8));
  return negative ? -units : units;
}

function quantityText(units: bigint): string {
  const sign = units < 0n ? "-" : "";
  const magnitude = units < 0n ? -units : units;
  const whole = magnitude / QUANTITY_SCALE;
  // Daily API volumes use four fractional places; graduated money rates keep eight.
  const fraction = (magnitude % QUANTITY_SCALE).toString().padStart(8, "0").slice(0, 4).replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function monthDistance(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12
    + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

function daysInMonth(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function monthlyQuantity(spec: UsageSubscriptionSpec, startOn: string, today: string): bigint {
  const initial = quantityUnits(spec.volume.initialMonthlyQuantity);
  const step = quantityUnits(spec.volume.monthlyChangeQuantity);
  const minimum = quantityUnits(spec.volume.minimumMonthlyQuantity ?? "0");
  const projected = initial + step * BigInt(monthDistance(startOn, today));
  return projected > minimum ? projected : minimum;
}

async function linkedUsageSubscriptions(orgId: string): Promise<SubscriptionUsageRow[]> {
  return (await db.execute<SubscriptionUsageRow>(sql`
    select s.id, s.customer_id as "customerId", customer.display_name as "customerName",
           s.start_on::text as "startOn", s.status, s.paused_on::text as "pausedOn",
           s.resume_on::text as "resumeOn", link.id as "linkId", meter.key as "productKey",
           meter.id as "meterId", link.effective_from::text as "effectiveFrom"
      from subscription_usage_links link
      join subscriptions s on s.org_id = link.org_id and s.id = link.subscription_id
      join parties customer on customer.org_id = s.org_id and customer.id = s.customer_id
      join usage_meters meter on meter.org_id = link.org_id and meter.id = any(link.meter_ids)
     where link.org_id = ${orgId}
     order by customer.display_name, meter.key`)).rows;
}

async function applyProfileLifecycle(
  profile: Profile,
  world: SimOrg,
  today: string,
  rows: readonly SubscriptionUsageRow[],
): Promise<void> {
  const rowByCustomer = new Map(rows.map((row) => [row.customerName, row]));
  for (const spec of profile.usageSubscriptions ?? []) {
    if (spec.pauseAfterDays === undefined && spec.resumeAfterDays === undefined) continue;
    if (
      spec.pauseAfterDays === undefined || spec.resumeAfterDays === undefined ||
      !Number.isInteger(spec.pauseAfterDays) || !Number.isInteger(spec.resumeAfterDays) ||
      spec.pauseAfterDays < 0 || spec.resumeAfterDays <= spec.pauseAfterDays
    ) {
      throw new Error(`Invalid pause/resume schedule for ${spec.customer}`);
    }
    const subscription = rowByCustomer.get(spec.customer);
    if (!subscription) throw new Error(`No usage subscription exists for ${spec.customer} in ${world.orgId}`);
    const pauseOn = addCalendarDays(subscription.startOn, spec.pauseAfterDays);
    const resumeOn = addCalendarDays(subscription.startOn, spec.resumeAfterDays);
    if (today === pauseOn) {
      if (subscription.status === "paused" && subscription.pausedOn === today) continue;
      if (subscription.status !== "active") throw new Error(`Cannot pause ${spec.customer} from subscription status ${subscription.status}`);
      const paused = await db.execute(sql`
        update subscriptions set status = 'paused', paused_on = ${today}
         where org_id = ${world.orgId} and id = ${subscription.id} and status = 'active'
        returning id`);
      if (paused.rows.length !== 1) throw new Error(`Pausing ${spec.customer} did not update one active subscription`);
      subscription.status = "paused";
      subscription.pausedOn = today;
    }
    if (today === resumeOn) {
      if (subscription.status === "active" && subscription.resumeOn === today) continue;
      if (subscription.status !== "paused") throw new Error(`Cannot resume ${spec.customer} from subscription status ${subscription.status}`);
      const resumed = await db.execute(sql`
        update subscriptions set status = 'active', resume_on = ${today}
         where org_id = ${world.orgId} and id = ${subscription.id} and status = 'paused'
        returning id`);
      if (resumed.rows.length !== 1) throw new Error(`Resuming ${spec.customer} did not update one paused subscription`);
      subscription.status = "active";
      subscription.resumeOn = today;
    }
  }
}

/** Provision metered products through the usage engine and prepaid invoices through AR. */
export async function provisionSaasUsage(
  profile: Profile,
  world: SimOrg,
  window: { startDate: string; endDate: string },
): Promise<void> {
  if (!profile.meteredProducts?.length) return;
  const specs = profile.usageSubscriptions ?? [];
  if (!specs.length) throw new Error(`Profile ${profile.id} declares metered products without usage subscriptions`);

  for (const product of profile.meteredProducts) {
    const usageItemId = randomUUID();
    await db.execute(sql`
      insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on,
                         revenue_allocation, income_account_id)
      values (${usageItemId}, ${world.orgId}, 'service', ${product.name}, false, true,
              jsonb_build_object('simUsageProduct', ${product.key}::text), 'billing', 'normal', ${world.accounts.usageRevenue})`);
    const meter = await createUsageMeter(world.orgId, world.actors.controller, {
      key: product.key,
      name: product.name,
      unit: product.unit,
      aggregation: product.aggregation,
      itemId: usageItemId,
    });
    const plan = await createUsageRatingPlan(world.orgId, world.actors.controller, {
      name: `${product.name} Graduated Plan`,
      currency: world.currency,
    });
    const version = await createUsageRatingPlanVersion(world.orgId, world.actors.controller, {
      planId: plan.id,
      effectiveFrom: window.startDate,
    });
    await replaceUsageRatingBands(world.orgId, world.actors.controller, version.id,
      product.bands.map((band, index) => ({
        meterId: meter.id,
        kind: "graduated" as const,
        seq: index + 1,
        upToQty: band.upToQty,
        unitPrice: band.unitPrice,
      })),
    );
    await publishUsagePlanVersion(world.orgId, world.actors.controller, version.id);

    const customerIds = new Map(world.customers.map((customer) => [customer.name, customer.id]));
    const subscriptionsByCustomer = new Map(world.subscriptions.map((subscription) => [subscription.customerId, subscription]));
    const productSpecs = specs.filter((spec) => spec.product === product.key);
    if (!productSpecs.length) throw new Error(`No profile subscribers use metered product ${product.key}`);

    for (const spec of productSpecs) {
      const customerId = customerIds.get(spec.customer);
      const subscriber = customerId ? subscriptionsByCustomer.get(customerId) : undefined;
      if (!customerId || !subscriber) throw new Error(`No recurring subscription exists for metered customer ${spec.customer}`);
      await createSubscriptionUsageLink(world.orgId, world.actors.controller, {
        subscriptionId: subscriber.id,
        customerId,
        planVersionId: version.id,
        meterIds: [meter.id],
        effectiveFrom: window.startDate,
        ...(spec.annualCommitAmount ? { commitAmount: spec.annualCommitAmount, commitPeriod: "annual" as const } : {}),
        allowOverage: true,
      });
    }

    const prepaidSpecs = productSpecs.filter((spec) => spec.prepaidPack);
    if (prepaidSpecs.length) {
      const ruleId = randomUUID();
      const prepaidItemId = randomUUID();
      await db.execute(sql`
        insert into recognition_rules
          (id, org_id, code, name, method, is_forecast, start_date_source, end_date_source,
           deferred_account_id, recognized_account_id, is_active)
        values (${ruleId}, ${world.orgId}, ${`SIM_USAGE_PREPAID_${product.key}`},
                ${`${product.name} Prepaid Draw Recognition`}, 'usage', false, 'obligation', 'term',
                ${world.accounts.deferredRevenue}, ${world.accounts.usageRevenue}, true)`);
      await db.execute(sql`
        insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on,
                           revenue_allocation, income_account_id, recognition_rule_id, deferred_account_id)
        values (${prepaidItemId}, ${world.orgId}, 'service', ${`${product.name} Prepaid Pack`}, false, true,
                jsonb_build_object('simUsageProduct', ${product.key}::text, 'prepaid', true), 'billing', 'normal',
                ${world.accounts.usageRevenue}, ${ruleId}, ${world.accounts.deferredRevenue})`);
      for (const spec of prepaidSpecs) {
        const customer = world.customers.find((candidate) => candidate.name === spec.customer);
        if (!customer || !spec.prepaidPack) throw new Error(`Prepaid pack customer ${spec.customer} is missing`);
        const invoice = await createSubscriptionInvoice({
          orgId: world.orgId,
          actorId: world.actors.controller,
          customerId: customer.id,
          subsidiaryId: world.subsidiaryId,
          currency: world.currency,
          incomeAccountId: world.accounts.usageRevenue!,
          itemId: prepaidItemId,
          taxCodeId: null,
          description: `${product.name} prepaid usage pack`,
          quantity: "1",
          unitPrice: spec.prepaidPack.amount,
          memo: `${product.name} prepaid usage pack`,
          invoiceDate: window.startDate,
          autoPost: false,
          lines: [{
            description: `${product.name} prepaid usage pack`,
            quantity: "1",
            unitPrice: spec.prepaidPack.amount,
            incomeAccountId: world.accounts.usageRevenue!,
            itemId: prepaidItemId,
            taxCodeId: null,
          }],
          custom: { simPrepaidUsageProduct: product.key },
        });
        await issueInvoice(world, invoice.invoiceId);
        const sourceLine = (await db.execute<{ id: string }>(sql`
          select id from document_lines where org_id = ${world.orgId} and document_id = ${invoice.invoiceId}
          order by line_number`)).rows;
        if (sourceLine.length !== 1) throw new Error(`Prepaid invoice ${invoice.documentNumber} must have exactly one source line`);
        await createPrepaidGrant(world.orgId, world.actors.controller, {
          customerId: customer.id,
          sourceDocumentLineId: sourceLine[0]!.id,
          amount: spec.prepaidPack.amount,
          currency: world.currency,
        });
      }
    }
  }
}

/** Ingest deterministic daily usage and post each month's committed rating invoices. */
export async function runSaasUsageDay(
  profile: Profile,
  world: SimOrg,
  today: string,
): Promise<void> {
  if (!profile.meteredProducts?.length) return;
  const rows = await linkedUsageSubscriptions(world.orgId);
  await applyProfileLifecycle(profile, world, today, rows);

  const specsByCustomerAndProduct = new Map(
    (profile.usageSubscriptions ?? []).map((spec) => [`${spec.customer}\u0000${spec.product}`, spec]),
  );
  const records: IngestUsageRecordInput[] = [];
  for (const row of rows) {
    if (row.status !== "active") continue;
    const spec = specsByCustomerAndProduct.get(`${row.customerName}\u0000${row.productKey}`);
    if (!spec) throw new Error(`No usage volume shape exists for ${row.customerName} and ${row.productKey}`);
    const monthly = monthlyQuantity(spec, row.startOn, today);
    const days = BigInt(daysInMonth(today));
    const variation = spec.volume.dailyVariationPercent;
    if (!Number.isInteger(variation) || variation < 0 || variation > 20) {
      throw new Error(`Daily usage variation for ${row.customerName} must be a whole percent from 0 through 20`);
    }
    const stream = Rng.fromSeed(`${profile.id}:${row.customerName}:${today}`).stream("saas-daily-usage");
    const factor = BigInt(stream.int(100 - variation, 100 + variation));
    const quantity = quantityText((monthly / days) * factor / 100n);
    records.push({
      meterKey: row.productKey,
      customerId: row.customerId,
      subscriptionId: row.id,
      occurredOn: today,
      quantity,
      source: "api" as const,
      sourceRef: `sim:${today}`,
      idempotencyKey: `sim:${row.id}:${today}`,
    });
  }
  if (records.length) await ingestUsageRecords(world.orgId, world.actors.controller, records);

  const day = Number(today.slice(8, 10));
  if (day !== daysInMonth(today)) return;
  const periodStart = `${today.slice(0, 7)}-01`;
  for (const row of rows) {
    const start = row.effectiveFrom > periodStart ? row.effectiveFrom : periodStart;
    const result = await commitRateRun(world.orgId, world.actors.controller, row.linkId, start, today);
    if (!result.invoiceId) continue;
    const invoice = (await db.execute<{ status: string }>(sql`
      select status from documents where org_id = ${world.orgId} and id = ${result.invoiceId}`)).rows[0];
    if (!invoice) throw new Error(`Usage rating run ${result.run.id} points to a missing invoice`);
    if (invoice.status === "draft") await issueInvoice(world, result.invoiceId);
    else if (invoice.status !== "posted") throw new Error(`Usage invoice ${result.invoiceId} cannot post from status ${invoice.status}`);
  }
}

/** Run usage revenue tie-outs after the existing monthly recognition pass. */
export async function recomputeSaasUsageMetrics(world: SimOrg): Promise<void> {
  if (world.subscriptions.length) await recomputeOpenSaasMetrics(world.orgId);
}

export interface SaasUsageInvariantFailure {
  invariant: string;
  detail: string;
}

/** Verify that the latest rated month still replays and its 4010 credit ties to usage. */
export async function saasUsageMonthInvariant(orgId: string): Promise<SaasUsageInvariantFailure[]> {
  const latest = (await db.execute<{ periodEnd: string | null }>(sql`
    select max(period_end)::text as "periodEnd" from usage_rating_runs where org_id = ${orgId} and status = 'active'`)).rows[0]?.periodEnd;
  if (!latest) return [];
  const monthStart = `${latest.slice(0, 7)}-01`;
  const runs = (await db.execute<{
    id: string;
    linkId: string;
    periodStart: string;
    periodEnd: string;
    inputHash: string;
    outputHash: string;
  }>(sql`
    select id, link_id as "linkId", period_start::text as "periodStart", period_end::text as "periodEnd",
           input_hash as "inputHash", output_hash as "outputHash"
      from usage_rating_runs
     where org_id = ${orgId} and status = 'active' and period_end = ${latest}::date
     order by link_id`)).rows;
  const failures: SaasUsageInvariantFailure[] = [];
  for (const run of runs) {
    const preview = await previewRateRun(orgId, run.linkId, run.periodStart, run.periodEnd);
    if (preview.inputHash !== run.inputHash || preview.outputHash !== run.outputHash) {
      failures.push({
        invariant: "saas-usage-rating-replay",
        detail: `rating run ${run.id} for ${run.periodStart} through ${run.periodEnd} no longer reproduces its stored input and output hashes`,
      });
    }
  }

  // Posted invoice history survives both voiding and rating-run supersession.
  // Each reversal is a separate negative leg in its own accounting month;
  // filtering the original by its current state would erase earlier revenue.
  const invoiceAmount = (await db.execute<{ amount: string }>(sql`
    with invoice_legs as (
      select line.amount, posted.posting_date
        from usage_rating_runs run
        join documents invoice on invoice.org_id = run.org_id and invoice.id = run.invoice_id
        join document_lines line on line.org_id = invoice.org_id and line.document_id = invoice.id
        join journal_entries posted on posted.org_id = invoice.org_id and posted.id = invoice.posted_entry_id
       where run.org_id = ${orgId} and invoice.status in ('posted', 'voided')
         and posted.status in ('posted', 'reversed')
      union all
      select -line.amount, reversal.posting_date
        from usage_rating_runs run
        join documents invoice on invoice.org_id = run.org_id and invoice.id = run.invoice_id
        join document_lines line on line.org_id = invoice.org_id and line.document_id = invoice.id
        join journal_entries reversal on reversal.org_id = invoice.org_id and reversal.id = invoice.reversal_entry_id
       where run.org_id = ${orgId} and invoice.status = 'voided' and invoice.posted_entry_id is not null
         and reversal.status in ('posted', 'reversed')
    )
    select coalesce(sum(amount), 0)::text as amount from invoice_legs
     where posting_date >= ${monthStart}::date and posting_date <= ${latest}::date`)).rows[0]?.amount ?? "0";
  const drawAmount = (await db.execute<{ amount: string }>(sql`
    select coalesce(sum(amount), 0)::text as amount from usage_prepaid_draws
     where org_id = ${orgId} and period_month = ${monthStart}::date`)).rows[0]?.amount ?? "0";
  const usageAccount = (await db.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and number = '4010' and is_active`)).rows[0];
  if (!usageAccount) {
    failures.push({ invariant: "saas-usage-revenue-tieout", detail: "usage revenue account 4010 is missing or inactive" });
    return failures;
  }
  const creditAmount = (await db.execute<{ amount: string }>(sql`
    select coalesce(sum(line.amount), 0)::text as amount
      from journal_lines line
      join journal_entries entry on entry.org_id = line.org_id and entry.id = line.entry_id
     where line.org_id = ${orgId} and line.account_id = ${usageAccount.id}
       and line.posting_date >= ${monthStart}::date and line.posting_date <= ${latest}::date
       and entry.status in ('posted', 'reversed')`)).rows[0]?.amount ?? "0";
  const expected = add(invoiceAmount, drawAmount);
  const credited = neg(parseMoney(creditAmount));
  if (cmp(credited, expected) !== 0) {
    failures.push({
      invariant: "saas-usage-revenue-tieout",
      detail: `account 4010 credits ${credited} in ${monthStart.slice(0, 7)}; usage invoice and reversal lines plus prepaid draws total ${expected}`,
    });
  }
  return failures;
}
