import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  EmploymentReadError,
  findEmploymentsByParty,
  getEmploymentRecord,
  getHeadcountAsOf,
} from "./employment-read.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { NoRevisionError } from "./temporal.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

// DB-backed proof for the HRM read-surface public boundaries (feature gate,
// transactions, real SQL): headcount grouping, the record envelope with its
// refusal-carrying as-of leg, scoped party resolution, and the 0185 list.
// Runs against the reviewer's own database; never touches shared fixtures.

const KNOWN_AT = "2026-07-01T00:00:00.000001Z";

async function enableHrm(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true)
     where id = ${orgId}`);
}

async function grantRead(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = '["hrm.employment.read"]'::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function mkParty(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into parties (org_id, kind, display_name)
    values (${orgId}, 'person', ${name}) returning id`)).rows[0]!.id;
}

async function mkDepartment(orgId: string, name: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into departments (org_id, name) values (${orgId}, ${name}) returning id`)).rows[0]!.id;
}

async function mkEmployment(orgId: string, partyId: string, subsidiaryId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkVersion(
  orgId: string,
  employmentId: string,
  versionNo: number,
  status: string,
  from: string,
  to: string | null,
  recordedAt: string,
): Promise<void> {
  await db.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, ${versionNo}, ${status}, ${from}::date, ${to}::date, ${recordedAt}::timestamptz)`);
}

async function mkAssignment(
  orgId: string,
  employmentId: string,
  departmentId: string | null,
  primary: boolean,
): Promise<void> {
  const slot = (await db.execute<{ id: string }>(sql`
    insert into employment_assignments (org_id, employment_id, assignment_key)
    values (${orgId}, ${employmentId}, 'primary') returning id`)).rows[0]!.id;
  await db.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, department_id, fte, is_primary,
       effective_from, recorded_at)
    values (${orgId}, ${slot}, ${employmentId}, 1, 'Cashier', ${departmentId}, '1.0000', ${primary},
      '2026-01-01'::date, '2026-01-01T00:00:00.000001Z'::timestamptz)`);
}

async function mkDraftRequest(orgId: string, employmentId: string): Promise<string> {
  return (await db.execute<{ id: string }>(sql`
    insert into hrm_employment_change_requests
      (org_id, employment_id, expected_employment_revision, payload, payload_digest,
       payload_schema_version, created_by)
    values (${orgId}, ${employmentId}, 1, '{"title":"Cashier"}'::jsonb, ${"0".repeat(64)}, 'v1', null)
    returning id`)).rows[0]!.id;
}

test("headcount groups live employments by subsidiary and department", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const dept = await mkDepartment(org.orgId, "Front");
    const party = await mkParty(org.orgId, "Counted worker");
    const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
    await mkVersion(org.orgId, employmentId, 1, "active", "2026-01-01", null, "2026-01-01T00:00:00.000001Z");
    await mkAssignment(org.orgId, employmentId, dept, true);

    const dto = await getHeadcountAsOf({ orgId: org.orgId, actorId: actor, effectiveDate: "2026-06-15", knownAt: KNOWN_AT });
    assert.equal(dto.total, 1);
    assert.equal(dto.groups.length, 1);
    assert.equal(dto.groups[0]?.employerSubsidiaryId, org.subsidiaryId);
    assert.equal(dto.groups[0]?.departmentId, dept);
    assert.equal(dto.groups[0]?.departmentName, "Front");
    assert.equal(dto.groups[0]?.headcount, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record carries episodes, the resolved as-of, and the change-request list", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const party = await mkParty(org.orgId, "Record worker");
    const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
    await mkVersion(org.orgId, employmentId, 1, "active", "2026-01-01", "2026-05-01", "2026-01-01T00:00:00.000001Z");
    await mkVersion(org.orgId, employmentId, 2, "on_leave", "2026-05-01", null, "2026-05-01T00:00:00.000001Z");
    const requestId = await mkDraftRequest(org.orgId, employmentId);

    const record = await getEmploymentRecord({
      orgId: org.orgId,
      actorId: actor,
      employmentId,
      effectiveDate: "2026-06-15",
      knownAt: KNOWN_AT,
    });
    assert.deepEqual(record.episodes.map((episode) => episode.versionNo), [1, 2]);
    assert.equal(record.asOfRefusal, null);
    assert.equal(record.asOf?.version.status, "on_leave");
    assert.equal(record.asOf?.version.versionNo, 2);
    assert.equal(record.changeRequests.length, 1);
    assert.equal(record.changeRequests[0]?.id, requestId);
    assert.equal(record.changeRequests[0]?.status, "draft");
    assert.equal(record.changeRequests[0]?.expectedEmploymentRevision, 1);
    assert.equal(record.changeRequests[0]?.flowRunId, null);

    assert.deepEqual(await findEmploymentsByParty({ orgId: org.orgId, actorId: actor, workerPartyId: party }), [employmentId]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("record carries a missing-version refusal as data beside live episodes", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const party = await mkParty(org.orgId, "Future worker");
    const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
    await mkVersion(org.orgId, employmentId, 1, "offered", "2027-01-01", null, "2026-06-01T00:00:00.000001Z");

    const record = await getEmploymentRecord({
      orgId: org.orgId,
      actorId: actor,
      employmentId,
      effectiveDate: "2026-06-15",
      knownAt: KNOWN_AT,
    });
    assert.equal(record.asOf, null);
    assert.equal(record.asOfRefusal?.code, NoRevisionError.name);
    assert.ok(record.asOfRefusal?.message);
    assert.equal(record.episodes.length, 1);
    // Nobody in service: a resolved zero, and proof the empty name lookups
    // never reach PostgreSQL as an empty IN list.
    const headcount = await getHeadcountAsOf({
      orgId: org.orgId,
      actorId: actor,
      effectiveDate: "2026-06-15",
      knownAt: KNOWN_AT,
    });
    assert.equal(headcount.total, 0);
    assert.deepEqual(headcount.groups, []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("storage refuses an overlapping live version; the ambiguous write never lands", { skip }, async () => {
  // Two applicable revisions at one as-of point are storage-impossible
  // (worker_employment_versions_no_overlap), so the engine ambiguity
  // refusal is defense-in-depth proven unit-side; here the write itself
  // must fail instead of landing a fork the reads would have to survive.
  const org = await createScratchOrg();
  try {
    await enableHrm(org.orgId);
    const party = await mkParty(org.orgId, "Forked worker");
    const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
    await mkVersion(org.orgId, employmentId, 1, "active", "2026-01-01", null, "2026-01-01T00:00:00.000001Z");
    // Drizzle nests the Postgres code under cause; walk it like the
    // schema-owned HRM proofs do.
    const pgCode = (error: unknown): string | undefined => {
      let value = error as { code?: unknown; cause?: unknown } | null;
      for (let depth = 0; depth < 5 && value; depth += 1) {
        if (typeof value.code === "string") return value.code;
        value = (value.cause ?? null) as typeof value;
      }
      return undefined;
    };
    await assert.rejects(
      mkVersion(org.orgId, employmentId, 2, "active", "2026-03-01", null, "2026-03-01T00:00:00.000001Z"),
      (error: unknown) => pgCode(error) === "23P01",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("gate off and missing grant refuse the public boundaries", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    const party = await mkParty(org.orgId, "Gated worker");
    const employmentId = await mkEmployment(org.orgId, party, org.subsidiaryId);
    await mkVersion(org.orgId, employmentId, 1, "active", "2026-01-01", null, "2026-01-01T00:00:00.000001Z");

    // Gate off: every boundary names the Features remedy.
    await assert.rejects(
      getHeadcountAsOf({ orgId: org.orgId, actorId: actor, effectiveDate: "2026-06-15", knownAt: KNOWN_AT }),
      (error: unknown) =>
        error instanceof EmploymentReadError && error.message.includes("Company Settings → Features"),
    );
    await enableHrm(org.orgId);

    // Grant revoked: uniform authorization denial.
    await db.execute(sql`update app_roles set permissions = '[]'::jsonb where org_id = ${org.orgId} and key = 'hrm_reader'`);
    await assert.rejects(
      getHeadcountAsOf({ orgId: org.orgId, actorId: actor, effectiveDate: "2026-06-15", knownAt: KNOWN_AT }),
      HrmAuthorizationError,
    );
    await assert.rejects(
      findEmploymentsByParty({ orgId: org.orgId, actorId: actor, workerPartyId: party }),
      HrmAuthorizationError,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a stranger's employment id is refused, never resolved", { skip }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "HRM reader", "hrm_reader");
    await grantRead(org.orgId, "hrm_reader");
    await enableHrm(org.orgId);
    const party = await mkParty(other.orgId, "Other worker");
    const employmentId = await mkEmployment(other.orgId, party, other.subsidiaryId);
    await mkVersion(other.orgId, employmentId, 1, "active", "2026-01-01", null, "2026-01-01T00:00:00.000001Z");
    await assert.rejects(
      getEmploymentRecord({
        orgId: org.orgId,
        actorId: actor,
        employmentId,
        effectiveDate: "2026-06-15",
        knownAt: KNOWN_AT,
      }),
      HrmAuthorizationError,
    );
  } finally {
    await dropScratchOrg(other.orgId);
    await dropScratchOrg(org.orgId);
  }
});
