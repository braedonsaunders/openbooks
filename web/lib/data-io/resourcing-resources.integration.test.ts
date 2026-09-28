import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";

const { assignmentPlanResource, retainerBalancesResource } = await import("./resourcing-resources.ts");

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const ids = await withBypassContext(async () => {
    const actorId = await createScratchUser(org.orgId, "Bench importer", "bench-importer");
    assert.equal((await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"projects":true,"resourcing":true}'::jsonb) where id = ${org.orgId} returning id`)).rows.length, 1, "resourcing resource fixture feature setup updates one organization");
    const employee = randomUUID(), project = randomUUID();
    await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom) values (${employee}, ${org.orgId}, 'person', 'Import', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`insert into employee_roles (org_id, party_id, job_title, hired_on, is_active) values (${org.orgId}, ${employee}, 'Consultant', '2026-01-01', true)`);
    await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom) values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'IM', 'Import project', null, 'active', true, '{}'::jsonb)`);
    return { actorId, project };
  });
  return { org, ...ids };
}

const row = (f: { project: string }, over: Record<string, unknown> = {}) => ({
  project: f.project, employee: "Import", weekStart: "2026-10-04", plannedHours: "8", ...over,
});
const ctx = (f: { org: { orgId: string }; actorId: string }, over: Record<string, unknown> = {}) => ({
  orgId: f.org.orgId, actorId: f.actorId, dryRun: false, allowedSubsidiaryIds: null, permissions: new Set(["resourcing.manage"]), ...over,
});

test("assignment round-trip preserves validation and scope", enabled, async () => {
  const f = await fixture();
  try {
    const res = assignmentPlanResource(f.org.orgId);
    const first = await res.write([row(f)], "upsert", ctx(f));
    assert.deepEqual([first.created, first.updated, first.failed], [1, 0, 0]);
    const again = await res.write([row(f)], "upsert", ctx(f));
    assert.deepEqual([again.created, again.updated, again.failed], [0, 1, 0]);
    const noManage = await res.write([row(f)], "upsert", ctx(f, { permissions: new Set(["resourcing.read"]) }));
    const { actorId: _omit, ...dropped } = ctx(f);
    const noActor = await res.write([row(f)], "upsert", dropped as never);
    assert.deepEqual([noManage.failed, noActor.failed], [1, 1]);
    assert.match(noManage.errors[0]!.message, /resourcing\.manage/);
    assert.match(noActor.errors[0]!.message, /actorId/);
    const exported = await res.read({ actorId: f.actorId, allowedSubsidiaryIds: null });
    assert.ok(exported.rows.some((r) => r.weekStart === "2026-10-04"));
    assert.equal(exported.rows.length, 1, "refused writes persist nothing");
    const scoped = await res.write([row(f)], "upsert", ctx(f, { allowedSubsidiaryIds: new Set([randomUUID()]) }));
    assert.equal(scoped.failed, 1);
    const dryScoped = await res.write([row(f)], "upsert", ctx(f, { dryRun: true, allowedSubsidiaryIds: new Set([randomUUID()]) }));
    assert.equal(dryScoped.failed, 1, "dry-run shares the governed scope decision");
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});

test("invalid and zero-effect imports refuse with usable remedy", enabled, async () => {
  const f = await fixture();
  try {
    const res = assignmentPlanResource(f.org.orgId);
    const bad = await res.write([row(f, { weekStart: "2026-10-06" })], "upsert", ctx(f));
    assert.equal(bad.failed, 1);
    assert.match(bad.errors[0]!.message, /week_must_start_sunday|Sunday/);
    const empty = await res.write([], "upsert", ctx(f));
    assert.equal(empty.failed, 1);
    assert.ok(empty.errors[0]!.message.length > 10);
    const balances = await retainerBalancesResource(f.org.orgId).read({ actorId: f.actorId, allowedSubsidiaryIds: null });
    assert.deepEqual(balances.rows, []);
    assert.deepEqual(balances.columns.map((c) => c.key), ["currency", "balance", "drawn"]);
  } finally { await dropScratchOrgReporting(f.org.orgId); }
});
