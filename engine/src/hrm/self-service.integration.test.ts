import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { decideGate, ReleaseError } from "../flows/gates.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import {
  createChangeRequestDraft,
} from "./change-requests.ts";
import { SelfServiceError } from "./self-service/actor.ts";
import { getMyProfile, getMyRequests, getMySteps } from "./self-service/self-read.ts";
import { actorHasTeam, getTeamView } from "./self-service/team-read.ts";
import { fileProfileChangeRequest } from "./self-service/profile-changes.ts";

/**
 * HR-9 self-service DB coverage (integration partition): the person link
 * (no link = named refusal, never an empty page), self scope (a second
 * person's rows never returned, read back from storage under RLS-aware
 * sessions), team scope (a manager of A is not a manager of B; a report's
 * report is not visible — one level, stated), profile_change end to end
 * including approval application and the stale-race rollback, and the
 * kind-aware authoring gates (HR manage never files a profile change; a
 * self grant never authors an employment change).
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone: parties/address rows, the revision bump, and the
 * profile_changed event with its before-images.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  personAId: string;
  personBId: string;
  managerId: string;
  manager2Id: string;
  hrId: string;
  hr2Id: string;
  noLinkId: string;
  partyA: string;
  partyB: string;
  partyM: string;
  partyM2: string;
  partyHR: string;
  employmentA: string;
  employmentB: string;
  employmentM: string;
  employmentM2: string;
  employmentC: string;
};

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function linkPerson(orgId: string, userId: string, displayName: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${displayName}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

/** A live employment identity with one active version from 2026-01-01. */
async function seedLiveEmployment(orgId: string, subsidiaryId: string, workerPartyId: string): Promise<string> {
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2026-01-01'::date, null, now())
  `);
  await db.execute(sql`
    insert into employment_changes
      (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
       recorded_source, recorded_source_ref, closed_versions)
    values (${orgId}, ${employmentId}, 2, 'created', '{}'::jsonb, 'self-service seed',
            'system', 'self-service-seed', '[]'::jsonb)
  `);
  await db.execute(sql`
    update worker_employments set revision = 2, updated_at = now()
     where org_id = ${orgId} and id = ${employmentId}
  `);
  return employmentId;
}

async function seedLine(
  orgId: string,
  employmentId: string,
  managerEmploymentId: string,
  args: { kind?: string; from?: string; to?: string | null; recordedUntil?: string | null } = {},
): Promise<void> {
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id,
       effective_from, effective_to, recorded_at, recorded_until)
    values (${orgId}, ${employmentId}, ${managerEmploymentId}, ${args.kind ?? "line"}, ${randomUUID()},
            ${args.from ?? "2026-01-01"}::date, ${args.to ?? null}::date, now(),
            ${args.recordedUntil ?? null}::timestamptz)
  `);
}

async function seedEmployeeStep(
  orgId: string,
  employmentId: string,
  title: string,
): Promise<string> {
  const templateId = randomUUID();
  await db.execute(sql`
    insert into hrm_process_templates (id, org_id, kind, name, applies_to)
    values (${templateId}, ${orgId}, 'onboarding', ${`Self-service seed template ${title}`}, '{}'::jsonb)
  `);
  const processId = randomUUID();
  await db.execute(sql`
    insert into hrm_processes (id, org_id, template_id, employment_id, kind, effective_date, status)
    values (${processId}, ${orgId}, ${templateId}, ${employmentId}, 'onboarding', '2026-09-01'::date, 'open')
  `);
  const stepId = randomUUID();
  await db.execute(sql`
    insert into hrm_process_steps
      (id, org_id, process_id, position, title, owner_kind, due_on, required, evidence_kind, status)
    values (${stepId}, ${orgId}, ${processId}, 0, ${title}, 'employee', '2026-10-01'::date, true, 'none', 'pending')
  `);
  return stepId;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  // Self-service reads recheck the HRM feature gate inside their
  // transaction like every other HRM read boundary.
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${org.orgId}
  `);
  const personAId = await createScratchUser(org.orgId, "Self Person A", "self_a");
  const personBId = await createScratchUser(org.orgId, "Self Person B", "self_b");
  const managerId = await createScratchUser(org.orgId, "Self Manager", "self_mgr");
  const manager2Id = await createScratchUser(org.orgId, "Self Manager Two", "self_mgr2");
  const hrId = await createScratchUser(org.orgId, "Self HR", "self_hr");
  const hr2Id = await createScratchUser(org.orgId, "Self HR Two", "self_hr2");
  const noLinkId = await createScratchUser(org.orgId, "Self No Link", "self_nolink");
  await grantPermissions(org.orgId, personAId, ["hrm.self.read", "hrm.self.request"]);
  await grantPermissions(org.orgId, personBId, ["hrm.self.read", "hrm.self.request"]);
  await grantPermissions(org.orgId, managerId, ["hrm.self.read"]);
  await grantPermissions(org.orgId, manager2Id, ["hrm.self.read"]);
  await grantPermissions(org.orgId, hrId, ["hrm.employment.read", "hrm.employment.manage", "hrm.employment.approve"]);
  await grantPermissions(org.orgId, hr2Id, ["hrm.employment.read", "hrm.employment.manage", "hrm.employment.approve"]);
  await grantPermissions(org.orgId, noLinkId, ["hrm.self.read", "hrm.self.request"]);
  const partyA = await linkPerson(org.orgId, personAId, "Person A");
  const partyB = await linkPerson(org.orgId, personBId, "Person B");
  const partyM = await linkPerson(org.orgId, managerId, "Manager M");
  const partyM2 = await linkPerson(org.orgId, manager2Id, "Manager Two");
  const partyHR = await linkPerson(org.orgId, hrId, "HR Decider");
  await linkPerson(org.orgId, hr2Id, "HR Decider Two");
  // noLinkId deliberately keeps users.party_id null.
  const employmentA = await seedLiveEmployment(org.orgId, org.subsidiaryId, partyA);
  const employmentB = await seedLiveEmployment(org.orgId, org.subsidiaryId, partyB);
  const employmentM = await seedLiveEmployment(org.orgId, org.subsidiaryId, partyM);
  const employmentM2 = await seedLiveEmployment(org.orgId, org.subsidiaryId, partyM2);
  const partyC = await linkPerson(org.orgId, await createScratchUser(org.orgId, "Self Person C", "self_c"), "Person C");
  const employmentC = await seedLiveEmployment(org.orgId, org.subsidiaryId, partyC);
  // A reports to M; B reports to M2; C reports to A (transitive, invisible to M).
  await seedLine(org.orgId, employmentA, employmentM);
  await seedLine(org.orgId, employmentB, employmentM2);
  await seedLine(org.orgId, employmentC, employmentA);
  return {
    org, personAId, personBId, managerId, manager2Id, hrId, hr2Id, noLinkId,
    partyA, partyB, partyM, partyM2, partyHR,
    employmentA, employmentB, employmentM, employmentM2, employmentC,
  };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function seedFlow(orgId: string, ...approverIds: string[]): Promise<void> {
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
    assignees: approverIds.map((userId) => ({ type: "user" as const, userId })),
    mode: "any",
  });
}

async function gateOf(requestId: string): Promise<{ id: string; status: string }> {
  const rows = (await db.execute<{ id: string; status: string }>(sql`
    select id, status from flow_gates where subject_id = ${requestId} order by created_at
  `)).rows;
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return rows[0]!;
}

test("no linked person is a named refusal, never an empty page", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    for (const call of [
      () => getMyProfile({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => getMySteps({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => getMyRequests({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () => getTeamView({ orgId: h.org.orgId, actorId: h.noLinkId }),
      () =>
        fileProfileChangeRequest({
          orgId: h.org.orgId, actorId: h.noLinkId,
          employmentId: h.employmentA, changes: { kind: "profile_change", phone: "x" }, reason: "test",
        }),
    ]) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof SelfServiceError, `expected SelfServiceError, got ${String(error)}`);
        assert.equal(error.code, "NO_LINK");
        assert.match(error.message, /Admin → Users → Link person/);
        return true;
      });
    }
  });
});

test("self scope: a second person's rows are never returned", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const stepA = await seedEmployeeStep(h.org.orgId, h.employmentA, "Acknowledge the handbook");
    await seedEmployeeStep(h.org.orgId, h.employmentB, "B's private step");
    const profile = await getMyProfile({ orgId: h.org.orgId, actorId: h.personAId });
    assert.equal(profile.partyId, h.partyA);
    assert.deepEqual(profile.employments.map((row) => row.employmentId), [h.employmentA]);
    assert.ok(!profile.employments.some((row) => row.employmentId === h.employmentB));
    const steps = await getMySteps({ orgId: h.org.orgId, actorId: h.personAId });
    assert.deepEqual(steps.map((row) => row.id), [stepA]);
    const requests = await getMyRequests({ orgId: h.org.orgId, actorId: h.personAId });
    assert.deepEqual(requests, []);
    // The profile names the manager through the live line: M, never M2.
    assert.deepEqual(profile.employments[0]!.managerNames, ["Manager M"]);
    // B's mirror image holds none of A's rows.
    const profileB = await getMyProfile({ orgId: h.org.orgId, actorId: h.personBId });
    assert.equal(profileB.partyId, h.partyB);
    assert.deepEqual(profileB.employments.map((row) => row.employmentId), [h.employmentB]);
  });
});

test("RLS hides one org's self-service rows from another org's session", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const foreign = await createScratchOrg();
    try {
      // Raw constrained sessions (no test bypass): the policy itself is the
      // oracle here, not the service's org predicate.
      const url = process.env.OPENBOOKS_RUNTIME_DB_URL || process.env.OPENBOOKS_DB_URL!;
      const countAs = async (orgId: string): Promise<{ parties: number; employments: number }> => {
        const client = new Client({ connectionString: url });
        await client.connect();
        try {
          await client.query("select set_config('app.current_org', $1, false)", [orgId]);
          const parties = await client.query("select count(*)::int as n from parties where id = $1", [h.partyA]);
          const employments = await client.query(
            "select count(*)::int as n from worker_employments where id = $1",
            [h.employmentA],
          );
          return { parties: parties.rows[0].n as number, employments: employments.rows[0].n as number };
        } finally {
          await client.end();
        }
      };
      assert.deepEqual(await countAs(h.org.orgId), { parties: 1, employments: 1 });
      assert.deepEqual(await countAs(foreign.orgId), { parties: 0, employments: 0 });
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
  });
});

test("team scope: a manager of A is not a manager of B, and a report's report is not visible", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    assert.equal(await actorHasTeam({ orgId: h.org.orgId, actorId: h.managerId }), true);
    const teamM = await getTeamView({ orgId: h.org.orgId, actorId: h.managerId });
    assert.deepEqual(teamM.reports.map((row) => row.employmentId), [h.employmentA]);
    assert.equal(teamM.reports[0]!.workerPartyId, h.partyA);
    // B reports to M2: M never sees B, M2 never sees A.
    assert.ok(!teamM.reports.some((row) => row.employmentId === h.employmentB));
    const teamM2 = await getTeamView({ orgId: h.org.orgId, actorId: h.manager2Id });
    assert.deepEqual(teamM2.reports.map((row) => row.employmentId), [h.employmentB]);
    // C reports to A: A (who holds hrm.self.read as a person) sees C, M does not.
    await grantPermissions(h.org.orgId, h.personAId, ["hrm.self.read"]);
    const teamA = await getTeamView({ orgId: h.org.orgId, actorId: h.personAId });
    assert.deepEqual(teamA.reports.map((row) => row.employmentId), [h.employmentC]);
    assert.ok(!teamM.reports.some((row) => row.employmentId === h.employmentC));
    // B manages nobody: the team read refuses by name, never an empty team.
    await assert.rejects(() => getTeamView({ orgId: h.org.orgId, actorId: h.personBId }), (error: unknown) => {
      assert.ok(error instanceof SelfServiceError);
      assert.equal(error.code, "NO_TEAM");
      return true;
    });
    assert.equal(await actorHasTeam({ orgId: h.org.orgId, actorId: h.personBId }), false);
  });
});

test("profile_change files, approves, and applies onto the party with evidence", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.hrId);
    const revisionBefore = (await db.execute<{ revision: number }>(sql`
      select revision from worker_employments where id = ${h.employmentA}
    `)).rows[0]!.revision;
    const filed = await fileProfileChangeRequest({
      orgId: h.org.orgId, actorId: h.personAId, employmentId: h.employmentA,
      changes: {
        kind: "profile_change",
        phone: "+1 555 0100",
        email: "a.person@example.com",
        emergencyContact: { name: "Kin A", relationship: "sibling", phone: "+1 555 0101" },
        address: { line1: "1 Harbour Road", city: "Halifax", country: "CA" },
      },
      reason: "moved across town",
    });
    assert.equal(filed.request.status, "pending_approval");
    assert.equal(filed.request.payload.kind, "profile_change");
    const gate = await gateOf(filed.request.id);
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.hrId });
    const party = (await db.execute<{ phone: string | null; email: string | null; emergency_contact: unknown }>(sql`
      select phone, email, emergency_contact as "emergency_contact" from parties where id = ${h.partyA}
    `)).rows[0]!;
    assert.equal(party.phone, "+1 555 0100");
    assert.equal(party.email, "a.person@example.com");
    assert.deepEqual(party.emergency_contact, { name: "Kin A", relationship: "sibling", phone: "+1 555 0101" });
    const address = (await db.execute<{ line1: string | null; city: string | null; country: string | null }>(sql`
      select line1, city, country from addresses where org_id = ${h.org.orgId} and party_id = ${h.partyA}
    `)).rows;
    assert.equal(address.length, 1);
    assert.deepEqual([address[0]!.line1, address[0]!.city, address[0]!.country], ["1 Harbour Road", "Halifax", "CA"]);
    const revisionAfter = (await db.execute<{ revision: number }>(sql`
      select revision from worker_employments where id = ${h.employmentA}
    `)).rows[0]!.revision;
    assert.equal(revisionAfter, revisionBefore + 1);
    const events = (await db.execute<{ kind: string; snapshot: unknown; applied: string | null }>(sql`
      select change_kind as kind, prior_snapshot as snapshot,
             (select applied_employment_change_id::text from hrm_employment_change_requests where id = ${filed.request.id}) as applied
        from employment_changes where employment_id = ${h.employmentA} order by revision
    `)).rows;
    const profile = events.find((row) => row.kind === "profile_changed");
    assert.ok(profile, "a profile_changed event evidences the application");
    assert.deepEqual((profile.snapshot as { party: unknown }).party, {
      phone: null, email: null, emergencyContact: null,
    });
    const status = (await db.execute<{ status: string }>(sql`
      select status from hrm_employment_change_requests where id = ${filed.request.id}
    `)).rows[0]!.status;
    assert.equal(status, "applied");
  });
});

test("a stale profile approval refuses with the party untouched", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    await seedFlow(h.org.orgId, h.hrId, h.hr2Id);
    const filed = await fileProfileChangeRequest({
      orgId: h.org.orgId, actorId: h.personAId, employmentId: h.employmentA,
      changes: { kind: "profile_change", phone: "+1 555 0199" },
      reason: "new number",
    });
    // HR lands an employment change first: the profile proposal goes stale.
    // Submitted by one HR identity, decided by another (the SoD invariant
    // refuses self-approval before the revision race is even reached).
    const race = await createChangeRequestDraft({
      orgId: h.org.orgId, actorId: h.hrId, employmentId: h.employmentA,
      payload: { kind: "status_change", status: "on_leave", effectiveFrom: "2026-01-01" },
    });
    const { submitChangeRequest } = await import("./change-requests.ts");
    await submitChangeRequest({ orgId: h.org.orgId, actorId: h.hrId, requestId: race.id, reason: "cover" });
    const { decideGate: decide } = await import("../flows/gates.ts");
    // Gates are per-assignee: the hr2Id-assigned gate is decided by hr2Id
    // (hrId submitted the race, so the SoD invariant bars hrId from its
    // own gate; mode "any" releases on the first approval).
    const raceGates = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where subject_id = ${race.id} and status = 'pending' and assignee_user_id = ${h.hr2Id}
       order by created_at
    `)).rows;
    assert.equal(raceGates.length, 1, "the race submit opens hr2Id's gate");
    await decide({ gateId: raceGates[0]!.id, decision: "approved", userId: h.hr2Id });
    const gate = (await db.execute<{ id: string }>(sql`
      select id from flow_gates
       where subject_id = ${filed.request.id} and status = 'pending' and assignee_user_id = ${h.hrId}
       order by created_at limit 1
    `)).rows[0];
    assert.ok(gate, "the profile submit opens a gate");
    await assert.rejects(decide({ gateId: gate.id, decision: "approved", userId: h.hrId }), (error: unknown) => {
      assert.ok(error instanceof ReleaseError);
      assert.match(String(error), /expected revision/);
      return true;
    });
    const party = (await db.execute<{ phone: string | null }>(sql`
      select phone from parties where id = ${h.partyA}
    `)).rows[0]!;
    assert.equal(party.phone, null, "the stale application wrote nothing");
    const status = (await db.execute<{ status: string }>(sql`
      select status from hrm_employment_change_requests where id = ${filed.request.id}
    `)).rows[0]!.status;
    assert.equal(status, "pending_approval", "the refused decision leaves the request pending");
  });
});

test("authoring gates are kind-aware in both directions", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    // HR holds employment.manage but no self grant: a profile draft refuses
    // with the authorization remedy (an HrmAuthorizationError, the same
    // class every other permission refusal in this service carries).
    await assert.rejects(
      createChangeRequestDraft({
        orgId: h.org.orgId, actorId: h.hrId, employmentId: h.employmentA,
        payload: { kind: "profile_change", phone: "+1 555 0100" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HrmAuthorizationError);
        assert.match(error.message, /hrm\.self\.request/);
        return true;
      },
    );
    // The person holds self.request but no manage grant: an employment
    // draft refuses, and a foreign employment's profile draft refuses.
    await assert.rejects(
      createChangeRequestDraft({
        orgId: h.org.orgId, actorId: h.personAId, employmentId: h.employmentA,
        payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HrmAuthorizationError);
        assert.match(error.message, /hrm\.employment\.manage/);
        return true;
      },
    );
    await assert.rejects(
      createChangeRequestDraft({
        orgId: h.org.orgId, actorId: h.personAId, employmentId: h.employmentB,
        payload: { kind: "profile_change", phone: "+1 555 0100" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HrmAuthorizationError);
        assert.match(error.message, /only your own employment/);
        return true;
      },
    );
    // HR reads every row including profile proposals; the person reads
    // their own proposal but never another's. The submit inside filing
    // needs the approval flow seeded like every other submit.
    await seedFlow(h.org.orgId, h.hrId);
    await grantPermissions(h.org.orgId, h.personAId, ["hrm.self.read"]);
    const { getChangeRequest } = await import("./change-requests.ts");
    const filed = await fileProfileChangeRequest({
      orgId: h.org.orgId, actorId: h.personAId, employmentId: h.employmentA,
      changes: { kind: "profile_change", phone: "+1 555 0100" },
      reason: "read check",
    });
    const seenByHr = await getChangeRequest({ orgId: h.org.orgId, actorId: h.hrId, requestId: filed.request.id });
    assert.equal(seenByHr.id, filed.request.id);
    const seenBySelf = await getChangeRequest({ orgId: h.org.orgId, actorId: h.personAId, requestId: filed.request.id });
    assert.equal(seenBySelf.id, filed.request.id);
    await assert.rejects(
      getChangeRequest({ orgId: h.org.orgId, actorId: h.personBId, requestId: filed.request.id }),
      /hrm\.employment\.read|only your own employment/,
    );
  });
});
