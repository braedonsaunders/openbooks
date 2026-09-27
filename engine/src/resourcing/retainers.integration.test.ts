import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { assertWriteRows, createRetainer, draftHoursDrawdown } from "./retainers.ts";
import { ResourcingRefusal } from "./errors.ts";
let org: ScratchOrg;
let actorId: string;
beforeEach(async () => {
  org = await withBypassContext(() => createScratchOrg());
  actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId;
  const rows = await withBypassContext(() => db.execute<{ id: string }>(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb)
        || '{"projects":true,"resourcing":true,"retainerBilling":true,"revenueRecognition":true}'::jsonb,
      true) where id = ${org.orgId} returning id
  `));
  assertWriteRows(rows.rows, 1, "test feature setup");
});
afterEach(async () => { if (org) await withBypassContext(() => dropScratchOrg(org.orgId)); });

test("hours drawdown selects only approved, billable, in-window, undrawn entries", async () => {
  const selected = randomUUID(), held = randomUUID();
  const fx = await fixture([
    { id: selected, workedOn: "2026-06-02", hours: "2.0000", status: "approved", billable: true },
    { id: held, workedOn: "2026-06-03", hours: "3.0000", status: "approved", billable: true },
    { id: randomUUID(), workedOn: "2026-06-02", hours: "4.0000", status: "submitted", billable: true },
    { id: randomUUID(), workedOn: "2026-06-02", hours: "5.0000", status: "approved", billable: false },
    { id: randomUUID(), workedOn: "2026-05-31", hours: "6.0000", status: "approved", billable: true },
    { id: randomUUID(), workedOn: "2026-06-05", hours: "7.0000", status: "approved", billable: true },
    { id: randomUUID(), workedOn: "2026-06-06", hours: "8.0000", status: "approved", billable: true },
  ], { startsOn: "2026-06-01", endsOn: "2026-06-04", preclaim: held });
  const draft = await draftHoursDrawdown({
    orgId: org.orgId, actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    retainerId: fx.retainerId, sunday: "2026-05-31",
  });
  assert.deepEqual(draft.byEntry.map((entry) => entry.id), [selected]);
  assert.equal(draft.hours, "2.0000");
  assert.equal(draft.amount, "200.0000");
});

test("a second draft for the same retainer week refuses without duplicating evidence", async () => {
  const fx = await fixture([
    { id: randomUUID(), workedOn: "2026-06-08", hours: "1.0000", status: "approved", billable: true },
  ]);
  const input = {
    orgId: org.orgId, actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    retainerId: fx.retainerId, sunday: "2026-06-07",
  };
  assert.equal((await draftHoursDrawdown(input)).amount, "100.0000");
  await assert.rejects(draftHoursDrawdown(input), (error: unknown) => {
    assert.ok(error instanceof ResourcingRefusal);
    assert.equal(error.status, 409);
    assert.equal(error.code, "drawdown_exists");
    return true;
  });
  const counts = await withBypassContext(() => db.execute<{ drafts: number; links: number }>(sql`
    select (select count(*)::int from res_retainer_drawdowns where org_id = ${org.orgId} and retainer_id = ${fx.retainerId}) as drafts,
           (select count(*)::int from res_retainer_drawdown_entries where org_id = ${org.orgId} and drawdown_id in
             (select id from res_retainer_drawdowns where org_id = ${org.orgId} and retainer_id = ${fx.retainerId})) as links
  `));
  assert.deepEqual(counts.rows[0], { drafts: 1, links: 1 });
});

test("a zero-row update is raised as a write failure", async () => {
  const rows = await withOrgTransaction(org.orgId, async () => db.execute<{ id: string }>(sql`
    update res_retainers set ends_on = '2026-12-31'
     where org_id = ${org.orgId} and id = ${randomUUID()} returning id
  `));
  assert.equal(rows.rows.length, 0);
  assert.throws(() => assertWriteRows(rows.rows, 1, "retainer extension"), /wrote 0 rows/);
});

type TimeSeed = { id: string; workedOn: string; hours: string; status: "approved" | "submitted"; billable: boolean };
async function fixture(
  entries: readonly TimeSeed[],
  terms: { startsOn?: string; endsOn?: string; preclaim?: string } = {},
): Promise<{ retainerId: string }> {
  const projectId = randomUUID(), employeeId = randomUUID();
  const projectCode = `RET-${projectId.slice(0, 8)}`;
  await withBypassContext(async () => {
    const project = await db.execute<{ id: string }>(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, ${projectCode}, ${projectCode}, ${org.customerId}, 'active', true, '{}'::jsonb)
      returning id
    `);
    assertWriteRows(project.rows, 1, "test project setup");
    const employee = await db.execute<{ id: string }>(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'employee', ${projectCode}, ${org.subsidiaryId}, true, '{}'::jsonb)
      returning id
    `);
    assertWriteRows(employee.rows, 1, "test employee setup");
  });
  const retainer = await createHoursRetainer(projectId, terms.startsOn ?? "2026-06-01", terms.endsOn ?? "2026-06-30");
  const claimRetainer = terms.preclaim
    ? await createHoursRetainer(projectId, "2026-06-01", "2026-06-30")
    : null;
  await withBypassContext(async () => {
    const values = entries.map((entry) => sql`(
      ${entry.id}, ${org.orgId}, ${employeeId}, ${projectId}, ${entry.workedOn}, ${entry.hours},
      ${entry.status}, ${entry.billable}, 'unbilled', ${actorId}, ${actorId}
    )`);
    const inserted = await db.execute<{ id: string }>(sql`
      insert into time_entries (id, org_id, employee_party_id, project_id, worked_on, hours, status,
        is_billable, billing_status, created_by, updated_by) values ${sql.join(values, sql`, `)} returning id
    `);
    assertWriteRows(inserted.rows, entries.length, "test time-entry setup");
    if (claimRetainer && terms.preclaim) {
      const drawdownId = randomUUID();
      const drawdown = await db.execute<{ id: string }>(sql`
        insert into res_retainer_drawdowns (id, org_id, retainer_id, week_start, hours, amount, state, created_by, updated_by)
        values (${drawdownId}, ${org.orgId}, ${claimRetainer.id}, '2026-05-31', '3.0000', '300.0000', 'draft', ${actorId}, ${actorId})
        returning id
      `);
      assertWriteRows(drawdown.rows, 1, "test prior drawdown setup");
      const link = await db.execute<{ id: string }>(sql`
        insert into res_retainer_drawdown_entries (org_id, drawdown_id, time_entry_id, created_by, updated_by)
        values (${org.orgId}, ${drawdownId}, ${terms.preclaim}, ${actorId}, ${actorId}) returning id
      `);
      assertWriteRows(link.rows, 1, "test prior evidence setup");
    }
  });
  return { retainerId: retainer.id };
}
async function createHoursRetainer(projectId: string, startsOn: string, endsOn: string) {
  const retainer = await createRetainer({
    orgId: org.orgId, actorId, allowedSubsidiaryIds: new Set([org.subsidiaryId]),
    projectId, customerPartyId: org.customerId, kind: "hours", totalHours: "10.0000",
    unitRate: "100.0000", startsOn, endsOn, retainerItemId: org.items.service,
  });
  const activated = await withBypassContext(() => db.execute<{ id: string }>(sql`
    update res_retainers set state = 'active' where org_id = ${org.orgId} and id = ${retainer.id} returning id
  `));
  assertWriteRows(activated.rows, 1, "test retainer activation");
  return retainer;
}
