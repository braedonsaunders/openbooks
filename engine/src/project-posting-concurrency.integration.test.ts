import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  postProjectLaborCost,
  reverseProjectGlEntry,
  reverseProjectLaborCost,
} from "./project-recognition.ts";
import {
  applyOverheadForTime,
  reverseOverheadForTime,
} from "./overhead-apply.ts";
import { postPayrollVariance } from "./labor-costing.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("project labor and overhead posting are exactly-once under concurrency and release whole reversal groups", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const employeeId = randomUUID();
    const projectId = randomUUID();
    const timeEntryIds = [randomUUID(), randomUUID()];

    await db.execute(sql`
      update orgs
         set settings = settings || ${JSON.stringify({
           controlAccounts: {
             ar: org.accounts.ar,
             ap: org.accounts.ap,
             bank: org.accounts.bank,
             laborWip: org.accounts.cogs,
             laborClearing: org.accounts.clearing,
             payrollVariance: org.accounts.freight,
           },
           overheadApplication: {
             mode: "net_zero_pair",
             accountId: org.accounts.adjustment,
           },
         })}::jsonb
       where id = ${org.orgId}`);
    await db.execute(sql`
      insert into parties
        (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values
        (${employeeId}, ${org.orgId}, 'employee', 'Project Worker',
         ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into projects
        (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values
        (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-RACE',
         'Posting race job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into overhead_rates
        (id, org_id, method, rate_kind, rate_percent, effective_from)
      values
        (${randomUUID()}, ${org.orgId}, 'standard', 'per_hour', '12.5000', '2026-07-01')`);
    await db.execute(sql`
      insert into time_entries
        (id, org_id, employee_party_id, worked_on, hours, project_id, status,
         cost_rate, cost_rate_currency, cost_rate_subsidiary_id, costing_basis,
         is_billable, custom, created_by, updated_by)
      values
        (${timeEntryIds[0]}, ${org.orgId}, ${employeeId}, ${org.date}, '2.0000',
         ${projectId}, 'approved', '25.0000', 'CAD', ${org.subsidiaryId},
         'actual', false, '{}'::jsonb, ${actorId}, ${actorId}),
        (${timeEntryIds[1]}, ${org.orgId}, ${employeeId}, ${org.date}, '3.0000',
         ${projectId}, 'approved', '25.0000', 'CAD', ${org.subsidiaryId},
         'actual', false, '{}'::jsonb, ${actorId}, ${actorId})`);

    const laborResults = await Promise.all([
      postProjectLaborCost(org.orgId, actorId, timeEntryIds),
      postProjectLaborCost(org.orgId, actorId, timeEntryIds),
    ]);
    assert.deepEqual(
      laborResults.map((result) => result.length).sort(),
      [0, 1],
      "only one worker may claim and post the labor group",
    );
    const laborEntryId = laborResults.flat()[0]!;

    const overheadResults = await Promise.all([
      applyOverheadForTime(org.orgId, actorId, timeEntryIds),
      applyOverheadForTime(org.orgId, actorId, timeEntryIds),
    ]);
    assert.deepEqual(
      overheadResults.map((result) => result.entryId === null).sort(),
      [false, true],
      "only one worker may claim and post the overhead group",
    );
    const overheadEntryId = overheadResults.find((result) => result.entryId)?.entryId;
    assert.ok(overheadEntryId);

    const posted = (await db.execute<{ origin: string; count: number }>(sql`
      select origin, count(*)::int as count
        from journal_entries
       where org_id = ${org.orgId}
         and origin in ('labor_burden', 'overhead_applied')
         and reverses_entry_id is null
       group by origin
       order by origin`));
    assert.deepEqual(posted.rows, [
      { origin: "labor_burden", count: 1 },
      { origin: "overhead_applied", count: 1 },
    ]);

    const stamps = (await db.execute<{
        cost_journal_entry_id: string | null;
        overhead_journal_entry_id: string | null;
      }>(sql`
      select cost_journal_entry_id, overhead_journal_entry_id
        from time_entries
       where id = any(${`{${timeEntryIds.join(",")}}`}::uuid[])
       order by id`));
    assert.equal(stamps.rows.length, 2);
    assert.ok(stamps.rows.every((row) => row.cost_journal_entry_id === laborEntryId));
    assert.ok(stamps.rows.every((row) => row.overhead_journal_entry_id === overheadEntryId));

    const varianceResults = await Promise.all([
      postPayrollVariance({
        orgId: org.orgId,
        actorId,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        subsidiaryId: org.subsidiaryId,
      }),
      postPayrollVariance({
        orgId: org.orgId,
        actorId,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        subsidiaryId: org.subsidiaryId,
      }),
    ]);
    assert.ok(varianceResults.every((result) => result.entryId));
    assert.ok(varianceResults.every((result) => result.variance === "125.0000"));
    const varianceJournals = (await db.execute<{ status: string; reverses_entry_id: string | null }>(sql`
      select status, reverses_entry_id
        from journal_entries
       where org_id = ${org.orgId}
         and origin = 'payroll_variance'
         and entry_number like 'PVAR-%'
       order by created_at, id`));
    assert.equal(
      varianceJournals.rows.filter(
        (row) => row.status === "posted" && row.reverses_entry_id === null,
      ).length,
      1,
      "concurrent variance runs leave one current source journal",
    );
    assert.equal(
      varianceJournals.rows.filter((row) => row.status === "reversed").length,
      1,
      "the superseded variance journal is controlled history",
    );
    assert.equal(
      varianceJournals.rows.filter((row) => row.reverses_entry_id !== null).length,
      1,
      "the superseded variance journal has exactly one mirror",
    );

    const reversalRace = await Promise.all([
      reverseProjectGlEntry(
        org.orgId,
        actorId,
        overheadEntryId,
        "Concurrent project overhead reversal test",
        org.date,
      ),
      reverseProjectGlEntry(
        org.orgId,
        actorId,
        overheadEntryId,
        "Concurrent project overhead reversal test",
        org.date,
      ),
    ]);
    assert.equal(reversalRace.filter(Boolean).length, 1, "one source journal receives one reversal");
    const reversalCount = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from journal_entries
       where org_id = ${org.orgId} and reverses_entry_id = ${overheadEntryId}`));
    assert.equal(reversalCount.rows[0]?.count, 1);

    await Promise.all([
      reverseProjectLaborCost(
        org.orgId,
        actorId,
        [timeEntryIds[0]],
        "Concurrent labor release test",
        org.date,
      ),
      reverseProjectLaborCost(
        org.orgId,
        actorId,
        [timeEntryIds[1]],
        "Concurrent labor release test",
        org.date,
      ),
    ]);
    await Promise.all([
      reverseOverheadForTime(
        org.orgId,
        actorId,
        [timeEntryIds[0]],
        "Concurrent overhead release test",
        org.date,
      ),
      reverseOverheadForTime(
        org.orgId,
        actorId,
        [timeEntryIds[1]],
        "Concurrent overhead release test",
        org.date,
      ),
    ]);
    const released = (await db.execute<{
        cost_journal_entry_id: string | null;
        overhead_journal_entry_id: string | null;
      }>(sql`
      select cost_journal_entry_id, overhead_journal_entry_id
        from time_entries
       where id = any(${`{${timeEntryIds.join(",")}}`}::uuid[])
       order by id`));
    assert.ok(
      released.rows.every(
        (row) => row.cost_journal_entry_id === null && row.overhead_journal_entry_id === null,
      ),
      "reversing one member releases every source row carried by the reversed group",
    );
  } finally {
    await db.execute(sql`delete from time_entries where org_id = ${org.orgId}`);
    await db.execute(sql`delete from overhead_rates where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
