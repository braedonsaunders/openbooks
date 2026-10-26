import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  setupHarness,
  withHarness,
  seedEmployment,
  seedPlan,
  seedWindow,
  seededContributionTerms,
  enableHrm,
} from "../../testing/hrm-harness.ts";
import { installEngineSeams } from "../../composition/install.ts";
import { retryFlowRun } from "../../flows/run.ts";
import { electEnrollment } from "./enrollments.ts";

const spec = {
  users: [
    {
      key: "actorId",
      name: "Benefits submission operator",
      handle: "benefits_submission_operator",
      permissions: ["hrm.benefits.read", "hrm.benefits.manage", "flows.manage"],
      link: true,
    },
  ],
} as const;
const trigger = {
  id: "submit",
  position: { x: 0, y: 0 },
  data: { kind: "trigger", trigger: { trigger: "on_submit" } },
};
test(
  "a refused enrollment rolls back before corrected tenant routing releases fresh canonical coverage",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    await withHarness(
      () => setupHarness(spec),
      async (h) => {
        installEngineSeams();
        await enableHrm(h.org.orgId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId);
        const { planId } = await seedPlan(h.org.orgId),
          windowId = await seedWindow(h.org.orgId),
          flowId = randomUUID();
        const graph = {
          schemaVersion: 1,
          nodes: [
            trigger,
            {
              id: "unavailable",
              position: { x: 200, y: 0 },
              data: {
                kind: "gate",
                gate: {
                  title: "Benefits decision",
                  assignees: [{ type: "user", userId: randomUUID() }],
                  mode: "any",
                  preventSelfApproval: true,
                },
              },
            },
          ],
          edges: [
            {
              id: "submit-unavailable",
              source: "submit",
              target: "unavailable",
              sourceHandle: "next",
            },
          ],
        };
        await db.execute(sql`insert into flows(id,org_id,name,subject_kind,enabled,graph)
      values(${flowId},${h.org.orgId},'Benefits election policy','hrm_benefit_enrollment',true,${JSON.stringify(graph)}::jsonb)`);
        const query = {
          orgId: h.org.orgId,
          actorId: h.actorId,
          employmentId,
          planId,
          windowId,
          effectiveFrom: "2026-03-01",
          contributionTerms: await seededContributionTerms(h.org.orgId, planId),
        };
        await assert.rejects(electEnrollment(query), /zero assignees/);
        assert.equal(
          (
            await db.execute(
              sql`select id from hrm_benefit_enrollments where org_id=${h.org.orgId} and plan_id=${planId}`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from flow_submissions where org_id=${h.org.orgId} and subject_kind='hrm_benefit_enrollment'`,
              "objects",
            )
          ).length,
          0,
        );
        assert.equal(
          (
            await db.execute(
              sql`select id from flow_runs where org_id=${h.org.orgId} and flow_id=${flowId}`,
              "objects",
            )
          ).length,
          0,
        );
        await db.execute(
          sql`update flows set graph=${JSON.stringify({ schemaVersion: 1, nodes: [trigger], edges: [] })}::jsonb where org_id=${h.org.orgId} and id=${flowId}`,
        );
        const active = await electEnrollment(query);
        assert.equal(active.status, "active");
        const receipt = (
          await db.execute<{ policy: { kind: string; runIds: string[] }; actor_id: string }>(
            sql`select policy,actor_id from flow_submissions
      where org_id=${h.org.orgId} and subject_kind='hrm_benefit_enrollment' and subject_id=${active.id}`,
            "objects",
          )
        )[0]!;
        assert.equal(receipt.policy.kind, "ungated");
        assert.equal(receipt.policy.runIds.length, 1);
        assert.equal(receipt.actor_id, h.actorId);
        const evidence = async () => ({
          election: await db.execute(
            sql`select to_jsonb(e) as snapshot from hrm_benefit_enrollments e where org_id=${h.org.orgId} and id=${active.id}`,
            "objects",
          ),
          terms: await db.execute(
            sql`select to_jsonb(t) as snapshot from hrm_benefit_enrollment_terms t where org_id=${h.org.orgId} and enrollment_id=${active.id} order by id`,
            "objects",
          ),
          events: await db.execute(
            sql`select id from hrm_benefit_events where org_id=${h.org.orgId} and enrollment_id=${active.id} order by id`,
            "objects",
          ),
        });
        const original = await evidence();
        assert.equal(original.terms.length, 2);
        await assert.rejects(
          retryFlowRun(receipt.policy.runIds[0]!, { orgId: h.org.orgId, userId: h.actorId }),
          /failed/,
        );
        await assert.rejects(electEnrollment(query), /already holds this plan/);
        assert.deepEqual(await evidence(), original);
      },
    );
  },
);
