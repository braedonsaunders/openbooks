import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createSubscriptionInvoice } from "../subscription-billing.ts";
import { cancelRevenueRecognitionForInvoice } from "../../ledger/revenue-recognition-cancellation.ts";
import { postDocument } from "../../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../../records/control-accounts.ts";
import { db, withOrgContext } from "../../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, type ScratchOrg } from "../../testing/fixtures.ts";
import { createPrepaidGrant, prepaidState } from "./prepaid.ts";
import { createUsageMeter, ingestUsageRecords, reverseUsageRecord } from "./records.ts";
import { createSubscriptionUsageLink, createUsageRatingPlan, createUsageRatingPlanVersion, publishUsagePlanVersion, replaceUsageRatingBands } from "./rating-plans.ts";
import { commitRateRun, previewRateRun, voidAndRebillRateRun } from "./rate-run.ts";
import { UsageBillingError } from "./errors.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Usage rating controller", "admin"));
    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb)
            || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb, true)
         where id = ${org.orgId}`);
      assert.equal(enabled.rowCount, 1);
    });
    await withOrgContext(org.orgId, () => run(org, actor));
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function meter(org: ScratchOrg, actor: string, recognitionRule = false) {
  let itemId = org.items.service;
  if (!recognitionRule) {
    itemId = randomUUID();
    await withOrgContext(org.orgId, async () => {
      const item = await db.execute(sql`insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
        values (${itemId}, ${org.orgId}, 'service', ${`Meter item ${itemId.slice(0, 8)}`}, ${org.accounts.revenue}, true, '{}'::jsonb) returning id`);
      assert.equal(item.rows.length, 1);
    });
  }
  return createUsageMeter(org.orgId, actor, { key: `requests-${randomUUID()}`, name: "API requests", unit: "request", aggregation: "sum", itemId });
}

async function linkedPlan(org: ScratchOrg, actor: string, meterId: string, options: { effectiveFrom?: string; commitAmount?: string; commitPeriod?: "monthly" | "annual"; allowOverage?: boolean; } = {}) {
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  const subscriptionName = `Usage subscription ${planId.slice(0, 8)}`;
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
      values (${planId}, ${org.orgId}, ${subscriptionName}, 0, 'CAD', 'monthly', 1)`);
    const row = await db.execute(sql`insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, 1, 'active', ${org.date}, ${org.date}) returning id`);
    assert.equal(row.rows.length, 1);
  });
  const plan = await createUsageRatingPlan(org.orgId, actor, { name: `Plan ${randomUUID()}`, currency: "CAD" });
  const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: plan.id, effectiveFrom: options.effectiveFrom ?? org.date });
  await replaceUsageRatingBands(org.orgId, actor, version.id, [
    { meterId, kind: "graduated", seq: 1, upToQty: "2", unitPrice: "1.25" },
    { meterId, kind: "graduated", seq: 2, upToQty: null, unitPrice: "2.5" },
  ]);
  await publishUsagePlanVersion(org.orgId, actor, version.id);
  const link = await createSubscriptionUsageLink(org.orgId, actor, {
    subscriptionId, customerId: org.customerId, planVersionId: version.id, meterIds: [meterId],
    effectiveFrom: options.effectiveFrom ?? org.date, commitAmount: options.commitAmount ?? null,
    commitPeriod: options.commitPeriod ?? null, allowOverage: options.allowOverage ?? true,
  });
  return { link, subscriptionId };
}

async function record(org: ScratchOrg, actor: string, meterKey: string, quantity: string, occurredOn = org.date, subscriptionId?: string) {
  return ingestUsageRecords(org.orgId, actor, [{ meterKey, customerId: org.customerId, subscriptionId: subscriptionId ?? null, occurredOn, quantity, source: "api", idempotencyKey: randomUUID() }]);
}

async function postInvoice(org: ScratchOrg, actor: string, invoiceId: string): Promise<void> {
  await withOrgContext(org.orgId, async () => {
    const approved = await db.execute(sql`update documents set status = 'approved' where org_id = ${org.orgId} and id = ${invoiceId} and status = 'draft' returning id`);
    assert.equal(approved.rows.length, 1);
  });
  await postDocument(invoiceId, { control: await loadRequiredControlAccounts(org.orgId) }, { audit: { actorId: actor, source: "usage-rating-test" } });
}

test("graduated rating is traced, idempotent, and draft rerating replaces the invoice", DB, async () => {
  await fixture(async (org, actor) => {
    const usageMeter = await meter(org, actor);
    const { link, subscriptionId } = await linkedPlan(org, actor, usageMeter.id);
    await record(org, actor, usageMeter.key, "3", org.date, subscriptionId);
    const preview = await previewRateRun(org.orgId, link.id, org.date, org.date);
    assert.equal(preview.totalRated, "5.0000");
    const first = await commitRateRun(org.orgId, actor, link.id, org.date, org.date);
    assert.ok(first.invoiceId);
    assert.equal(first.preview.invoiceLines.length, 2);
    const lines = await db.execute<{ amount: string; trace: { rating?: Record<string, unknown> } }>(sql`
      select amount::text as amount, custom as trace from document_lines
       where org_id = ${org.orgId} and document_id = ${first.invoiceId} order by line_number`);
    assert.equal(lines.rows.length, 2);
    const lineTotal = await db.execute<{ amount: string }>(sql`select sum(amount)::text as amount from document_lines
      where org_id = ${org.orgId} and document_id = ${first.invoiceId}`);
    assert.equal(lineTotal.rows[0]?.amount, "5.0000");
    for (const line of lines.rows) {
      assert.deepEqual([line.trace.rating?.runId, line.trace.rating?.planVersionId], [first.run.id, first.run.planVersionId]);
    }
    const replay = await commitRateRun(org.orgId, actor, link.id, org.date, org.date);
    assert.deepEqual([replay.run.id, replay.invoiceId], [first.run.id, first.invoiceId]);

    await record(org, actor, usageMeter.key, "1", org.date, subscriptionId);
    await assert.rejects(
      commitRateRun(org.orgId, actor, link.id, org.date, org.date),
      (error: unknown) => error instanceof UsageBillingError && error.code === "usage_rate_run_inputs_changed" && error.remedy.includes("voidAndRebillRateRun"),
    );
    const replacement = await voidAndRebillRateRun(org.orgId, actor, first.run.id);
    if ("status" in replacement) assert.fail("draft rerating must not wait for a void approval");
    assert.equal(replacement.run.supersedesRunId, first.run.id);
    assert.notEqual(replacement.invoiceId, first.invoiceId);
    assert.equal(replacement.preview.totalRated, "7.5000");
    await postInvoice(org, actor, replacement.invoiceId!);

    const posting = await db.execute<{ postingDate: string; income: string; deferred: number }>(sql`select e.posting_date::text as "postingDate",
      coalesce(sum(case when jl.account_id = ${org.accounts.revenue} then jl.amount else 0 end), 0)::text as income,
      (select count(*)::int from performance_obligations o join document_lines source on source.org_id = o.org_id and source.id = o.document_line_id
        where source.org_id = ${org.orgId} and source.document_id = ${replacement.invoiceId}) as deferred
      from journal_entries e join journal_lines jl on jl.org_id = e.org_id and jl.entry_id = e.id
      where e.org_id = ${org.orgId} and e.source_document_id = ${replacement.invoiceId} group by e.posting_date`);
    assert.deepEqual([posting.rows[0]?.postingDate, posting.rows[0]?.income, posting.rows[0]?.deferred], [org.date, "-7.5000", 0]);
  });
});

test("prepaid usage rerating reverses the prior draw and recognition before drawing again", DB, async () => {
  await fixture(async (org, actor) => {
    const usageMeter = await meter(org, actor);
    const { link, subscriptionId } = await linkedPlan(org, actor, usageMeter.id);
    await withOrgContext(org.orgId, async () => {
      const changed = await db.execute(sql`update recognition_rules set method = 'usage'
        where org_id = ${org.orgId} and id = ${org.recognitionRuleId} returning id`);
      assert.equal(changed.rows.length, 1);
    });
    const prepaidInvoice = await createSubscriptionInvoice({
      orgId: org.orgId,
      actorId: actor,
      customerId: org.customerId,
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
      incomeAccountId: org.accounts.revenue,
      itemId: org.items.service,
      taxCodeId: null,
      description: "Prepaid usage",
      quantity: "1",
      unitPrice: "10",
      memo: "Prepaid usage",
      invoiceDate: org.date,
      autoPost: true,
    });
    const source = (await db.execute<{ id: string }>(sql`select id from document_lines where org_id = ${org.orgId} and document_id = ${prepaidInvoice.invoiceId}`)).rows[0];
    assert.ok(source);
    const grant = await createPrepaidGrant(org.orgId, actor, { customerId: org.customerId, sourceDocumentLineId: source.id, amount: "3", currency: "CAD" });
    await record(org, actor, usageMeter.key, "2", org.date, subscriptionId);
    const correctedRecord = await record(org, actor, usageMeter.key, "1", org.date, subscriptionId);
    const first = await commitRateRun(org.orgId, actor, link.id, org.date, org.date);
    assert.equal(first.preview.prepaidDrawn, "3.0000");
    assert.ok(first.invoiceId, "the partial prepaid draw leaves a draft invoice to replace");
    const committedPreview = await previewRateRun(org.orgId, link.id, org.date, org.date);
    assert.deepEqual([committedPreview.inputHash, committedPreview.outputHash], [first.run.inputHash, first.run.outputHash]);
    assert.deepEqual(await prepaidState(org.orgId, grant.id, org.date), { state: "depleted", balance: "0.0000" });

    await reverseUsageRecord(org.orgId, actor, correctedRecord[0]!.id, "Correct reported usage", org.date);
    const replacement = await voidAndRebillRateRun(org.orgId, actor, first.run.id);
    if ("status" in replacement) assert.fail("draft rerating must not wait for a void approval");
    assert.equal(replacement.preview.totalRated, "2.5000");
    assert.equal(replacement.preview.prepaidDrawn, "2.5000");
    assert.equal(replacement.invoiceId, null);

    const draws = await db.execute<{
      id: string;
      runId: string;
      amount: string;
      periodMonth: string;
      reversesDrawId: string | null;
    }>(sql`select id, run_id as "runId", amount::text as amount,
        period_month::text as "periodMonth", reverses_draw_id as "reversesDrawId"
      from usage_prepaid_draws where org_id = ${org.orgId} and grant_id = ${grant.id}
      order by created_at, id`);
    assert.equal(draws.rows.length, 3);
    const originalDraw = draws.rows.find((draw) => draw.runId === first.run.id && draw.reversesDrawId === null);
    const reversal = draws.rows.find((draw) => draw.reversesDrawId === originalDraw?.id);
    const newDraw = draws.rows.find((draw) => draw.runId === replacement.run.id && draw.reversesDrawId === null);
    assert.ok(originalDraw);
    assert.deepEqual([reversal?.runId, reversal?.amount, reversal?.periodMonth], [first.run.id, "-3.0000", `${org.date.slice(0, 7)}-01`]);
    assert.deepEqual([newDraw?.amount, newDraw?.periodMonth], ["2.5000", `${org.date.slice(0, 7)}-01`]);
    assert.deepEqual(await prepaidState(org.orgId, grant.id, org.date), { state: "active", balance: "0.5000" });

    const references = [`usage-run:${first.run.id}:grant:${grant.id}`, `usage-run:${first.run.id}:grant:${grant.id}:reversal`, `usage-run:${replacement.run.id}:grant:${grant.id}`];
    const recognized = await db.execute<{ count: number; reversals: number; reversalAmount: string; amount: string; periodMonth: string }>(sql`
      select count(*)::int as count, count(*) filter (where amount < 0)::int as reversals,
             min(amount) filter (where amount < 0)::text as "reversalAmount", sum(amount)::text as amount,
             min(period_month)::text as "periodMonth"
        from recognition_events where org_id = ${org.orgId}
         and source_reference in (${sql.join(references.map((reference) => sql`${reference}`), sql`, `)})`);
    assert.deepEqual(recognized.rows[0], { count: 3, reversals: 1, reversalAmount: "-3.0000", amount: newDraw!.amount, periodMonth: `${org.date.slice(0, 7)}-01` });
  });
});

test("annual minimums true up only in the year-closing run and recognition rules refuse", DB, async () => {
  await fixture(async (org, actor) => {
    const usageMeter = await meter(org, actor);
    const { link, subscriptionId } = await linkedPlan(org, actor, usageMeter.id, {
      effectiveFrom: "2026-01-01",
      commitAmount: "100",
      commitPeriod: "annual",
    });
    await record(org, actor, usageMeter.key, "3", org.date, subscriptionId);
    const july = await commitRateRun(org.orgId, actor, link.id, "2026-07-01", "2026-07-31");
    assert.deepEqual([july.preview.commitShortfall, july.preview.totalRated], ["0.0000", "5.0000"]);
    assert.ok(!july.preview.invoiceLines.some((line) => line.kind === "commit_shortfall"));
    await withOrgContext(org.orgId, async () => {
      const calendar = await db.execute<{ id: string }>(sql`select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId}`);
      const period = await db.execute(sql`insert into accounting_periods
        (org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${org.orgId}, 2026, 12, '2026-12', '2026-12-01', '2026-12-31', false, ${calendar.rows[0]!.id}) returning id`);
      assert.equal(period.rows.length, 1);
    });
    const yearEnd = await commitRateRun(org.orgId, actor, link.id, "2026-12-01", "2026-12-31");
    const trueUp = yearEnd.preview.invoiceLines.find((line) => line.kind === "commit_shortfall");
    assert.deepEqual([yearEnd.preview.commitShortfall, trueUp?.amount, yearEnd.preview.commitRatedTotal], ["95.0000", "95.0000", "5.0000"]);

    const ruleMeter = await meter(org, actor, true);
    const rulePlan = await linkedPlan(org, actor, ruleMeter.id);
    await assert.rejects(
      commitRateRun(org.orgId, actor, rulePlan.link.id, org.date, org.date),
      (error: unknown) => error instanceof UsageBillingError && error.code === "usage_rate_run_item_recognition_rule" && error.remedy.includes("Remove the rule"),
    );
  });
});

test("a voided prepaid source invoice funds no usage draw", DB, async () => await fixture(async (org, actor) => {
    const usageMeter = await meter(org, actor);
    const { link, subscriptionId } = await linkedPlan(org, actor, usageMeter.id);
    const changed = await withOrgContext(org.orgId, async () => db.execute(sql`update recognition_rules set method = 'usage' where org_id = ${org.orgId} and id = ${org.recognitionRuleId} returning id`));
    assert.equal(changed.rows.length, 1);
    const invoice = await createSubscriptionInvoice({ orgId: org.orgId, actorId: actor, customerId: org.customerId, subsidiaryId: org.subsidiaryId,
      currency: "CAD", incomeAccountId: org.accounts.revenue, itemId: org.items.service, taxCodeId: null, description: "Prepaid usage", quantity: "1",
      unitPrice: "10", memo: "Prepaid usage", invoiceDate: org.date, autoPost: true });
    const source = (await db.execute<{ id: string }>(sql`select id from document_lines where org_id = ${org.orgId} and document_id = ${invoice.invoiceId}`)).rows[0]!; assert.ok(source);
    const grant = await createPrepaidGrant(org.orgId, actor, { customerId: org.customerId, sourceDocumentLineId: source.id, amount: "3", currency: "CAD" });
    const cancelled = await cancelRevenueRecognitionForInvoice({ documentId: invoice.invoiceId, orgId: org.orgId, actorId: actor, reason: "Prepaid source invoice cancelled", reversalDate: org.date, allowedSubsidiaryIds: null });
    assert.equal(cancelled.status, "cancelled");
    await record(org, actor, usageMeter.key, "3", org.date, subscriptionId); const run = await commitRateRun(org.orgId, actor, link.id, org.date, org.date);
    assert.deepEqual([run.preview.prepaidDrawn, run.preview.totalRated, Boolean(run.invoiceId)], ["0.0000", "5.0000", true]);
    const draws = await db.execute<{ count: number }>(sql`select count(*)::int as count from usage_prepaid_draws where org_id = ${org.orgId} and grant_id = ${grant.id}`); assert.equal(draws.rows[0]?.count, 0);
}));
