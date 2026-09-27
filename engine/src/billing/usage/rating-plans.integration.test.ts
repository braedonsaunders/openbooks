import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../../platform/db.ts";
import { postDocument } from "../../ledger/posting-document.ts";
import { UsageBillingError } from "./errors.ts";
import {
  assertUsagePlanVersionMutable,
  createSubscriptionUsageLink,
  createUsageRatingPlan,
  createUsageRatingPlanVersion,
  publishUsagePlanVersion,
  replaceUsageRatingBands,
} from "./rating-plans.ts";
import {
  createPrepaidGrant,
  prepaidBalance,
  prepaidState,
  recordPrepaidDraw,
} from "./prepaid.ts";
import { createUsageMeter } from "./records.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function withUsageOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Usage plan controller", "admin");
    await withBypassContext(async () => {
      const enabled = await db.execute(sql`
        update orgs
           set settings = jsonb_set(
             settings,
             '{features}',
             coalesce(settings->'features', '{}'::jsonb)
               || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb,
             true
           )
         where id = ${org.orgId}`);
      assert.equal(enabled.rowCount, 1, "the scratch organization must receive the usage feature settings");
    });
    await run(org, actor);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function meterFor(org: ScratchOrg, actor: string, tag: string) {
  return createUsageMeter(org.orgId, actor, {
    key: `rating-${tag}-${randomUUID()}`,
    name: `Rating meter ${tag}`,
    unit: "request",
    aggregation: "sum",
    itemId: org.items.service,
  });
}

async function publishedVersion(
  org: ScratchOrg,
  actor: string,
  meterId: string,
  currency = "CAD",
  unitPrice = "1.25",
) {
  const plan = await createUsageRatingPlan(org.orgId, actor, {
    name: `Usage plan ${randomUUID()}`,
    currency,
  });
  const version = await createUsageRatingPlanVersion(org.orgId, actor, {
    planId: plan.id,
    effectiveFrom: org.date,
  });
  await replaceUsageRatingBands(org.orgId, actor, version.id, [
    { meterId, kind: "graduated", seq: 1, upToQty: null, unitPrice },
  ]);
  const published = await publishUsagePlanVersion(org.orgId, actor, version.id);
  return { plan, version: published };
}

async function seedSubscription(org: ScratchOrg, actor: string, currency: string): Promise<string> {
  const planId = randomUUID();
  const subscriptionId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into subscription_plans
        (id, org_id, name, amount, currency_code, "interval", interval_count, is_active, created_by, updated_by)
      values (${planId}, ${org.orgId}, ${`Usage subscription ${planId.slice(0, 8)}`}, 0, ${currency}, 'monthly', 1, true, ${actor}, ${actor})`);
    await db.execute(sql`
      insert into subscriptions
        (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, created_by, updated_by)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, 1, 'active', ${org.date}, ${org.date}, ${actor}, ${actor})`);
  });
  return subscriptionId;
}

async function seedPostedInvoiceLine(
  org: ScratchOrg,
  actor: string,
  method: "usage" | "point_in_time",
  amount: string,
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  await withBypassContext(async () => {
    const rule = (await db.execute<{ method: string }>(sql`
      select method from recognition_rules where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`)).rows[0];
    assert.ok(rule, "the scratch recognition rule must be available");
    if (rule.method !== method) {
      const changed = await db.execute(sql`
        update recognition_rules set method = ${method}
         where org_id = ${org.orgId} and id = ${org.recognitionRuleId}`);
      assert.equal(changed.rowCount, 1, "the scratch recognition rule must remain available");
    }
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, due_date, currency, fx_rate, status,
         subtotal, tax_total, total, is_final_invoice, custom, extra_dims,
         created_by, updated_by)
      values
        (${documentId}, ${org.orgId}, 'customer_invoice', ${`USAGE-${documentId.slice(0, 10)}`},
         ${org.customerId}, ${org.subsidiaryId}, ${org.date}, ${org.date}, ${org.date}, 'CAD', '1', 'draft',
         ${amount}, '0', ${amount}, false, '{}'::jsonb, '{}'::jsonb, ${actor}, ${actor})`);
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, item_id, account_id,
         quantity, unit_price, amount, tax_amount, is_billable,
         quantity_fulfilled, quantity_billed, custom, tax_overridden,
         extra_dims, created_by, updated_by)
      values
        (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.items.service}, ${org.accounts.revenue},
         1, ${amount}, ${amount}, 0, false, 0, 0, '{}'::jsonb, false, '{}'::jsonb, ${actor}, ${actor})`);
    const approved = await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where org_id = ${org.orgId} and id = ${documentId} and status = 'draft'`);
    assert.equal(approved.rowCount, 1, "the invoice must enter the approved posting state");
  });
  await postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  }, { audit: { actorId: actor, source: "test" } });
  return lineId;
}

function usageError(code: string, detail: string) {
  return (error: unknown) =>
    error instanceof UsageBillingError && error.code === code &&
    `${error.message} ${error.remedy}`.toLowerCase().includes(detail.toLowerCase());
}

test("publishing freezes a rating version and hashes a sub-cent band price", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await meterFor(org, actor, "freeze");
    const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Frozen ${randomUUID()}`, currency: "CAD" });
    const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
    await replaceUsageRatingBands(org.orgId, actor, version.id, [
      { meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "0.00000001" },
    ]);
    const published = await publishUsagePlanVersion(org.orgId, actor, version.id);
    assert.equal(published.status, "published");
    assert.match(published.specHash ?? "", /^[0-9a-f]{64}$/);
    assert.throws(
      () => assertUsagePlanVersionMutable(published.status),
      usageError("usage_plan_version_immutable", "publish a new version"),
    );
    await assert.rejects(
      replaceUsageRatingBands(org.orgId, actor, version.id, [
        { meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "1" },
      ]),
      usageError("usage_plan_version_immutable", "publish a new version"),
    );
  });
});

test("band coverage refuses a sequence gap and overlapping quantity boundary by seq", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await meterFor(org, actor, "coverage");
    const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Coverage ${randomUUID()}`, currency: "CAD" });
    const gap = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
    await replaceUsageRatingBands(org.orgId, actor, gap.id, [
      { meterId: meter.id, kind: "graduated", seq: 1, upToQty: "10", unitPrice: "1" },
      { meterId: meter.id, kind: "graduated", seq: 3, upToQty: null, unitPrice: "2" },
    ]);
    await assert.rejects(
      publishUsagePlanVersion(org.orgId, actor, gap.id),
      (error: unknown) => error instanceof UsageBillingError && error.code === "usage_band_coverage_gap" &&
        error.message.includes("seq 3") && error.remedy.includes("seq 2"),
    );

    const zeroRange = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
    await replaceUsageRatingBands(org.orgId, actor, zeroRange.id, [
      { meterId: meter.id, kind: "graduated", seq: 1, upToQty: "0", unitPrice: "1" },
      { meterId: meter.id, kind: "graduated", seq: 2, upToQty: null, unitPrice: "2" },
    ]);
    await assert.rejects(
      publishUsagePlanVersion(org.orgId, actor, zeroRange.id),
      (error: unknown) => error instanceof UsageBillingError && error.code === "usage_band_coverage_gap" &&
        error.message.includes("seq 1") && error.remedy.includes("seq 1"),
    );

    const overlap = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
    await replaceUsageRatingBands(org.orgId, actor, overlap.id, [
      { meterId: meter.id, kind: "graduated", seq: 1, upToQty: "10", unitPrice: "1" },
      { meterId: meter.id, kind: "graduated", seq: 2, upToQty: "9", unitPrice: "2" },
      { meterId: meter.id, kind: "graduated", seq: 3, upToQty: null, unitPrice: "3" },
    ]);
    await assert.rejects(
      publishUsagePlanVersion(org.orgId, actor, overlap.id),
      (error: unknown) => error instanceof UsageBillingError && error.code === "usage_band_coverage_overlap" &&
        error.message.includes("seq 2") && error.remedy.includes("seq 2"),
    );
  });
});

test("a nine-decimal unit price is refused with the invoice precision remedy", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await meterFor(org, actor, "precision");
    const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Precision ${randomUUID()}`, currency: "CAD" });
    const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: org.date });
    await assert.rejects(
      replaceUsageRatingBands(org.orgId, actor, version.id, [
        { meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "0.000000001" },
      ]),
      usageError("usage_band_price_precision_invalid", "Round the unit price to 8 decimal places"),
    );
  });
});

test("subscription links validate the customer's identity and plan currency", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const meter = await meterFor(org, actor, "link");
    const subscriptionId = await seedSubscription(org, actor, "CAD");
    const { version } = await publishedVersion(org, actor, meter.id);
    const input = {
      subscriptionId,
      customerId: org.vendorId,
      planVersionId: version.id,
      meterIds: [meter.id],
      effectiveFrom: org.date,
    };
    await assert.rejects(
      createSubscriptionUsageLink(org.orgId, actor, input),
      usageError("usage_link_customer_mismatch", "subscription's own customer"),
    );

    const validLink = await createSubscriptionUsageLink(org.orgId, actor, {
      ...input,
      customerId: org.customerId,
      planVersionId: version.id,
    });
    assert.deepEqual([validLink.id.length > 0, validLink.meterIds], [true, input.meterIds]);

    const usd = await publishedVersion(org, actor, meter.id, "USD");
    await assert.rejects(
      createSubscriptionUsageLink(org.orgId, actor, { ...input, customerId: org.customerId, planVersionId: usd.version.id }),
      usageError("usage_link_currency_mismatch", "matches the subscription's own plan currency"),
    );
  });
});

test("prepaid grant refuses a posted invoice line without usage-method recognition", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const lineId = await seedPostedInvoiceLine(org, actor, "point_in_time", "25");
    await assert.rejects(
      createPrepaidGrant(org.orgId, actor, {
        customerId: org.customerId,
        sourceDocumentLineId: lineId,
        amount: "25",
        currency: "CAD",
      }),
      usageError("usage_prepaid_source_not_eligible", "Set a usage-method recognition rule on the prepaid item and bill it again"),
    );
  });
});

test("prepaid draws reduce derived balances, depletion and expiry remain derived", DB, async () => {
  await withUsageOrg(async (org, actor) => {
    const depletedLine = await seedPostedInvoiceLine(org, actor, "usage", "10");
    const depletedGrant = await createPrepaidGrant(org.orgId, actor, {
      customerId: org.customerId,
      sourceDocumentLineId: depletedLine,
      amount: "10",
      currency: "CAD",
    });
    await recordPrepaidDraw(org.orgId, { grantId: depletedGrant.id, periodMonth: "2026-07-01", amount: "4" });
    assert.equal(await prepaidBalance(org.orgId, depletedGrant.id, "2026-07-15"), "6.0000");
    await recordPrepaidDraw(org.orgId, { grantId: depletedGrant.id, periodMonth: "2026-07-01", amount: "6" });
    assert.deepEqual(await prepaidState(org.orgId, depletedGrant.id, "2026-07-31"), {
      state: "depleted",
      balance: "0.0000",
    });
    await assert.rejects(
      recordPrepaidDraw(org.orgId, { grantId: depletedGrant.id, periodMonth: "2026-07-01", amount: "0.01" }),
      usageError("usage_prepaid_balance_exceeded", "remaining balance of 0.0000"),
    );

    const expiredLine = await seedPostedInvoiceLine(org, actor, "usage", "12");
    const expiredGrant = await createPrepaidGrant(org.orgId, actor, {
      customerId: org.customerId,
      sourceDocumentLineId: expiredLine,
      amount: "12",
      currency: "CAD",
      expiresOn: "2026-07-15",
    });
    assert.deepEqual(await prepaidState(org.orgId, expiredGrant.id, "2026-07-16"), {
      state: "expired",
      balance: "12.0000",
    });
    await assert.rejects(
      recordPrepaidDraw(org.orgId, { grantId: expiredGrant.id, periodMonth: "2026-08-01", amount: "1" }),
      usageError("usage_prepaid_grant_expired", "expired balances remain liabilities"),
    );
  });
});
