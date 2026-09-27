import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { parseMoney, parseQuantity, parseRate } from "../money/brands.ts";
import { rateUsage, type RatingBand } from "../billing/usage/rating.ts";
import { UsageBillingError } from "../billing/usage/errors.ts";
import { linkStripeCustomer, linkStripeSubscription, importStripeBilling, type StripeBillingFetch } from "./stripe-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };
const ACCOUNT = { id: "acct_sm09", object: "account" };
const METER = { id: "mtr_usage", event_name: "api_calls", display_name: "API calls", default_aggregation: { formula: "sum" } };
const PRICES = [
  { id: "price_grad", currency: "cad", product: "prod_cloud", created: 1784073600, billing_scheme: "tiered", tiers_mode: "graduated", recurring: { usage_type: "metered", meter: "mtr_usage" }, tiers: [{ up_to: 10, unit_amount_decimal: "100", flat_amount_decimal: "50" }, { up_to: null, unit_amount_decimal: "50", flat_amount_decimal: "100" }] },
  { id: "price_volume", currency: "cad", product: "prod_cloud", created: 1784073600, billing_scheme: "tiered", tiers_mode: "volume", recurring: { usage_type: "metered", meter: "mtr_usage" }, tiers: [{ up_to: null, unit_amount_decimal: "150", flat_amount_decimal: "200" }] },
  { id: "price_package", currency: "cad", product: "prod_cloud", created: 1784073600, billing_scheme: "per_unit", recurring: { usage_type: "metered", meter: "mtr_usage" }, unit_amount_decimal: "200", transform_quantity: { divide_by: 10, round: "up" } },
  { id: "price_precise", currency: "cad", product: "prod_cloud", created: 1784073600, billing_scheme: "per_unit", recurring: { usage_type: "metered", meter: "mtr_usage" }, unit_amount_decimal: "0.12345678901" },
];

async function setup(run: (org: ScratchOrg, actor: string) => Promise<void>, opts: { feature?: boolean; stripe?: boolean } = {}): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Stripe billing tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ subscriptionBilling: opts.feature !== false, usageBilling: opts.feature !== false })}::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
      if (opts.stripe !== false) await db.execute(sql`insert into psp_provider_configs (org_id,provider,display_name,is_enabled,acceptance_enabled,default_bank_account_id,secrets,created_by,updated_by) values (${org.orgId},'stripe','Stripe',true,true,${org.accounts.bank},${sealJson({ apiKey: "sk_test_billing_import" }, { orgId: org.orgId, purpose: "payment.provider.secrets" })},${actor},${actor})`);
      await db.execute(sql`update parties set email = 'linked@example.test' where org_id = ${org.orgId} and id = ${org.customerId}`);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

function transport(): StripeBillingFetch {
  return async (url) => {
    const path = new URL(url).pathname;
    const data = path === "/v1/billing/meters" ? [METER]
      : path === "/v1/prices" ? PRICES
      : path === "/v1/customers" ? [{ id: "cus_linked", email: "linked@example.test" }, { id: "cus_unlinked", email: "linked@example.test" }]
      : path === "/v1/subscriptions" ? [{ id: "sub_linked", customer: "cus_linked", current_period_start: 1784073600, items: { data: [{ id: "si_draft", price: { id: "price_grad", recurring: { usage_type: "metered" } } }] } }]
      : path.endsWith("/event_summaries") ? [{ id: "summary_daily", start_time: 1784073600, aggregated_value: "12" }]
      : [];
    return { status: 200, json: async () => path === "/v1/account" ? ACCOUNT : { data, has_more: false } };
  };
}

test("Stripe billing imports draft price models and replays usage idempotently", DB, async () => {
  await setup(async (org, actor) => {
    const fetch = transport();
    const planId = randomUUID(), subscriptionId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`update parties set email = 'linked@example.test' where org_id = ${org.orgId} and id = ${org.customerId}`);
      await db.execute(sql`insert into subscription_plans (id,org_id,name,amount,currency_code,interval,interval_count,is_active,created_by,updated_by) values (${planId},${org.orgId},'Stripe test plan','0','CAD','monthly',1,true,${actor},${actor})`);
      await db.execute(sql`insert into subscriptions (id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,current_period_start,created_by,updated_by) values (${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active',${org.date},${org.date},${org.date},${actor},${actor})`);
    });
    await linkStripeCustomer(org.orgId, actor, "cus_linked", org.customerId, { fetch });
    await linkStripeSubscription(org.orgId, actor, "sub_linked", subscriptionId, { fetch });
    const run = () => importStripeBilling(org.orgId, actor, { since: org.date, until: org.date }, { fetch });
    const first = await run();
    const second = await run();
    assert.ok(first.refusals.some((item) => item.code === "stripe_price_precision_unsupported" && item.remedy.toLowerCase().includes("round the price in stripe")));
    assert.ok(first.refusals.some((item) => item.code === "stripe_customer_unlinked"));
    assert.ok(first.refusals.some((item) => item.code === "stripe_subscription_price_unpublished"));
    assert.equal(first.unlinkedCustomers[0]?.suggestedCustomerId, org.customerId);
    assert.ok(first.draftVersionsAwaitingPublish.some((version) => version.stripeId === "price_grad" && version.versionId.length > 0));
    assert.equal(first.counts.prices.draftsCreated, 3);
    assert.equal(first.counts.usage.recordsCreated, 1);
    assert.equal(second.counts.prices.draftsCreated, 0);
    assert.equal(second.counts.usage.recordsCreated, 0);
    assert.equal(second.counts.usage.recordsReplayed, 1);
    const links = (await withOrgContext(org.orgId, async () => db.execute<{ stripe_id: string; openbooks_id: string }>(sql`select stripe_id,openbooks_id from stripe_billing_links where org_id=${org.orgId} and object_type='price'`))).rows;
    assert.equal(links.length, 3);
    const plans = await withOrgContext(org.orgId, async () => db.execute<{ n: number }>(sql`select count(*)::int as n from usage_rating_plans where org_id=${org.orgId} and name='Stripe prod_cloud CAD'`));
    assert.equal(plans.rows[0]?.n, 1);
    const expected = new Map<string, [string, string]>([["price_grad", ["12", "12.5000"]], ["price_volume", ["12", "20.0000"]], ["price_package", ["101", "22.0000"]]]);
    for (const row of links) {
      const bands = (await withOrgContext(org.orgId, async () => db.execute<{ kind: RatingBand["kind"]; seq: number; up_to_qty: string | null; unit_price: string; flat_amount: string; included_qty: string; package_size: string | null; package_rounding: RatingBand["packageRounding"] }>(sql`select kind,seq,up_to_qty::text,unit_price::text,flat_amount::text,included_qty::text,package_size::text,package_rounding from usage_rating_bands where org_id=${org.orgId} and plan_version_id=${row.openbooks_id} order by seq`))).rows;
      const expectedPrice = expected.get(row.stripe_id);
      if (!expectedPrice) throw new Error(`No expected rating was supplied for ${row.stripe_id}`);
      const [quantity, amount] = expectedPrice;
      const rated = rateUsage({ quantity: parseQuantity(quantity), bands: bands.map((band) => ({ ...band, upToQty: band.up_to_qty === null ? null : parseQuantity(band.up_to_qty), unitPrice: parseRate(band.unit_price), flatAmount: parseMoney(band.flat_amount), includedQty: parseQuantity(band.included_qty), packageSize: band.package_size === null ? null : parseQuantity(band.package_size), packageRounding: band.package_rounding })) as RatingBand[] });
      assert.equal(rated.reduce((sum, line) => sum + BigInt(parseMoney(line.amount).replace(".", "")), 0n).toString(), BigInt(amount.replace(".", "")).toString());
    }
    const count = await withOrgContext(org.orgId, async () => db.execute<{ n: number }>(sql`select count(*)::int as n from usage_records where org_id=${org.orgId} and source='connector_stripe'`));
    assert.equal(count.rows[0]?.n, 1);
    const runs = await withOrgContext(org.orgId, async () => db.execute<{ stats: { usage: { recordsCreated: number }; meters: { created: number }; prices: { draftsCreated: number; awaitingPublication: Array<{ stripeId: string; versionId: string }> }; customers: { unlinked: Array<{ suggestedCustomerId: string | null }> }; refusals: Array<{ code: string; remedy: string }>; invoices: string } }>(sql`select stats from sync_runs where org_id=${org.orgId} and kind='stripe_billing' order by started_at`));
    assert.equal(runs.rows.length, 2);
    assert.equal(runs.rows[0]?.stats.usage.recordsCreated, 1);
    assert.equal(runs.rows[1]?.stats.usage.recordsCreated, 0);
    assert.equal(runs.rows[1]?.stats.meters.created, 0);
    assert.equal(runs.rows[1]?.stats.prices.draftsCreated, 0);
    assert.ok(runs.rows[0]?.stats.prices.awaitingPublication.some((version) => version.stripeId === "price_grad" && version.versionId.length > 0));
    assert.equal(runs.rows[0]?.stats.customers.unlinked[0]?.suggestedCustomerId, org.customerId);
    assert.ok(runs.rows[0]?.stats.invoices.includes("were not imported or posted"));
    assert.ok(runs.rows[0]?.stats.refusals.some((item) => item.code === "stripe_customer_unlinked" && item.remedy.includes("linkStripeCustomer")));
    assert.ok(runs.rows[0]?.stats.refusals.some((item) => item.code === "stripe_subscription_price_unpublished" && item.remedy.includes("publish")));
    const meter = await withOrgContext(org.orgId, async () => db.execute<{ aggregation: string }>(sql`select m.aggregation from stripe_billing_links l join usage_meters m on m.org_id=l.org_id and m.id=l.openbooks_id where l.org_id=${org.orgId} and l.object_type='meter'`));
    assert.equal(meter.rows[0]?.aggregation, "sum");
  });
});

test("Stripe setup and Usage Billing feature refusals name their remedies", DB, async () => {
  await setup(async (org, actor) => {
    await assert.rejects(importStripeBilling(org.orgId, actor, { since: org.date, until: org.date }, { fetch: transport() }), (error: unknown) => error instanceof UsageBillingError && error.code === "stripe_not_configured" && error.remedy.includes("Setup → Payment providers"));
  }, { stripe: false });
  await setup(async (org, actor) => {
    await assert.rejects(importStripeBilling(org.orgId, actor, { since: org.date, until: org.date }, { fetch: async () => { throw new Error("must not call Stripe while disabled"); } }), (error: unknown) => error instanceof UsageBillingError && error.code === "feature_off" && error.remedy.includes("Company Settings → Features"));
  }, { feature: false });
});
