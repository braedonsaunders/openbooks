import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Same-scope leave-policy windows are exclusive in storage (0266): a second
 * active window for one (leave type, scope) dies on the GiST exclusion.
 * Through the Setup drawer that death must read as a typed 409 naming the
 * remedy — never raw Postgres exclusion text, and never a silent second
 * window the balance then resolves arbitrarily.
 */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSetupRecord, updateSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await withBypass(() => createScratchOrg());
  const actorId = (await withBypass(() => seedFlowActors(org.orgId))).adminId;
  await withBypass(() => db.execute(sql`
    update orgs set settings = settings || '{"features": {"hrm": true}}'::jsonb
     where id = ${org.orgId}`));
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  const type = await withBypass(() => createSetupRecord(actor, "leave-types", {
    code: "VAC", name: "Vacation", paid: true, valueCrossing: "none", isActive: true,
  }));
  assert.equal(type.status, 200, `type refused: ${JSON.stringify(type.body)}`);
  return { orgId: org.orgId, actor, typeId: String((type.body as { id?: string }).id) };
}

function policyBody(overrides: Record<string, unknown> = {}) {
  return {
    accrualKind: "per_year",
    accrualHours: "120",
    carryoverKind: "none",
    minimumNoticeDays: 0,
    isActive: true,
    ...overrides,
  };
}

test("an overlapping leave-policy create conflicts typed with the remedy, never pg text", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const first = await withBypass(() => createSetupRecord(org.actor, "leave-policies", policyBody({
      leaveTypeId: org.typeId, effectiveFrom: "2026-01-01",
    })));
    assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
    const retry = await withBypass(() => createSetupRecord(org.actor, "leave-policies", policyBody({
      leaveTypeId: org.typeId, effectiveFrom: "2026-06-01",
    })));
    assert.equal(retry.status, 409);
    assert.equal((retry.body as { code?: string }).code, "overlap");
    assert.match(String((retry.body as { error?: string }).error), /Another policy already covers this leave type and scope/);
    assert.doesNotMatch(String((retry.body as { error?: string }).error), /exclusion|conflicting key|SQLSTATE|gist/i);
    const count = (await withBypass(() => db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_leave_policies
       where org_id = ${org.orgId} and leave_type_id = ${org.typeId} and is_active
    `))).rows[0]?.n ?? 0;
    assert.equal(count, 1, "the refused create leaves no second window behind");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("stretching a policy window into its neighbour conflicts typed and moves nothing", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const first = await withBypass(() => createSetupRecord(org.actor, "leave-policies", policyBody({
      leaveTypeId: org.typeId, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30",
    })));
    assert.equal(first.status, 200, `first policy refused: ${JSON.stringify(first.body)}`);
    const second = await withBypass(() => createSetupRecord(org.actor, "leave-policies", policyBody({
      leaveTypeId: org.typeId, effectiveFrom: "2026-07-01",
    })));
    assert.equal(second.status, 200, `second policy refused: ${JSON.stringify(second.body)}`);
    const neighbourId = String((second.body as { id?: string }).id);
    const stretched = await withBypass(() => updateSetupRecord(org.actor, "leave-policies", {
      id: neighbourId,
      ...policyBody({ leaveTypeId: org.typeId, effectiveFrom: "2026-06-15" }),
    }));
    assert.equal(stretched.status, 409);
    assert.equal((stretched.body as { code?: string }).code, "overlap");
    assert.match(String((stretched.body as { error?: string }).error), /Another policy already covers this leave type and scope/);
    const kept = (await withBypass(() => db.execute<{ from: string }>(sql`
      select effective_from::text as from from hrm_leave_policies where id = ${neighbourId}
    `))).rows[0]?.from;
    assert.equal(String(kept).slice(0, 10), "2026-07-01", "the refused edit moves no boundary");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
