import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { commitRateRun, voidAndRebillRateRun } from "../billing/usage/rate-run.ts";
import { createUsageMeter, ingestUsageRecords } from "../billing/usage/records.ts";
import { createSubscriptionUsageLink, createUsageRatingPlan, createUsageRatingPlanVersion, publishUsagePlanVersion, replaceUsageRatingBands } from "../billing/usage/rating-plans.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { saasUsageMonthInvariant } from "./saas-usage.ts";

for (const reversalDate of ["2026-07-31", "2026-08-15"]) {
  test(`usage accounting retains original and reversing evidence when voided on ${reversalDate}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      await withOrgContext(org.orgId, async () => {
        const actor = await createScratchUser(org.orgId, "Usage accounting controller", "admin");
        const itemId = randomUUID(), planId = randomUUID(), subscriptionId = randomUUID();
        await withOrgTransaction(org.orgId, async () => {
          const enabled = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
            coalesce(settings->'features', '{}'::jsonb) || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb)
            where id = ${org.orgId} returning id`);
          assert.equal(enabled.rows.length, 1, "usage billing must be enabled for the fixture organization");
          const item = await db.execute(sql`insert into items (id, org_id, kind, name, income_account_id, is_active, custom)
            values (${itemId}, ${org.orgId}, 'service', 'Metered requests', ${org.accounts.recognized}, true, '{}'::jsonb) returning id`);
          assert.equal(item.rows.length, 1, "usage must post directly to its configured revenue account");
          const plan = await db.execute(sql`insert into subscription_plans (id, org_id, name, amount, currency_code, "interval", interval_count)
            values (${planId}, ${org.orgId}, 'Metered service', '0', 'CAD', 'monthly', 1) returning id`);
          assert.equal(plan.rows.length, 1, "the subscription plan must exist");
          const subscription = await db.execute(sql`insert into subscriptions (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on)
            values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${planId}, 1, 'active', ${org.date}, ${org.date}) returning id`);
          assert.equal(subscription.rows.length, 1, "the customer must have an active subscription");
          const period = await db.execute(sql`insert into accounting_periods
            (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
            select org_id, fiscal_calendar_id, 2026, 8, 'August 2026', '2026-08-01', '2026-08-31', false
              from accounting_periods where org_id = ${org.orgId} and id = ${org.periodId} returning id`);
          assert.equal(period.rows.length, 1, "August must be available for a dated reversal");
          // A balanced draft journal contains real lines but is not accounting evidence.
          const draftId = randomUUID();
          const draft = await db.execute(sql`insert into journal_entries
            (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
            values (${draftId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'UNPOSTED-USAGE', ${org.date}, ${org.periodId}, 'draft', 'manual') returning id`);
          assert.equal(draft.rows.length, 1, "the unposted journal must be stored");
          for (const [lineNumber, accountId, amount] of [[1, org.accounts.bank, "99"], [2, org.accounts.recognized, "-99"]] as const) {
            const line = await db.execute(sql`insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
              values (${org.orgId}, ${draftId}, ${lineNumber}, ${accountId}, ${org.subsidiaryId}, ${amount}, 'CAD', ${amount}, 1) returning id`);
            assert.equal(line.rows.length, 1, "each balanced draft line must be observable");
          }
        });
        const meter = await createUsageMeter(org.orgId, actor, { key: "accounting-requests", name: "Requests", unit: "request", aggregation: "sum", itemId });
        const ratingPlan = await createUsageRatingPlan(org.orgId, actor, { name: "Request pricing", currency: "CAD" });
        const version = await createUsageRatingPlanVersion(org.orgId, actor, { planId: ratingPlan.id, effectiveFrom: org.date });
        await replaceUsageRatingBands(org.orgId, actor, version.id, [{ meterId: meter.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "2" }]);
        await publishUsagePlanVersion(org.orgId, actor, version.id);
        const link = await createSubscriptionUsageLink(org.orgId, actor, { subscriptionId, customerId: org.customerId, planVersionId: version.id, meterIds: [meter.id], effectiveFrom: org.date });
        await ingestUsageRecords(org.orgId, actor, [{ meterKey: meter.key, customerId: org.customerId, subscriptionId, occurredOn: org.date, quantity: "10", source: "api", idempotencyKey: randomUUID() }]);
        const first = await commitRateRun(org.orgId, actor, link.id, org.date, "2026-07-31");
        assert.ok(first.invoiceId);
        assert.equal(first.preview.totalRated, "20.0000");
        assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "neither an unposted usage invoice nor draft journal lines count");
        const approve = async (invoiceId: string) => {
          const approved = await db.execute(sql`update documents set status = 'approved'
            where org_id = ${org.orgId} and id = ${invoiceId} and status = 'draft' returning id`);
          assert.equal(approved.rows.length, 1, "the invoice must enter the approved but unposted state");
        };
        await approve(first.invoiceId);
        assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "approval alone is not posted accounting evidence");
        await postDocument(first.invoiceId, { control: await loadRequiredControlAccounts(org.orgId) }, { audit: { actorId: actor, source: "usage-accounting-test" } });
        assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "the posted invoice and its real journal must tie");
        const original = (await db.execute<{ id: string }>(sql`select posted_entry_id as id from documents
          where org_id = ${org.orgId} and id = ${first.invoiceId}`)).rows[0];
        assert.ok(original?.id);
        const voided = await requestDocumentVoid({ orgId: org.orgId, actorId: actor, documentId: first.invoiceId,
          reversalDate, reason: "Correct the metered service invoice", allowedSubsidiaryIds: null });
        assert.equal(voided.status, "voided");
        assert.ok(voided.reversalEntryId);
        const history = (await db.execute<{ id: string; status: string; posting_date: string; revenue: string; balance: string }>(sql`
          select e.id, e.status, e.posting_date::text,
                 sum(l.amount) filter (where l.account_id = ${org.accounts.recognized})::text as revenue,
                 sum(l.amount)::text as balance
            from journal_entries e join journal_lines l on l.org_id = e.org_id and l.entry_id = e.id
           where e.org_id = ${org.orgId} and e.id in (${original.id}, ${voided.reversalEntryId})
           group by e.id order by e.status`)).rows;
        assert.deepEqual(history, [
          { id: voided.reversalEntryId, status: "posted", posting_date: reversalDate, revenue: "20.0000", balance: "0.0000" },
          { id: original.id, status: "reversed", posting_date: "2026-07-31", revenue: "-20.0000", balance: "0.0000" },
        ], "voiding preserves the original balanced journal and posts an independently dated negative mirror");
        assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "same-month reversals net to zero; later reversals preserve July");
        const replacement = await voidAndRebillRateRun(org.orgId, actor, first.run.id);
        if ("status" in replacement) assert.fail("a completed void must permit replacement rating");
        assert.equal(replacement.run.supersedesRunId, first.run.id);
        assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "superseding a run cannot remove its posted history, even while the replacement is draft");
        if (reversalDate.startsWith("2026-08")) {
          await ingestUsageRecords(org.orgId, actor, [{ meterKey: meter.key, customerId: org.customerId, subscriptionId, occurredOn: "2026-08-15", quantity: "1", source: "api", idempotencyKey: randomUUID() }]);
          const august = await commitRateRun(org.orgId, actor, link.id, "2026-08-01", "2026-08-31");
          assert.ok(august.invoiceId);
          assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "August includes July's negative reversal leg without repeating July's positive leg");
          await approve(august.invoiceId);
          await postDocument(august.invoiceId, { control: await loadRequiredControlAccounts(org.orgId) }, { audit: { actorId: actor, source: "usage-accounting-test" } });
          assert.deepEqual(await saasUsageMonthInvariant(org.orgId), [], "August's new invoice nets against the independently dated reversal");
        }
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
