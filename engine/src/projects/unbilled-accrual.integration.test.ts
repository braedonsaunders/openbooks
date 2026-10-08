import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { db, withBypassContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import {
  previewUnbilledRevenueAccrual,
  runUnbilledRevenueAccrual,
  unbilledAccrualReadiness,
  UnbilledAccrualError,
} from "./unbilled-accrual.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

type Scenario = {
  org: ScratchOrg;
  actorId: string;
  julyId: string;
  augustId: string;
  unbilledAccountId: string;
  employeeId: string;
  tmProject: string;
  pocProject: string;
};

/** A T&M project and a project recognized by percent complete, with July
 *  and August periods and the accrual feature on. */
async function scenario(org: ScratchOrg): Promise<Scenario> {
  const actors = await seedFlowActors(org.orgId);
  const julyId = org.periodId;
  const augustId = randomUUID();
  const calendar = (await db.execute<{ fiscal_calendar_id: string }>(sql`
    select fiscal_calendar_id from accounting_periods where id = ${julyId}`)).rows[0]!.fiscal_calendar_id;
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${augustId}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar})`);
  const unbilledAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${unbilledAccountId}, ${org.orgId}, '1220', 'Unbilled receivable', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
             jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
               || '{"projects": true, "unbilledRevenueAccrual": true}'::jsonb, true),
             '{controlAccounts}', coalesce(settings->'controlAccounts', '{}'::jsonb)
               || jsonb_build_object('unbilledReceivable', ${unbilledAccountId}::text, 'projectRevenue', ${org.accounts.recognized}::text), true)
     where id = ${org.orgId}`);
  const tm = BUILTIN_PROJECT_TYPES.find((type) => type.key === "time_and_materials")!;
  const typeId = randomUUID();
  await db.execute(sql`
    insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
    values (${typeId}, ${org.orgId}, 'time_and_materials', 'Time & Materials', 'time_and_materials',
            ${JSON.stringify(tm.invoicingProfile)}::jsonb, ${JSON.stringify(tm.backupProfile)}::jsonb)`);
  await db.execute(sql`
    insert into project_financial_profile_versions (org_id, project_type_id, effective_from, financial_profile, reason)
    values (${org.orgId}, ${typeId}, '2000-01-01', ${JSON.stringify(tm.financialProfile)}::jsonb, 'accrual fixture baseline')`);
  const tmProject = randomUUID();
  const pocProject = randomUUID();
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, project_type_id, status, is_active, custom)
    values (${tmProject}, ${org.orgId}, ${org.subsidiaryId}, 'TM-1', 'Time and materials job', ${org.customerId}, ${typeId}, 'active', true, '{}'::jsonb)`);
  // The same type, recognized by percent complete for this project: it
  // carries its own contract asset and never accrues here.
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, project_type_id, status, is_active, custom, invoicing_profile)
    values (${pocProject}, ${org.orgId}, ${org.subsidiaryId}, 'POC-1', 'Percent complete job', ${org.customerId}, ${typeId}, 'active', true, '{}'::jsonb,
            '{"recognition": "percent_complete_cost"}'::jsonb)`);
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id)
    values (${employeeId}, ${org.orgId}, 'employee', 'Billable worker', ${org.subsidiaryId})`);
  return { org, actorId: actors.adminId, julyId, augustId, unbilledAccountId, employeeId, tmProject, pocProject };
}

async function approvedTime(s: Scenario, projectId: string, workedOn: string, hours: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, item_id, is_billable, status, bill_rate, bill_rate_currency)
    values (${id}, ${s.org.orgId}, ${s.employeeId}, ${workedOn}, ${hours}, ${projectId}, ${s.org.items.service}, true, 'approved', '100.0000', 'CAD')`);
  return id;
}

/** A customer invoice dated `date` that billed the time entry. */
async function billTime(s: Scenario, timeEntryId: string, date: string): Promise<void> {
  const invoiceId = randomUUID();
  const lineId = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, subsidiary_id, kind, status, document_number, document_date, currency, project_id, party_id)
    values (${invoiceId}, ${s.org.orgId}, ${s.org.subsidiaryId}, 'customer_invoice', 'draft', ${`INV-${invoiceId.slice(0, 8)}`}, ${date}, 'CAD', ${s.tmProject}, ${s.org.customerId})`);
  await db.execute(sql`
    insert into document_lines (id, org_id, document_id, line_number, account_id, amount, project_id, time_entry_id)
    values (${lineId}, ${s.org.orgId}, ${invoiceId}, 1, ${s.org.accounts.revenue}, '100.0000', ${s.tmProject}, ${timeEntryId})`);
  const stamped = await db.execute(sql`
    update time_entries set billing_status = 'billed', invoiced_by_line_id = ${lineId}
     where org_id = ${s.org.orgId} and id = ${timeEntryId} returning id`);
  assert.equal(stamped.rows.length, 1);
}

async function accrualEntries(orgId: string) {
  return (await db.execute<{
    id: string; posting_date: string; period_id: string; reverses_entry_id: string | null; status: string;
  }>(sql`
    select id, posting_date::text, period_id, reverses_entry_id, status from journal_entries
     where org_id = ${orgId} and origin = 'revenue_accrual' order by created_at, entry_number`)).rows;
}

async function entryLines(orgId: string, entryId: string) {
  return (await db.execute<{ account_id: string; amount: string; project_id: string | null }>(sql`
    select account_id, amount::text, project_id from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId} order by line_number`)).rows;
}

test("unbilled T&M revenue accrues at period end, reverses next period, and reruns post only the change", { skip }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      const s = await scenario(org);
      const first = await approvedTime(s, s.tmProject, "2026-07-10", "2.0000");
      await approvedTime(s, s.pocProject, "2026-07-12", "1.0000");
      // Work after the period end is next period's revenue.
      await approvedTime(s, s.tmProject, "2026-08-02", "5.0000");

      const preview = await previewUnbilledRevenueAccrual(org.orgId, { periodEnd: "2026-07-31" });
      assert.equal(preview.period.id, s.julyId);
      assert.equal(preview.reversal.periodId, s.augustId);
      assert.equal(preview.reversal.date, "2026-08-01");
      assert.deepEqual(preview.lines.map((line) => [line.projectId, line.unbilled, line.delta]), [[s.tmProject, "200.0000", "200.0000"]]);
      assert.equal(preview.upToDate, false);

      const run = await runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodEnd: "2026-07-31" });
      assert.equal(run.posted.length, 1);
      const [accrual, reversal] = await accrualEntries(org.orgId);
      assert.equal(accrual!.posting_date, "2026-07-31");
      assert.equal(accrual!.period_id, s.julyId);
      assert.equal(reversal!.posting_date, "2026-08-01");
      assert.equal(reversal!.period_id, s.augustId);
      assert.equal(reversal!.reverses_entry_id, accrual!.id);
      assert.deepEqual(await entryLines(org.orgId, accrual!.id), [
        { account_id: s.unbilledAccountId, amount: "200.0000", project_id: s.tmProject },
        { account_id: org.accounts.revenue, amount: "-200.0000", project_id: s.tmProject },
      ]);
      assert.deepEqual(await entryLines(org.orgId, reversal!.id), [
        { account_id: s.unbilledAccountId, amount: "-200.0000", project_id: s.tmProject },
        { account_id: org.accounts.revenue, amount: "200.0000", project_id: s.tmProject },
      ]);
      const evidence = (await db.execute<{ amount: string; accrual_entry_id: string; reversal_entry_id: string; reversal_date: string }>(sql`
        select amount::text, accrual_entry_id, reversal_entry_id, reversal_date::text from project_revenue_accruals
         where org_id = ${org.orgId}`)).rows;
      assert.deepEqual(evidence, [{ amount: "200.0000", accrual_entry_id: accrual!.id, reversal_entry_id: reversal!.id, reversal_date: "2026-08-01" }]);
      assert.equal((await unbilledAccrualReadiness(org.orgId, s.julyId)).pendingKeys, 0);

      // An unchanged rerun posts nothing.
      const rerun = await runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodId: s.julyId });
      assert.equal(rerun.runId, null);
      assert.equal((await accrualEntries(org.orgId)).length, 2);

      // More July work posts only the difference.
      const second = await approvedTime(s, s.tmProject, "2026-07-20", "1.0000");
      assert.equal((await unbilledAccrualReadiness(org.orgId, s.julyId)).pendingKeys, 1);
      await runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodEnd: "2026-07-31" });
      const deltas = (await db.execute<{ amount: string }>(sql`
        select amount::text from project_revenue_accruals where org_id = ${org.orgId} order by created_at`)).rows;
      assert.deepEqual(deltas.map((row) => row.amount), ["200.0000", "100.0000"]);

      // Billed in August: still unbilled at the end of July.
      await billTime(s, first, "2026-08-05");
      assert.equal((await previewUnbilledRevenueAccrual(org.orgId, { periodId: s.julyId })).upToDate, true);

      // Billed in July: no longer unbilled at July's end, so the accrual is reduced.
      await billTime(s, second, "2026-07-25");
      const reduced = await previewUnbilledRevenueAccrual(org.orgId, { periodId: s.julyId });
      assert.deepEqual(reduced.lines.map((line) => [line.unbilled, line.accrued, line.delta]), [["200.0000", "300.0000", "-100.0000"]]);
      await runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodId: s.julyId });
      const correction = (await accrualEntries(org.orgId)).at(-2)!;
      assert.deepEqual(await entryLines(org.orgId, correction.id), [
        { account_id: s.unbilledAccountId, amount: "-100.0000", project_id: s.tmProject },
        { account_id: org.accounts.revenue, amount: "100.0000", project_id: s.tmProject },
      ]);
      assert.equal((await previewUnbilledRevenueAccrual(org.orgId, { periodId: s.julyId })).upToDate, true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});

test("the accrual refuses closed reversal periods, unmapped accounts and a disabled feature, posting nothing", { skip }, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg();
    try {
      const s = await scenario(org);
      await approvedTime(s, s.tmProject, "2026-07-10", "2.0000");
      const refusedWith = (code: string) => (error: unknown) => error instanceof UnbilledAccrualError && error.code === code;
      const nothingPosted = async () => {
        assert.equal((await accrualEntries(org.orgId)).length, 0);
        assert.equal((await db.execute(sql`select 1 from project_revenue_accruals where org_id = ${org.orgId}`)).rows.length, 0);
      };

      // The reversal period is closed.
      await db.execute(sql`
        insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by)
        values (${org.orgId}, ${s.augustId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', 'closed', now(), ${s.actorId})`);
      await assert.rejects(
        runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodEnd: "2026-07-31" }),
        (error: unknown) => refusedWith("period_closed")(error) && /reverses on 2026-08-01/.test((error as Error).message),
      );
      await nothingPosted();
      await db.execute(sql`delete from period_locks where org_id = ${org.orgId} and period_id = ${s.augustId}`);

      // The unbilled receivable control account is unmapped.
      await db.execute(sql`
        update orgs set settings = settings #- '{controlAccounts,unbilledReceivable}' where id = ${org.orgId}`);
      const preview = await previewUnbilledRevenueAccrual(org.orgId, { periodEnd: "2026-07-31" });
      assert.deepEqual(preview.problems.map((problem) => problem.code), ["unbilled_account_unmapped"]);
      assert.match(preview.problems[0]!.message, /Map Unbilled receivable under Setup → Company & Accounting → Control accounts/);
      await assert.rejects(runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodEnd: "2026-07-31" }), refusedWith("unbilled_account_unmapped"));
      await nothingPosted();
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{controlAccounts,unbilledReceivable}', to_jsonb(${s.unbilledAccountId}::text))
         where id = ${org.orgId}`);

      // The feature is off.
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features,unbilledRevenueAccrual}', 'false'::jsonb) where id = ${org.orgId}`);
      await assert.rejects(previewUnbilledRevenueAccrual(org.orgId, { periodEnd: "2026-07-31" }), refusedWith("feature_disabled"));
      await assert.rejects(runUnbilledRevenueAccrual(org.orgId, s.actorId, { periodEnd: "2026-07-31" }), refusedWith("feature_disabled"));
      assert.equal((await unbilledAccrualReadiness(org.orgId, s.julyId)).applies, false);
      await nothingPosted();
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
});
