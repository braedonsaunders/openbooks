import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox, refreshSandbox, resetSandbox } from "./lifecycle.ts";
import { applyChangeSet, approveChangeSet, buildChangeSet, reviewChangeSet } from "./promote.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
async function fixture(run: (org: Awaited<ReturnType<typeof createScratchOrg>>, actors: string[], child: string) => Promise<void>) {
  const org = await createScratchOrg();
  try {
    const actors: string[] = [];
    for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
    await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
    await createScratchUser(org.orgId, "Scoped subtree", "scoped_tree");
    await createScratchUser(org.orgId, "Scoped list", "scoped_list");
    const child = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${child},${org.orgId},${org.subsidiaryId},'Branch','CAD','CA')`);
    await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','subtree','subsidiaryId',${org.subsidiaryId.toUpperCase()}::text) where org_id=${org.orgId} and key='scoped_tree'`);
    await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','list','subsidiaryIds',jsonb_build_array(${child}::text)) where org_id=${org.orgId} and key='scoped_list'`);
    await db.execute(sql`update subsidiaries set control_accounts=jsonb_build_object('receivable',${org.accounts.ar.toUpperCase()}::text) where org_id=${org.orgId} and id=${child}`);
    await run(org, actors, child);
  } finally {
    const sandboxes = (await db.execute<{ id: string }>(sql`select id from sandboxes where production_org_id=${org.orgId}`)).rows;
    for (const sandbox of sandboxes) await deleteSandbox(sandbox.id);
    await dropScratchOrgReporting(org.orgId);
  }
}

for (const tier of ["full", "masked", "as_of", "dev"] as const) {
  test(`${tier} sandbox preserves role visibility and rebases entity control accounts through refresh/reset`, enabled, async () => fixture(async (org, _actors, child) => {
    const sandbox = await createSandbox({ productionOrgId: org.orgId, name: `JSON scope ${tier}`, tier, masked: tier === "masked", asOfPeriodId: tier === "as_of" ? org.periodId : null });
    const assertReferences = async () => {
      const entities = (await db.execute<{ id: string; parent_id: string | null; control_accounts: Record<string, string> }>(sql`select id,parent_id,control_accounts from subsidiaries where org_id=${sandbox.sandboxOrgId}`)).rows;
      assert.equal(entities.length, 2);
      const root = entities.find(row => row.parent_id === null)!;
      const branch = entities.find(row => row.parent_id === root.id)!;
      assert.notEqual(root.id, org.subsidiaryId);
      assert.notEqual(branch.id, child);
      for (const key of ["scoped_tree", "scoped_list"]) {
        const user = (await db.execute<{ user_id: string }>(sql`select a.user_id from role_assignments a join app_roles r on r.id=a.role_id and r.org_id=a.org_id where r.org_id=${sandbox.sandboxOrgId} and r.key=${key}`)).rows[0]!.user_id;
        const allowed = await actorAllowedSubsidiaryIds(db, sandbox.sandboxOrgId, user);
        assert.deepEqual([...allowed!].sort(), (key === "scoped_tree" ? [root.id, branch.id] : [branch.id]).sort());
      }
      if (tier === "dev") {
        assert.deepEqual(branch.control_accounts, {});
        assert.equal((await db.execute(sql`select id from accounts where org_id=${sandbox.sandboxOrgId}`)).rows.length, 0);
        assert.equal((await db.execute(sql`select id from journal_entries where org_id=${sandbox.sandboxOrgId}`)).rows.length, 0);
      } else {
        assert.notEqual(branch.control_accounts.receivable, org.accounts.ar);
        assert.equal((await db.execute(sql`select id from accounts where org_id=${sandbox.sandboxOrgId} and id=${branch.control_accounts.receivable}`)).rows.length, 1);
      }
      const evidence = (await db.execute(sql`select id from audit_log where org_id=${sandbox.sandboxOrgId} and changes->>'mode'='sandbox_json_reference_rebase'`)).rows;
      assert.ok(evidence.length >= 3);
    };
    await assertReferences();
    // Existing sandboxes can still hold the pre-fix production UUIDs. A keep
    // refresh repairs that proven mapping without overwriting the role policy.
    await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','list','subsidiaryIds',jsonb_build_array(${child}::text)) where org_id=${sandbox.sandboxOrgId} and key='scoped_list'`);
    await refreshSandbox(sandbox.sandboxId, { keepCustomizations: true });
    await assertReferences();
    await resetSandbox(sandbox.sandboxId);
    await assertReferences();
  }));
}

test("HRM scope filters are rebased through proven sandbox counterparts and their generated projections follow", enabled, async () => fixture(async (org, _actors, child) => {
  const department = randomUUID();
  await db.execute(sql`insert into departments(id,org_id,name) values(${department},${org.orgId},'Field crews')`);
  const leaveType = randomUUID();
  await db.execute(sql`insert into hrm_leave_types(id,org_id,code,name) values(${leaveType},${org.orgId},'VAC','Vacation')`);
  const scopedTemplate = randomUUID();
  const openTemplate = randomUUID();
  const policy = randomUUID();
  // Upper-case ids on purpose: the filter is text inside jsonb and production
  // rows may carry either casing; the counterpart lookup must not care.
  await db.execute(sql`insert into hrm_process_templates(id,org_id,kind,name,applies_to) values
    (${scopedTemplate},${org.orgId},'onboarding','Branch crews',jsonb_build_object('employer_subsidiary_id',${child.toUpperCase()}::text,'department_id',${department}::text)),
    (${openTemplate},${org.orgId},'offboarding','Everyone','{}'::jsonb)`);
  await db.execute(sql`insert into hrm_leave_policies(id,org_id,leave_type_id,applies_to,accrual_rule,effective_from) values
    (${policy},${org.orgId},${leaveType},jsonb_build_object('employer_subsidiary_id',null,'department_id',${department.toUpperCase()}::text),'{"kind":"per_year","hours":"80"}'::jsonb,'2026-01-01')`);
  const sandbox = await createSandbox({ productionOrgId: org.orgId, name: "HRM scope", tier: "full", masked: false });
  const assertScopes = async () => {
    const branch = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${sandbox.sandboxOrgId} and parent_id is not null`)).rows[0]!.id;
    const departments = (await db.execute<{ id: string }>(sql`select id from departments where org_id=${sandbox.sandboxOrgId}`)).rows;
    assert.equal(departments.length, 1);
    const dept = departments[0]!.id;
    assert.notEqual(dept, department);
    type Scoped = { id: string; name: string; applies_to: Record<string, string | null>; applies_employer_subsidiary_id: string | null; applies_department_id: string | null };
    const templates = (await db.execute<Scoped>(sql`
      select id,name,applies_to,applies_employer_subsidiary_id,applies_department_id from hrm_process_templates where org_id=${sandbox.sandboxOrgId} order by name`)).rows;
    assert.deepEqual(templates.map(row => row.name), ["Branch crews", "Everyone"]);
    const [scoped, open] = templates as [Scoped, Scoped];
    assert.deepEqual(scoped.applies_to, { employer_subsidiary_id: branch, department_id: dept });
    // The STORED projections recomputed from the rebased filter, which is the
    // whole reason the clone must never name them.
    assert.equal(scoped.applies_employer_subsidiary_id, branch);
    assert.equal(scoped.applies_department_id, dept);
    assert.deepEqual(open.applies_to, {});
    assert.equal(open.applies_department_id, null);
    const policies = (await db.execute<Scoped & { accrual_rule: unknown }>(sql`
      select id,applies_to,applies_employer_subsidiary_id,applies_department_id,accrual_rule from hrm_leave_policies where org_id=${sandbox.sandboxOrgId}`)).rows;
    assert.equal(policies.length, 1);
    assert.deepEqual(policies[0]!.applies_to, { employer_subsidiary_id: null, department_id: dept });
    assert.equal(policies[0]!.applies_employer_subsidiary_id, null);
    assert.equal(policies[0]!.applies_department_id, dept);
    // Rule JSON carries no identities and copies verbatim.
    assert.deepEqual(policies[0]!.accrual_rule, { kind: "per_year", hours: "80" });
    const evidence = (await db.execute<{ table_name: string; row_id: string }>(sql`
      select table_name,row_id from audit_log where org_id=${sandbox.sandboxOrgId} and changes->>'mode'='sandbox_json_reference_rebase'
         and table_name in ('hrm_process_templates','hrm_leave_policies')`)).rows;
    // Every copy (create, refresh, reset) records its own rebase; the audit
    // trail survives a keep-customizations refresh, so compare the distinct set.
    assert.deepEqual(
      [...new Set(evidence.map(row => `${row.table_name}:${row.row_id}`))].sort(),
      [`hrm_leave_policies:${policies[0]!.id}`, `hrm_process_templates:${scoped.id}`].sort(),
    );
  };
  await assertScopes();
  await refreshSandbox(sandbox.sandboxId, { keepCustomizations: true });
  await assertScopes();
  await resetSandbox(sandbox.sandboxId);
  await assertScopes();
  // A filter pinned to a department production no longer has cannot be
  // guessed into the sandbox: the clone refuses as a whole.
  await db.execute(sql`update hrm_process_templates set applies_to=jsonb_build_object('department_id',${randomUUID()}::text) where org_id=${org.orgId} and id=${openTemplate}`);
  await assert.rejects(
    createSandbox({ productionOrgId: org.orgId, name: "HRM stale scope", tier: "full", masked: false }),
    /scope filter department_id has no counterpart in the target organization/,
  );
}));

test("role scope promotion compares and writes production identities while preserving assignments", enabled, async () => fixture(async (org, actors, child) => {
  const sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Scope promotion", tier: "full", masked: false });
  const unchanged = await buildChangeSet(sandbox.sandboxId, "No role changes", actors[0]);
  assert.equal((await db.execute(sql`select id from change_set_items where change_set_id=${unchanged.changeSetId} and table_name='app_roles'`)).rows.length, 0);
  const branch = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${sandbox.sandboxOrgId} and parent_id is not null`)).rows[0]!.id;
  await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','subtree','subsidiaryId',${branch}::text) where org_id=${sandbox.sandboxOrgId} and key='scoped_tree'`);
  const change = await buildChangeSet(sandbox.sandboxId, "Narrow subtree", actors[0]);
  const items = (await db.execute<{ payload: { subsidiary_restriction: unknown } }>(sql`select payload from change_set_items where change_set_id=${change.changeSetId} and table_name='app_roles'`)).rows;
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.payload.subsidiary_restriction, { mode: "subtree", subsidiaryId: child });
  await reviewChangeSet(change.changeSetId, actors[1]);
  await approveChangeSet(change.changeSetId, actors[2]);
  await applyChangeSet(change.changeSetId, actors[3]);
  assert.deepEqual((await db.execute(sql`select subsidiary_restriction from app_roles where org_id=${org.orgId} and key='scoped_tree'`)).rows[0]!.subsidiary_restriction, { mode: "subtree", subsidiaryId: child });
  assert.equal((await db.execute(sql`select id from role_assignments where org_id=${org.orgId}`)).rows.length, 6);
}));

test("promotion refuses a captured role scope whose production subsidiary was deleted", enabled, async () => fixture(async (org, actors, child) => {
  const sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Stale captured scope", tier: "full", masked: false });
  const before = (await db.execute(sql`select name from app_roles where org_id=${org.orgId} and key='scoped_list'`)).rows[0]!.name;
  await db.execute(sql`update app_roles set name='Changed scoped role' where org_id=${sandbox.sandboxOrgId} and key='scoped_list'`);
  const change = await buildChangeSet(sandbox.sandboxId, "Stale scope", actors[0]);
  await reviewChangeSet(change.changeSetId, actors[1]);
  await approveChangeSet(change.changeSetId, actors[2]);
  await db.execute(sql`delete from subsidiaries where org_id=${org.orgId} and id=${child}`);
  await assert.rejects(applyChangeSet(change.changeSetId, actors[3]), /no counterpart in the target organization/);
  assert.equal((await db.execute(sql`select status from change_sets where id=${change.changeSetId}`)).rows[0]!.status, 'approved');
  assert.equal((await db.execute(sql`select name from app_roles where org_id=${org.orgId} and key='scoped_list'`)).rows[0]!.name, before);
}));

test("a sandbox-only subsidiary cannot enter a production role through promotion", enabled, async () => fixture(async (org, actors) => {
  const sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Unmapped scope", tier: "full", masked: false });
  const root = (await db.execute<{ id: string }>(sql`select id from subsidiaries where org_id=${sandbox.sandboxOrgId} and parent_id is null`)).rows[0]!.id;
  const novel = randomUUID();
  await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country) values(${novel},${sandbox.sandboxOrgId},${root},'Sandbox only','CAD','CA')`);
  await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','list','subsidiaryIds',jsonb_build_array(${novel}::text)) where org_id=${sandbox.sandboxOrgId} and key='scoped_list'`);
  await assert.rejects(buildChangeSet(sandbox.sandboxId, "Unmappable scope", actors[0]), /no counterpart in the target organization/);
  assert.equal((await db.execute(sql`select id from change_sets where org_id=${org.orgId}`)).rows.length, 0);
}));

test("invalid source role scope aborts the whole clone without broadening access", enabled, async () => fixture(async (org) => {
  await db.execute(sql`update app_roles set subsidiary_restriction=jsonb_build_object('mode','subtree','subsidiaryId',${randomUUID()}::text) where org_id=${org.orgId} and key='scoped_tree'`);
  await assert.rejects(createSandbox({ productionOrgId: org.orgId, name: "Invalid source scope", tier: "full", masked: false }), /no counterpart in the target organization/);
  const sandbox = (await db.execute<{ org_id: string; status: string }>(sql`select org_id,status from sandboxes where production_org_id=${org.orgId}`)).rows[0]!;
  assert.equal(sandbox.status, "failed");
  assert.equal((await db.execute(sql`select id from app_roles where org_id=${sandbox.org_id}`)).rows.length, 0);
  assert.equal((await db.execute(sql`select id from subsidiaries where org_id=${sandbox.org_id}`)).rows.length, 0);
}));
