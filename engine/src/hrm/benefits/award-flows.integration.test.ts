import {
  seedPayrollBenefitProgram,
  seedBenefitRoleActors,
} from "../../testing/benefit-fixtures.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction, withBypass } from "../../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../../testing/fixtures.ts";
import {
  enableHrm,
  mkHr,
  seedEmployment,
  seedComponent,
  grantPermissions,
} from "../../testing/hrm-harness.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { decideGate } from "../../flows/gates.ts";
import { benefitAwardsFlowAdapter } from "../../flows/benefit-awards-adapter.ts";
import { activateBenefitProgram } from "./programs.ts";
import {
  createBenefitAward,
  submitBenefitAward,
  queueBenefitAward,
  getBenefitAward,
  voidBenefitAward,
  releaseBenefitAwardApproval,
  completeBenefitAwardSubmission,
} from "./awards.ts";
import { listBenefitApprovalPolicies } from "./approval-policies.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
function refusalMessage(pattern: RegExp) {
  return (error: unknown): boolean => {
    assert.match(String((error as { cause?: unknown }).cause ?? error), pattern);
    return true;
  };
}

test("Benefits native approval lifecycle", { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  let org: ScratchOrg;
  let author: string;
  let approver: string;
  let thirdActor: string;
  let employment: string;
  let program: string;
  let component: string;
  let foreignOrg: ScratchOrg | null = null;

  t.after(async () => {
    if (foreignOrg) await dropScratchOrg(foreignOrg.orgId);
    if (org) await dropScratchOrg(org.orgId);
  });

  {
    installEngineSeams();
    org = await createScratchOrg();
    await enableHrm(org.orgId);
    const actors = await seedBenefitRoleActors(org.orgId, {
      author: {
        name: "Benefits author",
        roleKey: "benefits_workflow_author",
        permissions: ["hrm.benefits.read", "hrm.benefits.manage", "payroll.manage"],
      },
      approver: {
        name: "Benefits approver",
        roleKey: "benefits_workflow_approver",
        permissions: ["hrm.benefits.read", "hrm.benefits.manage"],
      },
      submitter: {
        name: "Benefits submitter",
        roleKey: "benefits_workflow_submitter",
        permissions: ["hrm.benefits.read", "hrm.benefits.manage"],
      },
    });
    author = actors.author;
    approver = actors.approver;
    thirdActor = actors.submitter;
    employment = (await seedEmployment(org.orgId, org.subsidiaryId)).employmentId;
    component = await seedComponent(org.orgId, {
      code: "FLOW_BONUS",
      kind: "earning",
    });
    const account = (
      await db.execute<{ id: string }>(
        sql`insert into accounts (org_id,number,name,type,is_active,is_summary) values (${org.orgId},'6050','Benefits expense','expense',true,false) returning id`,
        "objects",
      )
    )[0]!.id;
    program = (
      await seedPayrollBenefitProgram(
        {
          orgId: org.orgId,
          actorId: author,
          subsidiaryId: org.subsidiaryId,
          componentId: component,
        },
        {
          code: "WORKFLOW_REWARD",
          name: "Workflow rewards",
          family: "reward",
          valuation: "pool",
          budgetAmount: "1000000.0000",
          sourceAccountIds: [account],
        },
        { employmentIds: [employment] },
      )
    ).id;
  }
  t.beforeEach(async () => {
    if (DB)
      await db.execute(
        sql`update flows set enabled=false where org_id=${org.orgId} and subject_kind='hrm_benefit_award'`,
      );
  });

  async function award(value = "100.0000") {
    return createBenefitAward({
      orgId: org.orgId,
      actorId: author,
      programId: program,
      employmentId: employment,
      periodFrom: "2026-03-01",
      value,
      currency: "CAD",
      sourceKey: randomUUID(),
    });
  }
  const trigger = {
    id: "submit",
    position: { x: 0, y: 0 },
    data: { kind: "trigger", trigger: { trigger: "on_submit" } },
  };
  function gate(id: string, userId = approver, preventSelfApproval = true) {
    return {
      id,
      position: { x: 200, y: 0 },
      data: {
        kind: "gate",
        gate: {
          title: `Benefits ${id}`,
          assignees: [{ type: "user", userId }],
          mode: "any",
          preventSelfApproval,
        },
      },
    };
  }
  async function policy(nodes: unknown[], edges: unknown[]) {
    const id = randomUUID();
    await db.execute(
      sql`insert into flows(id,org_id,name,subject_kind,enabled,graph) values (${id},${org.orgId},'Benefits reward policy','hrm_benefit_award',true,${JSON.stringify({ schemaVersion: 1, nodes, edges })}::jsonb)`,
    );
    return id;
  }
  async function singleGate(userId = approver, preventSelfApproval = true) {
    return policy(
      [trigger, gate("approve", userId, preventSelfApproval)],
      [edge("submit", "approve")],
    );
  }
  async function gates(id: string) {
    return await db.execute<{
      id: string;
      status: string;
      decided_by: string | null;
    }>(
      sql`select id,status,decided_by from flow_gates where org_id=${org.orgId} and subject_kind='hrm_benefit_award' and subject_id=${id} order by created_at,id`,
      "objects",
    );
  }
  async function pendingGate(id: string) {
    const rows = (await gates(id)).filter((g) => g.status === "pending");
    assert.equal(rows.length, 1);
    return rows[0]!;
  }
  async function read(id: string) {
    return getBenefitAward(db, org.orgId, author, id);
  }
  async function approve(id: string) {
    await decideGate({
      gateId: (await pendingGate(id)).id,
      userId: approver,
      decision: "approved",
    });
  }

  await t.test(
    "automatic completion cannot invent an original submission or replace a gated decision",
    async () => {
      const policyId = await singleGate();
      const draft = await award();
      const pending = await submit(draft.id);
      assert.ok(pending.flowRunId);
      const before = await read(draft.id),
        priorGates = await gates(draft.id);
      const history = await db.execute(
        sql`select to_jsonb(a) as snapshot from audit_log a where org_id=${org.orgId}
        and table_name='hrm_benefit_awards' and row_id=${draft.id} order by id`,
        "objects",
      );
      const complete = (runId: string, actorId = author) =>
        completeBenefitAwardSubmission({
          orgId: org.orgId,
          actorId,
          awardId: draft.id,
          runId,
          mode: "automatic",
        });
      await assert.rejects(complete(randomUUID()), /routing evidence/);
      await assert.rejects(complete(pending.flowRunId), /routing evidence/);
      await assert.rejects(
        complete(pending.flowRunId, randomUUID()),
        /permission|user|actor|scope|manage|authorized/i,
      );
      assert.deepEqual(await read(draft.id), before);
      assert.deepEqual(await gates(draft.id), priorGates);
      assert.deepEqual(
        await db.execute(
          sql`select to_jsonb(a) as snapshot from audit_log a where org_id=${org.orgId}
        and table_name='hrm_benefit_awards' and row_id=${draft.id} order by id`,
          "objects",
        ),
        history,
      );
      assert.equal(
        (
          await db.execute<{
            n: number;
          }>(
            sql`select count(*)::int as n from flow_runs where org_id=${org.orgId}
        and flow_id=${policyId} and subject_id=${draft.id}`,
            "objects",
          )
        )[0]!.n,
        1,
        "refusals do not create another run",
      );
    },
  );

  await t.test(
    "a refused reward submission rolls back before a corrected Flow releases a fresh receipt once",
    async () => {
      const flowId = await singleGate(randomUUID());
      const draft = await award("123.4500");
      await assert.rejects(submit(draft.id), /zero assignees/);
      const refused = await read(draft.id);
      assert.equal(refused.status, "draft");
      assert.equal(refused.submittedBy, null);
      assert.equal(refused.flowRunId, null);
      assert.equal((await gates(draft.id)).length, 0);
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_submissions where org_id=${org.orgId} and subject_id=${draft.id}`,
            "objects",
          )
        ).length,
        0,
      );
      await db.execute(sql`update flows set graph=${JSON.stringify({ schemaVersion: 1, nodes: [trigger], edges: [] })}::jsonb
          where org_id=${org.orgId} and id=${flowId}`);
      const ready = await submit(draft.id);
      assert.equal(ready.status, "approved");
      assert.equal(ready.approvedBy, null);
      assert.equal(ready.decisionSnapshot?.mode, "ungated");
      const evidence = async () => ({
        receipts: await db.execute(
          sql`select id,policy,graphs from flow_submissions where org_id=${org.orgId} and subject_id=${draft.id}`,
          "objects",
        ),
        events: await db.execute(
          sql`select id from hrm_benefit_award_events where org_id=${org.orgId} and award_id=${draft.id}`,
          "objects",
        ),
      });
      const once = await evidence();
      assert.equal(once.receipts.length, 1);
      assert.deepEqual(await submit(draft.id), ready);
      assert.deepEqual(await evidence(), once);
    },
  );

  function submit(awardId: string, actorId = author) {
    return submitBenefitAward({ orgId: org.orgId, actorId, awardId });
  }
  function queue(awardId: string) {
    return queueBenefitAward({ orgId: org.orgId, actorId: author, awardId });
  }
  function voidReward(awardId: string, reason: string) {
    return voidBenefitAward({
      orgId: org.orgId,
      actorId: author,
      awardId,
      reason,
    });
  }

  function edge(source: string, target: string, sourceHandle = "next") {
    return {
      id: `${source}-${sourceHandle}-${target}`,
      source,
      target,
      sourceHandle,
    };
  }
  function rejectWrite(statement: SQL, pattern: RegExp) {
    return assert.rejects(
      withOrgTransaction(org.orgId, () => db.execute(statement)),
      refusalMessage(pattern),
    );
  }
  await t.test(
    "no configured Flow releases the reward with an explicit empty policy receipt",
    async () => {
      const draft = await award();
      const ready = await submit(draft.id);
      assert.equal(ready.status, "approved");
      assert.equal(ready.approvedBy, null);
      assert.equal(ready.decisionSnapshot?.mode, "ungated");
      const receipt = (
        await db.execute<{ policy: { flowIds: string[]; runIds: string[] } }>(
          sql`
          select policy from flow_submissions where org_id=${org.orgId} and subject_id=${draft.id}
        `,
          "objects",
        )
      )[0];
      assert.deepEqual(receipt?.policy.flowIds, []);
      assert.deepEqual(receipt?.policy.runIds, []);
    },
  );
  await t.test(
    "an enabled zero-gate Flow releases a payroll-ready reward with its policy snapshot and replay safety",
    async () => {
      const policyId = await policy([trigger], []);
      const draft = await award();
      const ready = await submit(draft.id);
      assert.equal(ready.status, "approved");
      assert.equal(ready.approvedBy, null);
      assert.equal(ready.decisionSnapshot?.mode, "ungated");
      assert.equal((await gates(draft.id)).length, 0);
      assert.equal(ready.flowRunId, null);
      const receipt = (
        await db.execute<{ graphs: Array<{ id: string }>; policy: { runIds: string[] } }>(
          sql`
          select graphs,policy from flow_submissions where org_id=${org.orgId} and id=${ready.decisionSnapshot?.submissionId}
        `,
          "objects",
        )
      )[0]!;
      assert.equal(receipt.graphs[0]?.id, policyId);
      assert.equal(receipt.policy.runIds.length, 1);
      assert.deepEqual(await submit(draft.id), ready);
      assert.equal(
        (await db.execute(sql`select id from flow_runs where subject_id=${draft.id}`, "objects"))
          .length,
        1,
      );
    },
  );
  await t.test(
    "four sequential stages use pinned policy after live graph changes and block premature queue",
    async () => {
      const nodes = [trigger, ...Array.from({ length: 4 }, (_, i) => gate(`stage-${i}`))];
      const edges = Array.from({ length: 4 }, (_, i) =>
        edge(i === 0 ? "submit" : `stage-${i - 1}`, `stage-${i}`, i === 0 ? "next" : "approve"),
      );
      const flowId = await policy(nodes, edges);
      const draft = await award();
      await submit(draft.id);
      for (let i = 0; i < 4; i++) {
        assert.equal((await read(draft.id)).status, "pending");
        await assert.rejects(queue(draft.id), /only approved/);
        await approve(draft.id);
        if (i === 0)
          await db.execute(
            sql`update flows set graph='{"schemaVersion":1,"nodes":[],"edges":[]}'::jsonb where id=${flowId}`,
          );
      }
      const ready = await read(draft.id);
      assert.equal(ready.status, "approved");
      assert.equal(ready.approvedBy, approver);
      assert.equal((ready.decisionSnapshot?.gates as unknown[]).length, 4);
      assert.equal((await gates(draft.id)).filter((g) => g.status === "approved").length, 4);
    },
  );
  await t.test(
    "conditional amount rules use native routing and direct outcome only below the threshold",
    async () => {
      await policy(
        [
          trigger,
          {
            id: "large",
            position: { x: 180, y: 0 },
            data: {
              kind: "condition",
              rule: { op: "gte", field: "value", value: 100 },
            },
          },
          gate("approve"),
        ],
        [edge("submit", "large"), edge("large", "approve", "then")],
      );
      const small = await award("50.0000");
      const large = await award("100.0000");
      assert.equal((await submit(small.id)).status, "approved");
      assert.equal((await submit(large.id)).status, "pending");
      await approve(large.id);
      assert.equal((await read(large.id)).status, "approved");
    },
  );
  await t.test(
    "large exact amount thresholds cannot lose the cent that requires approval",
    async () => {
      const highValue = "999999999999900.02";
      const account = (
        await db.execute<{ id: string }>(
          sql`select id from accounts where org_id=${org.orgId} and number='6050'`,
          "objects",
        )
      )[0]!.id;
      const largeProgram = await seedPayrollBenefitProgram(
        {
          orgId: org.orgId,
          actorId: author,
          subsidiaryId: org.subsidiaryId,
          componentId: component,
        },
        {
          code: "LARGE_EXACT_REWARD",
          name: "Exact amount reward",
          family: "reward",
          valuation: "fixed",
          fixedAmount: highValue,
          sourceAccountIds: [account],
        },
        { employmentIds: [employment] },
      );
      await policy(
        [
          trigger,
          {
            id: "large",
            position: { x: 180, y: 0 },
            data: {
              kind: "condition",
              rule: { op: "gt", field: "value", value: "999999999999900.01" },
            },
          },
          gate("approve"),
        ],
        [edge("submit", "large"), edge("large", "approve", "then")],
      );
      const draft = await createBenefitAward({
        orgId: org.orgId,
        actorId: author,
        programId: largeProgram.id,
        employmentId: employment,
        periodFrom: "2026-03-01",
        value: highValue,
        currency: "CAD",
      });
      assert.equal((await submit(draft.id)).status, "pending");
      await approve(draft.id);
      assert.equal((await read(draft.id)).status, "approved");
    },
  );
  await t.test(
    "missing approver prevents submission even beside a direct policy and preserves an actionable remedy",
    async () => {
      await policy([trigger], []);
      await singleGate(randomUUID());
      const draft = await award();
      await assert.rejects(submit(draft.id), /Benefits reward policy.*zero assignees.*Open Flows/);
      assert.equal((await read(draft.id)).status, "draft");
      assert.equal((await gates(draft.id)).length, 0);
    },
  );
  await t.test(
    "rejection retains reason and evidence, cancels parallel gates and cannot enter payroll",
    async () => {
      await singleGate();
      await singleGate();
      const draft = await award();
      await submit(draft.id);
      const opened = (await gates(draft.id)).filter((g) => g.status === "pending");
      assert.equal(opened.length, 2);
      await decideGate({
        gateId: opened[0]!.id,
        userId: approver,
        decision: "rejected",
        comment: "Award exceeds approved departmental policy",
      });
      const rejected = await read(draft.id);
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.decisionSnapshot?.outcome, "rejected");
      assert.ok(
        (rejected.decisionSnapshot?.gates as { comment: string | null }[]).some(
          (g) => g.comment === "Award exceeds approved departmental policy",
        ),
      );
      assert.equal((await gates(draft.id)).filter((g) => g.status === "pending").length, 0);
      await assert.rejects(queue(draft.id), /only approved/);
    },
  );
  await t.test(
    "human independence applies to maker and submitter while explicitly permitted self-decision remains configurable",
    async () => {
      await singleGate(approver, true);
      const draft = await award();
      await submit(draft.id, thirdActor);
      const independentGate = await pendingGate(draft.id);
      await assert.rejects(
        db
          .execute(
            sql`update flow_gates set assignee_user_id=${author} where org_id=${org.orgId} and id=${independentGate.id}`,
          )
          .then(() =>
            decideGate({
              gateId: independentGate.id,
              userId: author,
              decision: "approved",
            }),
          ),
        /cannot approve your own submission/,
      );
      await db.execute(sql`update flows set enabled=false where org_id=${org.orgId}`);
      await singleGate(author, false);
      const ownerDraft = await award();
      await submit(ownerDraft.id);
      await decideGate({
        gateId: (await pendingGate(ownerDraft.id)).id,
        userId: author,
        decision: "approved",
      });
      assert.equal((await read(ownerDraft.id)).status, "approved");
    },
  );
  await t.test(
    "tenant and permission boundaries refuse submission, read and direct release",
    async () => {
      await singleGate();
      const draft = await award();
      foreignOrg = await createScratchOrg();
      await enableHrm(foreignOrg.orgId);
      const outsider = await mkHr(foreignOrg.orgId, "Foreign author", "foreign_benefits", null, [
        "hrm.benefits.read",
        "hrm.benefits.manage",
      ]);
      await assert.rejects(
        submitBenefitAward({
          orgId: foreignOrg.orgId,
          actorId: outsider,
          awardId: draft.id,
        }),
        /not found|loading the reward/,
      );
      const reader = await mkHr(org.orgId, "Reader", "benefits_reader", null, [
        "hrm.benefits.read",
      ]);
      await assert.rejects(submit(draft.id, reader), /permission|manage/);
      await submit(draft.id);
      await assert.rejects(
        releaseBenefitAwardApproval({
          orgId: org.orgId,
          actorId: approver,
          awardId: draft.id,
          outcome: "approved",
        }),
        /current native Flow gates before release/,
      );
      assert.equal((await read(draft.id)).status, "pending");
      await grantPermissions(org.orgId, reader, ["hrm.benefits.manage"]);
      await approve(draft.id);
    },
  );
  await t.test(
    "database guards reject fabricated unanchored approval and immutable policy changes",
    async () => {
      const draft = await award();
      await rejectWrite(
        sql`update hrm_benefit_awards set status='pending' where org_id=${org.orgId} and id=${draft.id}`,
        /pending reward must retain its native Flow gate run/i,
      );
      await singleGate();
      await submit(draft.id);
      await rejectWrite(
        sql`update hrm_benefit_awards set status='approved' where org_id=${org.orgId} and id=${draft.id}`,
        /matching workflow decision evidence/,
      );
      await approve(draft.id);
      await rejectWrite(
        sql`update hrm_benefit_awards set decision_snapshot='{}'::jsonb where org_id=${org.orgId} and id=${draft.id}`,
        /decisions are immutable|approval evidence is immutable/,
      );
      await rejectWrite(
        sql`update hrm_benefit_awards set approved_by=${author} where org_id=${org.orgId} and id=${draft.id}`,
        /decisions are immutable|approval evidence is immutable/,
      );
    },
  );
  await t.test(
    "caught workflow refusal inside an outer transaction cannot leave pending gates or submission stamps",
    async () => {
      await singleGate();
      await singleGate(randomUUID());
      const draft = await award();
      await withOrgTransaction(org.orgId, async () => {
        await assert.rejects(submit(draft.id), /zero assignees/);
        assert.equal((await read(draft.id)).status, "draft");
      });
      assert.equal((await gates(draft.id)).length, 0);
      assert.equal((await read(draft.id)).submittedBy, null);
      assert.equal(
        (await db.execute(sql`select id from flow_runs where subject_id=${draft.id}`, "objects"))
          .length,
        0,
      );
    },
  );
  await t.test("policy availability reads stay scoped and expose native editor links", async () => {
    const empty = await listBenefitApprovalPolicies({
      orgId: org.orgId,
      actorId: author,
      programId: program,
    });
    assert.equal(empty.configured, false);
    const flowId = await policy([trigger], []);
    const configured = await listBenefitApprovalPolicies({
      orgId: org.orgId,
      actorId: author,
      programId: program,
    });
    assert.equal(configured.configured, true);
    assert.equal(configured.policies[0]!.id, flowId);
    assert.equal(configured.policies[0]!.href, `/admin/flows/${flowId}`);
  });
  await t.test(
    "workflow context pins routing values and withdraw cancels pending approvals",
    async () => {
      await singleGate();
      const draft = await award();
      await submit(draft.id);
      const context = await benefitAwardsFlowAdapter.loadContext(draft.id);
      assert.equal(context?.values.value, "100.0000");
      assert.equal(context?.makerUserId, author);
      await voidReward(draft.id, "Duplicate reward");
      assert.equal((await read(draft.id)).status, "voided");
      assert.equal((await gates(draft.id)).filter((g) => g.status === "pending").length, 0);
    },
  );

  await t.test(
    "zero-gate reward submission releases once and retains immutable routing evidence",
    async () => {
      const created = await seedPayrollBenefitProgram(
        {
          orgId: org.orgId,
          actorId: author,
          subsidiaryId: org.subsidiaryId,
          componentId: component,
        },
        {
          code: `NONE${randomUUID().slice(0, 8)}`,
          name: "Recognition without approvals",
          family: "reward",
          valuation: "pool",
          budgetAmount: "1000.0000",
        },
        { employmentIds: [employment], activate: false },
      );
      await activateBenefitProgram({
        orgId: org.orgId,
        actorId: author,
        programId: created.id,
      });
      const draft = await createBenefitAward({
        orgId: org.orgId,
        actorId: author,
        programId: created.id,
        employmentId: employment,
        periodFrom: "2026-03-01",
        value: "75.0000",
        currency: "CAD",
      });
      await rejectWrite(
        sql`update hrm_benefit_awards set status='approved' where org_id=${org.orgId} and id=${draft.id}`,
        /ungated Flow submission receipt/,
      );
      await assert.rejects(queue(draft.id), /only approved/);
      const ready = await submit(draft.id);
      assert.equal(ready.status, "approved");
      assert.equal(ready.flowRunId, null);
      assert.equal(ready.approvedBy, null);
      assert.equal(ready.submittedBy, author);
      assert.equal(ready.decisionSnapshot?.mode, "ungated");
      const receipt = (
        await db.execute<{ program_id: string; policy: { kind: string } }>(
          sql`select context->>'programId' as program_id,policy from flow_submissions where org_id=${org.orgId} and id=${ready.decisionSnapshot?.submissionId}`,
          "objects",
        )
      )[0];
      assert.equal(receipt?.program_id, created.id);
      assert.equal(receipt?.policy.kind, "ungated");
      assert.equal(
        (
          await db.execute(
            sql`select id from flow_runs where org_id=${org.orgId} and subject_id=${draft.id}`,
            "objects",
          )
        ).length,
        0,
      );
      await singleGate();
      assert.deepEqual(await submit(draft.id), ready);
      await rejectWrite(
        sql`update hrm_benefit_programs set budget_amount='999.0000' where org_id=${org.orgId} and id=${created.id}`,
        /active policy.*edit it with a change date/,
      );
      await rejectWrite(
        sql`update hrm_benefit_awards set decision_snapshot='{}'::jsonb where org_id=${org.orgId} and id=${draft.id}`,
        /decisions are immutable/,
      );
      assert.equal((await gates(draft.id)).length, 0);
    },
  );

  await t.test(
    "concurrent final decisions across policies release one reward exactly once",
    { timeout: 30000 },
    async () => {
      await singleGate();
      await singleGate();
      const draft = await award();
      await submit(draft.id);
      const pending = (await gates(draft.id)).filter((row) => row.status === "pending");
      assert.equal(pending.length, 2);
      await Promise.all(
        pending.map((row) =>
          decideGate({
            gateId: row.id,
            userId: approver,
            decision: "approved",
          }),
        ),
      );
      assert.equal((await read(draft.id)).status, "approved");
      assert.equal((await gates(draft.id)).filter((row) => row.status === "approved").length, 2);
      assert.equal(
        (
          await db.execute(
            sql`select id from hrm_benefit_award_events where org_id=${org.orgId} and award_id=${draft.id} and kind='approved'`,
            "objects",
          )
        ).length,
        1,
      );
    },
  );

  await t.test(
    "concurrent approval and void leave a terminal reward with no open gates",
    { timeout: 30000 },
    async () => {
      await singleGate();
      const draft = await award();
      await submit(draft.id);
      const pending = await pendingGate(draft.id);
      const outcomes = await Promise.allSettled([
        decideGate({
          gateId: pending.id,
          userId: approver,
          decision: "approved",
        }),
        voidReward(draft.id, "Recognition request withdrawn"),
      ]);
      assert.equal(outcomes[1]!.status, "fulfilled");
      if (outcomes[0]!.status === "rejected")
        assert.match(String(outcomes[0]!.reason), /already resolved|voided|cancelled/);
      assert.equal((await read(draft.id)).status, "voided");
      assert.equal(
        (await gates(draft.id)).filter((row) => ["pending", "escalated"].includes(row.status))
          .length,
        0,
      );
      assert.equal(
        (
          await db.execute(
            sql`select id from hrm_benefit_award_events where org_id=${org.orgId} and award_id=${draft.id} and kind='voided'`,
            "objects",
          )
        ).length,
        1,
      );
    },
  );

  await t.test(
    "unissued approved records missing decision evidence cannot enter the payout queue",
    async () => {
      const draft = await award();
      // Reproduce an inconsistent imported record only through the native trusted
      // maintenance transaction; ordinary writes cannot fabricate approved state.
      await withBypass(async () => {
        await db.execute(sql`set local app.bypass_rls='on'`);
        await db.execute(sql`set local openbooks.amend='on'`);
        await db.execute(
          sql`update hrm_benefit_awards set status='approved', approved_by=${approver}, approved_at=now(), program_snapshot=program_snapshot - 'approvalMode' where org_id=${org.orgId} and id=${draft.id}`,
        );
      });
      await assert.rejects(
        queue(draft.id),
        /no complete pinned approval decision.*Void the unissued reward/i,
      );
      await rejectWrite(
        sql`update hrm_benefit_awards set status='queued' where org_id=${org.orgId} and id=${draft.id}`,
        /retained Flow release before payroll processing/i,
      );
      assert.equal((await read(draft.id)).status, "approved");
      const voided = await voidReward(
        draft.id,
        "Replace unissued record missing a pinned approval decision",
      );
      assert.equal(voided.status, "voided");
    },
  );

  await t.test(
    "native decision evidence refuses fabricated approval actors and missing or altered timestamps",
    async () => {
      const amend = async (work: () => Promise<void>) =>
        withBypass(async () => {
          await db.execute(sql`set local app.bypass_rls='on'`);
          await db.execute(sql`set local openbooks.amend='on'`);
          await work();
        });
      const reset = async (ready: Awaited<ReturnType<typeof read>>) =>
        amend(async () => {
          await db.execute(
            sql`update hrm_benefit_awards set status='pending',decision_snapshot=null,approved_by=null,approved_at=null where org_id=${org.orgId} and id=${ready.id}`,
          );
        });
      const restore = async (ready: Awaited<ReturnType<typeof read>>) =>
        amend(async () => {
          await db.execute(
            sql`update hrm_benefit_awards set status=${ready.status},decision_snapshot=${JSON.stringify(ready.decisionSnapshot)}::jsonb,approved_by=${ready.approvedBy},approved_at=${ready.approvedAt}::timestamptz where org_id=${org.orgId} and id=${ready.id}`,
          );
        });
      await policy([trigger], []);
      const direct = await award();
      const automatic = await submit(direct.id);
      await reset(automatic);
      await rejectWrite(
        sql`update hrm_benefit_awards set status='approved',decision_snapshot=${JSON.stringify(automatic.decisionSnapshot)}::jsonb,approved_at=null,updated_by=${author} where org_id=${org.orgId} and id=${direct.id}`,
        /immutable matching workflow decision evidence/,
      );
      assert.equal((await read(direct.id)).status, "pending");
      await restore(automatic);

      await singleGate();
      const humanDraft = await award();
      await submit(humanDraft.id);
      await approve(humanDraft.id);
      const human = await read(humanDraft.id);
      const actualGate = (await gates(human.id)).find((row) => row.status === "approved")!;
      assert.equal(actualGate.decided_by, approver);
      // Keep the real gate and its decision. Only restore the reward's pending
      // projection in a trusted fixture transaction to exercise database guards.
      await reset(human);
      for (const actor of [author, null]) {
        await rejectWrite(
          sql`update hrm_benefit_awards set status='approved',decision_snapshot=${JSON.stringify(human.decisionSnapshot)}::jsonb,approved_by=${actor},approved_at=now(),updated_by=${approver} where org_id=${org.orgId} and id=${human.id}`,
          /matching native approval actor and timestamp/,
        );
      }
      await rejectWrite(
        sql`update hrm_benefit_awards set status='approved',decision_snapshot=${JSON.stringify(human.decisionSnapshot)}::jsonb,approved_by=${approver},approved_at=null,updated_by=${approver} where org_id=${org.orgId} and id=${human.id}`,
        /matching native approval actor and timestamp/,
      );
      const altered = structuredClone(human.decisionSnapshot!);
      for (const row of altered.gates as {
        id: string;
        decided_at: string | null;
      }[]) {
        if (row.id === actualGate.id) row.decided_at = "2000-01-01T00:00:00Z";
      }
      await rejectWrite(
        sql`update hrm_benefit_awards set status='approved',decision_snapshot=${JSON.stringify(altered)}::jsonb,approved_by=${approver},approved_at=now(),updated_by=${approver} where org_id=${org.orgId} and id=${human.id}`,
        /matching native approval actor and timestamp/,
      );
      assert.equal((await read(human.id)).status, "pending");
      assert.deepEqual(
        (await gates(human.id)).find((row) => row.id === actualGate.id),
        actualGate,
      );
      await restore(human);

      const rejectedDraft = await award();
      await submit(rejectedDraft.id);
      await decideGate({
        gateId: (await pendingGate(rejectedDraft.id)).id,
        userId: approver,
        decision: "rejected",
        comment: "Outside the authorized recognition policy",
      });
      const rejected = await read(rejectedDraft.id);
      await reset(rejected);
      await rejectWrite(
        sql`update hrm_benefit_awards set status='rejected',decision_snapshot=${JSON.stringify(rejected.decisionSnapshot)}::jsonb,approved_by=${approver},approved_at=now(),updated_by=${approver} where org_id=${org.orgId} and id=${rejected.id}`,
        /matching native approval actor and timestamp/,
      );
      assert.equal((await read(rejected.id)).status, "pending");
      await restore(rejected);
    },
  );
});
