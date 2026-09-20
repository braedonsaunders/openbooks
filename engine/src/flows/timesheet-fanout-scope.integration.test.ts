import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { timesheetWeeksFlowAdapter } from "./timesheet-weeks-adapter.ts";
import { getFlowAdapter } from "./registry.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Scheduled fan-out tenant isolation for timesheet weeks — parity with the
 * documents candidate read (documents-fanout-scope.integration.test.ts,
 * fnd_mtlnbr4x_wd5odm).
 *
 * The firing wraps in withOrg(flow.orgId), but the adapter's candidate query
 * must carry its own explicit org_id predicate and fail closed with no
 * ambient tenant, instead of trusting the surrounding RLS scope: under an
 * ambient bypass resolver (as the scheduler tick and this suite run with)
 * unscoped reads see every tenant, fanning one flow's firing out across
 * orgs — evaluating rules against, and raising runs over, another org's
 * employees' weeks.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedWeek(orgId: string, actorId: string, subsidiaryId: string): Promise<string> {
  const employeeId = randomUUID();
  const headerId = randomUUID();
  await db.execute(sql`
    insert into parties
      (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values
      (${employeeId}, ${orgId}, 'employee', 'Fanout Worker',
       ${subsidiaryId}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into timesheet_weeks
      (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
    values
      (${headerId}, ${orgId}, ${employeeId}, '2026-07-12',
       'submitted', ${actorId}, ${actorId})
  `);
  return headerId;
}

test("timesheet fan-out candidates stay inside the firing org", { skip: !DB }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const actorsA = await seedFlowActors(orgA.orgId);
    const actorsB = await seedFlowActors(orgB.orgId);
    const aWeeks: string[] = [];
    for (let i = 0; i < 2; i++) {
      aWeeks.push(await seedWeek(orgA.orgId, actorsA.adminId, orgA.subsidiaryId));
    }
    for (let i = 0; i < 3; i++) {
      await seedWeek(orgB.orgId, actorsB.adminId, orgB.subsidiaryId);
    }

    const candidates = await withOrg(orgA.orgId, () =>
      timesheetWeeksFlowAdapter.findCandidateIds!(100),
    );
    assert.deepEqual(new Set(candidates), new Set(aWeeks), "only the firing org's weeks are candidates");

    const otherWay = await withOrg(orgB.orgId, () =>
      getFlowAdapter("timesheet_week")!.findCandidateIds!(100),
    );
    assert.equal(otherWay.length, 3, "the neighboring org sees exactly its own weeks");
    assert.ok(otherWay.every((id) => !aWeeks.includes(id)));
  } finally {
    await db.execute(sql`delete from timesheet_weeks where org_id = ${orgA.orgId}`);
    await db.execute(sql`delete from timesheet_weeks where org_id = ${orgB.orgId}`);
    await dropScratchOrg(orgA.orgId);
    await dropScratchOrg(orgB.orgId);
  }
});

test("timesheet fan-out refuses to read without an ambient tenant", { skip: !DB }, async () => {
  await assert.rejects(
    () => timesheetWeeksFlowAdapter.findCandidateIds!(10),
    /ambient tenant context/,
    "an unscoped candidate read fails closed instead of scanning every tenant",
  );
});
