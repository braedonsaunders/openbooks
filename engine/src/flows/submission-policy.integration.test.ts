import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withBypassContext } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedDraftDocument,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { submitAndReleaseIfUngated, withdrawDocumentSubmission } from "./submit.ts";
import { decideGate } from "./gates.ts";
import { completedGateDecisionPolicy } from "./approval-decision-policy.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "zero-gate submission releases the native document and retains immutable tenant routing evidence",
  DB,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      const result = await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      assert.equal(result.autoApproved, true);
      const receipt = (
        await db.execute<{
          id: string;
          actor_id: string;
          policy: { kind: string; runIds: string[] };
          graphs: unknown[];
        }>(
          sql`select id,actor_id,policy,graphs from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
          "objects",
        )
      )[0];
      assert.ok(receipt);
      assert.equal(receipt.actor_id, actors.submitterId);
      assert.deepEqual(receipt.policy.runIds, []);
      assert.equal(receipt.policy.kind, "ungated");
      assert.deepEqual(receipt.graphs, []);
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          db.execute(
            sql`update flow_submissions set context='{}'::jsonb where org_id=${org.orgId} and id=${receipt.id}`,
          ),
        ),
        (error: unknown) =>
          error instanceof Error &&
          /immutable/.test(
            error.message + " " + ((error as { cause?: Error }).cause?.message ?? ""),
          ),
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${id}`,
            "objects",
          )
        )[0]?.status,
        "approved",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "withdrawal revokes a partially approved submission even when one of its runs already completed",
  DB,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      for (let i = 0; i < 2; i++)
        await seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      const gates = await db.execute<{ id: string; run_id: string }>(
        sql`select id,run_id from flow_gates where org_id=${org.orgId} and subject_id=${id} order by id`,
        "objects",
      );
      assert.equal(gates.length, 2);
      await decideGate({
        gateId: gates[0]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      await withdrawDocumentSubmission({
        orgId: org.orgId,
        documentId: id,
        actorId: actors.submitterId,
        actorIsApprover: false,
        reason: "Correct the document before resubmission",
      });
      const proof = await withOrgTransaction(org.orgId, () =>
        completedGateDecisionPolicy(db, {
          orgId: org.orgId,
          subjectKind: "vendor_bill",
          subjectId: id,
          actorId: actors.approver1Id,
          outcome: "approved",
          approvalRunId: gates[0]!.run_id,
        }),
      );
      assert.equal(proof, null, "completed sibling evidence cannot release a withdrawn submission");
      await assert.rejects(
        decideGate({
          gateId: gates[1]!.id,
          decision: "approved",
          userId: actors.approver1Id,
        }),
        /resolved/,
      );
      await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      const receipts = await db.execute<{ id: string }>(
        sql`select id from flow_submissions where org_id=${org.orgId} and subject_id=${id}`,
        "objects",
      );
      assert.equal(receipts.length, 2, "resubmission appends policy evidence");
      const oldProof = await withOrgTransaction(org.orgId, () =>
        completedGateDecisionPolicy(db, {
          orgId: org.orgId,
          subjectKind: "vendor_bill",
          subjectId: id,
          actorId: actors.approver1Id,
          outcome: "approved",
          approvalRunId: gates[0]!.run_id,
        }),
      );
      assert.equal(oldProof, null, "superseded run cannot decide the new submission");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "an administrator who is not a configured approver cannot decide a submitted bill",
  DB,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      const gate = (
        await db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending'`,
          "objects",
        )
      )[0];
      assert.ok(gate);
      await assert.rejects(
        decideGate({
          gateId: gate.id,
          decision: "approved",
          userId: actors.adminId,
        }),
        /not an approver/,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${id}`,
            "objects",
          )
        )[0]?.status,
        "pending_approval",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "terminal posting branches wait for every governing Flow and retain exactly one native journal",
  DB,
  async () => {
    const { installEngineSeams } = await import("../composition/install.ts");
    const { grantScratchPermissions } = await import("../testing/fixtures.ts");
    const { randomUUID } = await import("node:crypto");
    installEngineSeams();
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["ap.post"]);
      for (let index = 0; index < 2; index++) {
        const { flowId, gateNodeId } = await seedApprovalFlow(org.orgId, {
          subjectKind: "vendor_bill",
          assignees: [{ type: "user", userId: actors.approver1Id }],
          mode: "all",
        });
        const node = {
          id: "post",
          position: { x: 440, y: 0 },
          data: { kind: "action", action: { action: "post_document" } },
        };
        const edge = {
          id: "approve-post",
          source: gateNodeId,
          target: "post",
          sourceHandle: "approve",
        };
        await db.execute(
          sql`update flows set graph=jsonb_set(jsonb_set(graph,'{nodes}',(graph->'nodes')||${JSON.stringify([node])}::jsonb),'{edges}',(graph->'edges')||${JSON.stringify([edge])}::jsonb) where org_id=${org.orgId} and id=${flowId}`,
        );
      }
      async function bill() {
        const id = await seedDraftDocument(org.orgId, {
          kind: "vendor_bill",
          createdBy: actors.submitterId,
        });
        await db.execute(
          sql`update documents set party_id=${org.vendorId},subsidiary_id=${org.subsidiaryId},document_date=${org.date},posting_date=${org.date},subtotal='100',tax_total='0',total='100' where org_id=${org.orgId} and id=${id}`,
        );
        await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,account_id,quantity,unit_price,amount,tax_amount)
        values(${randomUUID()},${org.orgId},${id},1,${org.accounts.cogs},'1','100','100','0')`);
        await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
        const gates = await db.execute<{ id: string; run_id: string }>(
          sql`select id,run_id from flow_gates where org_id=${org.orgId} and subject_id=${id} and status='pending' order by id`,
          "objects",
        );
        assert.equal(gates.length, 2);
        return { id, gates };
      }
      const first = await bill();
      const partial = await decideGate({
        gateId: first.gates[0]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      assert.equal(partial.runStatus, "waiting");
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${first.id}`,
            "objects",
          )
        )[0]?.status,
        "pending_approval",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${first.id}`,
            "objects",
          )
        ).length,
        0,
      );
      await decideGate({
        gateId: first.gates[1]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${first.id}`,
            "objects",
          )
        )[0]?.status,
        "posted",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${first.id}`,
            "objects",
          )
        ).length,
        1,
      );
      const runs = await db.execute<{ status: string; deferred: boolean }>(
        sql`select status,context ? 'approvalContinuation' as deferred from flow_runs where org_id=${org.orgId} and subject_id=${first.id}`,
        "objects",
      );
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === "completed" && !run.deferred));
      const held = await bill();
      await decideGate({
        gateId: held.gates[0]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      await db.execute(
        sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.approver1Id},'ap.post','deny') on conflict(user_id,permission) do update set effect='deny'`,
      );
      await assert.rejects(
        decideGate({ gateId: held.gates[1]!.id, decision: "approved", userId: actors.approver1Id }),
        /posting|permission|ap.post|branch/i,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from flow_gates where org_id=${org.orgId} and id=${held.gates[1]!.id}`,
            "objects",
          )
        )[0]?.status,
        "pending",
        "a refused posting leaves the final gate undecided",
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${held.id}`,
            "objects",
          )
        )[0]?.status,
        "pending_approval",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${held.id}`,
            "objects",
          )
        ).length,
        0,
        "posting and release roll back together",
      );
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["ap.post"]);
      await decideGate({
        gateId: held.gates[1]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${held.id}`,
            "objects",
          )
        ).length,
        1,
        "retry retains one journal across both native branches",
      );
      const rejected = await bill();
      await decideGate({
        gateId: rejected.gates[0]!.id,
        decision: "approved",
        userId: actors.approver1Id,
      });
      await decideGate({
        gateId: rejected.gates[1]!.id,
        decision: "rejected",
        userId: actors.approver1Id,
        comment: "The second policy refused this purchase.",
      });
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${org.orgId} and id=${rejected.id}`,
            "objects",
          )
        )[0]?.status,
        "draft",
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from journal_entries where org_id=${org.orgId} and source_document_id=${rejected.id}`,
            "objects",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from flow_runs where org_id=${org.orgId} and id=${rejected.gates[0]!.run_id}`,
            "objects",
          )
        )[0]?.status,
        "cancelled",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "submitted record facts and gate requirements remain immutable while decisions complete",
  DB,
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "vendor_bill",
        assignees: [{ type: "user", userId: actors.approver1Id }],
        mode: "all",
      });
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
      });
      await submitAndReleaseIfUngated("vendor_bill", id, actors.submitterId);
      const gate = (
        await db.execute<{ id: string; run_id: string }>(
          sql`
        select id,run_id from flow_gates where org_id=${org.orgId} and subject_id=${id}
      `,
          "objects",
        )
      )[0]!;
      const immutable = (error: unknown) =>
        error instanceof Error &&
        /immutable|retains its submitted policy/.test(
          error.message + " " + ((error as { cause?: Error }).cause?.message ?? ""),
        );
      for (const mutation of [
        sql`update flow_runs set context=jsonb_set(context,'{submissionPolicy,graph}', '{"nodes":[],"edges":[]}'::jsonb)
          where org_id=${org.orgId} and id=${gate.run_id}`,
        sql`update flow_runs set context=context || '{"approvalFingerprint":"changed"}'::jsonb
          where org_id=${org.orgId} and id=${gate.run_id}`,
        sql`update flow_gates set quorum='any' where org_id=${org.orgId} and id=${gate.id}`,
        sql`update flow_gates set signature_required=not signature_required where org_id=${org.orgId} and id=${gate.id}`,
      ]) {
        await assert.rejects(
          withOrgTransaction(org.orgId, () => db.execute(mutation)),
          immutable,
        );
      }
      await decideGate({ gateId: gate.id, decision: "approved", userId: actors.approver1Id });
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          db.execute(sql`
        update flow_gates set decided_by=${actors.submitterId}
          where org_id=${org.orgId} and id=${gate.id}
      `),
        ),
        immutable,
      );
      const record = (
        await db.execute<{ status: string }>(
          sql`
        select status from documents where org_id=${org.orgId} and id=${id}
      `,
          "objects",
        )
      )[0];
      assert.equal(record?.status, "approved");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a switched-tenant submission retains its active native home identity without changing tenant scope",
  DB,
  async () => {
    const home = await createScratchOrg(),
      target = await createScratchOrg();
    try {
      const actor = (await seedFlowActors(home.orgId)).adminId;
      await withBypassContext(() =>
        db.execute(
          sql`update users set is_super_admin=true where org_id=${home.orgId} and id=${actor}`,
        ),
      );
      const targetActor = (await seedFlowActors(target.orgId)).submitterId;
      const docId = await seedDraftDocument(target.orgId, {
        kind: "vendor_bill",
        createdBy: targetActor,
      });
      await withOrgTransaction(target.orgId, async () => {
        const result = await submitAndReleaseIfUngated("vendor_bill", docId, actor);
        assert.equal(result.autoApproved, true);
        const receipt = (
          await db.execute<{ actor_id: string; home: string; scope: string }>(
            sql`
        select actor_id,context->>'submissionActorHomeOrgId' as home,current_setting('app.current_org') as scope
          from flow_submissions where org_id=${target.orgId} and subject_id=${docId}
      `,
            "objects",
          )
        )[0]!;
        assert.equal(receipt.actor_id, actor);
        assert.equal(receipt.home, home.orgId);
        assert.equal(receipt.scope, target.orgId);
      });
      await withBypassContext(() =>
        db.execute(
          sql`update users set is_active=false where org_id=${home.orgId} and id=${actor}`,
        ),
      );
      const second = await seedDraftDocument(target.orgId, {
        kind: "vendor_bill",
        createdBy: targetActor,
      });
      await assert.rejects(submitAndReleaseIfUngated("vendor_bill", second, actor));
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_submissions where org_id=${target.orgId} and subject_id=${second}`,
            "objects",
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await db.execute<{ status: string }>(
            sql`select status from documents where org_id=${target.orgId} and id=${second}`,
            "objects",
          )
        )[0]?.status,
        "draft",
      );
    } finally {
      await dropScratchOrg(target.orgId);
      await dropScratchOrg(home.orgId);
    }
  },
);
