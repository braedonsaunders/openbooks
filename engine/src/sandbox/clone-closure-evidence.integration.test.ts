import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { decideGate } from "../flows/gates.ts";
import { createChangeRequestDraft, submitChangeRequest } from "../hrm/change-requests.ts";
import { createPosition, revisePosition } from "../hrm/positions.ts";
import { db } from "../platform/db.ts";
import {
  addLiveVersion,
  DB,
  gateOf,
  seedEmployment,
  seedFlow,
  setupHarness,
  withHarness,
} from "../testing/hrm-harness.ts";
import { installEngineSeams } from "../composition/install.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

installEngineSeams();

const CLONE_CLOSURE_SPEC = {
  users: [
    {
      key: "positionManagerId",
      name: "Clone Position Manager",
      handle: "clone_position_manager",
      permissions: ["hrm.position.read", "hrm.position.manage"],
    },
    {
      key: "submitterId",
      name: "Clone HRM Submitter",
      handle: "clone_hrm_author",
      permissions: ["hrm.employment.read", "hrm.employment.manage"],
      link: true,
    },
    {
      key: "approverId",
      name: "Clone HRM Approver",
      handle: "clone_hrm_decider",
      permissions: ["hrm.employment.read", "hrm.employment.approve"],
      link: true,
    },
  ],
} as const;

type ClosureEvidence = {
  table: string;
  identity: string;
  version_no: number;
  row_id: string;
  before: Record<string, unknown>;
};

async function deleteSandboxesFor(productionOrgId: string): Promise<void> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from sandboxes where production_org_id = ${productionOrgId}`,
    "objects",
  );
  for (const row of rows) await deleteSandbox(row.id);
}

function differingKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort();
}

test(
  "a full sandbox rebases identifiers in employment and position closure evidence",
  { skip: !DB },
  async () => {
    await withHarness(
      () => setupHarness(CLONE_CLOSURE_SPEC),
      async (h) => {
        await seedFlow(h.org.orgId, h.approverId);
        const { employmentId } = await seedEmployment(h.org.orgId, h.org.subsidiaryId, {
          withVersion: false,
          displayName: "Closure Evidence Worker",
        });
        await addLiveVersion(h.org.orgId, employmentId, {
          status: "active",
          from: "2026-01-01",
          sourceRef: "closure-evidence-seed",
        });

        const request = await createChangeRequestDraft({
          orgId: h.org.orgId,
          actorId: h.submitterId,
          employmentId,
          payload: { kind: "status_change", status: "on_leave", effectiveFrom: "2026-01-01" },
        });
        await submitChangeRequest({
          orgId: h.org.orgId,
          actorId: h.submitterId,
          requestId: request.id,
          reason: "record approved leave",
        });
        const decision = await decideGate({
          gateId: (await gateOf(request.id)).id,
          decision: "approved",
          userId: h.approverId,
        });
        assert.equal(decision.ok, true);

        const position = await createPosition({
          orgId: h.org.orgId,
          actorId: h.positionManagerId,
          positionCode: `CLONE-${randomUUID()}`,
          title: "Operations Analyst",
          employerSubsidiaryId: h.org.subsidiaryId,
          status: "planned",
          effectiveFrom: "2026-01-01",
          reason: "establish the position",
        });
        await revisePosition({
          orgId: h.org.orgId,
          actorId: h.positionManagerId,
          positionId: position.id,
          title: "Senior Operations Analyst",
          reason: "update the position title",
        });

        const sourceEmploymentClosures = await db.execute<{
          closed: ClosureEvidence[];
          versionImage: Record<string, unknown>;
        }>(
          sql`select c.closed_versions as closed, to_jsonb(v) as "versionImage"
                from employment_changes c
                join worker_employment_versions v
                  on v.org_id = c.org_id and v.closed_by_change_id = c.id
               where c.org_id = ${h.org.orgId} and c.employment_id = ${employmentId}
                 and c.change_kind = 'status_changed'`,
          "objects",
        );
        assert.equal(sourceEmploymentClosures.length, 1);
        assert.equal(sourceEmploymentClosures[0]!.closed.length, 1);
        const sourcePositionClosures = await db.execute<{
          closed: ClosureEvidence[];
          versionImage: Record<string, unknown>;
        }>(
          sql`select c.closed_versions as closed, to_jsonb(v) as "versionImage"
                from position_changes c
                join position_versions v
                  on v.org_id = c.org_id and v.closed_by_change_id = c.id
               where c.org_id = ${h.org.orgId} and c.position_id = ${position.id}
                 and c.change_kind = 'revised'`,
          "objects",
        );
        assert.equal(sourcePositionClosures.length, 1);
        assert.equal(sourcePositionClosures[0]!.closed.length, 1);
        assert.deepEqual(
          differingKeys(
            sourcePositionClosures[0]!.closed[0]!.before,
            sourcePositionClosures[0]!.versionImage,
          ),
          ["closed_by_change_id", "recorded_until", "superseded_by"],
        );
        assert.deepEqual(
          differingKeys(
            sourceEmploymentClosures[0]!.closed[0]!.before,
            sourceEmploymentClosures[0]!.versionImage,
          ),
          ["closed_by_change_id", "recorded_until", "superseded_by"],
        );

        try {
          const created = await createSandbox({
            productionOrgId: h.org.orgId,
            name: `Closure Evidence ${randomUUID()}`,
            tier: "full",
            masked: false,
          });

          const employmentClosures = await db.execute<{
            closed: ClosureEvidence[];
            identity: string;
            versionId: string;
            versionImage: Record<string, unknown>;
          }>(
            sql`
            select c.closed_versions as closed, v.employment_id as identity,
                   v.id as "versionId", to_jsonb(v) as "versionImage"
              from employment_changes c
              join worker_employment_versions v
                on v.org_id = c.org_id and v.closed_by_change_id = c.id
             where c.org_id = ${created.sandboxOrgId} and c.change_kind = 'status_changed'`,
            "objects",
          );
          assert.equal(employmentClosures.length, 1, "the clone commits the governed closure");
          const employment = employmentClosures[0]!;
          assert.equal(employment.closed.length, 1);
          const employmentEvidence = employment.closed[0]!;
          const sourceEmploymentEvidence = sourceEmploymentClosures[0]!.closed[0]!;
          assert.equal(employmentEvidence.table, "worker_employment_versions");
          assert.equal(employmentEvidence.identity, employment.identity);
          assert.notEqual(employmentEvidence.identity, sourceEmploymentEvidence.identity);
          assert.equal(employmentEvidence.version_no, sourceEmploymentEvidence.version_no);
          assert.equal(employmentEvidence.row_id, employment.versionId);
          assert.notEqual(employmentEvidence.row_id, sourceEmploymentEvidence.row_id);
          assert.deepEqual(employmentEvidence.before, employment.versionImage);

          const positionClosures = await db.execute<{
            closed: ClosureEvidence[];
            identity: string;
            versionId: string;
            versionImage: Record<string, unknown>;
          }>(
            sql`
            select c.closed_versions as closed, v.position_id as identity,
                   v.id as "versionId", to_jsonb(v) as "versionImage"
              from position_changes c
              join position_versions v
                on v.org_id = c.org_id and v.closed_by_change_id = c.id
             where c.org_id = ${created.sandboxOrgId} and c.change_kind = 'revised'`,
            "objects",
          );
          assert.equal(positionClosures.length, 1, "the clone commits the position closure");
          const positionClosure = positionClosures[0]!;
          assert.equal(positionClosure.closed.length, 1);
          const positionEvidence = positionClosure.closed[0]!;
          const sourcePositionEvidence = sourcePositionClosures[0]!.closed[0]!;
          assert.equal(positionEvidence.table, "position_versions");
          assert.equal(positionEvidence.identity, positionClosure.identity);
          assert.notEqual(positionEvidence.identity, sourcePositionEvidence.identity);
          assert.equal(positionEvidence.version_no, sourcePositionEvidence.version_no);
          assert.equal(positionEvidence.row_id, positionClosure.versionId);
          assert.notEqual(positionEvidence.row_id, sourcePositionEvidence.row_id);
          assert.deepEqual(positionEvidence.before, positionClosure.versionImage);
        } finally {
          await deleteSandboxesFor(h.org.orgId);
        }
      },
    );
  },
);
