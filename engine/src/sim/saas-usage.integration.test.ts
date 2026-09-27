import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "drizzle-orm";
import { createSubscriptionInvoice } from "../billing/subscription-billing.ts";
import { recomputeOpenSaasMetrics } from "../billing/metrics/metrics-ledger.ts";
import { prepaidBalance } from "../billing/usage/prepaid.ts";
import { cmp } from "../money/money.ts";
import { db, withOrgContext } from "../platform/db.ts";
import { runScenario } from "../golden/scenario.ts";
import { autopilotRunToEnd, loadRun, provisionRun } from "./runner.ts";
import { autopilotSaas } from "./saas-autopilot.ts";
import { issueInvoice } from "./ops.ts";
import { getProfile } from "./profiles/index.ts";
import { runSaasUsageDay, saasUsageMonthInvariant } from "./saas-usage.ts";
import { withSimClock } from "../platform/clock.ts";
import { wipeSimOrg } from "./world.ts";

async function simulate(root: string) {
  const run = await provisionRun({ profileId: "saas", seed: "usage-repeatability", startDate: "2026-11-25", endDate: "2027-01-05", runsRoot: root });
  const { world } = loadRun(run.runDir);
  try {
    const probes: string[] = [];
    for (const dueDate of ["2026-12-07", "2026-12-08"]) {
      const probe = await createSubscriptionInvoice({
        orgId: run.orgId, actorId: world.actors.controller, customerId: world.customers[0]!.id,
        subsidiaryId: world.subsidiaryId, currency: world.currency, incomeAccountId: world.accounts.servicesRevenue!,
        itemId: null, taxCodeId: null, description: "Collections timing probe", quantity: "1", unitPrice: "25",
        memo: "Collections timing probe", invoiceDate: "2026-12-01", dueDate, autoPost: false,
      });
      probes.push(probe.invoiceId); await withOrgContext(run.orgId, () => issueInvoice(world, probe.invoiceId));
    }
    await autopilotRunToEnd(run.runDir);
    const dunningRun = await withSimClock("2026-12-12", () => withOrgContext(run.orgId, () => autopilotSaas(getProfile("saas"), world, "2026-12-12")));
    assert.deepEqual(dunningRun.dunningCall, { orgId: run.orgId, asOf: "2026-12-12" });
    await withSimClock("2027-01-05", () => withOrgContext(run.orgId, () => recomputeOpenSaasMetrics(run.orgId)));
    const evidence = await withOrgContext(run.orgId, async () => {
      const records = (await db.execute<{ customer: string; day: string; quantity: string }>(sql`select p.display_name as customer, r.occurred_on::text as day, r.quantity::text as quantity
        from usage_records r join parties p on p.org_id = r.org_id and p.id = r.customer_id
        where r.org_id = ${run.orgId} and r.source_ref like 'sim:%' order by p.display_name, r.occurred_on`)).rows;
      const invoices = (await db.execute<{ customer: string; period_end: string; document_date: string; total: string }>(sql`select p.display_name as customer, run.period_end::text as period_end,
          doc.document_date::text as document_date, doc.total::text as total
        from usage_rating_runs run join documents doc on doc.org_id = run.org_id and doc.id = run.invoice_id
        join subscription_usage_links link on link.org_id = run.org_id and link.id = run.link_id
        join subscriptions s on s.org_id = link.org_id and s.id = link.subscription_id
        join parties p on p.org_id = s.org_id and p.id = s.customer_id
        where run.org_id = ${run.orgId} and run.status = 'active' and doc.status = 'posted'
        order by run.period_end, p.display_name`)).rows;
      const shortfalls = (await db.execute<{ period_end: string }>(sql`select distinct run.period_end::text as period_end
        from usage_rating_runs run join documents doc on doc.org_id = run.org_id and doc.id = run.invoice_id
        join document_lines line on line.org_id = doc.org_id and line.document_id = doc.id
        where run.org_id = ${run.orgId} and run.status = 'active'
          and line.custom->'rating'->>'kind' = 'commit_shortfall' order by period_end`)).rows;
      const grant = (await db.execute<{ id: string; amount: string }>(sql`select g.id, g.amount::text as amount
        from usage_prepaid_grants g join document_lines line on line.org_id = g.org_id and line.id = g.source_document_line_id
        join documents doc on doc.org_id = line.org_id and doc.id = line.document_id
        join parties p on p.org_id = g.org_id and p.id = g.customer_id
        where g.org_id = ${run.orgId} and p.display_name = 'Atlas Retail Group'
          and doc.custom->>'simPrepaidUsageProduct' = 'api-requests'`)).rows[0]!;
      const balance = await prepaidBalance(run.orgId, grant.id, "2026-12-31");
      const draws = (await db.execute<{ period_month: string; amount: string; event_month: string | null; recognition_events: number }>(sql`select d.period_month::text as period_month, d.amount::text as amount,
          e.period_month::text as event_month, count(e.id)::int as recognition_events
        from usage_prepaid_draws d join usage_prepaid_grants g on g.org_id = d.org_id and g.id = d.grant_id
        left join recognition_events e on e.org_id = d.org_id
          and e.source_reference = 'usage-run:' || d.run_id::text || ':grant:' || d.grant_id::text
        where d.org_id = ${run.orgId} and g.id = ${grant.id}
        group by d.id, e.period_month order by d.period_month`)).rows;
      const reactivation = (await db.execute(sql`select movement from saas_metrics_monthly m
        join parties p on p.org_id = m.org_id and p.id = m.customer_id
        where m.org_id = ${run.orgId} and m.month = '2027-01-01' and p.display_name = 'Brightpath Tutoring'`)).rows[0]?.movement;
      const contraction = (await db.execute(sql`select
          (select avg(r.quantity) from usage_records r join parties p on p.org_id = r.org_id and p.id = r.customer_id
            where r.org_id = ${run.orgId} and p.display_name = 'Kettle & Co Roasters' and r.occurred_on < '2026-12-01'::date)
          > (select avg(r.quantity) from usage_records r join parties p on p.org_id = r.org_id and p.id = r.customer_id
            where r.org_id = ${run.orgId} and p.display_name = 'Kettle & Co Roasters' and r.occurred_on >= '2026-12-01'::date) as contracted`)).rows[0]?.contracted;
      const dunning = (await db.execute<{ org_id: string; due_date: string; offset_days: number }>(sql`select log.org_id as org_id, doc.due_date::text as due_date, stage.offset_days as offset_days
        from dunning_log log join documents doc on doc.org_id = log.org_id and doc.id = log.document_id
        join dunning_stages stage on stage.org_id = log.org_id and stage.id = log.stage_id
        where log.org_id = ${run.orgId} and log.document_id in (${sql.join(probes.map((id) => sql`${id}::uuid`), sql`, `)})
        order by doc.due_date`)).rows;
      const trace = await runScenario(run.orgId, { at: "2027-01-05" });
      const replayFailures = await saasUsageMonthInvariant(run.orgId);
      await withSimClock("2027-01-05", () => withOrgContext(run.orgId, () => runSaasUsageDay(getProfile("saas"), world, "2027-01-05")));
      const afterRerun = (await db.execute<{ count: number }>(sql`select count(*)::int as count from usage_records
        where org_id = ${run.orgId} and source_ref = 'sim:2027-01-05'`)).rows[0]!.count;
      assert.equal(afterRerun, records.filter((row) => row.day === "2027-01-05").length, "replaying a simulated day must not add duplicate usage records");
      assert.ok(cmp(balance, grant.amount) < 0 && draws.length === 2);
      assert.ok(draws.every((draw) => draw.recognition_events === 1 && draw.event_month === draw.period_month));
      assert.ok(reactivation === "reactivation" && contraction === true);
      assert.deepEqual(dunning, [{ org_id: run.orgId, due_date: "2026-12-07", offset_days: 5 }]);
      assert.deepEqual(shortfalls, [{ period_end: "2026-12-31" }]);
      assert.deepEqual(replayFailures, []);
      assert.equal(trace.checks.find((check) => check.name === "usage-invoice-trace")?.ok, true);
      assert.ok(invoices.some((invoice) => invoice.period_end.startsWith("2026-11")) && invoices.some((invoice) => invoice.period_end.startsWith("2026-12")));
      assert.ok(invoices.every((invoice) => invoice.period_end === invoice.document_date));
      return { records, invoices };
    });
    return evidence;
  } finally {
    await wipeSimOrg(run.orgId);
    rmSync(run.runDir, { recursive: true, force: true });
  }
}

test("the SaaS simulation rates metered usage, commits prepaid draws, and replays per seed", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const root = mkdtempSync(join(tmpdir(), "saas-usage-sim-"));
  try {
    const first = await simulate(root);
    const second = await simulate(root);
    assert.deepEqual([second.records, second.invoices], [first.records, first.invoices]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
