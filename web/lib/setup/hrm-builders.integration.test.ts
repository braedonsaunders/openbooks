import assert from "node:assert/strict";
import test from "node:test";

/**
 * The builder ordering commands against a real database. Positions are
 * unique per parent and the constraints are not deferrable, so a swap made
 * of row updates collides with itself; the commands must reorder (and move
 * a question across sections) in one transaction, refuse an order built on
 * a stale outline without writing, and switch the default pipeline without
 * ever holding two.
 */

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createSetupRecord } = await import("./write.ts");
const { makeDefaultPipeline, orderPipelineStages, orderReviewTemplateOutline } = await import("./hrm-builders.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedOrg() {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  await db.execute(sql`
    update orgs set settings = settings || '{"features": {"hrm": true}}'::jsonb
     where id = ${org.orgId}`);
  return { orgId: org.orgId, actor: { orgId: org.orgId, id: actorId, permissions: [] as string[] } };
}

type Actor = Awaited<ReturnType<typeof seedOrg>>["actor"];

async function create(actor: Actor, entity: string, body: Record<string, unknown>): Promise<string> {
  const res = await createSetupRecord(actor, entity, body);
  assert.equal(res.status, 200, `create ${entity} refused: ${JSON.stringify(res.body)}`);
  return String((res.body as { id?: string }).id);
}

test("the review outline reorders sections and moves a question across sections atomically", { skip: !DB }, async () => {
  const { orgId, actor } = await seedOrg();
  try {
    const templateId = await create(actor, "hrm-review-templates", { name: "Annual", ratingScaleMin: 1, ratingScaleMax: 5, ratingScaleLabels: [] });
    const a = await create(actor, "hrm-review-template-sections", { templateId, position: 0, title: "A", kind: "competency" });
    const b = await create(actor, "hrm-review-template-sections", { templateId, position: 1, title: "B", kind: "free_text" });
    const q1 = await create(actor, "hrm-review-template-questions", { sectionId: a, position: 0, prompt: "One", answerKind: "rating", required: true });
    const q2 = await create(actor, "hrm-review-template-questions", { sectionId: a, position: 1, prompt: "Two", answerKind: "text", required: false });
    const q3 = await create(actor, "hrm-review-template-questions", { sectionId: b, position: 0, prompt: "Three", answerKind: "text", required: false });

    // Swap the sections and move q1 to the end of B: every position collides mid-flight.
    const ok = await orderReviewTemplateOutline(actor, templateId, {
      sections: [{ id: b, questionIds: [q3, q1] }, { id: a, questionIds: [q2] }],
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const sections = (await db.execute<{ id: string; position: number }>(sql`
      select id, position from hrm_review_template_sections where org_id = ${orgId} order by position`)).rows;
    assert.deepEqual(sections.map((row) => [row.id, row.position]), [[b, 0], [a, 1]]);
    const questions = (await db.execute<{ id: string; sectionId: string; position: number }>(sql`
      select id, section_id as "sectionId", position from hrm_review_template_questions
       where org_id = ${orgId} order by section_id, position`)).rows;
    assert.deepEqual(
      new Set(questions.map((row) => `${row.id}@${row.sectionId}#${row.position}`)),
      new Set([`${q3}@${b}#0`, `${q1}@${b}#1`, `${q2}@${a}#0`]),
    );
    const audited = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${orgId} and table_name = 'hrm_review_template_questions' and row_id = ${q1} and action = 'update'`)).rows[0]!.n;
    assert.equal(audited, 1, "the cross-section move is audited");

    // An outline that omits a stored question is stale: refused, nothing moves.
    const stale = await orderReviewTemplateOutline(actor, templateId, {
      sections: [{ id: a, questionIds: [q2] }, { id: b, questionIds: [q3] }],
    });
    assert.equal(stale.status, 409);
    assert.equal((stale.body as { code?: string }).code, "stale");
    const after = (await db.execute<{ id: string }>(sql`
      select id from hrm_review_template_sections where org_id = ${orgId} order by position`)).rows;
    assert.deepEqual(after.map((row) => row.id), [b, a], "a refused order writes nothing");
  } finally {
    await dropScratchOrg(orgId);
  }
});

test("pipeline stages reorder in one transaction and the default switches without a second default", { skip: !DB }, async () => {
  const { orgId, actor } = await seedOrg();
  try {
    const first = await create(actor, "hrm-pipeline-templates", { name: "Campus", isDefault: true, isActive: true });
    const second = await create(actor, "hrm-pipeline-templates", { name: "Executive", isDefault: false, isActive: true });
    const applied = await create(actor, "hrm-pipeline-stages", { templateId: second, position: 0, key: "applied", name: "Applied", kind: "screening" });
    const hired = await create(actor, "hrm-pipeline-stages", { templateId: second, position: 1, key: "hired", name: "Hired", kind: "hired" });
    const panel = await create(actor, "hrm-pipeline-stages", { templateId: second, position: 2, key: "panel", name: "Panel", kind: "interview" });

    const ok = await orderPipelineStages(actor, second, { stageIds: [applied, panel, hired] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const stages = (await db.execute<{ id: string }>(sql`
      select id from hrm_pipeline_stages where org_id = ${orgId} and template_id = ${second} order by position`)).rows;
    assert.deepEqual(stages.map((row) => row.id), [applied, panel, hired]);

    const foreign = await orderPipelineStages(actor, first, { stageIds: [applied, panel, hired] });
    assert.equal(foreign.status, 409, "stages of another pipeline are refused");

    const switched = await makeDefaultPipeline(actor, second);
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    const defaults = (await db.execute<{ id: string }>(sql`
      select id from hrm_pipeline_templates where org_id = ${orgId} and is_default`)).rows;
    assert.deepEqual(defaults.map((row) => row.id), [second]);

    await db.execute(sql`update hrm_pipeline_templates set is_active = false where id = ${first}`);
    const inactive = await makeDefaultPipeline(actor, first);
    assert.equal(inactive.status, 400, "an inactive pipeline cannot become the default");
  } finally {
    await dropScratchOrg(orgId);
  }
});
