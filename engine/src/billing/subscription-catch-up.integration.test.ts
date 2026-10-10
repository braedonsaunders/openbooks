import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  previewSubscriptionCatchUp,
  prorateFirstInvoice,
  runSubscriptionCatchUp,
} from "./subscription-billing.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Subscription catch-up bills, drafts, or skips exactly the pending full
// periods — the identical rule as recurring catch-up. These tests pin the
// preview, each choice, the stopped-where-and-why outcome, the back-dated
// first-proration date, and the replay-instead-of-duplicate guarantee.

async function addPeriod(org: ScratchOrg, name: string, startsOn: string, endsOn: string, periodNumber: number): Promise<void> {
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment, custom)
    select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id,
           2026, ${periodNumber}, ${name}, ${startsOn}, ${endsOn}, false,
           '{}'::jsonb
      from accounting_periods
     where id = ${org.periodId}
  `);
}

async function seedSubscription(
  org: ScratchOrg,
  actorId: string,
  opts: { nextBillOn?: string; autoPost?: boolean } = {},
): Promise<string> {
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
  const planId = randomUUID();
  await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,interval,interval_count,income_account_id,created_by)
    values(${planId},${org.orgId},'Catch-up plan','100.0000','monthly',1,${org.accounts.revenue},${actorId})`);
  const subscriptionId = randomUUID();
  // The stored anchor follows the native first-bill-date rule (the 10th),
  // not the mid-month service start: without it the fallback reads the
  // start date's day and the cycle steps on the 1st.
  await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,anchor_day,created_by)
    values(${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active','2025-12-01',${opts.nextBillOn ?? org.date},${opts.autoPost ?? true},10,${actorId})`);
  return subscriptionId;
}

async function invoiceDates(orgId: string, subscriptionId: string): Promise<{ date: string; status: string }[]> {
  return (await db.execute<{ date: string; status: string }>(sql`
    select d.document_date::text as "date", d.status
      from subscription_period_invoices pi
      join documents d on d.id = pi.invoice_id and d.org_id = pi.org_id
     where pi.org_id = ${orgId} and pi.subscription_id = ${subscriptionId}
     order by d.document_date`)).rows;
}

async function nextBillOn(orgId: string, subscriptionId: string): Promise<string> {
  return (await db.execute<{ nextBillOn: string }>(sql`
    select next_bill_on::text as "nextBillOn" from subscriptions where id = ${subscriptionId} and org_id = ${orgId}`)).rows[0]!.nextBillOn;
}

async function catchUpAuditCount(orgId: string, subscriptionId: string): Promise<number> {
  return Number((await db.execute<{ n: string }>(sql`
    select count(*)::text as n from audit_log
     where org_id = ${orgId} and table_name = 'subscriptions' and row_id = ${subscriptionId}
       and action = 'update' and changes->>'mode' = 'catch_up'`)).rows[0]?.n ?? 0);
}

test("the preview lists exactly the pending periods", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const preview = await previewSubscriptionCatchUp(org.orgId, subscriptionId, "2026-02-10");
    assert.deepEqual(preview, {
      periods: ["2025-12-10", "2026-01-10", "2026-02-10"],
      truncated: false,
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("post-all bills each missed period on its own date and names the stop", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    await addPeriod(org, "2026-01", "2026-01-01", "2026-01-31", 1);
    await addPeriod(org, "2026-02", "2026-02-01", "2026-02-28", 2);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "post_all", asOf: "2026-02-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.periodStart, row.status]), [
      ["2025-12-10", "posted"],
      ["2026-01-10", "posted"],
      ["2026-02-10", "posted"],
    ]);
    assert.deepEqual((await invoiceDates(org.orgId, subscriptionId)).map((row) => row.date), [
      "2025-12-10",
      "2026-01-10",
      "2026-02-10",
    ]);
    assert.equal(await nextBillOn(org.orgId, subscriptionId), "2026-03-10");
    assert.equal(await catchUpAuditCount(org.orgId, subscriptionId), 1, "the choice is audited");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("drafts creates every missed period unposted", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    await addPeriod(org, "2026-01", "2026-01-01", "2026-01-31", 1);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "drafts", asOf: "2026-01-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "caught_up");
    assert.ok(outcome.results.every((row) => row.status === "draft"));
    const dates = await invoiceDates(org.orgId, subscriptionId);
    assert.deepEqual(dates.map((row) => row.date), ["2025-12-10", "2026-01-10"]);
    assert.ok(dates.every((row) => row.status === "draft"), "draft choice never posts");
    assert.equal(await nextBillOn(org.orgId, subscriptionId), "2026-02-10");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("skip advances past missed periods without generating and retries idle", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "skip", asOf: "2026-02-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => row.status), ["skipped", "skipped", "skipped"]);
    assert.equal((await invoiceDates(org.orgId, subscriptionId)).length, 0, "skip generates nothing");
    assert.equal(await nextBillOn(org.orgId, subscriptionId), "2026-03-10");

    const retry = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "skip", asOf: "2026-02-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.deepEqual(retry.results, [], "a retry with nothing pending is a no-op");
    assert.equal(retry.stopped, "caught_up");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a canceled subscription stops the run where it stands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const first = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "post_all", asOf: "2025-12-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(first.results.length, 1);
    await db.execute(sql`update subscriptions set status = 'canceled' where id = ${subscriptionId} and org_id = ${org.orgId}`);
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "post_all", asOf: "2026-02-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "canceled", "the outcome names where generation stopped");
    assert.deepEqual(outcome.results, [], "nothing bills after cancellation");
    assert.equal((await invoiceDates(org.orgId, subscriptionId)).length, 1, "the billed period stands");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("retrying a completed catch-up replays instead of duplicating", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const first = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "post_all", asOf: "2025-12-10", actorId, allowedSubsidiaryIds: null,
    });
    // Rewind the cursor without touching the billed period: the retry must
    // replay the committed invoice, not cut a second one.
    await db.execute(sql`update subscriptions set next_bill_on = '2025-12-10' where id = ${subscriptionId} and org_id = ${org.orgId}`);
    const second = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "post_all", asOf: "2025-12-10", actorId, allowedSubsidiaryIds: null,
    });
    assert.deepEqual(second.results.map((row) => row.status), ["replayed"]);
    assert.equal(second.results[0]?.invoiceId, first.results[0]?.invoiceId, "the same invoice replays");
    assert.equal((await invoiceDates(org.orgId, subscriptionId)).length, 1, "no duplicate invoice");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected bills only the ticked periods and skips the rest", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    await addPeriod(org, "2026-01", "2026-01-01", "2026-01-31", 1);
    await addPeriod(org, "2026-02", "2026-02-01", "2026-02-28", 2);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "selected", selectedPeriods: ["2025-12-10", "2026-02-10"], asOf: "2026-02-10",
      actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.periodStart, row.status]), [
      ["2025-12-10", "posted"],
      ["2026-01-10", "skipped"],
      ["2026-02-10", "posted"],
    ]);
    assert.deepEqual((await invoiceDates(org.orgId, subscriptionId)).map((row) => row.date), [
      "2025-12-10",
      "2026-02-10",
    ]);
    assert.equal(await nextBillOn(org.orgId, subscriptionId), "2026-03-10");
    assert.equal(await catchUpAuditCount(org.orgId, subscriptionId), 1, "the choice is audited");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected drafts the ticked periods when post is false", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await addPeriod(org, "2025-12", "2025-12-01", "2025-12-31", 12);
    await addPeriod(org, "2026-01", "2026-01-01", "2026-01-31", 1);
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const outcome = await runSubscriptionCatchUp(org.orgId, subscriptionId, {
      mode: "selected", selectedPeriods: ["2026-01-10"], postSelected: false, asOf: "2026-01-10",
      actorId, allowedSubsidiaryIds: null,
    });
    assert.equal(outcome.stopped, "caught_up");
    assert.deepEqual(outcome.results.map((row) => [row.periodStart, row.status]), [
      ["2025-12-10", "skipped"],
      ["2026-01-10", "draft"],
    ]);
    const dates = await invoiceDates(org.orgId, subscriptionId);
    assert.ok(dates.every((row) => row.status === "draft"), "draft-selected never posts");
    assert.equal(await nextBillOn(org.orgId, subscriptionId), "2026-02-10");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("selected refuses periods outside the preview by name", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    const subscriptionId = await seedSubscription(org, actorId, { nextBillOn: "2025-12-10" });
    const run = (input: Parameters<typeof runSubscriptionCatchUp>[2]) =>
      runSubscriptionCatchUp(org.orgId, subscriptionId, { asOf: "2026-02-10", actorId, allowedSubsidiaryIds: null, ...input });
    await assert.rejects(
      run({ mode: "selected", selectedPeriods: [] }),
      /selected catch-up needs at least one period date/,
    );
    await assert.rejects(
      run({ mode: "selected", selectedPeriods: ["2025-11-10"] }),
      /selected catch-up period 2025-11-10 is not a pending billing period/,
    );
    await assert.rejects(
      run({ mode: "drafts", selectedPeriods: ["2025-12-10"] }),
      /selected periods apply only to the selected catch-up choice/,
    );
    assert.equal((await invoiceDates(org.orgId, subscriptionId)).length, 0, "refusals bill nothing");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("a back-dated first proration is dated at its stub start", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Catch-up controller", "admin");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true}'::jsonb) where id=${org.orgId}`);
    await addPeriod(org, "2025-11", "2025-11-01", "2025-11-30", 11);
    const planId = randomUUID();
    await db.execute(sql`insert into subscription_plans(id,org_id,name,amount,interval,interval_count,income_account_id,created_by)
      values(${planId},${org.orgId},'Stub plan','130.0000','monthly',1,${org.accounts.revenue},${actorId})`);
    const subscriptionId = randomUUID();
    await db.execute(sql`insert into subscriptions(id,org_id,customer_id,plan_id,quantity,status,start_on,next_bill_on,auto_post,created_by)
      values(${subscriptionId},${org.orgId},${org.customerId},${planId},'1','active','2025-11-01','2025-11-01',false,${actorId})`);
    const gen = await prorateFirstInvoice(org.orgId, subscriptionId, "2025-11-10", undefined, { actorId });
    const doc = (await db.execute<{ date: string }>(sql`
      select document_date::text as "date" from documents where id = ${gen.invoiceId} and org_id = ${org.orgId}`)).rows[0]!;
    assert.equal(doc.date, "2025-11-01", "the stub bills on its own start date, never today");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
