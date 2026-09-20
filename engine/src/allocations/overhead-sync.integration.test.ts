import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import {
  OVERHEAD_EVENT_DOCUMENT_KIND,
  OVERHEAD_SYSTEM_DRIVER_KEY,
  OVERHEAD_SYSTEM_RULE_KEY,
  getOverheadSystemRuleEvidence,
  resolveOverheadRuleBinding,
  syncOverheadSystemRule,
} from "./overhead-sync.ts";

const DB = process.env.OPENBOOKS_DB_URL ? true : false;

interface Seed {
  orgId: string;
  actorId: string;
  accountId: string;
  deptA: string;
  deptB: string;
}

async function seed(): Promise<Seed> {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const deptA = randomUUID();
    const deptB = randomUUID();
    await db.execute(sql`update orgs set settings=settings || ${JSON.stringify({
      features: { projects: true, timeTracking: true },
      overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment },
    })}::jsonb where id=${org.orgId}`);
    await db.execute(sql`insert into departments(id,org_id,name) values(${deptA},${org.orgId},'Field'),(${deptB},${org.orgId},'Shop')`);
    await db.execute(sql`insert into overhead_rates(id,org_id,department_id,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${org.orgId},${deptA},'standard','per_hour',12.5,'2026-01-01'),
            (${randomUUID()},${org.orgId},${deptB},'standard','per_hour',20,'2026-01-01')`);
    return { orgId: org.orgId, actorId, accountId: org.accounts.adjustment, deptA, deptB };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

test("sync provisions the system rule, driver and derived version", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const first = await syncOverheadSystemRule(s.orgId, s.actorId);
    assert.equal(first.action, "published");
    assert.ok(first.versionId);
    const head = (await db.execute<{ is_system: boolean; mode: string; current_version_id: string }>(sql`
      select is_system, mode, current_version_id from allocation_rules
       where org_id = ${s.orgId} and key = ${OVERHEAD_SYSTEM_RULE_KEY}`)).rows[0]!;
    assert.deepEqual({ is_system: head.is_system, mode: head.mode }, { is_system: true, mode: "post" });
    assert.equal(head.current_version_id, first.versionId);
    const version = (await db.execute<{
      status: string; impact: string; basis_kind: string; target_kind: string;
      document_kinds: string[]; account_scope: { accountIds: string[] }; definition_hash: string | null;
    }>(sql`select status, impact, basis_kind, target_kind, document_kinds, account_scope, definition_hash
      from allocation_rule_versions where org_id = ${s.orgId} and id = ${first.versionId}`)).rows[0]!;
    assert.equal(version.status, "published");
    assert.equal(version.impact, "net_zero_pair");
    assert.equal(version.basis_kind, "driver");
    assert.equal(version.target_kind, "dynamic");
    assert.deepEqual(version.document_kinds, [OVERHEAD_EVENT_DOCUMENT_KIND]);
    assert.deepEqual(version.account_scope, { kind: "accounts", accountIds: [s.accountId] });
    assert.ok(version.definition_hash && version.definition_hash.length === 64);
    const driver = (await db.execute<{ dimension: string; source_kind: string; config: { measure: string }; is_active: boolean }>(sql`
      select dimension, source_kind, config, is_active from allocation_drivers
       where org_id = ${s.orgId} and key = ${OVERHEAD_SYSTEM_DRIVER_KEY}`)).rows[0]!;
    assert.deepEqual(
      { dimension: driver.dimension, source_kind: driver.source_kind, measure: driver.config.measure, is_active: driver.is_active },
      { dimension: "project", source_kind: "native_measure", measure: "labor_hours", is_active: true },
    );
    const binding = await resolveOverheadRuleBinding(s.orgId, "2026-07-15");
    assert.deepEqual(binding, {
      ruleId: first.ruleId,
      versionId: first.versionId,
      definitionHash: version.definition_hash,
      driverId: (await db.execute<{ id: string }>(sql`select id from allocation_drivers where org_id = ${s.orgId} and key = ${OVERHEAD_SYSTEM_DRIVER_KEY}`)).rows[0]!.id,
      accountId: s.accountId,
    });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("sync is a no-op on an unchanged card and republishes on a new generation", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const first = await syncOverheadSystemRule(s.orgId, s.actorId);
    const second = await syncOverheadSystemRule(s.orgId, s.actorId);
    assert.equal(second.action, "noop");
    assert.equal(second.versionId, first.versionId);
    // A new rate generation retires the open version and publishes the next.
    await db.execute(sql`update overhead_rates set effective_to = '2026-05-31'
       where org_id = ${s.orgId} and department_id = ${s.deptA} and rate_kind = 'per_hour'`);
    await db.execute(sql`insert into overhead_rates(id,org_id,department_id,method,rate_kind,rate_percent,effective_from)
      values(${randomUUID()},${s.orgId},${s.deptA},'standard','per_hour',15,'2026-06-01')`);
    const third = await syncOverheadSystemRule(s.orgId, s.actorId);
    assert.equal(third.action, "published");
    assert.notEqual(third.versionId, first.versionId);
    const statuses = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from allocation_rule_versions
       where org_id = ${s.orgId} and rule_id = ${third.ruleId} order by version_no`)).rows;
    assert.deepEqual(statuses.map((r) => r.status), ["retired", "published"]);
    const binding = await resolveOverheadRuleBinding(s.orgId, "2026-07-15");
    assert.equal(binding?.versionId, third.versionId);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("concurrent first-use syncs provision exactly one rule and version", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const results = await Promise.all([
      syncOverheadSystemRule(s.orgId, s.actorId),
      syncOverheadSystemRule(s.orgId, s.actorId),
    ]);
    assert.equal(results[0]?.versionId, results[1]?.versionId);
    const counts = await db.execute<{ heads: string; versions: string }>(sql`
      select (select count(*) from allocation_rules where org_id = ${s.orgId} and key = 'overhead-net-zero-pair') as heads,
             (select count(*) from allocation_rule_versions v
               join allocation_rules r on r.org_id = v.org_id and r.id = v.rule_id
              where v.org_id = ${s.orgId} and r.key = 'overhead-net-zero-pair' and v.status = 'published') as versions`);
    assert.deepEqual(counts.rows[0], { heads: "1", versions: "1" });
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("sync retires the open version when the policy leaves net-zero pair", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const first = await syncOverheadSystemRule(s.orgId, s.actorId);
    assert.equal(first.action, "published");
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{overheadApplication}',
      ${JSON.stringify({ mode: "report_only", accountId: s.accountId })}::jsonb) where id=${s.orgId}`);
    const retired = await syncOverheadSystemRule(s.orgId, s.actorId);
    assert.equal(retired.action, "retired");
    assert.equal(await resolveOverheadRuleBinding(s.orgId, "2026-07-15"), null);
    const evidence = await getOverheadSystemRuleEvidence(s.orgId);
    assert.equal(evidence.ruleId, first.ruleId);
    assert.equal(evidence.currentVersion, null);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("sync refuses a tenant-squatted rule key instead of adopting it", { skip: !DB }, async () => {
  const s = await seed();
  try {
    await db.execute(sql`insert into allocation_rules(id,org_id,key,name,mode,sort_order,is_active,is_system,custom)
      values(${randomUUID()},${s.orgId},${OVERHEAD_SYSTEM_RULE_KEY},'Squatter','period',100,true,false,'{}')`);
    await assert.rejects(syncOverheadSystemRule(s.orgId, s.actorId), /taken by a tenant/);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("evidence reader reports the derived version for the workspace slot", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const before = await getOverheadSystemRuleEvidence(s.orgId);
    assert.equal(before.ruleId, null);
    assert.equal(before.currentVersion, null);
    const synced = await syncOverheadSystemRule(s.orgId, s.actorId);
    const after = await getOverheadSystemRuleEvidence(s.orgId);
    assert.equal(after.ruleId, synced.ruleId);
    assert.equal(after.ruleKey, OVERHEAD_SYSTEM_RULE_KEY);
    assert.equal(after.isActive, true);
    assert.equal(after.driverKey, OVERHEAD_SYSTEM_DRIVER_KEY);
    assert.equal(after.currentVersion?.id, synced.versionId);
    assert.equal(after.currentVersion?.accountId, s.accountId);
    assert.equal(after.currentVersion?.effectiveFrom, "2026-01-01");
    assert.ok((after.currentVersion?.rateHash?.length ?? 0) === 64);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});
