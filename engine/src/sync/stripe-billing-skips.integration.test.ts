import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { UsageBillingError } from "../billing/usage/errors.ts";
import {
  getStripeBillingOverview,
  importStripeBilling,
  linkStripeCustomer,
  listStripeSkips,
  saveStripeBillingSchedule,
  skipStripeObject,
  unskipStripeObject,
  type StripeBillingFetch,
} from "./stripe-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };
const ACCOUNT = { id: "acct_skip", object: "account" };

function transport(): StripeBillingFetch {
  return async (url) => {
    const path = new URL(url).pathname;
    const data = path === "/v1/customers"
      ? [{ id: "cus_keep", email: "keep@example.test" }, { id: "cus_skip", email: "skip@example.test" }]
      : [];
    return { status: 200, json: async () => path === "/v1/account" ? ACCOUNT : { data, has_more: false } };
  };
}

async function setup(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await withOrgContext(org.orgId, () => createScratchUser(org.orgId, "Stripe skip tester", "admin"));
    await withOrgContext(org.orgId, async () => {
      const result = await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features','{}'::jsonb) || '{"subscriptionBilling":true,"usageBilling":true}'::jsonb, true) where id = ${org.orgId}`);
      assert.equal(result.rowCount, 1);
      await db.execute(sql`insert into psp_provider_configs (org_id,provider,display_name,is_enabled,acceptance_enabled,default_bank_account_id,secrets,created_by,updated_by) values (${org.orgId},'stripe','Stripe',true,true,${org.accounts.bank},${sealJson({ apiKey: "sk_test_skip_triage" }, { orgId: org.orgId, purpose: "payment.provider.secrets" })},${actor},${actor})`);
    });
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("skipped Stripe customers stay out of unlinked triage until unskipped or linked", DB, async () => {
  await setup(async (org, actor) => {
    const first = await importStripeBilling(org.orgId, actor, { since: "2026-07-01", until: "2026-07-31" }, { fetch: transport() });
    assert.equal(first.counts.customers.unlinked, 2);

    await skipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_skip", "test customer");
    // A repeated skip is idempotent, not a conflict.
    await skipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_skip", "test customer");
    assert.equal((await listStripeSkips(org.orgId)).length, 1);

    const second = await importStripeBilling(org.orgId, actor, { since: "2026-07-01", until: "2026-07-31" }, { fetch: transport() });
    assert.equal(second.counts.customers.skipped, 1);
    assert.equal(second.counts.customers.unlinked, 1);
    assert.deepEqual(second.unlinkedCustomers.map((row) => row.stripeId), ["cus_keep"]);
    assert.ok(!second.refusals.some((row) => row.stripeId === "cus_skip"));

    const overview = await getStripeBillingOverview(org.orgId);
    assert.deepEqual(overview.unlinked.map((row) => row.stripeId), ["cus_keep"]);
    assert.deepEqual(overview.skipped.map((row) => row.stripeId), ["cus_skip"]);

    await unskipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_skip");
    assert.deepEqual(await listStripeSkips(org.orgId), []);
    const third = await importStripeBilling(org.orgId, actor, { since: "2026-07-01", until: "2026-07-31" }, { fetch: transport() });
    assert.deepEqual(third.unlinkedCustomers.map((row) => row.stripeId).sort(), ["cus_keep", "cus_skip"]);

    // Linking removes the skip: skip again, then link, and the skip is gone.
    await skipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_skip", null);
    await linkStripeCustomer(org.orgId, actor, "cus_skip", org.customerId, null, { fetch: transport() });
    assert.deepEqual(await listStripeSkips(org.orgId), []);

    // A linked object cannot be skipped.
    await assert.rejects(
      skipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_skip", null),
      (error: unknown) => error instanceof UsageBillingError && error.code === "stripe_link_exists" && error.status === 409,
    );
    // Unskipping what was never skipped refuses by name.
    await assert.rejects(
      unskipStripeObject(org.orgId, actor, "acct_skip", "customer", "cus_missing"),
      (error: unknown) => error instanceof UsageBillingError && error.code === "stripe_skip_missing",
    );
    // The schedule accepts only its three cadences.
    await assert.rejects(
      saveStripeBillingSchedule(org.orgId, actor, "minutely"),
      (error: unknown) => error instanceof UsageBillingError && error.code === "stripe_schedule_invalid",
    );
    assert.equal(await saveStripeBillingSchedule(org.orgId, actor, "daily"), "daily");
    assert.equal((await getStripeBillingOverview(org.orgId)).schedule, "daily");
    void randomUUID;
  });
});
