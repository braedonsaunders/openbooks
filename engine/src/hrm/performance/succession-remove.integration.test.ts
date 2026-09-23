import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { createPosition } from "../positions.ts";
import { HrmPerformanceError } from "./errors.ts";
import {
  addSuccessionCandidate,
  createSuccessionPlan,
  removeSuccessionCandidate,
  setSuccessionPlanStatus,
} from "./talent.ts";

/**
 * Succession candidate removal status gate (fnd_muddrro5) over the real
 * 0228 tables — DB-owned, one file at a time. No skip guards: the
 * integration partition guarantees a database.
 *
 * An active or archived plan is evidence: removing a candidate would erase
 * history, so only draft plans shed candidates. Every refusal asserts its
 * code AND its message, and the candidate row's survival is proved from
 * storage.
 */

type Harness = {
  org: ScratchOrg;
  hrId: string;
  employmentId: string;
  planId: string;
  candidateId: string;
};

async function grant(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableTalent(orgId: string): Promise<void> {
  for (const key of ["hrm", "hrmPerformance", "hrmSuccession"] as const) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), string_to_array(${`features,${key}`}, ','), 'true'::jsonb, true)
       where id = ${orgId}`);
  }
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableTalent(org.orgId);
  const hrId = await createScratchUser(org.orgId, "Succession HR", "succession_hr");
  await grant(org.orgId, hrId, ["hrm.performance.manage", "hrm.position.manage"]);
  const partyId = (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name) values (${org.orgId}, 'person', 'Successor') returning id`)).rows[0]!.id;
  const employmentId = (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${org.orgId}, ${partyId}, ${org.subsidiaryId}) returning id`)).rows[0]!.id;
  const position = await createPosition({
    orgId: org.orgId,
    actorId: hrId,
    positionCode: "LEAD-1",
    title: "Lead",
    employerSubsidiaryId: org.subsidiaryId,
    plannedFte: "1.0000",
    status: "open",
    effectiveFrom: "2026-01-01",
    reason: "remove seed",
  });
  const plan = await createSuccessionPlan({ orgId: org.orgId, actorId: hrId, positionId: position.id });
  const candidate = await addSuccessionCandidate({
    orgId: org.orgId,
    actorId: hrId,
    planId: plan.id,
    employmentId,
    readiness: "ready_now",
  });
  return { org, hrId, employmentId, planId: plan.id, candidateId: candidate.id };
}

function perfError(error: unknown): HrmPerformanceError {
  assert.ok(error instanceof HrmPerformanceError, `expected HrmPerformanceError, got ${String(error)}`);
  return error;
}

async function candidateCount(orgId: string, planId: string): Promise<string> {
  return (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from hrm_succession_candidates
     where org_id = ${orgId} and plan_id = ${planId}`)).rows[0]!.n;
}

test("removing a candidate from an active or archived plan is refused", async () => {
  const h = await setupHarness();
  try {
    await setSuccessionPlanStatus({ orgId: h.org.orgId, actorId: h.hrId, id: h.planId, status: "active" });
    for (const status of ["active", "archived"] as const) {
      if (status === "archived") {
        await setSuccessionPlanStatus({ orgId: h.org.orgId, actorId: h.hrId, id: h.planId, status: "archived" });
      }
      const error = perfError(await removeSuccessionCandidate({
        orgId: h.org.orgId,
        actorId: h.hrId,
        planId: h.planId,
        candidateId: h.candidateId,
      }).then(
        () => null,
        (e: unknown) => e,
      ));
      assert.equal(error.code, "REFUSED");
      assert.match(error.message, new RegExp(`a ${status} succession plan keeps its candidates as evidence`));
      assert.equal(await candidateCount(h.org.orgId, h.planId), "1", "the refused removal writes nothing");
    }
    // Back to draft, the removal lands.
    await setSuccessionPlanStatus({ orgId: h.org.orgId, actorId: h.hrId, id: h.planId, status: "draft" });
    await removeSuccessionCandidate({
      orgId: h.org.orgId,
      actorId: h.hrId,
      planId: h.planId,
      candidateId: h.candidateId,
    });
    assert.equal(await candidateCount(h.org.orgId, h.planId), "0");
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
