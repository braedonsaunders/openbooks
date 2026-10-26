import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  LaborCostCatchUpRefusal,
  postUnpostedLaborCost,
  previewUnpostedLaborCost,
} from "./labor-cost-catch-up.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const enabled = !!process.env.OPENBOOKS_DB_URL;
const through = "2026-07-15";
const reason = "Cost approved time from before posting was enabled";

interface ConfigOptions {
  mode: "off" | "post";
  mapped?: boolean;
  projects?: boolean;
}

async function configureLabor(org: ScratchOrg, options: ConfigOptions): Promise<string> {
  const mapped = options.mapped ?? true;
  await db.execute(sql`
    update orgs
       set settings = coalesce(settings, '{}'::jsonb) || ${JSON.stringify({
         laborCosting: { mode: options.mode },
         controlAccounts: mapped
           ? { laborWip: org.accounts.cogs, laborClearing: org.accounts.clearing }
           : {},
       })}::jsonb
     where id = ${org.orgId}`);
  if (options.projects === false) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(settings, '{features}',
           coalesce(settings->'features', '{}'::jsonb) || '{"projects": false}'::jsonb)
       where id = ${org.orgId}`);
  }
  return (await seedFlowActors(org.orgId)).adminId;
}

async function insertProject(org: ScratchOrg, code: string, isInternal: boolean): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into projects
      (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom, is_internal)
    values
      (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${code}, ${isInternal ? null : org.customerId},
       'active', true, '{}'::jsonb, ${isInternal})`);
  return id;
}

async function insertTime(
  org: ScratchOrg,
  actorId: string,
  employeeId: string,
  entry: {
    id: string;
    projectId: string | null;
    workedOn: string;
    hours: string;
    rate: string | null;
    status: "approved" | "submitted";
  },
): Promise<void> {
  await db.execute(sql`
    insert into time_entries
      (id, org_id, employee_party_id, worked_on, hours, project_id, status,
       cost_rate, cost_rate_currency, cost_rate_subsidiary_id, costing_basis,
       is_billable, custom, created_by, updated_by)
    values
      (${entry.id}, ${org.orgId}, ${employeeId}, ${entry.workedOn}, ${entry.hours},
       ${entry.projectId}, ${entry.status}, ${entry.rate}, 'CAD', ${org.subsidiaryId},
       'actual', false, '{}'::jsonb, ${actorId}, ${actorId})`);
}

/**
 * July (open) holds two postable rows plus one row for each exclusion:
 * unrated, not approved, internal, no project, zero cost and after the through
 * date. June is closed for GL and holds one postable row that must be skipped.
 */
async function seedScenario(org: ScratchOrg, actorId: string) {
  const employeeId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values (${employeeId}, ${org.orgId}, 'employee', 'Catch-up Worker', ${org.subsidiaryId}, true, '{}'::jsonb)`);
  const project = await insertProject(org, "CU-JOB", false);
  const internal = await insertProject(org, "CU-SHOP", true);

  const eligibleA = randomUUID();
  const eligibleB = randomUUID();
  const june = randomUUID();
  await insertTime(org, actorId, employeeId, {
    id: eligibleA,
    projectId: project,
    workedOn: "2026-07-10",
    hours: "2.0000",
    rate: "25.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: eligibleB,
    projectId: project,
    workedOn: "2026-07-11",
    hours: "3.0000",
    rate: "20.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: project,
    workedOn: "2026-07-12",
    hours: "4.0000",
    rate: null,
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: project,
    workedOn: "2026-07-12",
    hours: "1.0000",
    rate: "25.0000",
    status: "submitted",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: internal,
    workedOn: "2026-07-12",
    hours: "5.0000",
    rate: "25.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: null,
    workedOn: "2026-07-12",
    hours: "2.0000",
    rate: "25.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: project,
    workedOn: "2026-07-13",
    hours: "0.0000",
    rate: "25.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: randomUUID(),
    projectId: project,
    workedOn: "2026-07-20",
    hours: "1.0000",
    rate: "25.0000",
    status: "approved",
  });
  await insertTime(org, actorId, employeeId, {
    id: june,
    projectId: project,
    workedOn: "2026-06-15",
    hours: "2.0000",
    rate: "25.0000",
    status: "approved",
  });

  const [calendar] = await db.execute<{ id: string }>(
    sql`
    select id from fiscal_calendars where org_id = ${org.orgId} and is_default`,
    "objects",
  );
  const juneId = randomUUID();
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values
      (${juneId}, ${org.orgId}, 2026, 6, '2026-06', '2026-06-01', '2026-06-30', false, ${calendar!.id})`);
  await db.execute(sql`
    insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, reason)
    values (${org.orgId}, ${juneId}, ${org.bookId}, null, 'gl', 'closed', 'June month-end close')`);
  return { eligibleIds: [eligibleA, eligibleB], juneId, june };
}

async function countLaborJournals(orgId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId} and origin = 'labor_burden'`,
      "objects",
    )
  )[0]!.n;
}

async function countCatchUpAudits(orgId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`
    select count(*)::int as n from audit_log
     where org_id = ${orgId} and action = 'post' and changes->>'kind' = 'labor_cost_catch_up'`,
      "objects",
    )
  )[0]!.n;
}

test(
  "catch-up preview counts only approved, project-bound, costed, unposted time through the date",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await configureLabor(org, { mode: "post" });
      await seedScenario(org, actorId);
      const preview = await previewUnpostedLaborCost(org.orgId, { through });
      assert.deepEqual(preview.blockers, []);
      assert.deepEqual(preview.months, [
        {
          month: "2026-06",
          entries: 1,
          hours: "2.0000",
          costs: [{ currency: "CAD", amount: "50.0000" }],
          state: "closed",
          blockedEntries: 1,
        },
        {
          month: "2026-07",
          entries: 2,
          hours: "5.0000",
          costs: [{ currency: "CAD", amount: "110.0000" }],
          state: "open",
          blockedEntries: 0,
        },
      ]);
      assert.deepEqual(preview.totals, {
        entries: 3,
        postableEntries: 2,
        blockedEntries: 1,
        hours: "7.0000",
        costs: [{ currency: "CAD", amount: "160.0000" }],
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "catch-up posts open-period time once, stamps it, skips the closed month, and a rerun posts nothing",
  { skip: !enabled },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await configureLabor(org, { mode: "post" });
      const { eligibleIds, june } = await seedScenario(org, actorId);

      await assert.rejects(
        postUnpostedLaborCost(org.orgId, actorId, { through, reason: " ok " }),
        (error: unknown) =>
          error instanceof LaborCostCatchUpRefusal &&
          error.code === "reason_invalid" &&
          error.remedy.length > 0,
      );
      assert.equal(await countLaborJournals(org.orgId), 0, "a refused reason writes nothing");

      const result = await postUnpostedLaborCost(org.orgId, actorId, { through, reason });
      assert.equal(result.postedEntries, 2);
      assert.equal(result.postedHours, "5.0000");
      assert.deepEqual(result.postedCosts, [{ currency: "CAD", amount: "110.0000" }]);
      assert.equal(result.journalEntryIds.length, 1);
      assert.equal(result.skippedEntries, 1);
      assert.deepEqual(
        result.skipped.map((group) => ({
          month: group.month,
          state: group.state,
          entries: group.entries,
        })),
        [{ month: "2026-06", state: "closed", entries: 1 }],
      );
      assert.ok(result.skipped[0]!.remedy.length > 0);

      const rows = await db.execute<{ id: string; cost_journal_entry_id: string | null }>(
        sql`
      select id, cost_journal_entry_id from time_entries
       where org_id = ${org.orgId} and cost_journal_entry_id is not null`,
        "objects",
      );
      assert.deepEqual(rows.map((row) => row.id).sort(), [...eligibleIds].sort());
      assert.ok(rows.every((row) => row.cost_journal_entry_id === result.journalEntryIds[0]));

      const journal = (
        await db.execute<{ origin: string; posting_date: string; status: string }>(
          sql`
      select origin, posting_date::text as posting_date, status from journal_entries
       where org_id = ${org.orgId} and id = ${result.journalEntryIds[0]!}`,
          "objects",
        )
      )[0];
      assert.deepEqual(journal, {
        origin: "labor_burden",
        posting_date: "2026-07-11",
        status: "posted",
      });
      const wip = (
        await db.execute<{ total: string }>(
          sql`
      select coalesce(sum(l.amount), 0)::text as total from journal_lines l
       where l.org_id = ${org.orgId} and l.entry_id = ${result.journalEntryIds[0]!} and l.account_id = ${org.accounts.cogs}`,
          "objects",
        )
      )[0];
      assert.equal(wip?.total, "110.0000");

      const juneRow = (
        await db.execute<{ cost_journal_entry_id: string | null }>(
          sql`
      select cost_journal_entry_id from time_entries where org_id = ${org.orgId} and id = ${june}`,
          "objects",
        )
      )[0];
      assert.equal(juneRow?.cost_journal_entry_id, null, "the closed-period entry stays unposted");
      assert.equal(await countCatchUpAudits(org.orgId), 1);

      const again = await postUnpostedLaborCost(org.orgId, actorId, {
        through,
        reason: "Second run of the same catch-up",
      });
      assert.equal(again.postedEntries, 0);
      assert.deepEqual(again.journalEntryIds, []);
      assert.deepEqual(again.postedCosts, []);
      assert.equal(again.skippedEntries, 1, "the closed month is still reported");
      assert.equal(await countLaborJournals(org.orgId), 1, "a rerun creates no journal");
      assert.equal(
        await countCatchUpAudits(org.orgId),
        1,
        "a rerun that posts nothing writes no audit row",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

const refusals = [
  { label: "labor posting off", options: { mode: "off" } as ConfigOptions, code: "mode_off" },
  {
    label: "control accounts unmapped",
    options: { mode: "post", mapped: false } as ConfigOptions,
    code: "accounts_unmapped",
  },
  {
    label: "Projects disabled",
    options: { mode: "post", projects: false } as ConfigOptions,
    code: "projects_disabled",
  },
] as const;

for (const refusal of refusals) {
  test(`catch-up refuses with a remedy when ${refusal.label}`, { skip: !enabled }, async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await configureLabor(org, refusal.options);
      await seedScenario(org, actorId);
      const preview = await previewUnpostedLaborCost(org.orgId, { through });
      const blocker = preview.blockers.find((item) => item.code === refusal.code);
      assert.ok(blocker, `preview reports ${refusal.code}`);
      assert.ok(blocker.remedy.length > 0);
      await assert.rejects(
        postUnpostedLaborCost(org.orgId, actorId, { through, reason }),
        (error: unknown) =>
          error instanceof LaborCostCatchUpRefusal &&
          error.code === refusal.code &&
          error.status === 422 &&
          error.remedy === blocker.remedy,
      );
      assert.equal(await countLaborJournals(org.orgId), 0);
      const stamped = (
        await db.execute<{ n: number }>(
          sql`
        select count(*)::int as n from time_entries where org_id = ${org.orgId} and cost_journal_entry_id is not null`,
          "objects",
        )
      )[0];
      assert.equal(stamped?.n, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
