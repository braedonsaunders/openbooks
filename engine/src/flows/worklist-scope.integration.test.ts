import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { decideGate, GateError, worklistGates } from "./gates.ts";
import { getFlowAdapter, listFlowSubjectProfiles } from "./registry.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

/**
 * Worklist subsidiary isolation: a restricted caller must not see approval
 * gates for legal entities outside their scope — including non-document
 * subjects such as timesheet weeks and work orders, which carry no joined
 * document row for callers to filter on.
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

async function seedWorkOrderGates(
  orgId: string,
  itemId: string,
  makerId: string,
  firstApproverId: string,
  secondApproverId: string,
  subsidiaryId: string,
  otherSubsidiaryId: string,
): Promise<{ inScopeGateId: string; outOfScopeGateId: string }> {
  const flowId = randomUUID();
  const inScopeOrderId = randomUUID();
  const outOfScopeOrderId = randomUUID();
  const inScopeRunId = randomUUID();
  const outOfScopeRunId = randomUUID();
  const inScopeGateId = randomUUID();
  const inScopeSiblingGateId = randomUUID();
  const outOfScopeGateId = randomUUID();

  await db.execute(sql`
    insert into mfg_work_orders
      (id, org_id, number, produced_item_id, quantity_ordered, unit, subsidiary_id, created_by)
    values
      (${inScopeOrderId}, ${orgId}, 'WO-WORKLIST-A', ${itemId}, 1, 'ea', ${subsidiaryId}, ${makerId}),
      (${outOfScopeOrderId}, ${orgId}, 'WO-WORKLIST-B', ${itemId}, 1, 'ea', ${otherSubsidiaryId}, ${makerId})
  `);
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, 'Work-order approvals', 'work_order', true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into flow_runs (id, org_id, flow_id, subject_kind, subject_id, trigger, status)
    values
      (${inScopeRunId}, ${orgId}, ${flowId}, 'work_order', ${inScopeOrderId}, 'on_submit', 'waiting'),
      (${outOfScopeRunId}, ${orgId}, ${flowId}, 'work_order', ${outOfScopeOrderId}, 'on_submit', 'waiting')
  `);
  await db.execute(sql`
    insert into flow_gates
      (id, org_id, flow_id, run_id, node_id, subject_kind, subject_id, title,
       assignee_user_id, group_key, quorum, status)
    values
      (${inScopeGateId}, ${orgId}, ${flowId}, ${inScopeRunId}, 'gate-a', 'work_order', ${inScopeOrderId},
       'Work-order approval', ${firstApproverId}, 'gate-a', 'all', 'pending'),
      (${inScopeSiblingGateId}, ${orgId}, ${flowId}, ${inScopeRunId}, 'gate-a', 'work_order', ${inScopeOrderId},
       'Work-order approval', ${secondApproverId}, 'gate-a', 'all', 'pending'),
      (${outOfScopeGateId}, ${orgId}, ${flowId}, ${outOfScopeRunId}, 'gate-b', 'work_order', ${outOfScopeOrderId},
       'Work-order approval', ${firstApproverId}, 'gate-b', 'any', 'pending')
  `);
  return { inScopeGateId, outOfScopeGateId };
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
    const workOrderGates = await withOrg(org.orgId, () =>
      seedWorkOrderGates(
        org.orgId,
        org.items.assembly,
        actors.submitterId,
        actors.approver1Id,
        actors.approver2Id,
        org.subsidiaryId,
        otherSubsidiary,
      ),
    );

    const unrestricted = await withOrg(org.orgId, () =>
      worklistGates(org.orgId, actors.approver1Id),
    );
    assert.ok(
      unrestricted.some((g) => g.id === gateId),
      "unrestricted callers still see every assigned gate",
    );
    assert.ok(unrestricted.some((g) => g.id === workOrderGates.inScopeGateId));
    assert.ok(unrestricted.some((g) => g.id === workOrderGates.outOfScopeGateId));
    const exposed = unrestricted.find((g) => g.id === gateId)!;
    assert.equal(exposed.subsidiaryId, otherSubsidiary, "the gate carries its legal entity for callers");

    const hidden = await withOrg(org.orgId, () =>
      worklistGates(org.orgId, actors.approver1Id, undefined, new Set([org.subsidiaryId])),
    );
    assert.ok(
      hidden.every((g) => g.id !== gateId),
      "a gate from another subsidiary is not listed",
    );
    assert.ok(hidden.some((g) => g.id === workOrderGates.inScopeGateId));
    assert.ok(hidden.every((g) => g.id !== workOrderGates.outOfScopeGateId));

    await withOrg(org.orgId, () =>
      decideGate({
        gateId: workOrderGates.inScopeGateId,
        decision: "approved",
        userId: actors.approver1Id,
        allowedSubsidiaryIds: new Set([org.subsidiaryId]),
      }),
    );
    await assert.rejects(
      withOrg(org.orgId, () =>
        decideGate({
          gateId: workOrderGates.outOfScopeGateId,
          decision: "approved",
          userId: actors.approver1Id,
          allowedSubsidiaryIds: new Set([org.subsidiaryId]),
        }),
      ),
      (error: unknown) => error instanceof GateError && error.message === "approval not found",
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
    await db.execute(sql`delete from mfg_work_orders where org_id = ${org.orgId}`);
    await db.execute(sql`delete from timesheet_weeks where org_id = ${org.orgId}`);
    await dropScratchOrg(org.orgId);
  }
});

test("every table-backed subject scope names real tables and columns", { skip: !DB }, async () => {
  // The scope interpreter builds its SQL from these identifiers; a typo would
  // only surface when a restricted caller first meets that kind.
  const catalog = new Set((await db.execute<{ name: string }>(sql`
    select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'
  `)).rows.map((row) => row.name));
  const defects = listFlowSubjectProfiles().flatMap(({ subjectKind }) => {
    const scope = getFlowAdapter(subjectKind)?.scope;
    if (!scope || !("table" in scope)) return [];
    return ["id", "org_id", scope.column]
      .map((column) => `${scope.table}.${column}`)
      .filter((name) => !catalog.has(name))
      .map((name) => `${subjectKind}: ${name} does not exist`);
  });
  assert.deepEqual(defects, [], `subject scopes naming missing columns:\n  ${defects.join("\n  ")}`);
});
