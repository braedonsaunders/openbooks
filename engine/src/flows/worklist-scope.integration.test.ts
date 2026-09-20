import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { worklistGates } from "./gates.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Worklist subsidiary isolation: a restricted caller must not see approval
 * gates for legal entities outside their scope — including non-document
 * subjects (timesheet weeks inherit their entity from the employee party),
 * which carry no joined document row for callers to filter on.
 *
 * The application layer already filters document gates by subsidiary; the
 * engine is the single point that can resolve every subject kind, so the
 * boundary lives here and every worklist surface inherits it.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  const subsidiaryId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subsidiaryId}, ${orgId}, ${parentId}, 'West Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return subsidiaryId;
}

async function seedTimesheetGate(
  orgId: string,
  actorId: string,
  assigneeId: string,
  subsidiaryId: string,
): Promise<string> {
  const employeeId = randomUUID();
  const headerId = randomUUID();
  await db.execute(sql`
    insert into parties
      (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
    values
      (${employeeId}, ${orgId}, 'employee', 'Worklist Worker',
       ${subsidiaryId}, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into timesheet_weeks
      (id, org_id, employee_party_id, week_start, status, created_by, updated_by)
    values
      (${headerId}, ${orgId}, ${employeeId}, '2026-07-12',
       'submitted', ${actorId}, ${actorId})
  `);
  const flowId = randomUUID();
  const runId = randomUUID();
  const gateId = randomUUID();
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, 'Timesheet approvals', 'timesheet_week', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into flow_runs
      (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
    values (${runId}, ${orgId}, ${flowId}, 'timesheet_week', ${headerId}, 'on_submit', 'waiting')
  `);
  await db.execute(sql`
    insert into flow_gates
      (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id,
       title, assignee_user_id, group_key, quorum, status)
    values (${gateId}, ${orgId}, ${flowId}, ${runId}, 'gate-1',
            'timesheet_week', ${headerId}, 'Manager approval',
            ${assigneeId}, 'gate-1', 'any', 'pending')
  `);
  return gateId;
}

test("a restricted worklist hides gates from other subsidiaries", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const otherSubsidiary = await withOrg(org.orgId, () =>
      seedSecondSubsidiary(org.orgId, org.subsidiaryId),
    );
    const gateId = await withOrg(org.orgId, () =>
      seedTimesheetGate(org.orgId, actors.adminId, actors.approver1Id, otherSubsidiary),
    );

    const unrestricted = await withOrg(org.orgId, () =>
      worklistGates(org.orgId, actors.approver1Id),
    );
    assert.ok(
      unrestricted.some((g) => g.id === gateId),
      "unrestricted callers still see every assigned gate",
    );
    const exposed = unrestricted.find((g) => g.id === gateId)!;
    assert.equal(exposed.subsidiaryId, otherSubsidiary, "the gate carries its legal entity for callers");

    const hidden = await withOrg(org.orgId, () =>
      worklistGates(org.orgId, actors.approver1Id, undefined, new Set([org.subsidiaryId])),
    );
    assert.ok(
      hidden.every((g) => g.id !== gateId),
      "a gate from another subsidiary is not listed",
    );

    const visible = await withOrg(org.orgId, () =>
      worklistGates(org.orgId, actors.approver1Id, undefined, new Set([otherSubsidiary])),
    );
    assert.ok(
      visible.some((g) => g.id === gateId),
      "an in-scope caller still sees the gate",
    );
  } finally {
    await db.execute(sql`delete from flow_gates where org_id = ${org.orgId}`);
    await db.execute(sql`delete from flow_runs where org_id = ${org.orgId}`);
    await db.execute(sql`delete from flows where org_id = ${org.orgId}`);
    await db.execute(sql`delete from timesheet_weeks where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});
