import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { ProjectProgressError, listProgress, recordProgress, reverseProgress } from "./progress.ts";
import { recordForecast } from "./forecasts.ts";
import { projectEarnedValue } from "./earned-value.ts";
import { syncProjectRevenueContracts } from "./revenue.ts";
import { createInternalBillingRuleVersion } from "../internal-billing/rules.ts";
import { postInternalBilling, saveInternalBillingDraft, voidInternalBilling } from "../internal-billing/documents.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function setup(org: ScratchOrg, features: Record<string, boolean> = { projects: true, projectProgress: true, revenueRecognition: true }) {
  await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({
    features,
    controlAccounts: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank,
      unbilledReceivable: org.accounts.ar, projectRevenue: org.accounts.revenue },
  })}::jsonb where id = ${org.orgId}`);
  const actor = (await seedFlowActors(org.orgId)).adminId;
  const projectId = randomUUID(), typeId = randomUUID(), conduit = randomUUID(), cleanup = randomUUID();
  await db.execute(sql`insert into project_types(id,org_id,key,name,billing_method,invoicing_profile,backup_profile)
    values(${typeId},${org.orgId},'poc','POC','fixed_price','{"recognition":"percent_complete_cost","billingProcedure":"standard"}'::jsonb,'{}'::jsonb)`);
  await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,project_type_id,status,is_active,starts_on,contract_value)
    values(${projectId},${org.orgId},${org.subsidiaryId},'EV-1','Earned value job',${org.customerId},${typeId},'active',true,${org.date},2000)`);
  await db.execute(sql`insert into project_tasks(id,org_id,project_id,code,name,estimated_cost,estimated_hours,budget_quantity,budget_unit)
    values(${conduit},${org.orgId},${projectId},'100','Conduit',1000,40,100,'m'),
          (${cleanup},${org.orgId},${projectId},'200','Cleanup',500,null,null,null)`);
  return { actor, projectId, conduit, cleanup };
}

async function postCost(org: ScratchOrg, projectId: string, amount: string) {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.execute(sql`insert into journal_entries(id,org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,status)
      values(${id},${org.orgId},${org.bookId},${org.subsidiaryId},${id},${org.date},${org.periodId},'draft')`);
    await tx.execute(sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,project_id,amount,currency,txn_amount)
      values(${org.orgId},${id},1,${org.accounts.cogs},${org.subsidiaryId},${projectId},${amount},'CAD',${amount}),
        (${org.orgId},${id},2,${org.accounts.bank},${org.subsidiaryId},${projectId},-${amount}::numeric,'CAD',-${amount}::numeric)`);
    await tx.execute(sql`update journal_entries set status='posted' where org_id=${org.orgId} and id=${id}`);
  });
  return id;
}

const refusal = (code: string) => (error: unknown) => error instanceof ProjectProgressError && error.code === code;

test("progress records in the budget unit, reverses exactly once, and history is immutable", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId, conduit, cleanup } = await setup(org);
    const base = { orgId: org.orgId, actorId: actor, projectId, allowedSubsidiaryIds: null };

    const entry = await recordProgress({ ...base, taskId: conduit, entryDate: org.date, quantity: "30", unit: "m", note: "North run" });
    assert.equal(entry.quantity, "30.00000000");
    assert.equal(entry.unit, "m");

    await assert.rejects(recordProgress({ ...base, taskId: conduit, entryDate: org.date, quantity: "5", unit: "ft" }), refusal("unit-mismatch"));
    await assert.rejects(recordProgress({ ...base, taskId: cleanup, entryDate: org.date, quantity: "1", unit: "ea" }), (error: unknown) =>
      refusal("no-budget-quantity")(error) && /Work breakdown/.test((error as ProjectProgressError).remedy ?? ""));
    await assert.rejects(recordProgress({ ...base, taskId: conduit, entryDate: "2999-01-01", quantity: "5", unit: "m" }), refusal("future-date"));
    await assert.rejects(recordProgress({ ...base, taskId: conduit, entryDate: org.date, quantity: "0", unit: "m" }), refusal("invalid"));
    // A task of another project, or a caller outside the project's entity, reads as missing.
    await assert.rejects(recordProgress({ ...base, projectId: randomUUID(), taskId: conduit, entryDate: org.date, quantity: "5", unit: "m" }), refusal("not-found"));
    await assert.rejects(recordProgress({ ...base, allowedSubsidiaryIds: new Set([randomUUID()]), taskId: conduit, entryDate: org.date, quantity: "5", unit: "m" }), refusal("not-found"));

    const reversal = await reverseProgress({ ...base, entryId: entry.id, reason: "Measured twice" });
    assert.equal(reversal.quantity, "-30.00000000");
    assert.equal(reversal.reversesEntryId, entry.id);
    await assert.rejects(reverseProgress({ ...base, entryId: entry.id, reason: "Again" }), refusal("already-reversed"));
    await assert.rejects(reverseProgress({ ...base, entryId: reversal.id, reason: "Undo undo" }), refusal("not-reversible"));

    // Posted progress is evidence: the ledger refuses edits and deletes outright.
    await assert.rejects(db.execute(sql`update project_progress_entries set quantity = 1 where id = ${entry.id}`));
    await assert.rejects(db.execute(sql`delete from project_progress_entries where id = ${entry.id}`));

    const history = await listProgress({ orgId: org.orgId, projectId, taskId: conduit, allowedSubsidiaryIds: null });
    assert.equal(history.length, 2);
    assert.equal(history.find((row) => row.id === entry.id)?.reversedByEntryId, reversal.id);
    const audits = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log where org_id = ${org.orgId} and table_name = 'project_progress_entries'`)).rows[0]!.n;
    assert.equal(audits, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("progress and forecasts refuse while Progress tracking is off", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId, conduit } = await setup(org, { projects: true, projectProgress: false });
    await assert.rejects(
      recordProgress({ orgId: org.orgId, actorId: actor, projectId, taskId: conduit, entryDate: org.date, quantity: "1", unit: "m", allowedSubsidiaryIds: null }),
      refusal("feature-disabled"),
    );
    await assert.rejects(
      recordForecast({ orgId: org.orgId, actorId: actor, projectId, taskId: conduit, asOfDate: org.date, method: "manual", costToComplete: "10", allowedSubsidiaryIds: null }),
      refusal("feature-disabled"),
    );
    const rows = (await db.execute<{ n: number }>(sql`
      select (select count(*) from project_progress_entries where org_id = ${org.orgId})
           + (select count(*) from project_forecasts where org_id = ${org.orgId}) as n`)).rows[0]!;
    assert.equal(Number(rows.n), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("earned value attributes labor and cost by task, keeps unassigned cost at project level, and honours the as-of date", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId, conduit } = await setup(org);
    const employee = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${employee},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(sql`insert into time_entries(org_id,employee_party_id,project_id,project_task_id,worked_on,hours,cost_rate,status)
      values(${org.orgId},${employee},${projectId},${conduit},${org.date},10,30,'approved'),
            (${org.orgId},${employee},${projectId},${conduit},${org.date},5,30,'draft'),
            (${org.orgId},${employee},${projectId},null,${org.date},2,30,'approved')`);
    const bill = randomUUID(), entry = await postCost(org, projectId, "250");
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,document_date,currency,status,project_id,subsidiary_id)
      values(${bill},${org.orgId},'vendor_bill','VB-EV',${org.date},'CAD','draft',${projectId},${org.subsidiaryId})`);
    await db.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,quantity,unit_price,amount,project_id,project_task_id)
      values(${org.orgId},${bill},1,${org.accounts.cogs},1,200,200,${projectId},${conduit}),
            (${org.orgId},${bill},2,${org.accounts.cogs},1,50,50,${projectId},null)`);
    await db.execute(sql`update documents set status='posted', posting_date=${org.date}, posted_entry_id=${entry}, posting_period_id=${org.periodId}
      where id=${bill} and org_id=${org.orgId}`);
    await recordProgress({ orgId: org.orgId, actorId: actor, projectId, taskId: conduit, entryDate: org.date, quantity: "25", unit: "m", allowedSubsidiaryIds: null });

    const earned = await projectEarnedValue(org.orgId, projectId, org.date, null);
    const task = earned!.tasks.find((row) => row.taskId === conduit)!;
    assert.equal(task.basis, "quantity");
    assert.equal(task.installedQuantity, "25.00000000");
    assert.equal(task.actualCost, "500.0000", "approved labor 300 + attributed bill line 200; draft time excluded");
    assert.equal(task.actualHours, "10.0000");
    assert.equal(task.earnedValue, "250.0000");
    assert.equal(task.costPerformanceIndex, "0.5000");
    assert.equal(earned!.totals.unassignedActualCost, "110.0000");
    assert.equal(earned!.totals.actualCost, "610.0000");

    const before = await projectEarnedValue(org.orgId, projectId, "2026-07-14", null);
    assert.equal(before!.totals.actualCost, "0.0000");
    assert.equal(before!.tasks.find((row) => row.taskId === conduit)!.installedQuantity, "0.00000000");

    // A different legal entity's reader sees nothing.
    assert.equal(await projectEarnedValue(org.orgId, projectId, org.date, new Set([randomUUID()])), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("accepted forecast suggestions are recomputed by the server and the latest governs", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId, conduit } = await setup(org);
    const base = { orgId: org.orgId, actorId: actor, projectId, taskId: conduit, allowedSubsidiaryIds: null };
    await assert.rejects(recordForecast({ ...base, asOfDate: org.date, method: "units_productivity" }), refusal("invalid"));
    const remaining = await recordForecast({ ...base, asOfDate: org.date, method: "remaining_budget", costToComplete: "1" });
    assert.equal(remaining.costToComplete, "1000.0000", "a suggestion records the server's figure, never the caller's");
    await recordForecast({ ...base, asOfDate: "2026-07-01", method: "manual", costToComplete: "50" });
    await recordForecast({ ...base, asOfDate: org.date, method: "manual", costToComplete: "1400", hoursToComplete: "60" });
    const earned = await projectEarnedValue(org.orgId, projectId, org.date, null);
    const task = earned!.tasks.find((row) => row.taskId === conduit)!;
    assert.equal(task.estimateToComplete, "1400.0000");
    assert.equal(task.forecastMethod, "manual");
    assert.equal(task.hoursToComplete, "60.0000");
    const earlier = await projectEarnedValue(org.orgId, projectId, "2026-07-10", null);
    assert.equal(earlier!.tasks.find((row) => row.taskId === conduit)!.estimateToComplete, "50.0000");
    await assert.rejects(db.execute(sql`update project_forecasts set cost_to_complete = 0 where id = ${remaining.id}`),
      (error: unknown) => errorChainMatches(error, /./));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("earned value refuses approved labor whose cost rate is missing", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { projectId, conduit } = await setup(org);
    const employee = randomUUID();
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active)
      values(${employee},${org.orgId},'employee','Crew Hand',${org.subsidiaryId},true)`);
    await db.execute(sql`insert into time_entries(org_id,employee_party_id,project_id,project_task_id,worked_on,hours,cost_rate,status)
      values(${org.orgId},${employee},${projectId},${conduit},${org.date},8,null,'approved')`);
    await assert.rejects(projectEarnedValue(org.orgId, projectId, org.date, null), (error: unknown) =>
      error instanceof ProjectProgressError && error.status === 422 && /cost rate/.test(error.message));
    await db.execute(sql`update time_entries set cost_rate=0 where org_id=${org.orgId} and project_id=${projectId}`);
    assert.equal((await projectEarnedValue(org.orgId, projectId, org.date, null))!.totals.actualCost, "0.0000",
      "an explicitly configured zero rate is distinct from a missing rate");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("earned value includes internal cost transfers, provider recovery and dated reversals exactly once", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId } = await setup(org, { projects: true, projectProgress: true, internalBilling: true });
    const provider = randomUUID(), recovery = randomUUID();
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,name,status,is_active)
      values(${provider},${org.orgId},${org.subsidiaryId},'Shop job','active',true)`);
    await db.execute(sql`insert into accounts(id,org_id,number,name,type)
      values(${recovery},${org.orgId},'7101','Shop recovery','expense')`);
    await createInternalBillingRuleVersion({
      orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null, reason: "Transfer shop cost",
      rule: { code: "SHOP", name: "Shop cost", method: "cost_transfer", debitAccountId: org.accounts.cogs,
        creditAccountId: recovery, effectiveFrom: "2026-01-01" },
    });
    const saved = await saveInternalBillingDraft({
      orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null,
      input: { ruleCode: "SHOP", documentDate: org.date, projectId: provider,
        lines: [{ amount: "300", projectId, isBillable: false }] },
    });
    const read = (id: string, date = org.date) => projectEarnedValue(org.orgId, id, date, null);
    assert.equal((await read(projectId))!.totals.actualCost, "0.0000", "drafts do not enter actuals");
    await postInternalBilling({ orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null, id: saved.id });
    assert.equal((await read(projectId))!.totals.actualCost, "300.0000");
    assert.equal((await read(projectId))!.totals.unassignedActualCost, "300.0000");
    assert.equal((await read(provider))!.totals.actualCost, "-300.0000", "the providing job retains its recovery");
    assert.equal((await read(projectId, "2026-07-14"))!.totals.actualCost, "0.0000", "future costs are excluded");
    await voidInternalBilling({ orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null, id: saved.id,
      reason: "Wrong job", reversalDate: "2026-07-16" });
    assert.equal((await read(projectId))!.totals.actualCost, "300.0000", "a later void preserves historical cost");
    assert.equal((await read(projectId, "2026-07-16"))!.totals.actualCost, "0.0000");
    assert.equal((await read(provider, "2026-07-16"))!.totals.actualCost, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("cost-to-cost revenue uses estimated total cost once forecasts exist, so a rising estimate lowers percent complete", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const { actor, projectId, conduit, cleanup } = await setup(org);
    await postCost(org, projectId, "375");
    // Budget 1500 → 375 / 1500.
    const budgeted = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(budgeted.problems, []);
    assert.equal(budgeted.synced[0]?.percentComplete, "25.0000");

    // Forecasting one task replaces the static budget with AC + ETC, where the
    // unforecast task contributes its remaining budget (500 − 0).
    await recordForecast({ orgId: org.orgId, actorId: actor, projectId, taskId: conduit, asOfDate: org.date, method: "manual", costToComplete: "1625", allowedSubsidiaryIds: null });
    const risen = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.deepEqual(risen.problems, []);
    assert.equal(risen.synced[0]?.percentComplete, "15.0000", "375 / (375 + 1625 + 500)");

    await recordForecast({ orgId: org.orgId, actorId: actor, projectId, taskId: cleanup, asOfDate: org.date, method: "manual", costToComplete: "0", allowedSubsidiaryIds: null });
    const lowered = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.equal(lowered.synced[0]?.percentComplete, "18.7500", "375 / (375 + 1625 + 0)");

    // With Progress tracking off the task budget governs again.
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projectProgress}', 'false'::jsonb) where id = ${org.orgId}`);
    const off = await syncProjectRevenueContracts(org.orgId, null, org.date, projectId);
    assert.equal(off.synced[0]?.percentComplete, "25.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
