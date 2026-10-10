import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { billSubscriptionNow } from "./subscription-billing.ts";
import { runConsolidationGroup } from "./consolidated-billing.ts";
import { runAutopayCollectionForOrg, type ChargeFn } from "../payments/autopay.ts";
import { runDunningForOrg } from "../receivables/dunning.ts";
import { sealJson } from "../platform/secrets.ts";
import { endOfMonth } from "../platform/civil-date.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

// Consolidated billing pays on the payer: the consolidated invoice names
// the payer on its header while its lines keep their service parties.
// Autopay must collect through the subscription enrollment (anchored on the
// service party) onto the payer's method, and dunning must write to the
// payer — the service child never sees either.

const DB = !!process.env.OPENBOOKS_DB_URL;

async function grantConsolidationOperator(orgId: string, actorId: string): Promise<void> {
  const result = await db.execute(sql`
    update app_roles set permissions='["documents.manage","ar.post"]'::jsonb,
      subsidiary_restriction='{"mode":"all"}'::jsonb
    where org_id=${orgId} and id in
      (select role_id from role_assignments where org_id=${orgId} and user_id=${actorId}) returning id
  `);
  assert.equal(result.rows.length, 1);
}



async function enableFeatures(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"consolidatedBilling":true,"onlinePayments":true,"autopay":true}}'::jsonb
     where id = ${orgId}
  `);
}

async function seedCustomer(orgId: string, name: string, subsidiaryId: string | null, email: string | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'customer', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  if (email) {
    await db.execute(sql`update parties set email = ${email} where id = ${id} and org_id = ${orgId}`);
  }
  return id;
}

const succeedCharge: ChargeFn = async () => ({ status: "succeeded", providerRef: "ch_payer_1" });

type PayerFixture = {
  org: ScratchOrg;
  actorId: string;
  payer: string;
  child: string;
  subscriptionId: string;
  invoiceId: string;
  payerMethodId: string;
};

/** One child subscription consolidated into one posted payer invoice. */
async function seedPayerInvoice(dueDate: string): Promise<PayerFixture> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Billing", "admin");
  await grantConsolidationOperator(org.orgId, actorId);
  await enableFeatures(org.orgId);
  // Collection receipts post on the real today, outside the July billing
  // window: provision the current month so the receipt can post.
  {
    const today = new Date().toISOString().slice(0, 10);
    const startsOn = `${today.slice(0, 7)}-01`;
    const endsOn = endOfMonth(today);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment, custom)
      select ${randomUUID()}, ${org.orgId}, fiscal_calendar_id, ${Number(today.slice(0, 4))},
             ${Number(today.slice(5, 7))}, ${today.slice(0, 7)}, ${startsOn}, ${endsOn}, false, '{}'::jsonb
        from accounting_periods where id = ${org.periodId}
      on conflict do nothing`);
  }
  const payer = await seedCustomer(org.orgId, "Parent Co", org.subsidiaryId, "payer@example.test");
  const child = await seedCustomer(org.orgId, "Child One", org.subsidiaryId, "child@example.test");
  const groupId = randomUUID();
  await db.execute(sql`
    insert into consolidation_groups
      (id, org_id, code, name, payer_party_id, billing_subsidiary_id, cadence, cutoff_day, grouping, template, is_active)
    values (${groupId}, ${org.orgId}, ${"GRP-" + groupId.slice(0, 8)}, 'Parent monthly', ${payer},
            null, 'monthly', 1, 'by_child', 'Parent consolidated', true)`);
  await db.execute(sql`
    insert into customer_billing_relationships
      (org_id, child_party_id, bill_to_party_id, payer_party_id, effective_from, effective_to, consolidation_group_id)
    values (${org.orgId}, ${child}, ${payer}, ${payer}, '2026-01-01'::date, null, ${groupId})`);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Hierarchy Plan', '100.00', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})`);
  const subscriptionId = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
    values (${subscriptionId}, ${org.orgId}, ${child}, ${planId}, '1', 'active',
            ${org.date}, ${org.date}, false, ${actorId})`);
  await billSubscriptionNow(org.orgId, subscriptionId, org.date, { actorId }, null);
  const [run] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
  assert.ok(run && !run.replayed);
  const invoiceId = run.invoiceId;
  const header = (
    await db.execute<{ party: string; custom: Record<string, unknown> }>(sql`
      select party_id as party, custom from documents where id = ${invoiceId} and org_id = ${org.orgId}`)
  ).rows[0]!;
  assert.equal(header.party, payer);
  assert.equal(header.custom["consolidationStatus"], "consolidated");
  await db.execute(sql`
    update documents set status = 'approved' where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
  await db.execute(sql`
    update documents set due_date = ${dueDate}::date where id = ${invoiceId} and org_id = ${org.orgId}`);

  // The service child's own method plus the subscription enrollment anchored
  // on the child: collection must still hit the payer's method below.
  const childMethod = (
    await db.execute<{ id: string }>(sql`
      insert into customer_payment_methods
        (org_id, party_id, provider, provider_customer_id, provider_method_id,
         brand, last4, exp_month, exp_year, is_default, status, created_by, updated_by)
      values (${org.orgId}, ${child}, 'stripe', 'cus_child', 'pm_child',
              'visa', '4242', 12, 2030, true, 'active', ${actorId}, ${actorId})
      returning id`)
  ).rows[0]!.id;
  const payerMethodId = (
    await db.execute<{ id: string }>(sql`
      insert into customer_payment_methods
        (org_id, party_id, provider, provider_customer_id, provider_method_id,
         brand, last4, exp_month, exp_year, is_default, status, created_by, updated_by)
      values (${org.orgId}, ${payer}, 'stripe', 'cus_payer', 'pm_payer',
              'visa', '4242', 12, 2030, true, 'active', ${actorId}, ${actorId})
      returning id`)
  ).rows[0]!.id;
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
            ${sealJson({ apiKey: "sk_test_payer", webhookSecret: "whsec_payer" }, { orgId: org.orgId, purpose: "payment.provider.secrets" })}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into autopay_enrollments (org_id, party_id, subscription_id, payment_method_id, status, created_by, updated_by)
    values (${org.orgId}, ${child}, ${subscriptionId}, ${childMethod}, 'active', ${actorId}, ${actorId})`);
  const policyId = randomUUID();
  await db.execute(sql`
    insert into dunning_policies
      (id, org_id, name, applies_to_kind, grace_period_days, min_balance, is_active,
       autopay_retry_offsets_days, autopay_final_action, created_by, updated_by)
    values (${policyId}, ${org.orgId}, 'Collections', 'customer_invoice', 0, '0', true,
            '{}'::integer[], 'none', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into dunning_stages
      (id, org_id, policy_id, sequence, name, offset_days, subject_template, body_template)
    values (${randomUUID()}, ${org.orgId}, ${policyId}, 1, 'First reminder', 0,
            'Reminder: {{invoice}}', 'Hi {{party}}, {{amount}} was due.')`);
  return { org, actorId, payer, child, subscriptionId, invoiceId, payerMethodId };
}

test("autopay collects a consolidated invoice through the subscription enrollment onto the payer method", { skip: !DB }, async () => {
  const fix = await seedPayerInvoice("2026-06-15");
  try {
    const result = await runAutopayCollectionForOrg(fix.org.orgId, { asOf: "2026-08-15", charge: succeedCharge });
    assert.equal(result.charged, 1);
    assert.equal(result.succeeded, 1);
    const attempt = (
      await db.execute<{ methodId: string; enrollmentParty: string; status: string }>(sql`
        select a.payment_method_id as "methodId", e.party_id as "enrollmentParty", a.status
          from collection_attempts a
          join autopay_enrollments e on e.id = a.enrollment_id and e.org_id = a.org_id
         where a.org_id = ${fix.org.orgId} and a.invoice_id = ${fix.invoiceId}`)
    ).rows[0]!;
    assert.equal(attempt.methodId, fix.payerMethodId);
    assert.equal(attempt.enrollmentParty, fix.child);
    assert.equal(attempt.status, "succeeded");

    // One invoice collects once: the subscription arm must not double-charge
    // what the payer enrollment path (or a rerun) already owns.
    const again = await runAutopayCollectionForOrg(fix.org.orgId, { asOf: "2026-08-15", charge: succeedCharge });
    assert.equal(again.charged, 0);
  } finally {
    await dropScratchOrg(fix.org.orgId);
  }
});

test("dunning writes to the payer, never the service child", { skip: !DB }, async () => {
  const fix = await seedPayerInvoice("2026-06-15");
  try {
    const result = await runDunningForOrg(fix.org.orgId, "2026-08-15");
    assert.ok(result.scanned >= 1);
    const log = (
      await db.execute<{ partyId: string; toEmail: string }>(sql`
        select party_id as "partyId", to_email as "toEmail" from dunning_log
         where org_id = ${fix.org.orgId} and document_id = ${fix.invoiceId}`)
    ).rows[0]!;
    assert.equal(log.partyId, fix.payer);
    assert.equal(log.toEmail, "payer@example.test");
  } finally {
    await dropScratchOrg(fix.org.orgId);
  }
});

test("an enrolled consolidated invoice without a payer method is refused by name", { skip: !DB }, async () => {
  const fix = await seedPayerInvoice("2026-06-15");
  try {
    await db.execute(sql`
      delete from customer_payment_methods where org_id = ${fix.org.orgId} and party_id = ${fix.payer}`);
    const result = await runAutopayCollectionForOrg(fix.org.orgId, { asOf: "2026-08-15", charge: succeedCharge });
    assert.equal(result.charged, 0);
    assert.equal(result.skipped, 1);
    const notice = result.notices.find((item) => item.invoiceId === fix.invoiceId);
    assert.ok(notice);
    assert.match(notice.detail, /no active payment method/);
  } finally {
    await dropScratchOrg(fix.org.orgId);
  }
});
