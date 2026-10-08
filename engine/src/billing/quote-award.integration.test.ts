import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { seedProjectTypes } from "../projects/seed-project-types.ts";
import {
  captureBudgetBaseline,
  projectBudgetComparison,
} from "../projects/budget-baselines.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { awardQuote, previewQuoteAward, QuoteAwardError } from "./quote-award.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

interface QuoteSeed {
  quoteId: string;
  laborLineId: string;
  cableLineId: string;
  mobilizationLineId: string;
}

/**
 * A fixed-price quote: 24 crew hours (labor item, standard cost 40/h), 200 m
 * of cable (standard cost 2.50/m) and a mobilization fee with no cost basis.
 */
async function seedQuote(org: ScratchOrg, actor: string, status: "draft" | "approved" = "approved"): Promise<QuoteSeed> {
  const laborItem = randomUUID();
  const cableItem = randomUUID();
  await db.execute(sql`
    insert into items (id, org_id, kind, name, unit, default_cost, default_rate, income_account_id)
    values (${laborItem}, ${org.orgId}, 'labor', 'Install crew', 'hr', '40', '95', ${org.accounts.revenue}),
           (${cableItem}, ${org.orgId}, 'non_inventory', 'Armored cable', 'm', '2.5', '6', ${org.accounts.revenue})`);
  const quoteId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, subsidiary_id, document_date,
       currency, subtotal, tax_total, total, billing_method, reference_number, memo, created_by)
    values (${quoteId}, ${org.orgId}, 'quote', 'draft', ${`EST-${quoteId.slice(0, 6)}`}, ${org.customerId},
            ${org.subsidiaryId}, ${org.date}, 'CAD', '4230', '0', '4230', 'fixed_price', 'PO-7781',
            'Warehouse electrical fit-out', ${actor})`);
  const laborLineId = randomUUID();
  const cableLineId = randomUUID();
  const mobilizationLineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, item_id, account_id, description, quantity, unit, unit_price, amount, tax_amount, tax_input_amount)
    values
      (${laborLineId}, ${org.orgId}, ${quoteId}, 1, ${laborItem}, ${org.accounts.revenue}, 'Install crew', '24', 'hr', '95', '2280', '0', '2280'),
      (${cableLineId}, ${org.orgId}, ${quoteId}, 2, ${cableItem}, ${org.accounts.revenue}, 'Armored cable', '200', 'm', '6', '1200', '0', '1200'),
      (${mobilizationLineId}, ${org.orgId}, ${quoteId}, 3, null, ${org.accounts.revenue}, 'Mobilization', '1', null, '750', '750', '0', '750')`);
  if (status !== "draft") {
    await db.execute(sql`update documents set status = ${status} where id = ${quoteId}`);
  }
  return { quoteId, laborLineId, cableLineId, mobilizationLineId };
}

async function withOrg(run: (org: ScratchOrg, actor: string) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Project controller", "admin");
    await seedProjectTypes(org.orgId, actor);
    await run(org, actor);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test("awarding a quote creates its project, tasks and original baseline exactly once", DB, async () => {
  await withOrg(async (org, actor) => {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const seed = await seedQuote(org, actor);

    const preview = await previewQuoteAward(ctx, seed.quoteId);
    assert.equal(preview.blocked, null);
    assert.equal(preview.awarded, null);
    assert.deepEqual(preview.plan?.missingCost.map((l) => l.lineNumber), [3]);
    // Fixed price prices the job at its contract value: the quoted net.
    assert.equal(preview.defaults.contractValue, "4230.0000");

    // The mobilization fee is priced but uncosted: refuse by line, write nothing.
    await assert.rejects(
      awardQuote(ctx, seed.quoteId),
      (error: unknown) => error instanceof QuoteAwardError && /line 3 has a price but no cost/.test(error.message),
    );
    const none = await db.execute(sql`select 1 from projects where org_id = ${org.orgId} and awarded_from_document_id = ${seed.quoteId}`);
    assert.equal(none.rows.length, 0);

    const awarded = await awardQuote(ctx, seed.quoteId, {
      lineCosts: [{ lineId: seed.mobilizationLineId, cost: "300" }],
    });
    assert.equal(awarded.created, true);
    assert.equal(awarded.taskCount, 3);

    const project = (await db.execute<{
      status: string; customer_id: string; contract_value: string; customer_po_number: string;
      subsidiary_id: string; name: string; awarded_by: string; type_key: string;
    }>(sql`
      select p.status, p.customer_id, p.contract_value::text as contract_value, p.customer_po_number,
             p.subsidiary_id, p.name, p.awarded_by, pt.key as type_key
        from projects p join project_types pt on pt.id = p.project_type_id
       where p.id = ${awarded.projectId}`)).rows[0]!;
    assert.equal(project.status, "awarded");
    assert.equal(project.customer_id, org.customerId);
    assert.equal(project.subsidiary_id, org.subsidiaryId);
    assert.equal(project.type_key, "fixed_price");
    assert.equal(project.contract_value, "4230.0000");
    assert.equal(project.customer_po_number, "PO-7781");
    assert.equal(project.name, "Warehouse electrical fit-out");
    assert.equal(project.awarded_by, actor);

    const tasks = (await db.execute<{ code: string; hours: string; cost: string; price: string }>(sql`
      select code, estimated_hours::text as hours, estimated_cost::text as cost, estimated_price::text as price
        from project_tasks where project_id = ${awarded.projectId} order by code`)).rows;
    assert.deepEqual(tasks, [
      { code: "01", hours: "24.0000", cost: "960.0000", price: "2280.0000" },
      { code: "02", hours: "0.0000", cost: "500.0000", price: "1200.0000" },
      { code: "03", hours: "0.0000", cost: "300.0000", price: "750.0000" },
    ]);

    const baseline = (await db.execute<{ kind: string; sequence: number; source_document_id: string; total_hours: string; total_cost: string; total_price: string }>(sql`
      select kind, sequence, source_document_id, total_hours::text as total_hours,
             total_cost::text as total_cost, total_price::text as total_price
        from project_budget_baselines where project_id = ${awarded.projectId}`)).rows;
    assert.equal(baseline.length, 1);
    assert.deepEqual(baseline[0], {
      kind: "original", sequence: 1, source_document_id: seed.quoteId,
      total_hours: "24.00000000", total_cost: "1760.0000", total_price: "4230.0000",
    });
    const sources = (await db.execute<{ source_line_id: string }>(sql`
      select source_line_id from project_budget_baseline_lines
       where baseline_id = ${awarded.baselineId} order by sequence`)).rows.map((r) => r.source_line_id);
    assert.deepEqual(sources, [seed.laborLineId, seed.cableLineId, seed.mobilizationLineId]);
    const tagged = (await db.execute<{ project_id: string }>(sql`select project_id from documents where id = ${seed.quoteId}`)).rows[0]!;
    assert.equal(tagged.project_id, awarded.projectId);
    const audit = await db.execute(sql`
      select 1 from audit_log where org_id = ${org.orgId} and table_name = 'documents' and row_id = ${seed.quoteId}`);
    assert.equal(audit.rows.length, 1);

    // A repeat award (a double click, a retry) returns the same project and writes nothing.
    const replay = await awardQuote(ctx, seed.quoteId, { lineCosts: [{ lineId: seed.mobilizationLineId, cost: "300" }] });
    assert.equal(replay.created, false);
    assert.equal(replay.projectId, awarded.projectId);
    const counts = (await db.execute<{ projects: string; baselines: string; tasks: string }>(sql`
      select (select count(*) from projects where org_id = ${org.orgId} and awarded_from_document_id = ${seed.quoteId})::text as projects,
             (select count(*) from project_budget_baselines where org_id = ${org.orgId})::text as baselines,
             (select count(*) from project_tasks where project_id = ${awarded.projectId})::text as tasks`)).rows[0]!;
    assert.deepEqual(counts, { projects: "1", baselines: "1", tasks: "3" });
    assert.equal((await previewQuoteAward(ctx, seed.quoteId)).awarded?.projectId, awarded.projectId);
  });
});

test("the sold budget stays fixed while the working budget is revised and actuals land by task", DB, async () => {
  await withOrg(async (org, actor) => {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const seed = await seedQuote(org, actor);
    const awarded = await awardQuote(ctx, seed.quoteId, { lineCosts: [{ lineId: seed.mobilizationLineId, cost: "300" }] });
    const crew = (await db.execute<{ id: string }>(sql`
      select id from project_tasks where project_id = ${awarded.projectId} and code = '01'`)).rows[0]!.id;

    // Recorded baselines are evidence: the storage refuses edits outright.
    await assert.rejects(
      db.execute(sql`update project_budget_baselines set label = 'Edited' where id = ${awarded.baselineId}`),
      (error: unknown) => /retained as recorded/.test(String((error as { cause?: { message?: string } }).cause?.message)),
    );

    // The crew task is re-estimated; a revision records the new working budget.
    await db.execute(sql`update project_tasks set estimated_hours = 30, estimated_cost = 1200 where id = ${crew}`);
    await assert.rejects(
      captureBudgetBaseline(ctx, { projectId: awarded.projectId, reason: "short" }),
      /at least 8 characters/,
    );
    const revised = await captureBudgetBaseline(ctx, { projectId: awarded.projectId, reason: "Owner added a second loading dock" });
    assert.equal(revised.kind, "revised");
    assert.equal(revised.sequence, 2);
    assert.equal(revised.totalCost, "2000.0000");

    // Ten approved crew hours on the crew task and two hours with no task.
    await db.execute(sql`
      insert into time_entries
        (org_id, employee_party_id, worked_on, hours, status, project_id, project_task_id, cost_rate)
      values (${org.orgId}, ${org.vendorId}, ${org.date}, '10', 'approved', ${awarded.projectId}, ${crew}, '42'),
             (${org.orgId}, ${org.vendorId}, ${org.date}, '2', 'approved', ${awarded.projectId}, null, '42')`);

    const comparison = await projectBudgetComparison(org.orgId, awarded.projectId, { asOf: org.date, allowedSubsidiaryIds: null });
    assert.equal(comparison.original?.id, awarded.baselineId);
    assert.equal(comparison.latest?.id, revised.id);
    const row = comparison.rows.find((r) => r.taskId === crew)!;
    assert.deepEqual(row.original, { hours: "24.0000", cost: "960.0000", price: "2280.0000" });
    assert.deepEqual(row.current, { hours: "30.0000", cost: "1200.0000", price: "2280.0000" });
    assert.deepEqual(row.actual, { hours: "10.0000", laborCost: "420.0000", otherCost: "0.0000", cost: "420.0000" });
    assert.deepEqual(row.variance, { hoursToOriginal: "14.0000", costToOriginal: "540.0000", hoursToCurrent: "20.0000", costToCurrent: "780.0000" });
    assert.deepEqual(comparison.unassigned, { hours: "2.0000", laborCost: "84.0000", otherCost: "0.0000", cost: "84.0000" });
    // Totals tie to everything recorded, the unassigned bucket included.
    assert.equal(comparison.totals.actual.cost, "504.0000");
    assert.equal(comparison.totals.original?.cost, "1760.0000");
    assert.equal(comparison.price.original, "4230.0000");
    assert.equal(comparison.price.invoicedToDate, "0.0000");

    // Work before the as-of date only.
    const earlier = await projectBudgetComparison(org.orgId, awarded.projectId, { asOf: "2026-01-01", allowedSubsidiaryIds: null });
    assert.equal(earlier.totals.actual.cost, "0.0000");
  });
});

test("only an issued quote with both features on can be awarded", DB, async () => {
  await withOrg(async (org, actor) => {
    const ctx = { orgId: org.orgId, actorId: actor, allowedSubsidiaryIds: null };
    const draft = await seedQuote(org, actor, "draft");
    await assert.rejects(awardQuote(ctx, draft.quoteId), /is a draft — issue it before awarding it/);

    const issued = await seedQuote(org, actor);
    // A signature on record must still match the quote as it stands.
    await db.execute(sql`
      insert into signature_requests
        (org_id, subject_table, subject_id, signer_name, signer_email, token_hash, status, expires_at, document_hash, signed_at)
      values (${org.orgId}, 'documents', ${issued.quoteId}, 'Ada Customer', 'ada@example.com', ${randomUUID()},
              'signed', now() + interval '7 days', 'a-different-presentation', now())`);
    await assert.rejects(
      awardQuote(ctx, issued.quoteId, { lineCosts: [{ lineId: issued.mobilizationLineId, cost: "300" }] }),
      /changed after the customer signed it/,
    );
    assert.match((await previewQuoteAward(ctx, issued.quoteId)).blocked ?? "", /changed after the customer signed it/);

    await db.execute(sql`
      update orgs
         set settings = coalesce(settings, '{}'::jsonb)
           || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"projects": false}'::jsonb)
       where id = ${org.orgId}`);
    await assert.rejects(
      awardQuote(ctx, draft.quoteId),
      (error: unknown) => error instanceof QuoteAwardError && error.status === 404 && /Company Settings → Features/.test(error.message),
    );
    const none = await db.execute(sql`select 1 from projects where org_id = ${org.orgId}`);
    assert.equal(none.rows.length, 0);
  });
});
