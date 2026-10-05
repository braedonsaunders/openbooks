import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import type { CanonicalBillingHistory } from "./billing-history.ts";
import {
  type BillingHistorySource,
  runBillingHistoryImport,
} from "./billing-history-import.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A billing platform frozen mid-contract: one customer on Starter $29/mo,
 * upgraded to Growth $99/mo on 2024-03-10, downgraded back to Starter on
 * 2024-05-20, then canceled 2024-07-01 with the June invoice still open.
 * All amounts are exact major-unit spellings — the fixture never floats.
 */
function fixtureHistory(): CanonicalBillingHistory {
  return {
    customers: [
      { externalId: "cus_fixture_1", name: "Fixture Acme", email: "billing@fixture.example", currency: "USD", updatedAt: "2024-01-01" },
    ],
    plans: [
      { externalId: "starter", name: "Starter", amountMajor: "29.0000", currency: "USD", interval: "monthly", intervalCount: 1, updatedAt: "2024-01-01" },
      { externalId: "growth", name: "Growth", amountMajor: "99.0000", currency: "USD", interval: "monthly", intervalCount: 1, updatedAt: "2024-01-01" },
    ],
    subscriptions: [
      {
        externalId: "sub_fixture_1",
        customerExternalId: "cus_fixture_1",
        planExternalId: "starter",
        quantity: "1",
        unitAmountMajor: null,
        currency: "USD",
        status: "canceled",
        startOn: "2024-01-15",
        canceledOn: "2024-07-01",
        trialEndOn: null,
        currentTermEndOn: null,
        updatedAt: "2024-07-01",
        changes: [
          { seq: 0, effectiveOn: "2024-03-10", kind: "plan_change", planExternalId: "growth", quantity: null, unitAmountMajor: null, derived: false },
          { seq: 1, effectiveOn: "2024-05-20", kind: "plan_change", planExternalId: "starter", quantity: null, unitAmountMajor: null, derived: false },
        ],
      },
    ],
    invoices: [
      { externalId: "inv_01", number: "INV-01", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-01-15", dueDate: "2024-02-14", currency: "USD", lines: [{ description: "Starter", quantity: "1", unitPriceMajor: "29.0000", amountMajor: "29.0000", taxAmountMajor: "0.0000", planExternalId: "starter" }], taxTotalMajor: "0.0000", totalMajor: "29.0000", balanceMajor: "0.0000", status: "paid", updatedAt: "2024-01-16" },
      { externalId: "inv_02", number: "INV-02", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-02-15", dueDate: "2024-03-16", currency: "USD", lines: [{ description: "Starter", quantity: "1", unitPriceMajor: "29.0000", amountMajor: "29.0000", taxAmountMajor: "0.0000", planExternalId: "starter" }], taxTotalMajor: "0.0000", totalMajor: "29.0000", balanceMajor: "0.0000", status: "paid", updatedAt: "2024-02-16" },
      { externalId: "inv_03", number: "INV-03", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-03-15", dueDate: "2024-04-14", currency: "USD", lines: [{ description: "Growth", quantity: "1", unitPriceMajor: "99.0000", amountMajor: "99.0000", taxAmountMajor: "0.0000", planExternalId: "growth" }], taxTotalMajor: "0.0000", totalMajor: "99.0000", balanceMajor: "0.0000", status: "paid", updatedAt: "2024-03-16" },
      { externalId: "inv_04", number: "INV-04", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-04-15", dueDate: "2024-05-15", currency: "USD", lines: [{ description: "Growth", quantity: "1", unitPriceMajor: "99.0000", amountMajor: "99.0000", taxAmountMajor: "0.0000", planExternalId: "growth" }], taxTotalMajor: "0.0000", totalMajor: "99.0000", balanceMajor: "0.0000", status: "paid", updatedAt: "2024-04-16" },
      { externalId: "inv_05", number: "INV-05", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-05-15", dueDate: "2024-06-14", currency: "USD", lines: [{ description: "Starter", quantity: "1", unitPriceMajor: "29.0000", amountMajor: "29.0000", taxAmountMajor: "0.0000", planExternalId: "starter" }], taxTotalMajor: "0.0000", totalMajor: "29.0000", balanceMajor: "0.0000", status: "paid", updatedAt: "2024-05-16" },
      { externalId: "inv_06", number: "INV-06", customerExternalId: "cus_fixture_1", subscriptionExternalId: "sub_fixture_1", date: "2024-06-15", dueDate: "2024-07-15", currency: "USD", lines: [{ description: "Starter", quantity: "1", unitPriceMajor: "29.0000", amountMajor: "29.0000", taxAmountMajor: "0.0000", planExternalId: "starter" }], taxTotalMajor: "0.0000", totalMajor: "29.0000", balanceMajor: "29.0000", status: "open", updatedAt: "2024-06-16" },
    ],
    creditNotes: [],
    payments: [
      { externalId: "pay_01", customerExternalId: "cus_fixture_1", date: "2024-01-16", currency: "USD", amountMajor: "29.0000", method: "card", applications: [{ invoiceExternalId: "inv_01", amountMajor: "29.0000" }], updatedAt: "2024-01-16" },
      { externalId: "pay_02", customerExternalId: "cus_fixture_1", date: "2024-02-16", currency: "USD", amountMajor: "29.0000", method: "card", applications: [{ invoiceExternalId: "inv_02", amountMajor: "29.0000" }], updatedAt: "2024-02-16" },
      { externalId: "pay_03", customerExternalId: "cus_fixture_1", date: "2024-03-16", currency: "USD", amountMajor: "99.0000", method: "card", applications: [{ invoiceExternalId: "inv_03", amountMajor: "99.0000" }], updatedAt: "2024-03-16" },
      { externalId: "pay_04", customerExternalId: "cus_fixture_1", date: "2024-04-16", currency: "USD", amountMajor: "99.0000", method: "card", applications: [{ invoiceExternalId: "inv_04", amountMajor: "99.0000" }], updatedAt: "2024-04-16" },
      { externalId: "pay_05", customerExternalId: "cus_fixture_1", date: "2024-05-16", currency: "USD", amountMajor: "29.0000", method: "card", applications: [{ invoiceExternalId: "inv_05", amountMajor: "29.0000" }], updatedAt: "2024-05-16" },
    ],
    usage: [],
    coupons: [],
    revenueSchedules: [],
  };
}

function fakeSource(): BillingHistorySource {
  return {
    provider: "chargebee",
    externalAccount: "fixture-site",
    pull: async () => fixtureHistory(),
  };
}

test(
  "billing history import reconstructs amendments, ties MRR and re-runs idempotently",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() => createScratchUser(org.orgId, "Billing importer", "admin"));
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          update orgs
             set settings = settings || '{"features":{"subscriptionBilling":true,"advancedSubscriptions":true,"billingHistoryImport":true}}'::jsonb
           where id = ${org.orgId}
        `);
      });
      const options = {
        orgId: org.orgId,
        actorId,
        mode: "opening_balances" as const,
        cutoverOn: "2024-07-15",
        incomeAccountId: org.accounts.revenue,
      };
      const first = await runBillingHistoryImport(fakeSource(), options);
      assert.equal(first.counts.subscriptions, 1);
      assert.equal(first.counts.amendments, 2);
      assert.equal(first.reconciliation.ties, true, JSON.stringify(first.reconciliation.differences));

      const amendments = await withOrgContext(org.orgId, () => db.execute<{ amendment_type: string; effective_on: string }>(sql`
        select a.amendment_type as amendment_type, a.effective_on::text as effective_on
          from subscription_amendments a
          join subscriptions s on s.org_id = a.org_id and s.id = a.subscription_id
          join external_links l on l.org_id = s.org_id and l.native_table = 'subscriptions' and l.native_id = s.id
         where a.org_id = ${org.orgId} and l.provider = 'chargebee' and l.external_id = 'sub_fixture_1'
         order by a.amendment_number
      `));
      assert.deepEqual(
        amendments.rows.map((row) => `${row.amendment_type}@${row.effective_on}`),
        ["change_component@2024-03-10", "change_component@2024-05-20"],
      );
      const mrr = Object.fromEntries(first.reconciliation.mrr.map((row) => [row.month, row.openbooksMrrMajor]));
      assert.equal(mrr["2024-01"], "29.0000");
      assert.equal(mrr["2024-02"], "29.0000");
      assert.equal(mrr["2024-03"], "99.0000");
      assert.equal(mrr["2024-04"], "99.0000");
      assert.equal(mrr["2024-05"], "29.0000");
      assert.equal(mrr["2024-06"], "29.0000");
      assert.equal(mrr["2024-07"], "0.0000");
      // Tied rows leave the differences-only AR view, so the open invoice is
      // verified against the native draft document itself.
      assert.equal(first.reconciliation.openAr.find((row) => row.customerExternalId === "cus_fixture_1"), undefined);
      const openDocs = await withOrgContext(org.orgId, () => db.execute<{ total: string }>(sql`
        select d.total::text as total
          from documents d
          join external_links l on l.org_id = d.org_id and l.native_id = d.id
         where d.org_id = ${org.orgId} and d.kind = 'customer_invoice' and d.status = 'draft'
           and l.provider = 'chargebee' and l.native_table = 'documents' and l.object_type = 'invoice'
      `));
      assert.deepEqual(openDocs.rows.map((row) => row.total), ["29.0000"]);

      const second = await runBillingHistoryImport(fakeSource(), options);
      assert.equal(second.counts.subscriptions, 1);
      const subscriptionRows = await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from subscriptions s
         where s.org_id = ${org.orgId}
           and exists (select 1 from external_links l
                        where l.org_id = s.org_id and l.native_table = 'subscriptions'
                          and l.native_id = s.id and l.provider = 'chargebee' and l.external_id = 'sub_fixture_1')
      `));
      assert.equal(subscriptionRows.rows[0]?.n, 1);
      const amendmentRows = await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from subscription_amendments a where a.org_id = ${org.orgId}
      `));
      assert.equal(amendmentRows.rows[0]?.n, 2);
      assert.equal(second.reconciliation.ties, true);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
