import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { decideGate } from "./flows/gates.ts";
import { submitForApproval } from "./flows/submit.ts";
import { commitPayRun } from "./payroll-run.ts";
import { seedAdoption, calculatedRun } from "./payroll-filing-test-fixtures.ts";
import { dropScratchOrg, seedApprovalFlow, seedFlowActors } from "./test-fixtures.ts";
import { PayrollError } from "./payroll-error.ts";

/**
 * A pay run behind an approval policy must still be committable after the
 * second user approves it.
 *
 * The release moves the document draft → approved, and commit explicitly
 * allows both ("both are committable") — but the document-line storage freeze
 * permits line writes only in draft, so commit's delete+insert of the GL
 * projection dies on the approved document with "lines are immutable outside
 * draft status". No tenant with a pay_run approval flow can finish a payroll.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function gateId(subjectId: string): Promise<string> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from flow_gates where subject_id = ${subjectId} order by created_at`));
  assert.equal(rows.rows.length, 1, `expected one gate, got ${rows.rows.length}`);
  return rows.rows[0]!.id;
}

async function runStatus(orgId: string, documentId: string): Promise<string> {
  const rows = (await db.execute<{ run_status: string }>(sql`
    select run_status from pay_runs where org_id = ${orgId} and document_id = ${documentId}`));
  return rows.rows[0]!.run_status;
}

test("an approved pay run commits (second-user approval releases the commit)", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const actors = await seedFlowActors(fx.orgId);
    await seedApprovalFlow(fx.orgId, {
      subjectKind: "pay_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    // The submitter calculates; the approver decides. Same split as production.
    const submitted = { ...fx, actorId: actors.submitterId };
    const { input } = await calculatedRun(submitted);
    const submission = await submitForApproval("pay_run", input.documentId, actors.submitterId);
    assert.equal(submission.gated, true, "submit must park the run behind a gate");

    // Money must not move pre-approval: commit fails closed while gated
    // (pending_approval is neither committable state).
    await assert.rejects(
      commitPayRun({ orgId: fx.orgId, documentId: input.documentId, actorId: actors.submitterId }),
      /awaiting|approval|gate|not editable/i,
    );

    const decision = await decideGate({
      gateId: await gateId(input.documentId),
      decision: "approved",
      userId: actors.approver1Id,
    });
    assert.equal(decision.resumed, "approve");

    const committed = await commitPayRun({
      orgId: fx.orgId, documentId: input.documentId, actorId: actors.submitterId,
    });
    assert.ok(committed.lines > 0, "commit must materialize GL lines");
    assert.equal(await runStatus(fx.orgId, input.documentId), "committed");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test("a rejected pay run stays committable-free (rejection is not a release)", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const actors = await seedFlowActors(fx.orgId);
    await seedApprovalFlow(fx.orgId, {
      subjectKind: "pay_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const submitted = { ...fx, actorId: actors.submitterId };
    const { input } = await calculatedRun(submitted);
    await submitForApproval("pay_run", input.documentId, actors.submitterId);
    await decideGate({
      gateId: await gateId(input.documentId),
      decision: "rejected",
      userId: actors.approver1Id,
      comment: "wrong period",
    });
    await assert.rejects(
      commitPayRun({ orgId: fx.orgId, documentId: input.documentId, actorId: actors.submitterId }),
      (error: unknown) => error instanceof PayrollError,
      "a rejected run must not commit",
    );
    assert.equal(await runStatus(fx.orgId, input.documentId), "calculated");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
