import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";
import { upsertAssignment } from "@openbooks/engine/src/resourcing/assignments.ts";
import type { Authz } from "../authz.ts";

const { RESOURCING_TOOLS } = await import("./tools-resourcing.ts");

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const WINDOW = { firstSunday: "2026-10-04", lastSunday: "2026-10-11" };

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const ids = await withBypassContext(async () => {
    const actorId = await createScratchUser(org.orgId, "Bench operator", "bench-operator");
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true,"retainerBilling":true,"revenueRecognition":true}'::jsonb) where id = ${org.orgId}`);
    await db.execute(sql`update app_roles set permissions = '["assistant.use","resourcing.read","retainers.read"]' where org_id = ${org.orgId} and key = 'bench-operator'`);
    const employee = randomUUID(), project = randomUUID();
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employee}, ${org.orgId}, 'person', 'Bench', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employee}, 'Consultant', '2026-01-01', true)`);
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'BN', 'Bench project', null, 'active', true, '{}'::jsonb)`);
    const written = await upsertAssignment({ orgId: org.orgId, actorId, allowedSubsidiaryIds: null, projectId: project, employeePartyId: employee, weekStart: "2026-10-04", plannedHours: "8.0000" });
    return { actorId, assignmentId: written.assignment.id };
  });
  return { org, ...ids };
}

const authzFor = (orgId: string, actorId: string, perms: string[], scope: Set<string> | null = null): Authz => ({ user: { id: actorId, orgId }, permissions: new Set(perms), allowedSubsidiaryIds: scope }) as Authz;

test("execution returns landed tenant-scoped data", enabled, async () => {
  const f = await fixture();
  try {
    const authz = authzFor(f.org.orgId, f.actorId, ["assistant.use", "resourcing.read"]);
    const board = await RESOURCING_TOOLS.find((t) => t.name === "get_staffing_board")!.execute(WINDOW, authz);
    assert.equal(board.ok, true);
    const one = await RESOURCING_TOOLS.find((t) => t.name === "get_resourcing_assignment")!.execute({ assignmentId: f.assignmentId }, authz);
    assert.equal(one.ok, true);
    const demand = await RESOURCING_TOOLS.find((t) => t.name === "get_staffing_demand")!.execute(WINDOW, authz);
    assert.equal(demand.ok, true);
    const missing = await RESOURCING_TOOLS.find((t) => t.name === "get_resourcing_assignment")!.execute({ assignmentId: randomUUID() }, authz);
    assert.ok(!missing.ok && /resourcing_assignment_not_found/.test(missing.error));
    const noId = await RESOURCING_TOOLS.find((t) => t.name === "get_resourcing_assignment")!.execute({}, authz);
    assert.deepEqual(noId, { ok: false, error: "assignment_id_required: pass the assignment id from list_resourcing_assignments" });
    const balances = await RESOURCING_TOOLS.find((t) => t.name === "get_retainer_balances")!.execute({}, authzFor(f.org.orgId, f.actorId, ["assistant.use", "retainers.read"]));
    assert.ok(balances.ok && JSON.stringify(Object.keys(balances.data as object).sort()) === JSON.stringify(["expiringCount", "href", "perCurrency"]));
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("feature-off refuses with remedy before input and loaders", enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Off", "off-role"));
    const r = await RESOURCING_TOOLS.find((t) => t.name === "get_staffing_board")!.execute({}, authzFor(org.orgId, actor, ["assistant.use", "resourcing.read"]));
    assert.deepEqual(r, { ok: false, error: "resourcing_feature_disabled: turn on Resourcing under Company Settings → Features" });
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("subsidiary isolation holds end to end", enabled, async () => {
  const f = await fixture();
  try {
    const scoped = authzFor(f.org.orgId, f.actorId, ["assistant.use", "resourcing.read"], new Set([randomUUID()]));
    const board = await RESOURCING_TOOLS.find((t) => t.name === "get_staffing_board")!.execute(WINDOW, scoped);
    assert.equal(board.ok, true);
    if (board.ok) assert.deepEqual((board.data as { assignments: unknown }).assignments, []);
    const one = await RESOURCING_TOOLS.find((t) => t.name === "get_resourcing_assignment")!.execute({ assignmentId: f.assignmentId }, scoped);
    assert.equal(one.ok, false);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});
