import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postProjectGlEntry } from "../project-recognition.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../test-fixtures.ts";
import { DriverNotAvailableError } from "./drivers.ts";
import { runDriverReport } from "./report-runner.ts";

async function seedReportsReader(orgId: string): Promise<string> {
  const actor = await createScratchUser(orgId, "Report driver tester", "admin");
  await db.execute(sql`
    update app_roles set permissions = '["reports.read"]'::jsonb
     where org_id = ${orgId} and key = 'admin'`);
  return actor;
}

async function seedTimesheetSource(orgId: string, subsidiaryId: string, workedOn: string): Promise<string> {
  const deptId = randomUUID();
  const projectId = randomUUID();
  const employeeId = randomUUID();
  await db.execute(sql`insert into departments (id, org_id, name) values (${deptId}, ${orgId}, 'Crew A')`);
  await db.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, status, is_active, custom)
    values (${projectId}, ${orgId}, ${subsidiaryId}, 'JOB-TS', 'Timesheet job', 'active', true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${orgId}, 'employee', 'Timesheet worker', ${subsidiaryId}, true, '{}'::jsonb)`);
  await db.execute(sql`
    insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, department_id,
                              status, costing_basis, is_billable, custom)
    values (${randomUUID()}, ${orgId}, ${employeeId}, ${workedOn}, '8.0000', ${projectId}, ${deptId},
            'approved', 'actual', false, '{}'::jsonb)`);
  const definitionId = randomUUID();
  await db.execute(sql`
    insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
    values (${definitionId}, ${orgId}, 'custom', 'driver-timesheets-test', 'Driver timesheets test', 'query',
      ${JSON.stringify({
        entity: "timesheets",
        columns: ["department", "hours"],
      })}::jsonb)`);
  return definitionId;
}

test("report runner honors canonical feature defaults (timeTracking on unless disabled)", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    // The scratch org never stores an explicit timeTracking flag: the
    // registry default (on) governs, exactly like the report routes.
    const definitionId = await seedTimesheetSource(org.orgId, org.subsidiaryId, org.date);
    const evidence = await runDriverReport({
      orgId: org.orgId,
      reportDefinitionId: definitionId,
      dimensionColumn: "department",
      valueColumn: "hours",
      params: {},
      from: org.date,
      to: org.date,
      actorId: actor,
      temporalMode: "balance_as_of",
    });
    assert.deepEqual(evidence.rows, [{ dimension: "Crew A", value: "8.0000" }]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("report runner refuses evidence that reaches the query row cap instead of truncating", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    await postProjectGlEntry({
      orgId: org.orgId,
      actorId: actor,
      origin: "manual",
      entryNumber: `TRUNC-SEED-${randomUUID()}`,
      postingDate: org.date,
      memo: "Truncation probe pool",
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
      lines: [
        { accountId: org.accounts.adjustment, amount: "100.0000" },
        { accountId: org.accounts.bank, amount: "-100.0000" },
      ],
    });
    // One matching row against a limit-1 display query: the runner cannot
    // prove completeness, so it must refuse with a named error — a truncated
    // weight vector would apportion real money on partial inputs.
    const cappedId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
      values (${cappedId}, ${org.orgId}, 'custom', 'driver-capped-test', 'Driver capped test', 'query',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "rows",
          columns: ["account_id", "debit"],
          limit: 1,
          filters: {
            combinator: "and",
            rules: [{ field: "account_id", op: "eq", value: org.accounts.adjustment }],
          },
        })}::jsonb)`);
    await assert.rejects(
      runDriverReport({
        orgId: org.orgId,
        reportDefinitionId: cappedId,
        dimensionColumn: "account_id",
        valueColumn: "debit",
        params: {},
        from: org.date,
        to: org.date,
        actorId: actor,
        temporalMode: "balance_as_of",
      }),
      (error: unknown) => error instanceof DriverNotAvailableError && /driver_evidence_truncated/.test(error.message),
    );
    // The same evidence under a roomy limit resolves normally.
    const roomyId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
      values (${roomyId}, ${org.orgId}, 'custom', 'driver-roomy-test', 'Driver roomy test', 'query',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "rows",
          columns: ["account_id", "debit"],
          limit: 100,
          filters: {
            combinator: "and",
            rules: [{ field: "account_id", op: "eq", value: org.accounts.adjustment }],
          },
        })}::jsonb)`);
    const evidence = await runDriverReport({
      orgId: org.orgId,
      reportDefinitionId: roomyId,
      dimensionColumn: "account_id",
      valueColumn: "debit",
      params: {},
      from: org.date,
      to: org.date,
      actorId: actor,
      temporalMode: "balance_as_of",
    });
    assert.deepEqual(evidence.rows, [{ dimension: org.accounts.adjustment, value: "100.0000" }]);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("report-backed drivers apply the requested period instead of all history", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    // Two postings in the same period on the same accounts; a first-ten-days
    // window must weigh the early one only, though the saved definition
    // carries no dates. (Scratch orgs own only the July 2026 period, so the
    // window narrows within it rather than across months.)
    for (const [date, amount] of [["2026-07-05", "1000.0000"], ["2026-07-25", "500.0000"]] as const) {
      await postProjectGlEntry({
        orgId: org.orgId,
        actorId: actor,
        origin: "manual",
        entryNumber: `PERIOD-SEED-${date}-${randomUUID().slice(0, 8)}`,
        postingDate: date,
        memo: "Period probe pool",
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        lines: [
          { accountId: org.accounts.adjustment, amount },
          { accountId: org.accounts.bank, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` },
        ],
      });
    }
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
      values (${definitionId}, ${org.orgId}, 'custom', 'driver-period-test', 'Driver period test', 'query',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "summarize",
          columns: [],
          breakouts: [{ column: "account_id" }],
          measures: [{ fn: "sum", column: "debit" }],
        })}::jsonb)`);
    const evidence = await runDriverReport({
      orgId: org.orgId,
      reportDefinitionId: definitionId,
      dimensionColumn: "account_id",
      valueColumn: "debit",
      params: {},
      from: "2026-07-01",
      to: "2026-07-10",
      actorId: actor,
      temporalMode: "period_activity",
    });
    assert.deepEqual(evidence.temporal, {
      mode: "period_activity",
      from: "2026-07-01",
      to: "2026-07-10",
      field: "posting_date",
    });
    const weights = new Map(evidence.rows.map((r) => [r.dimension, r.value] as [string, string]));
    assert.equal(weights.get(org.accounts.adjustment), "1000.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("fixed_query and balance_as_of weigh the report scope with the contract echoed", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    for (const [date, amount] of [["2026-07-05", "1000.0000"], ["2026-07-25", "500.0000"]] as const) {
      await postProjectGlEntry({
        orgId: org.orgId,
        actorId: actor,
        origin: "manual",
        entryNumber: `SCOPE-SEED-${date}-${randomUUID().slice(0, 8)}`,
        postingDate: date,
        memo: "Scope probe pool",
        subsidiaryId: org.subsidiaryId,
        currency: "CAD",
        lines: [
          { accountId: org.accounts.adjustment, amount },
          { accountId: org.accounts.bank, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` },
        ],
      });
    }
    const definitionId = randomUUID();
    await db.execute(sql`
      insert into report_definitions (id, org_id, kind, slug, name, report_type, query)
      values (${definitionId}, ${org.orgId}, 'custom', 'driver-scope-test', 'Driver scope test', 'query',
        ${JSON.stringify({
          entity: "ledger_lines",
          mode: "summarize",
          columns: [],
          breakouts: [{ column: "account_id" }],
          measures: [{ fn: "sum", column: "debit" }],
        })}::jsonb)`);
    const base = {
      orgId: org.orgId,
      reportDefinitionId: definitionId,
      dimensionColumn: "account_id",
      valueColumn: "debit",
      params: {},
      from: "2026-07-01",
      to: "2026-07-10",
      actorId: actor,
    };
    // fixed_query: the author's scope governs — both postings weigh, and the
    // echo says no period was bound.
    const fixed = await runDriverReport({ ...base, temporalMode: "fixed_query" });
    assert.deepEqual(fixed.temporal, { mode: "fixed_query", from: null, to: null, field: null });
    assert.equal(new Map(fixed.rows.map((r) => [r.dimension, r.value] as [string, string])).get(org.accounts.adjustment), "1500.0000");
    // balance_as_of (the historical behavior for undeclared drivers): the
    // snapshot at to governs, echoed with its date.
    const balanced = await runDriverReport({ ...base, temporalMode: "balance_as_of" });
    assert.deepEqual(balanced.temporal, {
      mode: "balance_as_of",
      from: null,
      to: "2026-07-10",
      field: null,
    });
    assert.equal(new Map(balanced.rows.map((r) => [r.dimension, r.value] as [string, string])).get(org.accounts.adjustment), "1500.0000");
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("report runner honors the feature parent gate (projects off disables timeTracking)", async () => {
  const org = await createScratchOrg();
  try {
    const actor = await seedReportsReader(org.orgId);
    const definitionId = await seedTimesheetSource(org.orgId, org.subsidiaryId, org.date);
    // A stale stored true must not override the disabled parent: the report
    // routes refuse this entity, so the driver runner must too.
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{features}',
               coalesce(settings->'features', '{}'::jsonb) || '{"timeTracking": true, "projects": false}'::jsonb)
       where id = ${org.orgId}`);
    await assert.rejects(
      runDriverReport({
        orgId: org.orgId,
        reportDefinitionId: definitionId,
        dimensionColumn: "department",
        valueColumn: "hours",
        params: {},
        from: org.date,
        to: org.date,
        actorId: actor,
        temporalMode: "balance_as_of",
      }),
      (error: unknown) => error instanceof DriverNotAvailableError && /feature is disabled/.test(error.message),
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
