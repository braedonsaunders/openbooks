import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { decideGate } from "../flows/gates.ts";
import {
  closePosition,
  createPosition,
  HrmPositionError,
  revisePosition,
  writePositionFunding,
} from "./positions.ts";
import { getPositionAsOf, getVacancyAsOf } from "./positions-read.ts";
import {
  createChangeRequestDraft,
  submitChangeRequest,
} from "./change-requests.ts";

/**
 * HR-3 DB coverage (integration partition): position create/revise/close/
 * fund over real 0192 rows, the close-while-held refusal with zero partial
 * effects, funding preflights committed (not constrained), stale-revision
 * refusal, RLS cross-org invisibility, and employment-to-position
 * assignment through the full change-request lifecycle with disagreement
 * warnings in both ledgers' evidence.
 *
 * Proofs are read back from storage, never from the service's own return
 * values alone: position_changes rows and kinds, closed_versions
 * before-images, revision bumps, and every refusal asserts the writes
 * that must NOT exist.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

type Harness = {
  org: ScratchOrg;
  managerId: string;
  submitterId: string;
  approverId: string;
};

function codeOf(error: unknown): string {
  assert.ok(error instanceof HrmPositionError);
  return error.code;
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function linkPerson(orgId: string, userId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${`Person ${partyId.slice(0, 8)}`}, true, '{}'::jsonb)
  `);
  await db.execute(sql`update users set party_id = ${partyId} where id = ${userId} and org_id = ${orgId}`);
  return partyId;
}

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableHrm(org.orgId);
  const managerId = await createScratchUser(org.orgId, "HRM Position Manager", "hrm_position_manager");
  const submitterId = await createScratchUser(org.orgId, "HRM Submitter", "hrm_author");
  const approverId = await createScratchUser(org.orgId, "HRM Approver", "hrm_decider");
  await grantPermissions(org.orgId, managerId, ["hrm.position.read", "hrm.position.manage"]);
  await grantPermissions(org.orgId, submitterId, ["hrm.employment.read", "hrm.employment.manage"]);
  await grantPermissions(org.orgId, approverId, ["hrm.employment.read", "hrm.employment.approve"]);
  await linkPerson(org.orgId, submitterId);
  await linkPerson(org.orgId, approverId);
  return { org, managerId, submitterId, approverId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function mkDepartment(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name) values (${orgId}, ${name}) returning id`)).rows[0]!.id;
}

/** A live employment with one live status version (test-only direct writer). */
async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  status = "active",
): Promise<{ employmentId: string; workerPartyId: string }> {
  const workerPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${workerPartyId}, ${orgId}, 'person', 'Position Holder', true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${workerPartyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from)
    values (${orgId}, ${employmentId}, 1, ${status}, '2026-07-01'::date)
  `);
  return { employmentId, workerPartyId };
}

/** A live assignment version on a slot (test-only direct writer). */
async function seedAssignment(
  orgId: string,
  employmentId: string,
  key: string,
  args: {
    positionId?: string | null;
    isPrimary?: boolean;
    fte?: string;
    jobTitle?: string | null;
    departmentId?: string | null;
  } = {},
): Promise<string> {
  const slotId = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, ${key}) returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no,
       job_title, department_id, fte, is_primary, effective_from)
    values (${orgId}, ${slotId}, ${employmentId}, ${args.positionId ?? null}, 1,
            ${args.jobTitle ?? null}, ${args.departmentId ?? null},
            ${args.fte ?? "1"}, ${args.isPrimary ?? false}, '2026-07-01'::date)
  `);
  return slotId;
}

async function positionChangeKinds(orgId: string, positionId: string): Promise<string[]> {
  const rows = (await db.execute<{ change_kind: string }>(sql`
    select change_kind from position_changes
     where org_id = ${orgId} and position_id = ${positionId} order by revision`)).rows;
  return rows.map((row) => row.change_kind);
}

async function seedFlow(orgId: string, approverId: string): Promise<void> {
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
    assignees: [{ type: "user", userId: approverId }],
    mode: "any",
  });
}

async function gateOf(requestId: string): Promise<{ id: string }> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from flow_gates where subject_id = ${requestId} order by created_at`)).rows;
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return { id: rows[0]!.id };
}

const KNOWN_AT = (): string => new Date().toISOString();

test("positions happy path: create, revise, fund, and vacancy with storage proofs", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const deptId = await mkDepartment(orgId, "Engineering");
    const created = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      departmentId: deptId,
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open the establishment",
    });
    assert.equal(created.revision, 1);
    assert.equal(created.version.status, "open");
    assert.deepEqual(await positionChangeKinds(orgId, created.id), ["created"]);

    const revised = await revisePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      plannedFte: "2.0000",
      reason: "double the establishment",
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.version.plannedFte, "2.0000");
    assert.deepEqual(await positionChangeKinds(orgId, created.id), ["created", "revised"]);
    // The closure names the exact retired version with its before-image.
    const closures = (await db.execute<{ closed: unknown }>(sql`
      select closed_versions as closed from position_changes
       where org_id = ${orgId} and position_id = ${created.id} and revision = 2`)).rows[0]!.closed as Array<{
      table: string;
      version_no: number;
      before: { planned_fte: string };
    }>;
    assert.equal(closures.length, 1);
    assert.equal(closures[0]!.table, "position_versions");
    assert.equal(closures[0]!.version_no, 1);
    assert.equal(closures[0]!.before.planned_fte, "1.0000");

    const funded = await writePositionFunding({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      periodId: h.org.periodId,
      fundedFte: "2.0000",
      reason: "fund the doubled establishment",
    });
    assert.equal(funded.funding.fundedFte, "2.0000");
    assert.equal(funded.preflight, null);
    assert.deepEqual(await positionChangeKinds(orgId, created.id), ["created", "revised", "funded"]);

    const vacancy = await getVacancyAsOf({
      orgId,
      actorId: h.managerId,
      effectiveDate: "2026-07-15",
      knownAt: KNOWN_AT(),
    });
    assert.equal(vacancy.totals.positions, 1);
    assert.equal(vacancy.totals.plannedFte, "2.0000");
    assert.equal(vacancy.totals.fundedFte, "2.0000");
    assert.equal(vacancy.totals.filledFte, "0.0000");
    assert.equal(vacancy.totals.vacantFte, "2.0000");
    assert.equal(vacancy.totals.unfundedFilledFte, "0.0000");
    assert.equal(vacancy.byDepartment.length, 1);
    assert.equal(vacancy.byDepartment[0]!.departmentName, "Engineering");
    assert.equal(vacancy.positions[0]!.vacancy.refusal, null);
    assert.deepEqual(vacancy.positions[0]!.holders, []);
  });
});

test("duplicate position codes are refused with nothing written", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-07-01",
      reason: "first",
    });
    const before = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from positions where org_id = ${orgId}`)).rows[0]!.n;
    let code = "";
    try {
      await createPosition({
        orgId,
        actorId: h.managerId,
        positionCode: "ENG-1042",
        title: "Engineer II",
        employerSubsidiaryId: h.org.subsidiaryId,
        effectiveFrom: "2026-07-01",
        reason: "second",
      });
    } catch (error) {
      code = codeOf(error);
    }
    assert.equal(code, "BAD_STATE");
    const after = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from positions where org_id = ${orgId}`)).rows[0]!.n;
    assert.equal(after, before);
  });
});

test("revise refusals: no-op, direct close, and terminal closed", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const created = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const noop = await revisePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      reason: "nothing",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(noop, "BAD_STATE");
    const direct = await revisePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      status: "closed",
      reason: "shortcut",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(direct, "BAD_STATE");
    // Illegal transition: planned cannot fill without opening.
    const planned = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1043",
      title: "Analyst",
      employerSubsidiaryId: h.org.subsidiaryId,
      status: "planned",
      effectiveFrom: "2026-07-01",
      reason: "plan",
    });
    const leap = await revisePosition({
      orgId,
      actorId: h.managerId,
      positionId: planned.id,
      status: "filled",
      reason: "leap",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(leap, "BAD_STATE");

    const closed = await closePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      effectiveDate: "2026-07-15",
      reason: "retire",
    });
    assert.equal(closed.version.status, "closed");
    const resurrect = await revisePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      status: "open",
      reason: "resurrect",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(resurrect, "BAD_STATE");
    const reclose = await closePosition({
      orgId,
      actorId: h.managerId,
      positionId: created.id,
      effectiveDate: "2026-07-16",
      reason: "again",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(reclose, "BAD_STATE");
  });
});

test("close is refused while a live primary assignment names the position", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const { employmentId } = await seedEmployment(orgId, h.org.subsidiaryId);
    await seedAssignment(orgId, employmentId, "primary", {
      positionId: position.id,
      isPrimary: true,
      fte: "1.0000",
    });
    let message = "";
    try {
      await closePosition({
        orgId,
        actorId: h.managerId,
        positionId: position.id,
        effectiveDate: "2026-07-15",
        reason: "retire",
      });
    } catch (error) {
      assert.equal(codeOf(error), "REFUSED");
      message = (error as Error).message;
    }
    assert.match(message, /ENG-1042/);
    assert.match(message, new RegExp(employmentId));
    assert.match(message, /position_assignment/);
    // Zero partial effects: no closed version, no closed event, revision still 1.
    const live = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from position_versions
       where org_id = ${orgId} and position_id = ${position.id} and recorded_until is null`)).rows[0]!.n;
    assert.equal(live, 1);
    assert.deepEqual(await positionChangeKinds(orgId, position.id), ["created"]);

    // A non-primary holder does not block the close.
    const backfill = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1043",
      title: "Analyst",
      employerSubsidiaryId: h.org.subsidiaryId,
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const { employmentId: second } = await seedEmployment(orgId, h.org.subsidiaryId);
    await seedAssignment(orgId, second, "extra", { positionId: backfill.id, isPrimary: false });
    const closed = await closePosition({
      orgId,
      actorId: h.managerId,
      positionId: backfill.id,
      effectiveDate: "2026-07-15",
      reason: "retire",
    });
    assert.equal(closed.version.status, "closed");
  });
});

test("funding preflights are reported, committed, and evidenced", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const over = await writePositionFunding({
      orgId,
      actorId: h.managerId,
      positionId: position.id,
      periodId: h.org.periodId,
      fundedFte: "1.5000",
      reason: "over-fund",
    });
    assert.equal(over.preflight?.code, "OVER_FUNDED");
    assert.match(over.preflight!.message, /ENG-1042/);
    const stored = (await db.execute<{ funded_fte: string }>(sql`
      select funded_fte::text as funded_fte from position_funding
       where org_id = ${orgId} and position_id = ${position.id}`)).rows[0]!.funded_fte;
    assert.equal(stored, "1.5000");
    const under = await writePositionFunding({
      orgId,
      actorId: h.managerId,
      positionId: position.id,
      periodId: h.org.periodId,
      fundedFte: "0.5000",
      reason: "under-fund",
    });
    assert.equal(under.preflight?.code, "UNDER_FUNDED");
    // The rewrite is evidenced with the prior row, not a silent second plan.
    const snapshots = (await db.execute<{ prior_snapshot: unknown }>(sql`
      select prior_snapshot from position_changes
       where org_id = ${orgId} and position_id = ${position.id} and change_kind = 'funded'
       order by revision`)).rows;
    assert.equal(snapshots.length, 2);
    assert.equal((snapshots[0]!.prior_snapshot as { prior: unknown }).prior, null);
    assert.equal(
      ((snapshots[1]!.prior_snapshot as { prior: { fundedFte: string } }).prior).fundedFte,
      "1.5000",
    );
  });
});

test("funding refuses half-written cost plans and foreign periods", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const half = await writePositionFunding({
      orgId,
      actorId: h.managerId,
      positionId: position.id,
      periodId: h.org.periodId,
      fundedFte: "1.0000",
      amount: "90000.0000",
      reason: "half plan",
    }).then(
      () => "APPLIED",
      (error) => codeOf(error),
    );
    assert.equal(half, "INVALID_INPUT");
    const foreign = await createScratchOrg();
    try {
      const crossed = await writePositionFunding({
        orgId,
        actorId: h.managerId,
        positionId: position.id,
        periodId: foreign.periodId,
        fundedFte: "1.0000",
        reason: "cross",
      }).then(
        () => "APPLIED",
        (error) => codeOf(error),
      );
      assert.equal(crossed, "INVALID_INPUT");
    } finally {
      await dropScratchOrg(foreign.orgId);
    }
    const rows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from position_funding
       where org_id = ${orgId} and position_id = ${position.id}`)).rows[0]!.n;
    assert.equal(rows, 0);
  });
});

test("concurrent revises leave no partial effects", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    // Two writers race on the same aggregate. Whatever the interleaving —
    // one wins and the other rolls back, or the second re-reads and wins
    // cleanly after — the ledger must show exactly one row per applied
    // revision: no orphaned successor, no unwitnessed bump.
    const attempts = await Promise.all([
      revisePosition({
        orgId,
        actorId: h.managerId,
        positionId: position.id,
        plannedFte: "2.0000",
        reason: "first writer",
      }).then(
        (value) => ({ ok: true as const, revision: value.revision }),
        (error) => ({ ok: false as const, code: codeOf(error) }),
      ),
      revisePosition({
        orgId,
        actorId: h.managerId,
        positionId: position.id,
        plannedFte: "3.0000",
        reason: "second writer",
      }).then(
        (value) => ({ ok: true as const, revision: value.revision }),
        (error) => ({ ok: false as const, code: codeOf(error) }),
      ),
    ]);
    const winners = attempts.filter((attempt) => attempt.ok);
    assert.ok(winners.length >= 1, "at least one writer applies");
    for (const attempt of attempts) {
      if (!attempt.ok) {
        assert.ok(
          attempt.code === "REFUSED" || attempt.code === "STALE_REVISION",
          `a losing writer refuses loudly, never silently (got ${attempt.code})`,
        );
      }
    }
    const revision = (await db.execute<{ revision: number }>(sql`
      select revision from positions where org_id = ${orgId} and id = ${position.id}`)).rows[0]!.revision;
    assert.equal(revision, 1 + winners.length);
    const revised = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from position_changes
       where org_id = ${orgId} and position_id = ${position.id} and change_kind = 'revised'`)).rows[0]!.n;
    assert.equal(revised, winners.length, "one revised event per applied revision");
    const totalVersions = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from position_versions
       where org_id = ${orgId} and position_id = ${position.id}`)).rows[0]!.n;
    assert.equal(totalVersions, revision, "no orphaned successor version survives a lost race");
    const live = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from position_versions
       where org_id = ${orgId} and position_id = ${position.id} and recorded_until is null`)).rows[0]!.n;
    assert.equal(live, 1);
  });
});

test("a second organization sees nothing of the first (RLS)", { skip: !DB }, async () => {
  const first = await setupHarness();
  const second = await setupHarness();
  try {
    const position = await createPosition({
      orgId: first.org.orgId,
      actorId: first.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: first.org.subsidiaryId,
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const vacancy = await getVacancyAsOf({
      orgId: second.org.orgId,
      actorId: second.managerId,
      effectiveDate: "2026-07-15",
      knownAt: KNOWN_AT(),
    });
    assert.equal(vacancy.totals.positions, 0);
    assert.equal(vacancy.positions.length, 0);
    await assert.rejects(
      getPositionAsOf({
        orgId: second.org.orgId,
        actorId: second.managerId,
        positionId: position.id,
        effectiveDate: "2026-07-15",
        knownAt: KNOWN_AT(),
      }),
      /not visible in this organization/,
    );
  } finally {
    await dropScratchOrg(first.org.orgId);
    await dropScratchOrg(second.org.orgId);
  }
});

test("position_assignment rides the change-request path with warnings in both ledgers", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedFlow(orgId, h.approverId);
    const deptId = await mkDepartment(orgId, "Engineering");
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      departmentId: deptId,
      employerSubsidiaryId: h.org.subsidiaryId,
      plannedFte: "1.0000",
      status: "open",
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const { employmentId } = await seedEmployment(orgId, h.org.subsidiaryId);
    await seedAssignment(orgId, employmentId, "primary", {
      isPrimary: true,
      fte: "1.0000",
      jobTitle: "Senior Engineer",
    });

    const draft = await createChangeRequestDraft({
      orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "position_assignment", assignmentKey: "primary", positionId: position.id },
    });
    const submitted = await submitChangeRequest({
      orgId,
      actorId: h.submitterId,
      requestId: draft.id,
      reason: "staff the establishment",
    });
    assert.equal(submitted.status, "pending_approval");
    const gate = await gateOf(draft.id);
    const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: h.approverId });
    assert.equal(decided.ok, true);

    const versions = (await db.execute<{ position_id: string | null; version_no: number }>(sql`
      select position_id::text as position_id, version_no
        from employment_assignment_versions
       where org_id = ${orgId} and employment_id = ${employmentId}
       order by version_no`)).rows;
    assert.deepEqual(
      versions.map((v) => v.version_no),
      [1, 2],
    );
    assert.equal(versions[1]!.position_id, position.id);
    // Employment evidence is assignment_superseded with the warnings.
    const employmentEvents = (await db.execute<{ change_kind: string; prior_snapshot: unknown }>(sql`
      select change_kind, prior_snapshot from employment_changes
       where org_id = ${orgId} and employment_id = ${employmentId} order by revision`)).rows;
    const applied = employmentEvents[employmentEvents.length - 1]!;
    assert.equal(applied.change_kind, "assignment_superseded");
    const warnings = (applied.prior_snapshot as { positionWarnings: string[] }).positionWarnings;
    assert.ok(warnings.length >= 1, "title disagreement warns");
    assert.match(warnings[0]!, /keeps its own title/);
    // Position evidence carries the same warnings plus the holder.
    const positionEvents = (await db.execute<{ change_kind: string; prior_snapshot: unknown }>(sql`
      select change_kind, prior_snapshot from position_changes
       where org_id = ${orgId} and position_id = ${position.id} order by revision`)).rows;
    const assigned = positionEvents[positionEvents.length - 1]!;
    assert.equal(assigned.change_kind, "assigned");
    assert.equal((assigned.prior_snapshot as { employmentId: string }).employmentId, employmentId);
    assert.deepEqual(
      (assigned.prior_snapshot as { disagreementWarnings: string[] }).disagreementWarnings,
      warnings,
    );

    const detail = await getPositionAsOf({
      orgId,
      actorId: h.managerId,
      positionId: position.id,
      effectiveDate: "2026-07-15",
      knownAt: KNOWN_AT(),
    });
    assert.equal(detail.holders.length, 1);
    assert.equal(detail.holders[0]!.employmentId, employmentId);
    assert.equal(detail.vacancy.filledFte, "1.0000");
    assert.equal(detail.vacancy.vacantFte, "0.0000");
    assert.ok(detail.disagreementWarnings.length >= 1);
  });
});

test("unassignment clears the link and evidences both sides", { skip: !DB }, async () => {
  await withHarness(async (h) => {
    const orgId = h.org.orgId;
    await seedFlow(orgId, h.approverId);
    const position = await createPosition({
      orgId,
      actorId: h.managerId,
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: h.org.subsidiaryId,
      effectiveFrom: "2026-07-01",
      reason: "open",
    });
    const { employmentId } = await seedEmployment(orgId, h.org.subsidiaryId);
    await seedAssignment(orgId, employmentId, "primary", { positionId: position.id, isPrimary: true });

    const draft = await createChangeRequestDraft({
      orgId,
      actorId: h.submitterId,
      employmentId,
      payload: { kind: "position_assignment", assignmentKey: "primary", positionId: null },
    });
    await submitChangeRequest({
      orgId,
      actorId: h.submitterId,
      requestId: draft.id,
      reason: "vacate the establishment",
    });
    const gate = await gateOf(draft.id);
    await decideGate({ gateId: gate.id, decision: "approved", userId: h.approverId });

    const latest = (await db.execute<{ position_id: string | null }>(sql`
      select position_id::text as position_id from employment_assignment_versions
       where org_id = ${orgId} and employment_id = ${employmentId}
       order by version_no desc limit 1`)).rows[0]!.position_id;
    assert.equal(latest, null);
    const kinds = await positionChangeKinds(orgId, position.id);
    assert.deepEqual(kinds, ["created", "unassigned"]);

    // The vacated establishment now closes without refusal.
    const closed = await closePosition({
      orgId,
      actorId: h.managerId,
      positionId: position.id,
      effectiveDate: "2026-07-15",
      reason: "retire",
    });
    assert.equal(closed.version.status, "closed");
  });
});
