import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * The pipeline-funnel half of the Setup writer, proved against the real
 * writer and a real database: hrm-pipeline-templates carry the funnel name
 * and flags, hrm-pipeline-stages carry the ordered rows with the fixed
 * kind vocabulary. An unknown kind or a parent funnel outside the org is
 * refused by field name before the write — never a half-row.
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
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSetupRecord } = await import("./write.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features": {"hrm": true}}'::jsonb
     where id = ${org.orgId}`);
  const actor = { orgId: org.orgId, id: actorId, permissions: [] as string[] };
  return { orgId: org.orgId, actor };
}

function created(res: { status: number; body: unknown }): string {
  assert.equal(res.status, 200, `create refused: ${JSON.stringify(res.body)}`);
  return String((res.body as { id?: string }).id ?? (res.body as { row?: { id?: string } }).row?.id);
}

test("a pipeline template with ordered stages persists through Setup", { skip: !DB }, async () => {
  const org = await seedOrg();
  try {
    const templateId = created(await createSetupRecord(org.actor, "hrm-pipeline-templates", {
      name: "Campus funnel", isDefault: false, isActive: true,
    }));
    const first = created(await createSetupRecord(org.actor, "hrm-pipeline-stages", {
      templateId, position: 0, key: "applied", name: "Applied", kind: "screening",
    }));
    const second = created(await createSetupRecord(org.actor, "hrm-pipeline-stages", {
      templateId, position: 1, key: "hired", name: "Hired", kind: "hired",
    }));
    const stages = (await db.execute<{ id: string; position: number; kind: string; is_terminal: boolean }>(sql`
      select id, position, kind, is_terminal from hrm_pipeline_stages
       where org_id = ${org.orgId} and template_id = ${templateId} order by position`)).rows;
    assert.deepEqual(stages.map((stage) => stage.id), [first, second]);
    assert.equal(stages[1]!.is_terminal, true, "terminality derives from kind in storage");

    // An unknown kind is refused before the write, and nothing lands.
    const refused = await createSetupRecord(org.actor, "hrm-pipeline-stages", {
      templateId, position: 2, key: "signed", name: "Signed", kind: "handshake",
    });
    assert.equal(refused.status, 400, `an unknown kind must be refused: ${JSON.stringify(refused.body)}`);
    assert.match(JSON.stringify(refused.body), /kind has an invalid value/);

    // A parent funnel outside the org is refused the same way.
    const foreign = await createSetupRecord(org.actor, "hrm-pipeline-stages", {
      templateId: "00000000-0000-4000-8000-000000000099", position: 0, key: "applied", name: "Applied", kind: "screening",
    });
    assert.equal(foreign.status, 400, `a foreign parent must be refused: ${JSON.stringify(foreign.body)}`);
    assert.match(JSON.stringify(foreign.body), /parent funnel is not visible/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
