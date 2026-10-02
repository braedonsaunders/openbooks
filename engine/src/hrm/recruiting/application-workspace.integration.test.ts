import assert from "node:assert/strict";
import {
  scopeMatrix,
  scopeRow,
  refusal,
  type ScopeWorld,
} from "../../testing/hrm-scope-matrix.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { createRequisition, openRequisition } from "./requisitions.ts";
import { createCandidate } from "./candidates.ts";
import {
  createApplication,
  moveApplicationStage,
  rejectApplication,
} from "./applications.ts";
import {
  getApplicationWorkspace,
  listApplicationWorklist,
} from "./application-workspace.ts";
import { RecruitingError } from "./errors.ts";
async function seed(w: ScopeWorld) {
  const base = { orgId: w.orgId, actorId: w.admin };
  const opening = async (employerSubsidiaryId: string, title: string) => {
    const draft = await createRequisition({
      ...base,
      employerSubsidiaryId,
      title,
      headcount: 1,
    });
    return openRequisition({ ...base, requisitionId: draft.id });
  };
  const a = await opening(w.subA, "Operations analyst"),
    b = await opening(w.subB, "Support specialist");
  const candidate = (
    await createCandidate({
      ...base,
      displayName: "Robin Taylor",
      email: "robin@example.test",
      source: "direct",
    })
  ).candidate;
  const appA = await createApplication({
      ...base,
      requisitionId: a.id,
      candidateId: candidate.id,
    }),
    appB = await createApplication({
      ...base,
      requisitionId: b.id,
      candidateId: candidate.id,
    });
  return { a, b, appA, appB };
}
scopeMatrix([
  scopeRow({
    name: "application queue scopes each candidacy and its evidence through its own opening",
    features: ["hrmRecruiting"],
    permissions: ["hrm.recruiting.read", "hrm.recruiting.manage"],
    seed,
    read: async (w, { appA, appB }) => {
      const rows = await listApplicationWorklist({
        orgId: w.orgId,
        actorId: w.scoped,
      });
      assert.deepEqual(
        rows.map((r) => r.id),
        [appA.id],
      );
      assert.equal(rows[0]!.candidate, "Robin Taylor");
      const workspace = await getApplicationWorkspace({
        orgId: w.orgId,
        actorId: w.scoped,
        applicationId: appA.id,
      });
      assert.equal(workspace.candidate.email, "robin@example.test");
      assert.deepEqual(
        workspace.candidate.applications.map((a) => a.applicationId),
        [appA.id],
      );
      assert.ok(workspace.events.length > 0);
      assert.ok(workspace.events.every((e) => !!e.at));
      await refusal(
        getApplicationWorkspace({
          orgId: w.orgId,
          actorId: w.scoped,
          applicationId: appB.id,
        }),
        HrmAuthorizationError,
      );
      assert.deepEqual(
        await listApplicationWorklist({
          orgId: w.orgId,
          actorId: w.scoped,
          opening: appB.requisitionId,
        }),
        [],
      );
    },
  }),
  scopeRow({
    name: "a stale application decision refuses without moving or rejecting the candidacy",
    features: ["hrmRecruiting"],
    permissions: ["hrm.recruiting.read", "hrm.recruiting.manage"],
    seed,
    write: async (w, { appA }) => {
      const base = {
        orgId: w.orgId,
        actorId: w.scoped,
        applicationId: appA.id,
      };
      const initial = await getApplicationWorkspace(base);
      const next = initial.requisition.stages.find(
        (stage) =>
          stage.id !== appA.stageId &&
          !["hired", "rejected"].includes(stage.kind),
      )!;
      const moved = await moveApplicationStage({
        ...base,
        expectedStageId: appA.stageId,
        toStageId: next.id,
      });
      assert.equal(moved.stageId, next.id);
      const error = await refusal(
        rejectApplication({
          ...base,
          expectedStageId: appA.stageId,
          reason: "Wrong experience",
        }),
        RecruitingError,
      );
      assert.match(error.message, /changed.*Reload|changed.*reload/);
      const after = await getApplicationWorkspace(base);
      assert.equal(after.application.status, "active");
      assert.equal(after.application.stageId, next.id);
      const reject = await rejectApplication({
        ...base,
        expectedStageId: next.id,
        reason: "Role requirements not met",
      });
      assert.equal(reject.status, "rejected");
      const evidence = await getApplicationWorkspace(base);
      assert.ok(
        evidence.events.some((e) => e.reason === "Role requirements not met"),
      );
    },
  }),
]);
