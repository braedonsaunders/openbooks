import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { submitAndReleaseIfUngated, SubmitError } from "../flows/submit.ts";
import { createDocumentsFlowAdapter } from "../flows/documents-adapter.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { applyDocumentEdit } from "../ledger/document-write.ts";
import { loadDocumentEditCurrent } from "../ledger/document-service.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { billSubscriptionNow } from "./subscription-billing.ts";
import {
  runConsolidationGroup,
  runDueConsolidations,
  ConsolidatedBillingError,
} from "./consolidated-billing.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting, type ScratchOrg } from "../testing/fixtures.ts";

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
  "held and consolidated source invoices refuse native edits, submissions, flow mutations and posting without changing evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Consolidated billing operator", "admin");
      await grantConsolidationOperator(org.orgId, actorId);
      await enableFeatures(org.orgId);
      const payer = await seedCustomer(org.orgId, "Payer", org.subsidiaryId);
      const child = await seedCustomer(org.orgId, "Service customer", org.subsidiaryId);
      const groupId = await seedGroup(org.orgId, payer);
      await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      const subId = await seedSubscription(org, actorId, planId, child, org.date);
      const { invoiceId: sourceId } = await billSubscriptionNow(org.orgId, subId, org.date, { actorId }, null);
      const deps = { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } };
      const snapshot = () => withOrgContext(org.orgId, async () => (await db.execute(sql`
        select to_jsonb(d) as document,
          (select jsonb_agg(to_jsonb(l) order by l.id) from document_lines l
            where l.org_id = d.org_id and l.document_id = d.id) as lines,
          (select count(*)::int from audit_log where org_id = d.org_id) as audits,
          (select count(*)::int from journal_entries where org_id = d.org_id) as journals,
          (select count(*)::int from flow_runs where org_id = d.org_id) as flows,
          (select count(*)::int from document_links where org_id = d.org_id) as links
        from documents d where d.org_id = ${org.orgId} and d.id = ${sourceId}
      `)).rows[0]);
      const refuseSourceCommands = async (message: RegExp) => {
        const before = await snapshot();
        await assert.rejects(withOrgTransaction(org.orgId, async () => {
          const current = await loadDocumentEditCurrent(sourceId, org.orgId);
          assert.ok(current);
          await applyDocumentEdit(sourceId, current, { memo: "Changed source", expectedUpdatedAt: current.updatedAt },
            { orgId: org.orgId, userId: actorId, source: "api" });
        }), (error: unknown) => error instanceof DocumentEditError && error.status === 422 && message.test(error.message));
        await assert.rejects(withOrgTransaction(org.orgId, () =>
          submitAndReleaseIfUngated("customer_invoice", sourceId, actorId)),
        (error: unknown) => error instanceof SubmitError && message.test(error.message));
        await assert.rejects(withOrgTransaction(org.orgId, () =>
          createDocumentsFlowAdapter("customer_invoice").setField(sourceId, "memo", "Flow changed source", { orgId: org.orgId, userId: actorId })), message);
        await assert.rejects(withOrgTransaction(org.orgId, () => postDocument(sourceId, deps)),
          (error: unknown) => error instanceof PostingError && message.test(error.message));
        assert.deepEqual(await snapshot(), before, "refusals preserve source, lines, audits, flows, links and journals");
      };
      await refuseSourceCommands(/held for consolidated billing.*Run its consolidation group/);
      const [run] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
      assert.ok(run);
      await refuseSourceCommands(/has been consolidated.*Continue with the consolidated invoice/);

      // Retained lineage must still protect imported or older source metadata.
      await withOrgTransaction(org.orgId, () => db.execute(sql`
        update documents set custom = custom - 'consolidationStatus' - 'supersededBy'
         where org_id = ${org.orgId} and id = ${sourceId} and status = 'draft'
      `));
      await refuseSourceCommands(/has been consolidated/);
      await withOrgTransaction(org.orgId, async () => {
        assert.equal((await submitAndReleaseIfUngated("customer_invoice", run.invoiceId, actorId)).autoApproved, true);
        await postDocument(run.invoiceId, deps);
      });
      const totals = await withOrgContext(org.orgId, async () => (await db.execute<{ source_status: string; total: string; journals: number }>(sql`
        select source.status as source_status, invoice.total::text as total,
          (select count(*)::int from journal_entries where org_id = ${org.orgId}) as journals
        from documents source join documents invoice on invoice.org_id = source.org_id
         where source.org_id = ${org.orgId} and source.id = ${sourceId} and invoice.id = ${run.invoiceId}
      `)).rows[0]!);
      assert.equal(totals.source_status, "draft");
      assert.equal(totals.total, "100.0000");
      assert.equal(totals.journals, 1, "only the payer invoice books the source charge");
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "consolidation locks source invoices before copying charges and a concurrent standalone submission cannot post them",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    let releaseSource!: () => void;
    const released = new Promise<void>((resolve) => { releaseSource = resolve; });
    const jobs: Promise<unknown>[] = [];
    try {
      const actorId = await createScratchUser(org.orgId, "Consolidated billing operator", "admin");
      await grantConsolidationOperator(org.orgId, actorId);
      await enableFeatures(org.orgId);
      const payer = await seedCustomer(org.orgId, "Concurrent payer", org.subsidiaryId);
      const child = await seedCustomer(org.orgId, "Concurrent service customer", org.subsidiaryId);
      const groupId = await seedGroup(org.orgId, payer);
      await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
      const planId = await seedPlan(org, actorId);
      const subId = await seedSubscription(org, actorId, planId, child, org.date);
      const { invoiceId: sourceId } = await billSubscriptionNow(org.orgId, subId, org.date, { actorId }, null);
      let reportLocked!: (pid: number) => void;
      let reportFailure!: (error: unknown) => void;
      const locked = new Promise<number>((resolve, reject) => { reportLocked = resolve; reportFailure = reject; });
      const holder = withOrgTransaction(org.orgId, async () => {
        const row = (await db.execute<{ pid: number }>(sql`
          select pg_backend_pid() as pid from documents
           where org_id = ${org.orgId} and id = ${sourceId} for update
        `)).rows[0];
        assert.ok(row);
        reportLocked(row.pid);
        await released;
      });
      jobs.push(holder);
      void holder.catch(reportFailure);
      const holderPid = await locked;
      const consolidation = runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId, autoPost: true })
        .then((runs) => ({ runs }), (error: unknown) => ({ error }));
      jobs.push(consolidation);
      const deadline = Date.now() + 5_000;
      let copyingBlocked = false;
      do {
        copyingBlocked = await withOrgContext(org.orgId, async () => (await db.execute<{ blocked: boolean }>(sql`
          select exists (
            select 1 from pg_stat_activity
             where datname = current_database() and ${holderPid} = any(pg_blocking_pids(pid))
               and query like '%locked_drafts%'
          ) as blocked
        `)).rows[0]!.blocked);
        if (copyingBlocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      assert.ok(copyingBlocked, "the source is locked before line copying, rather than only during final supersession");
      const submission = withOrgTransaction(org.orgId, () => submitAndReleaseIfUngated("customer_invoice", sourceId, actorId))
        .then((result) => ({ result }), (error: unknown) => ({ error }));
      jobs.push(submission);
      releaseSource();
      const consolidated = await consolidation;
      if ("error" in consolidated) throw consolidated.error;
      assert.equal(consolidated.runs.length, 1);
      assert.equal(consolidated.runs[0]!.posted, true);
      const submitted = await submission;
      assert.ok("error" in submitted && submitted.error instanceof SubmitError);
      assert.match(submitted.error.message, /consolidat/);
      const standing = await withOrgContext(org.orgId, async () => (await db.execute<{ status: string; journals: number; links: number }>(sql`
        select d.status,
          (select count(*)::int from journal_entries where org_id = d.org_id) as journals,
          (select count(*)::int from document_links where org_id = d.org_id
            and from_document_id = d.id and link_type = 'created_from') as links
        from documents d where d.org_id = ${org.orgId} and d.id = ${sourceId}
      `)).rows[0]!);
      assert.deepEqual(standing, { status: "draft", journals: 1, links: 1 });
    } finally {
      releaseSource();
      await Promise.allSettled(jobs);
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "three child subscriptions consolidate into one payer invoice with grouped lines and exact totals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "Billing", "admin");
      await grantConsolidationOperator(org.orgId, actorId);
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
      await grantConsolidationOperator(org.orgId, actorId);
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
      await grantConsolidationOperator(org.orgId, actorId);
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
      await grantConsolidationOperator(org.orgId, actorId);
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
      await grantConsolidationOperator(org.orgId, actorId);
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

test("consolidation rechecks current unrestricted operator and posting authority before creation or replay", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Consolidation operator", "admin");
    await grantConsolidationOperator(org.orgId, actorId);
    await enableFeatures(org.orgId);
    const payer = await seedCustomer(org.orgId, "Payer", org.subsidiaryId);
    const child = await seedCustomer(org.orgId, "Service customer", null);
    const groupId = await seedGroup(org.orgId, payer);
    await seedRelationship(org.orgId, child, payer, groupId, "2026-01-01", null);
    const planId = await seedPlan(org, actorId);
    const subId = await seedSubscription(org, actorId, planId, child, org.date);
    await billSubscriptionNow(org.orgId, subId, org.date, { actorId }, null);
    const snapshot = () => withOrgContext(org.orgId, async () => (await db.execute(sql`
      select (select jsonb_agg(to_jsonb(d) order by d.id) from documents d where d.org_id=${org.orgId}) as documents,
        (select count(*)::int from audit_log where org_id=${org.orgId}) as audits,
        (select count(*)::int from consolidation_runs where org_id=${org.orgId}) as runs,
        (select count(*)::int from document_links where org_id=${org.orgId}) as links,
        (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
        (select count(*)::int from flow_runs where org_id=${org.orgId}) as flows
    `)).rows[0]);
    const changeAuthority = async (permissions: readonly string[], restriction: {mode:"all"} | {mode:"list";subsidiaryIds:string[]}) => {
      const changed = await db.execute(sql`update app_roles set permissions=${JSON.stringify(permissions)}::jsonb,
        subsidiary_restriction=${JSON.stringify(restriction)}::jsonb where org_id=${org.orgId} and key='admin' returning id`);
      assert.equal(changed.rows.length, 1);
    };
    const refuse = async (options: Parameters<typeof runConsolidationGroup>[4]) => {
      const before = await snapshot();
      await assert.rejects(runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", options),
        (error: unknown) => error instanceof ConsolidatedBillingError && error.status === 404);
      assert.deepEqual(await snapshot(), before, "authority refusal has no document, lineage, approval or journal effects");
    };
    await refuse({ actorId: randomUUID() });
    await refuse({ actorId, allowedSubsidiaryIds: new Set() });
    await refuse({ actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]) });
    await refuse({ actorId: "" });
    await refuse({ autoPost: true });
    await changeAuthority(["documents.manage","ar.post"], {mode:"list",subsidiaryIds:[org.subsidiaryId]});
    await refuse({ actorId, allowedSubsidiaryIds: null });
    await changeAuthority(["documents.manage"], {mode:"all"});
    await refuse({ actorId, autoPost: true });
    const [run] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
    assert.ok(run); assert.equal(run.posted, false, "manage-only authority may create the native payer draft");
    await changeAuthority([], {mode:"all"});
    await refuse({ actorId });
    await grantConsolidationOperator(org.orgId, actorId);
    const [replay] = await runConsolidationGroup(org.orgId, groupId, "2026-07-01", "2026-07-31", { actorId });
    assert.equal(replay.invoiceId, run.invoiceId); assert.equal(replay.replayed, true);
  } finally { await dropScratchOrgReporting(org.orgId); }
});
