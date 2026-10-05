import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { billSubscriptionNow } from "./subscription-billing.ts";
import {
  runConsolidationGroup,
  runDueConsolidations,
} from "./consolidated-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFeatures(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = settings || '{"features":{"subscriptionBilling":true,"consolidatedBilling":true}}'::jsonb
     where id = ${orgId}
  `);
}

async function seedCustomer(orgId: string, name: string, subsidiaryId: string | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${id}, ${orgId}, 'customer', ${name}, ${subsidiaryId}, true, '{}'::jsonb)`);
  return id;
}

async function seedPlan(org: ScratchOrg, actorId: string, amount = "100.00"): Promise<string> {
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, interval, interval_count, income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Hierarchy Plan', ${amount}, 'monthly', 1,
            ${org.accounts.revenue}, true, ${actorId})`);
  return planId;
}

async function seedSubscription(
  org: ScratchOrg,
  actorId: string,
  planId: string,
  customerId: string,
  nextBillOn: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subscriptions
      (id, org_id, customer_id, plan_id, quantity, status, start_on, next_bill_on, auto_post, created_by)
    values (${id}, ${org.orgId}, ${customerId}, ${planId}, '1', 'active',
            ${nextBillOn}, ${nextBillOn}, false, ${actorId})`);
  return id;
}

async function seedGroup(
  orgId: string,
  payerId: string,
  opts: { billingSubsidiaryId?: string | null; grouping?: string; template?: string | null } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into consolidation_groups
      (id, org_id, code, name, payer_party_id, billing_subsidiary_id, cadence, cutoff_day, grouping, template, is_active)
    values (${id}, ${orgId}, ${"GRP-" + id.slice(0, 8)}, 'Parent monthly', ${payerId},
            ${opts.billingSubsidiaryId ?? null}, 'monthly', 1, ${opts.grouping ?? "by_child"},
            ${opts.template ?? null}, true)`);
  return id;
}

async function seedRelationship(
  orgId: string,
  childId: string,
  payerId: string,
  groupId: string | null,
  from: string,
  to: string | null,
): Promise<void> {
  await db.execute(sql`
    insert into customer_billing_relationships
      (org_id, child_party_id, bill_to_party_id, payer_party_id, effective_from, effective_to, consolidation_group_id)
    values (${orgId}, ${childId}, ${payerId}, ${payerId}, ${from}::date, ${to}::date, ${groupId})`);
}

test(
  "three child subscriptions consolidate into one payer invoice with grouped lines and exact totals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await enableFeatures(org.orgId);
      const payer = await seedCustomer(org.orgId, "Parent Co", org.subsidiaryId);
      const children = [
        await seedCustomer(org.orgId, "Child One", org.subsidiaryId),
        await seedCustomer(org.orgId, "Child Two", org.subsidiaryId),
        await seedCustomer(org.orgId, "Child Three", org.subsidiaryId),
      ];
      const groupId = await seedGroup(org.orgId, payer, { template: "Parent consolidated" });
      for (const child of children) await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      for (const child of children) {
        const sub = await seedSubscription(org, actorId, planId, child, org.date);
        const gen = await billSubscriptionNow(org.orgId, sub, org.date, { actorId }, null);
        const draft = (await db.execute<{ party: string; status: string; custom: Record<string, unknown> }>(sql`
          select party_id as party, status, custom from documents where id = ${gen.invoiceId}`)).rows[0]!;
        assert.equal(draft.party, payer, "the child charge is AR of the payer");
        assert.equal(draft.status, "draft", "a grouped charge stays draft for the run");
        assert.equal(draft.custom["consolidationStatus"], "pending_consolidation");
      }
      const [run] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
      assert.ok(run);
      assert.equal(run.replayed, false);
      assert.equal(run.total, "300.0000");
      const invoice = (await db.execute<{ party: string; status: string; subtotal: string; total: string; custom: Record<string, unknown> }>(sql`
        select party_id as party, status, subtotal::text as subtotal, total::text as total, custom
          from documents where id = ${run.invoiceId}`)).rows[0]!;
      assert.equal(invoice.party, payer, "AR lives on the payer");
      assert.equal(invoice.status, "draft");
      assert.equal(invoice.custom["template"], "Parent consolidated", "the group's template designation travels on the invoice");
      assert.equal(invoice.subtotal, "300.0000");
      assert.equal(invoice.total, "300.0000");
      const lines = (await db.execute<{ service: string; amount: string }>(sql`
        select service_party_id as service, amount::text as amount from document_lines
         where document_id = ${run.invoiceId} order by line_number`)).rows;
      assert.deepEqual(
        lines.map((l) => [l.service, l.amount]),
        children.map((c) => [c, "100.0000"]),
        "one line per child, grouped by child, with exact amounts",
      );
      const links = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from document_links
         where org_id = ${org.orgId} and to_document_id = ${run.invoiceId} and link_type = 'created_from'`)).rows[0]!;
      assert.equal(links.n, 3, "every superseded draft links to the consolidated invoice");
      const live = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind = 'customer_invoice'
           and custom->>'consolidationStatus' = 'pending_consolidation'`)).rows[0]!;
      assert.equal(live.n, 0, "no pending draft survives its consolidation");

      const before = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where org_id = ${org.orgId}`)).rows[0]!.n;
      const [replay] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
      assert.ok(replay?.replayed, "re-running a completed bucket replays instead of re-billing");
      assert.equal(replay.invoiceId, run.invoiceId);
      const after = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where org_id = ${org.orgId}`)).rows[0]!.n;
      assert.equal(after, before, "the replay writes no second invoice");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "an effective-dated relationship change bills each period to the right payer",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await enableFeatures(org.orgId);
      const child = await seedCustomer(org.orgId, "Moving Child", org.subsidiaryId);
      const first = await seedCustomer(org.orgId, "First Payer", org.subsidiaryId);
      const second = await seedCustomer(org.orgId, "Second Payer", org.subsidiaryId);
      await seedRelationship(org.orgId, child, first, null, "2026-01-01", "2026-06-30");
      await seedRelationship(org.orgId, child, second, null, "2026-07-01", null);
      const planId = await seedPlan(org, actorId);
      const sub = await seedSubscription(org, actorId, planId, child, "2026-06-15");
      const june = await billSubscriptionNow(org.orgId, sub, "2026-06-15", { actorId }, null);
      await db.execute(sql`update subscriptions set next_bill_on = '2026-07-20' where id = ${sub}`);
      const july = await billSubscriptionNow(org.orgId, sub, "2026-07-20", { actorId }, null);
      const parties = (await db.execute<{ id: string; party: string }>(sql`
        select id, party_id as party from documents where id in (${june.invoiceId}, ${july.invoiceId})`)).rows;
      assert.equal(parties.find((p) => p.id === june.invoiceId)?.party, first, "the June charge follows the June payer");
      assert.equal(parties.find((p) => p.id === july.invoiceId)?.party, second, "the July charge follows the July payer");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "a cross-entity consolidation posts a balanced intercompany pair",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await enableFeatures(org.orgId);
      const branchId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'Branch B', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      const dueFrom = randomUUID();
      const dueTo = randomUUID();
      for (const [id, number, name, type] of [
        [dueFrom, "1410", "Due from affiliates", "asset_current_other"],
        [dueTo, "2410", "Due to affiliates", "liability_current_other"],
      ] as const) {
        await db.execute(sql`
          insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children)
          values (${id},${org.orgId},${number},${name},${type},false,true,true,false,'[]'::jsonb,'{}'::jsonb,true)`);
      }
      await db.execute(sql`
        insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id)
        values (${org.orgId},${org.subsidiaryId},${branchId},${dueFrom},${dueTo})`);
      const payer = await seedCustomer(org.orgId, "Parent Co", org.subsidiaryId);
      const child = await seedCustomer(org.orgId, "Branch Child", branchId);
      const groupId = await seedGroup(org.orgId, payer, { billingSubsidiaryId: org.subsidiaryId });
      await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      const sub = await seedSubscription(org, actorId, planId, child, org.date);
      await billSubscriptionNow(org.orgId, sub, org.date, { actorId }, null);
      const [run] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", {
        actorId,
        autoPost: true,
      });
      assert.ok(run?.posted, "the consolidated invoice posts");
      const entry = (await db.execute<{ entry: string }>(sql`
        select posted_entry_id as entry from documents where id = ${run.invoiceId}`)).rows[0]!.entry;
      assert.ok(entry, "posting records its journal entry");
      const legs = (await db.execute<{ account: string; subsidiary: string; amount: string }>(sql`
        select account_id as account, subsidiary_id as subsidiary, amount::text as amount
          from journal_lines where org_id = ${org.orgId} and entry_id = ${entry}`)).rows;
      const total = legs.reduce((sum, leg) => sum + BigInt(leg.amount.replace(".", "")), 0n);
      assert.equal(total, 0n, "the cross-entity journal balances overall");
      const bySub = new Map<string, bigint>();
      for (const leg of legs) {
        const units = BigInt(leg.amount.replace(".", ""));
        bySub.set(leg.subsidiary, (bySub.get(leg.subsidiary) ?? 0n) + units);
      }
      for (const [sub, sum] of bySub) assert.equal(sum, 0n, `entity ${sub} balances on its own`);
      const accounts = new Set(legs.map((l) => l.account));
      assert.ok(accounts.has(dueFrom) && accounts.has(dueTo), "the pair travels on due-from/due-to legs");
      assert.ok(legs.some((l) => l.subsidiary === branchId), "service-entity legs survive on the branch");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the scheduler scan consolidates the closed bucket and leaves the open one pending",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await enableFeatures(org.orgId);
      const payer = await seedCustomer(org.orgId, "Parent Co", org.subsidiaryId);
      const child = await seedCustomer(org.orgId, "Only Child", org.subsidiaryId);
      const groupId = await seedGroup(org.orgId, payer);
      await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      const july = await seedSubscription(org, actorId, planId, child, "2026-07-15");
      await billSubscriptionNow(org.orgId, july, "2026-07-15", { actorId }, null);
      const august = await seedSubscription(org, actorId, planId, child, "2026-08-03");
      await billSubscriptionNow(org.orgId, august, "2026-08-03", { actorId }, null);
      const scan = await runDueConsolidations("2026-08-05");
      assert.equal(scan.failed, 0, `the scan takes no org down: ${JSON.stringify(scan.orgErrors)}`);
      assert.equal(scan.consolidated, 1, "only the closed July bucket consolidates");
      const julyInvoice = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind = 'customer_invoice'
           and custom->>'consolidationStatus' = 'consolidated'`)).rows[0]!.n;
      assert.equal(julyInvoice, 1);
      const augustPending = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind = 'customer_invoice'
           and custom->>'consolidationStatus' = 'pending_consolidation'`)).rows[0]!.n;
      assert.equal(augustPending, 1, "the still-open August bucket keeps collecting");
      const before = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where org_id = ${org.orgId}`)).rows[0]!.n;
      const replay = await runDueConsolidations("2026-08-05");
      assert.equal(replay.consolidated, 0, "a second scan cuts no second invoice");
      assert.equal(replay.replayed, 0, "the scan never revisits a bucket with nothing pending");
      const after = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where org_id = ${org.orgId}`)).rows[0]!.n;
      assert.equal(after, before, "the replay writes nothing new");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "the scheduler scan keeps a feature-off organization's drafts untouched",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await enableFeatures(org.orgId);
      const payer = await seedCustomer(org.orgId, "Parent Co", org.subsidiaryId);
      const child = await seedCustomer(org.orgId, "Only Child", org.subsidiaryId);
      const groupId = await seedGroup(org.orgId, payer);
      await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      const sub = await seedSubscription(org, actorId, planId, child, "2026-07-15");
      await billSubscriptionNow(org.orgId, sub, "2026-07-15", { actorId }, null);
      await db.execute(sql`
        update orgs set settings = settings || '{"features":{"consolidatedBilling":false}}'::jsonb
         where id = ${org.orgId}`);
      const scan = await runDueConsolidations("2026-08-05");
      assert.equal(scan.failed, 0, `the scan takes no org down: ${JSON.stringify(scan.orgErrors)}`);
      const runs = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from consolidation_runs where org_id = ${org.orgId}`)).rows[0]!.n;
      assert.equal(runs, 0, "no run is recorded while the feature is off");
      const pending = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and kind = 'customer_invoice'
           and custom->>'consolidationStatus' = 'pending_consolidation'`)).rows[0]!.n;
      assert.equal(pending, 1, "switching off keeps the pending draft, never consolidates it");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
