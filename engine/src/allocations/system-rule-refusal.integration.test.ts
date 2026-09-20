import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import {
  AllocationRuleError,
  createDraftVersion,
  createRule,
  deleteRule,
  publishVersion,
  replaceTargets,
  retireVersion,
  updateDraftVersion,
  updateRule,
} from "./rules.ts";

const DB = process.env.OPENBOOKS_DB_URL ? true : false;
const AUDIT = { actorId: "0f000000-0000-4000-8000-000000000000", reason: "refusal test" };

async function seed() {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const systemId = randomUUID();
    await db.execute(sql`insert into allocation_rules(id,org_id,key,name,mode,sort_order,is_active,is_system,custom)
      values(${systemId},${org.orgId},'overhead-net-zero-pair','Overhead net-zero pair (system)','post',100,true,true,'{}')`);
    return { orgId: org.orgId, actorId, systemId };
  } catch (error) {
    await dropScratchOrg(org.orgId);
    throw error;
  }
}

async function draftVersion(orgId: string, ruleId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into allocation_rule_versions(id,org_id,rule_id,version_no,status,effective_from)
    values(${id},${orgId},${ruleId},1,'draft','2026-01-01')`);
  return id;
}

async function expectFrozen(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AllocationRuleError);
    assert.equal(error.code, "FROZEN");
    return true;
  });
}

test("system rule heads refuse every rules-API edit", { skip: !DB }, async () => {
  const s = await seed();
  try {
    await expectFrozen(updateRule(s.systemId, { orgId: s.orgId, name: "Renamed" }, AUDIT));
    await expectFrozen(updateRule(s.systemId, { orgId: s.orgId, description: "x" }, AUDIT));
    await expectFrozen(updateRule(s.systemId, { orgId: s.orgId, sortOrder: 1 }, AUDIT));
    await expectFrozen(updateRule(s.systemId, { orgId: s.orgId, isActive: false }, AUDIT));
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("system rule versions refuse every rules-API transition", { skip: !DB }, async () => {
  const s = await seed();
  try {
    await expectFrozen(createDraftVersion(s.systemId, { orgId: s.orgId, effectiveFrom: "2026-06-01" }, AUDIT));
    const draftId = await draftVersion(s.orgId, s.systemId);
    await expectFrozen(updateDraftVersion(draftId, { orgId: s.orgId, runOffsetDays: 3 }, AUDIT));
    await expectFrozen(replaceTargets(draftId, { orgId: s.orgId, targets: [] }, AUDIT));
    await expectFrozen(publishVersion(draftId, { orgId: s.orgId, actorId: s.actorId }));
    await expectFrozen(retireVersion(draftId, { orgId: s.orgId, actorId: s.actorId }));
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("system rules cannot be deleted through the service", { skip: !DB }, async () => {
  const s = await seed();
  try {
    await expectFrozen(deleteRule(s.systemId, { orgId: s.orgId }, AUDIT));
  } finally {
    await dropScratchOrg(s.orgId);
  }
});

test("tenant rules delete with their drafts but never with published history", { skip: !DB }, async () => {
  const s = await seed();
  try {
    const created = await createRule({ orgId: s.orgId, key: "tenant-cleanup", name: "Tenant", mode: "period" }, AUDIT);
    const draft = await createDraftVersion(created.rule.id, { orgId: s.orgId, effectiveFrom: "2026-01-01" }, AUDIT);
    await deleteRule(created.rule.id, { orgId: s.orgId }, AUDIT);
    const gone = await db.execute<{ n: string }>(sql`select count(*) as n from allocation_rules
      where org_id = ${s.orgId} and id = ${created.rule.id}`);
    assert.equal(gone.rows[0]?.n, "0");
    const draftsGone = await db.execute<{ n: string }>(sql`select count(*) as n from allocation_rule_versions
      where org_id = ${s.orgId} and id = ${draft.version.id}`);
    assert.equal(draftsGone.rows[0]?.n, "0");

    const kept = await createRule({ orgId: s.orgId, key: "tenant-history", name: "Tenant", mode: "period" }, AUDIT);
    const keptDraft = await createDraftVersion(kept.rule.id, { orgId: s.orgId, effectiveFrom: "2026-01-01" }, AUDIT);
    await db.execute(sql`update allocation_rule_versions set status = 'published',
      definition_hash = 'x', published_at = now(), published_by = ${s.actorId}
      where org_id = ${s.orgId} and id = ${keptDraft.version.id}`);
    await assert.rejects(deleteRule(kept.rule.id, { orgId: s.orgId }, AUDIT), /published history/);
  } finally {
    await dropScratchOrg(s.orgId);
  }
});
