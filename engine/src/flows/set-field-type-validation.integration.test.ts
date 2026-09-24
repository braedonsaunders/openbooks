import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import type { AutomationPlan } from "@openbooks/forms-core";
import { db, schema } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { executeFlowPlan } from "./execute.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";

/**
 * E27: flow set_field resolved its DefaultValueExpression and persisted the
 * output with no type check against the field's declared type — a string
 * landed in a date column (or failed at the driver with storage internals).
 * set_field must refuse a value that cannot inhabit the field's type before
 * anything is written, naming the field and the expected shape.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const adapter = createDocumentsFlowAdapter("vendor_bill");

async function withOrgFixture(fn: (org: ScratchOrg, actors: FlowActors) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn(org, actors);
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

function setFieldPlan(field: string, value: unknown): AutomationPlan {
  return {
    actions: [],
    actionNodes: [
      {
        nodeId: "set_1",
        action: { action: "set_field", field, value: { kind: "literal", value } },
      },
    ],
    gates: [],
  };
}

async function createRun(orgId: string, submitterId: string): Promise<{ runId: string; flowId: string; subjectId: string }> {
  const flowId = randomUUID();
  const subjectId = await seedDraftDocument(orgId, { kind: "vendor_bill", createdBy: submitterId });
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph)
    values (${flowId}, ${orgId}, ${"Set-field type probe"}, 'vendor_bill', true, '{"nodes":[],"edges":[]}'::jsonb)`);
  const [run] = await db
    .insert(schema.flowRuns)
    .values({
      orgId,
      flowId,
      subjectKind: "vendor_bill",
      subjectId,
      trigger: "manual",
      status: "running",
      context: {},
    })
    .returning({ id: schema.flowRuns.id });
  return { runId: run!.id, flowId, subjectId };
}

async function docFields(subjectId: string): Promise<{ dueDate: unknown; memo: unknown }> {
  const rows = await db.execute<{ due_date: unknown; memo: unknown }>(sql`
    select due_date, memo from documents where id = ${subjectId}`);
  return { dueDate: rows.rows[0]?.due_date, memo: rows.rows[0]?.memo };
}

test("set_field refuses a wrongly-typed value and writes nothing", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const before = await docFields(run.subjectId);
    const res = await executeFlowPlan(
      { orgId: org.orgId },
      adapter,
      {
        flow: { id: run.flowId, name: "Type probe", subjectKind: "vendor_bill", graph: {} },
        runId: run.runId,
        subjectId: run.subjectId,
        plan: setFieldPlan("dueDate", "not-a-date"),
        evalCtx: { values: {}, rows: {} },
      },
    );
    assert.equal(res.completed.length, 0, "the mistyped write must not complete");
    assert.equal(res.failed.length, 1);
    assert.match(res.failed[0]!, /dueDate/, "the refusal must name the field");
    assert.match(res.failed[0]!, /YYYY-MM-DD/, "the refusal must name the expected shape");
    assert.deepEqual(await docFields(run.subjectId), before, "nothing may be persisted");
  });
});

test("set_field still persists a correctly-typed value", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const res = await executeFlowPlan(
      { orgId: org.orgId },
      adapter,
      {
        flow: { id: run.flowId, name: "Type probe", subjectKind: "vendor_bill", graph: {} },
        runId: run.runId,
        subjectId: run.subjectId,
        plan: setFieldPlan("dueDate", "2026-05-01"),
        evalCtx: { values: {}, rows: {} },
      },
    );
    assert.equal(res.failed.length, 0);
    assert.equal(res.completed.length, 1);
    const stored = (await docFields(run.subjectId)).dueDate;
    const day = stored instanceof Date ? stored.toISOString().slice(0, 10) : String(stored);
    assert.equal(day, "2026-05-01");
  });
});

test("set_field refuses a number for a text field", { skip: !DB }, async () => {
  await withOrgFixture(async (org, actors) => {
    const run = await createRun(org.orgId, actors.submitterId);
    const res = await executeFlowPlan(
      { orgId: org.orgId },
      adapter,
      {
        flow: { id: run.flowId, name: "Type probe", subjectKind: "vendor_bill", graph: {} },
        runId: run.runId,
        subjectId: run.subjectId,
        plan: setFieldPlan("memo", 42),
        evalCtx: { values: {}, rows: {} },
      },
    );
    assert.equal(res.completed.length, 0);
    assert.match(res.failed[0]!, /memo/);
  });
});
