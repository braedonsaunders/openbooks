import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleEmploymentAsOf,
  EmploymentReadError,
  loadEmploymentAsOf,
  type AssignmentVersionRow,
  type EmploymentAsOfQuery,
  type EmploymentVersionRow,
} from "./employment-read.ts";
import { HrmAuthorizationError, type TrustedEmploymentSubject } from "./authorization.ts";
import type { SqlExecutor } from "../db.ts";
import {
  AmbiguousRevisionError,
  InvalidCivilDateError,
  InvalidRecordedStampError,
  NoRevisionError,
  TemporalError,
} from "./temporal.ts";

const QUERY: EmploymentAsOfQuery = {
  orgId: "11111111-1111-4111-8111-111111111111",
  actorId: "22222222-2222-4222-8222-222222222222",
  employmentId: "33333333-3333-4333-8333-333333333333",
  effectiveDate: "2026-06-15",
  knownAt: "2026-07-01T00:00:00.000001Z",
};

const STABLE = {
  id: QUERY.employmentId,
  orgId: QUERY.orgId,
  workerPartyId: "44444444-4444-4444-8444-444444444444",
  employerSubsidiaryId: "55555555-5555-4555-8555-555555555555",
  revision: 3,
};

function employmentVersion(overrides: Partial<EmploymentVersionRow> = {}): EmploymentVersionRow {
  return {
    versionNo: 1,
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.123456Z",
    recordedUntil: null,
    ...overrides,
  };
}

function assignmentVersion(overrides: Partial<AssignmentVersionRow> = {}): AssignmentVersionRow {
  return {
    versionNo: 1,
    jobTitle: "Cashier",
    departmentId: null,
    locationId: null,
    fte: "1.0000",
    isPrimary: false,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.654321Z",
    recordedUntil: null,
    ...overrides,
  };
}

function slot(key: string, versions: AssignmentVersionRow[]) {
  return { slot: { id: `slot-${key}`, assignmentKey: key }, versions };
}

test("resolves the live employment version with simultaneous assignments and exact decimals", () => {
  const dto = assembleEmploymentAsOf(
    STABLE,
    [
      employmentVersion({ versionNo: 1, status: "offered", effectiveFrom: "2026-01-01", effectiveTo: "2026-03-01", recordedAt: "2026-01-01T00:00:00.000001Z", recordedUntil: "2026-02-01T00:00:00.000002Z" }),
      employmentVersion({ versionNo: 2, status: "active", effectiveFrom: "2026-03-01", effectiveTo: null, recordedAt: "2026-02-01T00:00:00.000002Z", recordedUntil: null }),
    ],
    [
      slot("register", [assignmentVersion({ fte: "0.7500", isPrimary: true })]),
      slot("floor", [assignmentVersion({ jobTitle: "Floor", fte: "0.2500", isPrimary: false })]),
    ],
    QUERY,
  );
  assert.equal(dto.employmentId, STABLE.id);
  assert.equal(dto.workerPartyId, STABLE.workerPartyId);
  assert.equal(dto.employerSubsidiaryId, STABLE.employerSubsidiaryId);
  assert.equal(dto.revision, 3);
  assert.equal(dto.version.status, "active");
  assert.equal(dto.version.versionNo, 2);
  // Microseconds survive: the recorded stamps are text, never JS Dates.
  assert.equal(dto.version.recordedAt, "2026-02-01T00:00:00.000002Z");
  assert.equal(dto.assignments.length, 2);
  assert.deepEqual(dto.assignments.map((a) => a.assignmentKey), ["floor", "register"]);
  assert.equal(dto.assignments[0]?.fte, "0.2500");
  assert.equal(dto.assignments[1]?.fte, "0.7500");
  assert.equal(dto.assignments[1]?.isPrimary, true);
  assert.equal(dto.assignments[1]?.recordedAt, "2026-01-01T00:00:00.654321Z");
});

test("no assignment slots is a legitimate empty list, not a refusal", () => {
  const dto = assembleEmploymentAsOf(STABLE, [employmentVersion()], [], QUERY);
  assert.deepEqual(dto.assignments, []);
});

test("a slot holding nothing on the effective date is excluded", () => {
  const dto = assembleEmploymentAsOf(
    STABLE,
    [employmentVersion()],
    [
      slot("register", [assignmentVersion({ isPrimary: true })]),
      slot("future", [assignmentVersion({ effectiveFrom: "2026-09-01", effectiveTo: null })]),
    ],
    QUERY,
  );
  assert.deepEqual(dto.assignments.map((a) => a.assignmentKey), ["register"]);
});

test("no employment version covering the as-of point is refused, never null", () => {
  assert.throws(
    () => assembleEmploymentAsOf(STABLE, [employmentVersion({ effectiveFrom: "2026-08-01" })], [], QUERY),
    (error: unknown) => error instanceof NoRevisionError,
  );
});

test("two live employment revisions are refused as ambiguous", () => {
  assert.throws(
    () =>
      assembleEmploymentAsOf(
        STABLE,
        [
          employmentVersion({ versionNo: 1, recordedAt: "2026-01-01T00:00:00.000001Z", recordedUntil: null }),
          employmentVersion({ versionNo: 2, recordedAt: "2026-01-02T00:00:00.000001Z", recordedUntil: null }),
        ],
        [],
        QUERY,
      ),
    (error: unknown) => error instanceof AmbiguousRevisionError,
  );
});

test("two primary assignments at one as-of point are refused", () => {
  assert.throws(
    () =>
      assembleEmploymentAsOf(
        STABLE,
        [employmentVersion()],
        [
          slot("a", [assignmentVersion({ isPrimary: true })]),
          slot("b", [assignmentVersion({ isPrimary: true })]),
        ],
        QUERY,
      ),
    (error: unknown) => error instanceof AmbiguousRevisionError,
  );
});

test("a slot with a recorded gap at knownAt is refused, not silently dropped", () => {
  assert.throws(
    () =>
      assembleEmploymentAsOf(
        STABLE,
        [employmentVersion()],
        [
          slot("register", [
            assignmentVersion({ versionNo: 1, recordedAt: "2026-01-01T00:00:00.000001Z", recordedUntil: "2026-02-01T00:00:00.000001Z" }),
            assignmentVersion({ versionNo: 2, recordedAt: "2026-03-01T00:00:00.000001Z", recordedUntil: null }),
          ]),
        ],
        { effectiveDate: QUERY.effectiveDate, knownAt: "2026-02-15T00:00:00.000001Z" },
      ),
    (error: unknown) => error instanceof NoRevisionError,
  );
});

test("malformed effective and knownAt inputs are refused before any read", () => {
  assert.throws(
    () => assembleEmploymentAsOf(STABLE, [employmentVersion()], [], { ...QUERY, effectiveDate: "2026-02-30" }),
    (error: unknown) => error instanceof InvalidCivilDateError,
  );
  assert.throws(
    () => assembleEmploymentAsOf(STABLE, [], [], { ...QUERY, knownAt: "not-an-instant" }),
    (error: unknown) => error instanceof InvalidRecordedStampError,
  );
  assert.throws(
    () => assembleEmploymentAsOf(STABLE, [employmentVersion()], [], { ...QUERY, knownAt: "2026-07-01T00:00:00.000001Z\n" }),
    (error: unknown) => error instanceof InvalidRecordedStampError,
  );
});

test("missing employment is a named refusal, not an empty DTO", () => {
  assert.throws(
    () => assembleEmploymentAsOf(null, [], [], QUERY),
    (error: unknown) => error instanceof EmploymentReadError && /not found/.test(error.message),
  );
});

test("refusals are TemporalError-coded errors, never silent values", () => {
  for (const fn of [
    () => assembleEmploymentAsOf(STABLE, [], [], QUERY),
    () => assembleEmploymentAsOf(STABLE, [employmentVersion({ effectiveFrom: "2026-08-01" })], [], QUERY),
  ]) {
    assert.throws(fn, (error: unknown) => error instanceof TemporalError && error.code === "NO_REVISION");
  }
});

/** Test-only stand-in: the real subject is branded by authorization.ts and only its loader produces it. */
function testSubject(): TrustedEmploymentSubject {
  return {
    id: STABLE.id,
    orgId: STABLE.orgId,
    workerPartyId: STABLE.workerPartyId,
    employerSubsidiaryId: STABLE.employerSubsidiaryId,
    revision: STABLE.revision,
  } as unknown as TrustedEmploymentSubject;
}

/** Sequence fake: authorize, then versions, slots, then per-slot versions in slot order. */
function sequenceExec(tables: { versions: EmploymentVersionRow[]; slots: { key: string; versions: AssignmentVersionRow[] }[] }): SqlExecutor {
  let step = 0;
  return {
    execute: (async (query: unknown) => {
      void query;
      step += 1;
      if (step === 1) {
        return {
          rows: tables.versions.map((v) => ({
            version_no: v.versionNo,
            status: v.status,
            effective_from: v.effectiveFrom,
            effective_to: v.effectiveTo,
            recorded_at: v.recordedAt,
            recorded_until: v.recordedUntil,
          })),
        };
      }
      if (step === 2) {
        return { rows: tables.slots.map((s, index) => ({ id: `slot-${index}`, assignment_key: s.key })) };
      }
      const slotIndex = step - 3;
      const found = tables.slots[slotIndex];
      assert.ok(found, `unexpected query step ${step}`);
      return {
        rows: found.versions.map((v) => ({
          version_no: v.versionNo,
          job_title: v.jobTitle,
          department_id: v.departmentId,
          location_id: v.locationId,
          fte: v.fte,
          is_primary: v.isPrimary,
          effective_from: v.effectiveFrom,
          effective_to: v.effectiveTo,
          recorded_at: v.recordedAt,
          recorded_until: v.recordedUntil,
        })),
      };
    }) as SqlExecutor["execute"],
  };
}

test("loadEmploymentAsOf reuses the trusted subject and assembles the DTO", async () => {
  let authorized: { orgId: string; actorId: string; employmentId: string } | null = null;
  const exec = sequenceExec({
    versions: [employmentVersion()],
    slots: [{ key: "register", versions: [assignmentVersion({ fte: "0.5000", isPrimary: true })] }],
  });
  const dto = await loadEmploymentAsOf(
    exec,
    QUERY,
    async (_exec, orgId, actorId, employmentId) => {
      authorized = { orgId, actorId, employmentId };
      return testSubject();
    },
  );
  assert.deepEqual(authorized, { orgId: QUERY.orgId, actorId: QUERY.actorId, employmentId: QUERY.employmentId });
  assert.equal(dto.employmentId, STABLE.id);
  assert.equal(dto.orgId, STABLE.orgId);
  assert.equal(dto.workerPartyId, STABLE.workerPartyId);
  assert.equal(dto.assignments.length, 1);
  assert.equal(dto.assignments[0]?.fte, "0.5000");
});

test("loadEmploymentAsOf surfaces the authorization denial unchanged", async () => {
  const denied = new HrmAuthorizationError("Employment access requires the hrm.employment.read permission.");
  await assert.rejects(
    loadEmploymentAsOf(sequenceExec({ versions: [], slots: [] }), QUERY, async () => {
      throw denied;
    }),
    (error: unknown) => error instanceof HrmAuthorizationError,
  );
});

test("loadEmploymentAsOf validates ids and dates before touching the database", async () => {
  const boom: SqlExecutor = {
    execute: (() => {
      throw new Error("database must not be reached");
    }) as SqlExecutor["execute"],
  };
  const stub = async () => testSubject();
  await assert.rejects(loadEmploymentAsOf(boom, { ...QUERY, orgId: "" }, stub), EmploymentReadError);
  await assert.rejects(loadEmploymentAsOf(boom, { ...QUERY, effectiveDate: "June 15" }, stub), InvalidCivilDateError);
});
