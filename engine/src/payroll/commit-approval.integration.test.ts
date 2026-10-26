import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { decideGate } from "../flows/gates.ts";
import { submitForApproval } from "../flows/submit.ts";
import { commitPayRun } from "./run-commit.ts";
import { payRunStaleness } from "./readiness.ts";
import { payRunApprovalState, recalculateStaleApprovedPayRun } from "./approval.ts";
import { seedAdoption, calculatedRun } from "./filing-test-fixtures.ts";
import {
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  grantScratchPermissions,
} from "../testing/fixtures.ts";
import { PayrollError } from "./error.ts";

async function payrollReviewActors(orgId: string) {
  const actors = await seedFlowActors(orgId);
  for (const actorId of [actors.submitterId, actors.approver1Id])
    await grantScratchPermissions(orgId, actorId, ["payroll.manage"]);
  return actors;
}

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
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates where subject_id = ${subjectId} order by created_at`,
    "objects",
  );
  assert.equal(rows.length, 1, `expected one gate, got ${rows.length}`);
  return rows[0]!.id;
}

async function runStatus(orgId: string, documentId: string): Promise<string> {
  const rows = await db.execute<{ run_status: string }>(
    sql`
    select run_status from pay_runs where org_id = ${orgId} and document_id = ${documentId}`,
    "objects",
  );
  return rows[0]!.run_status;
}

test(
  "an approved pay run commits (second-user approval releases the commit)",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const actors = await payrollReviewActors(fx.orgId);
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
        commitPayRun({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: actors.submitterId,
        }),
        /awaiting|approval|gate|not editable/i,
      );

      const decision = await decideGate({
        gateId: await gateId(input.documentId),
        decision: "approved",
        userId: actors.approver1Id,
      });
      assert.equal(decision.resumed, "approve");

      const committed = await commitPayRun({
        orgId: fx.orgId,
        documentId: input.documentId,
        actorId: actors.submitterId,
      });
      assert.ok(committed.lines > 0, "commit must materialize GL lines");
      assert.equal(await runStatus(fx.orgId, input.documentId), "committed");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "a rejected pay run stays committable-free (rejection is not a release)",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const actors = await payrollReviewActors(fx.orgId);
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
        commitPayRun({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: actors.submitterId,
        }),
        (error: unknown) => error instanceof PayrollError,
        "a rejected run must not commit",
      );
      assert.equal(await runStatus(fx.orgId, input.documentId), "calculated");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "a concurrent attempt to rewrite a recorded gate is refused while the approved payroll commits",
  { skip: !DB },
  async () => {
    // Hold the source population while commit is in flight, then attempt to
    // rewrite its retained gate. The decision must remain immutable and the
    // native commit must consume the unchanged approval evidence.
    const fx = await seedAdoption();
    try {
      const actors = await payrollReviewActors(fx.orgId);
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

      // The exact rows the commit's canonical source population will lock: the
      // run_scope query (after the approval pre-check, before the terminal
      // write) takes FOR UPDATE on the run's time entries, so holding these rows
      // parks the commit past its pre-check. The pre-check and the staleness
      // recheck are non-locking reads, so a commit observed waiting inside
      // run_scope is definitively past the pre-check.
      const snapshot = (
        await db.execute<{ snapshot: unknown }>(
          sql`
      select calculation_source_snapshot as snapshot from pay_runs
       where org_id = ${fx.orgId} and document_id = ${input.documentId}`,
          "objects",
        )
      )[0]!.snapshot as {
        claimEntryIds: string[];
      };
      assert.ok(
        snapshot.claimEntryIds.includes(entryId),
        "the fixture entry is what the commit claims",
      );
      const claimIds = snapshot.claimEntryIds;

      // Every wait below is bounded and the holder is ALWAYS released: a
      // barrier that fails must fail the test loudly, never wedge the process
      // on a dangling transaction (whose open socket keeps the runner alive
      // with no output).
      const barrierTimeout = (label: string) =>
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`barrier timeout: ${label}`)), 30000),
        );
      let releaseResolve!: () => void;
      const released = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      let lockedResolve!: () => void;
      const locked = new Promise<void>((resolve) => {
        lockedResolve = resolve;
      });
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
        (error: unknown) =>
          `holder failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      let committer: Promise<{ rejected: boolean; message: string }> | null = null;
      try {
        await Promise.race([locked, barrierTimeout("holder lock")]);
        committer = commitPayRun({
          orgId: fx.orgId,
          documentId: input.documentId,
          actorId: actors.submitterId,
        }).then(
          () => ({ rejected: false as const, message: "" }),
          (error: unknown) => ({
            rejected: true as const,
            message: String((error as Error)?.message ?? error),
          }),
        );
        // Wait until the commit is genuinely parked INSIDE the run_scope
        // statement before the rewrite attempt — otherwise the attempt lands before
        // the pre-check and the test cannot fail for the right reason. Parked
        // means: a live backend whose current statement names run_scope and is
        // in a lock wait, stable across two polls. pg_locks cannot prove this:
        // a backend blocked in a CTE waits on the transaction (relation NULL),
        // so a relation-scoped ungranted-lock count reads zero while the commit
        // is parked.
        const parkedInScope = async (): Promise<boolean> => {
          const seen = (
            await db.execute<{ n: number }>(
              sql`
          select count(*)::int as n from pg_stat_activity
           where datname = current_database()
             and pid <> pg_backend_pid()
             and state = 'active'
             and wait_event is not null
             and query ilike '%run_scope%'`,
              "objects",
            )
          )[0]!.n;
          return seen >= 1;
        };
        const parkDeadline = Date.now() + 15000;
        let parkStable = 0;
        let parked = false;
        while (Date.now() < parkDeadline) {
          if (await parkedInScope()) {
            parkStable += 1;
            if (parkStable >= 2) {
              parked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
          } else {
            parkStable = 0;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        if (!parked) {
          const live = await db.execute<{
            pid: number;
            state: string;
            wait: string | null;
            query: string;
          }>(
            sql`
          select pid, state, wait_event as "wait", left(query, 160) as query from pg_stat_activity
           where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'
           order by pid`,
            "objects",
          );
          assert.fail(
            `the commit never parked inside run_scope during the attempted approval rewrite ` +
              `(live backends: ${JSON.stringify(live)})`,
          );
        }

        await assert.rejects(
          db.execute(sql`
        update flow_gates set status='pending',decided_by=null,decided_at=null
          where org_id=${fx.orgId} and id=${decidedGateId}`),
          (error: unknown) =>
            error instanceof Error &&
            /recorded gate decision is immutable/.test(
              error.message + " " + ((error as { cause?: Error }).cause?.message ?? ""),
            ),
        );
        assert.equal(
          (
            await db.execute<{ status: string }>(
              sql`select status from flow_gates
        where org_id=${fx.orgId} and id=${decidedGateId}`,
              "objects",
            )
          )[0]?.status,
          "approved",
        );
      } finally {
        releaseResolve();
        assert.equal(
          await Promise.race([holderSettled, barrierTimeout("holder release")]),
          "holder released",
        );
      }
      const outcome = await Promise.race([committer!, barrierTimeout("commit outcome")]);
      assert.equal(outcome.rejected, false, outcome.message);
      assert.equal(await runStatus(fx.orgId, input.documentId), "committed");
      const lines = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from document_lines
       where org_id = ${fx.orgId} and document_id = ${input.documentId}`,
          "objects",
        )
      )[0]!.n;
      assert.ok(lines > 0, "the unchanged native approval permits the balanced payroll projection");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

async function documentStatus(orgId: string, documentId: string): Promise<string> {
  const rows = await db.execute<{ status: string }>(
    sql`
    select status from documents where org_id = ${orgId} and id = ${documentId}`,
    "objects",
  );
  return rows[0]!.status;
}

async function pendingGateId(subjectId: string): Promise<string> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates where subject_id = ${subjectId} and status = 'pending' order by created_at`,
    "objects",
  );
  assert.equal(rows.length, 1, `expected one pending gate, got ${rows.length}`);
  return rows[0]!.id;
}

/** A calculated run submitted and approved by the second user, as production does it. */
async function approvedPayRun(fx: Awaited<ReturnType<typeof seedAdoption>>) {
  const actors = await payrollReviewActors(fx.orgId);
  await grantScratchPermissions(fx.orgId, actors.submitterId, ["payroll.run"]);
  await seedApprovalFlow(fx.orgId, {
    subjectKind: "pay_run",
    assignees: [{ type: "user", userId: actors.approver1Id }],
    mode: "any",
  });
  const { input } = await calculatedRun({ ...fx, actorId: actors.submitterId });
  await submitForApproval("pay_run", input.documentId, actors.submitterId);
  await decideGate({
    gateId: await pendingGateId(input.documentId),
    decision: "approved",
    userId: actors.approver1Id,
  });
  assert.equal(await documentStatus(fx.orgId, input.documentId), "approved");
  return { actors, documentId: input.documentId };
}

test(
  "recalculating a stale approved run withdraws its approval, audits the reason, and requires re-approval",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { actors, documentId } = await approvedPayRun(fx);
      // An input the run reads moves after approval: the pay calendar is edited.
      await db.execute(sql`
      update pay_schedules set updated_at = now()
       where org_id = ${fx.orgId}
         and id = (select pay_schedule_id from pay_runs where org_id = ${fx.orgId} and document_id = ${documentId})`);
      const stale = await payRunStaleness(fx.orgId, documentId);
      assert.equal(stale.stale, true);
      assert.ok(
        stale.reasons.includes("schedule"),
        `expected a schedule reason, got ${stale.reasons.join(", ")}`,
      );

      const recalculated = await recalculateStaleApprovedPayRun({
        orgId: fx.orgId,
        documentId,
        actorId: actors.submitterId,
      });
      assert.ok(recalculated.reasons.includes("schedule"));
      assert.deepEqual(recalculated.calculation.errors, []);

      const after = await payRunApprovalState(fx.orgId, documentId);
      assert.equal(
        after.documentStatus,
        "draft",
        "the approval is withdrawn: the document is a draft again",
      );
      assert.equal(after.submitted, false, "the withdrawal clears the submission");
      assert.equal(after.released, false, "a withdrawn approval releases nothing");
      assert.equal(
        (await payRunStaleness(fx.orgId, documentId)).stale,
        false,
        "the recalculation is current",
      );

      const audit = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from audit_log
       where org_id = ${fx.orgId} and table_name = 'documents' and row_id = ${documentId}
         and action = 'update' and changes::text like ${"%Inputs changed since approval%"}`,
          "objects",
        )
      )[0]!.n;
      assert.equal(audit, 1, "the withdrawal records the stale inputs as its audited reason");

      await assert.rejects(
        commitPayRun({ orgId: fx.orgId, documentId, actorId: actors.submitterId }),
        /not been submitted|awaiting|approval/i,
        "commit is refused until the recalculated run is approved again",
      );

      const resubmission = await submitForApproval("pay_run", documentId, actors.submitterId);
      assert.equal(
        resubmission.gated,
        true,
        "the recalculated run is routed through the approval Flow again",
      );
      await decideGate({
        gateId: await pendingGateId(documentId),
        decision: "approved",
        userId: actors.approver1Id,
      });
      const committed = await commitPayRun({
        orgId: fx.orgId,
        documentId,
        actorId: actors.submitterId,
      });
      assert.ok(committed.lines > 0, "the re-approved run commits its GL projection");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "recalculating an approved run whose inputs have not changed is refused and keeps the approval",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { actors, documentId } = await approvedPayRun(fx);
      await assert.rejects(
        recalculateStaleApprovedPayRun({
          orgId: fx.orgId,
          documentId,
          actorId: actors.submitterId,
        }),
        /nothing to recalculate/,
      );
      assert.equal(
        await documentStatus(fx.orgId, documentId),
        "approved",
        "a refused recalculation keeps the approval",
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test("a posting-account change does not stale an approved run", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const { actors, documentId } = await approvedPayRun(fx);
    // A control-account mapping is saved: the org row and its audit evidence move,
    // but no calculated amount does.
    await db.execute(sql`update orgs set updated_at = now() where id = ${fx.orgId}`);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${fx.orgId}, 'orgs', ${fx.orgId}, 'update',
              ${JSON.stringify({ controlAccounts: [{}, { laborClearing: "posting-account" }] })}::jsonb,
              ${actors.submitterId})`);
    const staleness = await payRunStaleness(fx.orgId, documentId);
    assert.equal(
      staleness.stale,
      false,
      `a posting-only change must not stale the run (${staleness.reasons.join(", ")})`,
    );
    const approval = await payRunApprovalState(fx.orgId, documentId);
    assert.equal(approval.released, true, "the approval still releases the run");
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});

test(
  "an organization settings write the audit trail does not cover stales a calculated run",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { documentId } = await approvedPayRun(fx);
      await db.execute(sql`update orgs set updated_at = now() where id = ${fx.orgId}`);
      const staleness = await payRunStaleness(fx.orgId, documentId);
      assert.equal(staleness.stale, true);
      assert.ok(
        staleness.reasons.includes("settings"),
        `expected a settings reason, got ${staleness.reasons.join(", ")}`,
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "payroll calculation authority alone cannot withdraw an approved run",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { actors, documentId } = await approvedPayRun(fx);
      await db.execute(sql`insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${fx.orgId}, ${actors.outsiderId}, 'payroll.run', 'grant')`);
      await db.execute(sql`update pay_schedules set updated_at = now() where org_id = ${fx.orgId}`);
      await assert.rejects(
        recalculateStaleApprovedPayRun({
          orgId: fx.orgId,
          documentId,
          actorId: actors.outsiderId,
        }),
        /missing permission: payroll.manage/,
      );
      assert.equal(await documentStatus(fx.orgId, documentId), "approved");
      assert.equal((await payRunApprovalState(fx.orgId, documentId)).released, true);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "an approved run outside the actor's entity scope cannot be recalculated through an unrestricted input",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { actors, documentId } = await approvedPayRun(fx);
      await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id = ${fx.orgId} and id in (
        select role_id from role_assignments where org_id = ${fx.orgId} and user_id = ${actors.submitterId})`);
      for (const allowedSubsidiaryIds of [undefined, null]) {
        await assert.rejects(
          recalculateStaleApprovedPayRun({
            orgId: fx.orgId,
            documentId,
            actorId: actors.submitterId,
            allowedSubsidiaryIds,
          }),
          /pay run not found/,
        );
      }
      assert.equal(await documentStatus(fx.orgId, documentId), "approved");
      assert.equal((await payRunApprovalState(fx.orgId, documentId)).released, true);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);
