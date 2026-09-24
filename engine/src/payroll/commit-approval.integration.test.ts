import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { decideGate } from "../flows/gates.ts";
import { submitForApproval } from "../flows/submit.ts";
import { commitPayRun } from "./run-commit.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import { dropScratchOrg, seedApprovalFlow, seedFlowActors } from "../testing/fixtures.ts";
import { PayrollError } from "./error.ts";

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

test("an approval withdrawn mid-commit is refused by name at the terminal write", { skip: !DB }, async () => {
  // The outside-the-transaction defect: the approval check ran on the default
  // executor BEFORE the commit's writes, so an approval withdrawn between the
  // pre-check and the terminal status flip committed without a live approval.
  // The gate is now asked inside the commit transaction AND re-asked beside
  // the terminal staleness recheck. Barrier: the commit is stalled on the
  // time-entry claim (past the pre-check, before the terminal write) while
  // the approval is reopened; the commit must then refuse, not ride under a
  // release answer that was true when it was taken.
  const fx = await seedAdoption();
  try {
    const actors = await seedFlowActors(fx.orgId);
    await seedApprovalFlow(fx.orgId, {
      subjectKind: "pay_run",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
    });
    const submitted = { ...fx, actorId: actors.submitterId };
    const { input, entryId } = await calculatedRun(submitted);
    await submitForApproval("pay_run", input.documentId, actors.submitterId);
    const decidedGateId = await gateId(input.documentId);
    await decideGate({ gateId: decidedGateId, decision: "approved", userId: actors.approver1Id });

    // The exact rows the commit's claim will update: stalling on them parks
    // the commit between its approval pre-check and its terminal write.
    const snapshot = (await db.execute<{ snapshot: unknown }>(sql`
      select calculation_source_snapshot as snapshot from pay_runs
       where org_id = ${fx.orgId} and document_id = ${input.documentId}`)).rows[0]!.snapshot as {
      claimEntryIds: string[];
    };
    assert.ok(snapshot.claimEntryIds.includes(entryId), "the fixture entry is what the commit claims");
    const claimIds = snapshot.claimEntryIds;

    // Every wait below is bounded and the holder is ALWAYS released: a
    // barrier that fails must fail the test loudly, never wedge the process
    // on a dangling transaction (whose open socket keeps the runner alive
    // with no output).
    const barrierTimeout = (label: string) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`barrier timeout: ${label}`)), 30000));
    let releaseResolve!: () => void;
    const released = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => { lockedResolve = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`
        select id from time_entries
         where org_id = ${fx.orgId} and id = any(${`{${claimIds.join(",")}}`}::uuid[])
         for update`);
      lockedResolve();
      await released;
    });
    const holderSettled = holder.then(
      () => "holder released",
      (error: unknown) => `holder failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    let committer: Promise<{ rejected: boolean; message: string }> | null = null;
    try {
      await Promise.race([locked, barrierTimeout("holder lock")]);
      committer = commitPayRun({
        orgId: fx.orgId, documentId: input.documentId, actorId: actors.submitterId,
      }).then(
        () => ({ rejected: false as const, message: "" }),
        (error: unknown) => ({ rejected: true as const, message: String((error as Error)?.message ?? error) }),
      );
      // Let the commit reach the claim and block on the held rows; then check
      // it is genuinely parked there before withdrawing — otherwise the
      // withdrawal lands before the pre-check and the test cannot fail for the
      // right reason.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const parked = (await db.execute<{ pid: number; wait: string | null; query: string }>(sql`
        select pid, wait_event as "wait", left(query, 120) as query from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
         order by pid`));
      const waiters = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_locks
         where relation = 'time_entries'::regclass and not granted`)).rows[0]!.n;
      assert.ok(
        waiters >= 1,
        `the commit must be parked on the time-entry claim before the approval is withdrawn `
        + `(ungranted time_entries locks: ${waiters}; live backends: ${JSON.stringify(parked.rows)})`,
      );

      // The approval is withdrawn: the decided gate reopens.
      await db.execute(sql`
        update flow_gates set status = 'pending', decided_by = null, decided_at = null
         where org_id = ${fx.orgId} and id = ${decidedGateId}`);
    } finally {
      releaseResolve();
      assert.equal(
        await Promise.race([holderSettled, barrierTimeout("holder release")]),
        "holder released",
      );
    }
    const outcome = await Promise.race([committer!, barrierTimeout("commit outcome")]);
    assert.equal(outcome.rejected, true, "a commit racing a withdrawn approval must refuse");
    assert.match(outcome.message, /awaiting 1 approval/);
    assert.equal(await runStatus(fx.orgId, input.documentId), "calculated");
    const lines = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from document_lines
       where org_id = ${fx.orgId} and document_id = ${input.documentId}`)).rows[0]!.n;
    assert.equal(lines, 0, "a refused commit materializes no GL projection");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
