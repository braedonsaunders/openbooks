import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  assembleEmploymentAsOf,
  EmploymentReadError,
  loadEmploymentAsOf,
  type EmploymentAsOfQuery,
  type EmploymentVersionRow,
} from "./employment-read.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import type { SqlExecutor } from "../db.ts";
import {
  AmbiguousRevisionError,
  InvalidCivilDateError,
  InvalidRecordedStampError,
  NoRevisionError,
  TemporalError,
} from "./temporal.ts";

// Literal-SQL routing helpers copied from authorization.test.ts so the fake
// runner below serves the REAL requireHrmEmploymentRead SQL, not a stubbed
// authorizer: production has no callback to swap, and neither do these tests.
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  let out = "";
  for (const c of chunks) {
    if (c && typeof c === "object" && Array.isArray((c as { value?: unknown }).value)) {
      out += ((c as { value: string[] }).value).join("");
    }
  }
  return out;
}

function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  for (const c of chunks) {
    if (typeof c === "string") {
      out.push(c);
      continue;
    }
    if (c && typeof c === "object" && "value" in c) {
      const v = (c as { value: unknown }).value;
      if (!Array.isArray(v)) out.push(v);
    }
  }
  return out;
}

function str(params: unknown[], index: number): string {
  const v = params[index];
  assert.equal(typeof v, "string");
  return v as string;
}

interface FakeUser {
  isSuperAdmin: boolean;
  isActive: boolean;
  partyId: string | null;
}

interface FakeEmployment {
  id: string;
  orgId: string;
  workerPartyId: string;
  employerSubsidiaryId: string;
  revision: number;
}

interface FakeEmploymentVersion {
  id: string;
  versionNo: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedUntil: string | null;
}

interface FakeAssignmentVersion {
  id: string;
  assignmentId: string;
  assignmentKey: string;
  versionNo: number;
  jobTitle: string | null;
  departmentId: string | null;
  locationId: string | null;
  fte: string;
  isPrimary: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedUntil: string | null;
}

interface FakeState {
  users: Map<string, FakeUser>;
  roleGrants: Map<string, string[]>;
  denies: Map<string, string[]>;
  employments: Map<string, FakeEmployment>;
  employmentVersions: Map<string, FakeEmploymentVersion[]>;
  assignmentVersions: Map<string, FakeAssignmentVersion[]>;
  seen: string[];
}

function emptyState(): FakeState {
  return {
    users: new Map(),
    roleGrants: new Map(),
    denies: new Map(),
    employments: new Map(),
    employmentVersions: new Map(),
    assignmentVersions: new Map(),
    seen: [],
  };
}

/** Fake runner: routes the real helpers' SQL to in-memory state. */
function fakeExec(state: FakeState): SqlExecutor {
  return {
    execute: (async (query: unknown) => {
      const text = sqlText(query);
      const params = sqlParams(query);
      state.seen.push(text);
      if (/from users/i.test(text)) {
        if (/party_id/i.test(text)) {
          const person = state.users.get(str(params, 1));
          return { rows: person ? [{ id: str(params, 1), partyId: person.partyId }] : [] };
        }
        const user = state.users.get(str(params, 0));
        return { rows: user ? [{ isSuperAdmin: user.isSuperAdmin, isActive: user.isActive }] : [] };
      }
      if (/role_assignments/i.test(text)) {
        if (/subsidiary_restriction/i.test(text)) {
          return { rows: [{ restriction: { mode: "all" as const } }] };
        }
        const grants = state.roleGrants.get(str(params, 0)) ?? [];
        return { rows: grants.length ? [{ permissions: grants }] : [] };
      }
      if (/user_permission_overrides/i.test(text)) {
        const denyList = state.denies.get(str(params, 0)) ?? [];
        return { rows: denyList.map((permission) => ({ permission, effect: "deny" as const })) };
      }
      if (/from subsidiaries/i.test(text)) return { rows: [] };
      // Single-statement snapshot: one row with json aggregates, shaped the
      // way pg parses json_agg(row_to_json(...)) — arrays of aliased objects.
      if (/worker_employment_versions/i.test(text)) {
        const record = state.employments.get(`${str(params, 0)}:${str(params, 1)}`);
        const versions = state.employmentVersions.get(`${str(params, 0)}:${str(params, 1)}`) ?? [];
        const assignments = state.assignmentVersions.get(`${str(params, 0)}:${str(params, 1)}`) ?? [];
        return {
          rows: [{
            revision: record ? record.revision : null,
            employment_versions: versions.map((v) => ({
              id: v.id,
              version_no: v.versionNo,
              status: v.status,
              effective_from: v.effectiveFrom,
              effective_to: v.effectiveTo,
              recorded_at: v.recordedAt,
              recorded_until: v.recordedUntil,
            })),
            assignment_versions: assignments.map((v) => ({
              id: v.id,
              assignment_id: v.assignmentId,
              assignment_key: v.assignmentKey,
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
          }],
        };
      }
      if (/for share/i.test(text)) {
        const record = state.employments.get(`${str(params, 0)}:${str(params, 1)}`);
        return { rows: record ? [{ one: 1 }] : [] };
      }
      if (/from worker_employments/i.test(text)) {
        const record = state.employments.get(`${str(params, 0)}:${str(params, 1)}`);
        return {
          rows: record
            ? [{
                id: record.id,
                orgId: record.orgId,
                workerPartyId: record.workerPartyId,
                employerSubsidiaryId: record.employerSubsidiaryId,
                revision: record.revision,
              }]
            : [],
        };
      }
      throw new Error(`fake runner has no route for: ${text.slice(0, 120)}`);
    }) as SqlExecutor["execute"],
  };
}

const ORG = randomUUID();
const SUB = randomUUID();

function seedEmployment(state: FakeState): FakeEmployment {
  const record: FakeEmployment = {
    id: randomUUID(),
    orgId: ORG,
    workerPartyId: randomUUID(),
    employerSubsidiaryId: SUB,
    revision: 3,
  };
  state.employments.set(`${ORG}:${record.id}`, record);
  return record;
}

function seedUser(state: FakeState, grants: string[]): string {
  const id = randomUUID();
  state.users.set(id, { isSuperAdmin: false, isActive: true, partyId: randomUUID() });
  state.roleGrants.set(id, grants);
  return id;
}

function seedEmploymentVersions(state: FakeState, employmentId: string, versions: FakeEmploymentVersion[]): void {
  state.employmentVersions.set(`${ORG}:${employmentId}`, versions);
}

function seedAssignmentVersions(state: FakeState, employmentId: string, versions: FakeAssignmentVersion[]): void {
  state.assignmentVersions.set(`${ORG}:${employmentId}`, versions);
}

function queryFor(actor: string, employmentId: string, effectiveDate = "2026-06-15", knownAt = "2026-07-01T00:00:00.000001Z"): EmploymentAsOfQuery {
  return { orgId: ORG, actorId: actor, employmentId, effectiveDate, knownAt };
}

function employmentVersion(overrides: Partial<FakeEmploymentVersion> = {}): FakeEmploymentVersion {
  return {
    id: randomUUID(),
    versionNo: 1,
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.123456Z",
    recordedUntil: null,
    ...overrides,
  };
}

function assignmentVersion(overrides: Partial<FakeAssignmentVersion> = {}): FakeAssignmentVersion {
  return {
    id: randomUUID(),
    assignmentId: randomUUID(),
    assignmentKey: "register",
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

test("read resolves through the real gate with exact decimals and version ids", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  const employmentV = employmentVersion();
  seedEmploymentVersions(state, record.id, [employmentV]);
  const slotId = randomUUID();
  const otherId = randomUUID();
  const primary = assignmentVersion({ assignmentId: slotId, assignmentKey: "register", fte: "0.7500", isPrimary: true });
  const secondary = assignmentVersion({ assignmentId: otherId, assignmentKey: "floor", jobTitle: "Floor", fte: "0.2500" });
  seedAssignmentVersions(state, record.id, [primary, secondary]);

  const dto = await loadEmploymentAsOf(exec, queryFor(actor, record.id));

  assert.equal(dto.employmentId, record.id);
  assert.equal(dto.workerPartyId, record.workerPartyId);
  assert.equal(dto.employerSubsidiaryId, SUB);
  assert.equal(dto.revision, 3);
  assert.equal(dto.version.versionId, employmentV.id);
  assert.equal(dto.version.status, "active");
  assert.equal(dto.version.recordedAt, "2026-01-01T00:00:00.123456Z");
  assert.equal(dto.assignments.length, 2);
  assert.deepEqual(dto.assignments.map((a) => a.assignmentKey), ["floor", "register"]);
  assert.equal(dto.assignments[1]?.versionId, primary.id);
  assert.equal(dto.assignments[1]?.fte, "0.7500");
  assert.equal(dto.assignments[1]?.isPrimary, true);
  assert.equal(dto.assignments[1]?.recordedAt, "2026-01-01T00:00:00.654321Z");
  // One snapshot statement serves every slot: no per-slot N+1.
  assert.equal(state.seen.filter((text) => /employment_assignment_versions/i.test(text)).length, 1);
  assert.ok(state.seen.some((text) => /for share/i.test(text)), "aggregate stable row is locked");
});

test("no assignment versions is a legitimate empty list, not a refusal", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  seedAssignmentVersions(state, record.id, []);

  const dto = await loadEmploymentAsOf(exec, queryFor(actor, record.id));
  assert.deepEqual(dto.assignments, []);
});

test("regression: assignment recorded after knownAt is absent, not a failure", async () => {
  // Employment active recorded Jan1; assignment effective Jan1 but first
  // recorded Feb1. At Jan20 the assignment was unknown: the employment read
  // for Jan15 as known Jan20 must succeed with zero assignments.
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  seedAssignmentVersions(state, record.id, [
    assignmentVersion({ effectiveFrom: "2026-01-01", recordedAt: "2026-02-01T00:00:00.000001Z", recordedUntil: null, isPrimary: true }),
  ]);

  const dto = await loadEmploymentAsOf(
    exec,
    queryFor(actor, record.id, "2026-01-15", "2026-01-20T00:00:00.000001Z"),
  );
  assert.equal(dto.version.status, "active");
  assert.deepEqual(dto.assignments, []);
});

test("known-view semantics: the same read after recording includes the assignment", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  const late = assignmentVersion({ effectiveFrom: "2026-01-01", recordedAt: "2026-02-01T00:00:00.000001Z", recordedUntil: null, isPrimary: true });
  seedAssignmentVersions(state, record.id, [late]);

  const dto = await loadEmploymentAsOf(
    exec,
    queryFor(actor, record.id, "2026-01-15", "2026-02-15T00:00:00.000001Z"),
  );
  assert.equal(dto.assignments.length, 1);
  assert.equal(dto.assignments[0]?.versionId, late.id);
});

test("regression: a superseded January assignment does not fail February reads", async () => {
  // Correction closes the January assignment (recordedUntil Mar1) and
  // replaces it effective March. A February read as known in April must
  // succeed without the withdrawn slot.
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  const slotId = randomUUID();
  seedAssignmentVersions(state, record.id, [
    assignmentVersion({
      assignmentId: slotId, assignmentKey: "register", versionNo: 1, isPrimary: true,
      effectiveFrom: "2026-01-01", effectiveTo: "2026-03-01",
      recordedAt: "2026-01-01T00:00:00.000001Z", recordedUntil: "2026-03-01T00:00:00.000001Z",
    }),
    assignmentVersion({
      assignmentId: slotId, assignmentKey: "register", versionNo: 2, isPrimary: true,
      effectiveFrom: "2026-03-01", effectiveTo: null,
      recordedAt: "2026-03-01T00:00:00.000001Z", recordedUntil: null,
    }),
  ]);

  const dto = await loadEmploymentAsOf(
    exec,
    queryFor(actor, record.id, "2026-02-15", "2026-04-01T00:00:00.000001Z"),
  );
  assert.equal(dto.version.status, "active");
  assert.deepEqual(dto.assignments, []);
});

test("two live applicable assignment revisions are still refused", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  const slotId = randomUUID();
  seedAssignmentVersions(state, record.id, [
    assignmentVersion({ assignmentId: slotId, assignmentKey: "a", versionNo: 1, recordedAt: "2026-01-01T00:00:00.000001Z", recordedUntil: null }),
    assignmentVersion({ assignmentId: slotId, assignmentKey: "a", versionNo: 2, recordedAt: "2026-01-02T00:00:00.000001Z", recordedUntil: null }),
  ]);

  await assert.rejects(loadEmploymentAsOf(exec, queryFor(actor, record.id)), AmbiguousRevisionError);
});

test("no employment version covering the as-of point is refused, never null", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion({ effectiveFrom: "2026-08-01" })]);

  await assert.rejects(
    loadEmploymentAsOf(exec, queryFor(actor, record.id)),
    (error: unknown) => error instanceof NoRevisionError,
  );
});

test("two primary assignments at one as-of point are refused", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  seedAssignmentVersions(state, record.id, [
    assignmentVersion({ assignmentKey: "a", isPrimary: true }),
    assignmentVersion({ assignmentKey: "b", isPrimary: true }),
  ]);

  await assert.rejects(loadEmploymentAsOf(exec, queryFor(actor, record.id)), AmbiguousRevisionError);
});

test("authorization denial surfaces unchanged through the real gate", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["gl.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);

  await assert.rejects(
    loadEmploymentAsOf(exec, queryFor(actor, record.id)),
    (error: unknown) => error instanceof HrmAuthorizationError && /hrm\.employment\.read/.test(error.message),
  );
});

test("an employment from another organization is not visible", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);

  await assert.rejects(
    loadEmploymentAsOf(exec, { ...queryFor(actor, record.id), employmentId: randomUUID() }),
    HrmAuthorizationError,
  );
});

test("inputs are validated before the database is touched", async () => {
  let calls = 0;
  const boom: SqlExecutor = {
    execute: (() => {
      calls += 1;
      throw new Error("database must not be reached");
    }) as SqlExecutor["execute"],
  };
  const base = queryFor(randomUUID(), randomUUID());
  await assert.rejects(loadEmploymentAsOf(boom, { ...base, orgId: "" }), EmploymentReadError);
  await assert.rejects(loadEmploymentAsOf(boom, { ...base, effectiveDate: "June 15" }), InvalidCivilDateError);
  await assert.rejects(
    loadEmploymentAsOf(boom, { ...base, knownAt: "2026-07-01T00:00:00.000001Z\n" }),
    InvalidRecordedStampError,
  );
  assert.equal(calls, 0);
});

test("a version row without an id is refused: snapshots need the handle", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion({ id: "" })]);

  await assert.rejects(loadEmploymentAsOf(exec, queryFor(actor, record.id)), EmploymentReadError);
});

test("a forked stable identity (one slot, two keys) is refused", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  seedEmploymentVersions(state, record.id, [employmentVersion()]);
  const slotId = randomUUID();
  seedAssignmentVersions(state, record.id, [
    assignmentVersion({ assignmentId: slotId, assignmentKey: "a" }),
    assignmentVersion({ assignmentId: slotId, assignmentKey: "b", versionNo: 2, recordedAt: "2026-02-01T00:00:00.000001Z", recordedUntil: null }),
  ]);

  await assert.rejects(loadEmploymentAsOf(exec, queryFor(actor, record.id)), EmploymentReadError);
});

test("missing employment is a named refusal, not an empty DTO", () => {
  assert.throws(
    () =>
      assembleEmploymentAsOf(
        null,
        [],
        [],
        { effectiveDate: "2026-06-15", knownAt: "2026-07-01T00:00:00.000001Z" },
      ),
    (error: unknown) => error instanceof EmploymentReadError && /not found/.test(error.message),
  );
});

test("refusals are TemporalError-coded errors, never silent values", () => {
  const stable = {
    id: randomUUID(),
    orgId: ORG,
    workerPartyId: randomUUID(),
    employerSubsidiaryId: SUB,
    revision: 1,
  };
  const row = (overrides: Partial<EmploymentVersionRow> = {}): EmploymentVersionRow => ({
    id: randomUUID(),
    versionNo: 1,
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.000001Z",
    recordedUntil: null,
    ...overrides,
  });
  for (const fn of [
    () => assembleEmploymentAsOf(stable, [], [], { effectiveDate: "2026-06-15", knownAt: "2026-07-01T00:00:00.000001Z" }),
    () =>
      assembleEmploymentAsOf(stable, [row({ effectiveFrom: "2026-08-01" })], [], {
        effectiveDate: "2026-06-15",
        knownAt: "2026-07-01T00:00:00.000001Z",
      }),
  ]) {
    assert.throws(fn, (error: unknown) => error instanceof TemporalError && error.code === "NO_REVISION");
  }
});
