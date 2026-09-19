import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  EmploymentReadError,
  loadEmploymentsByParty,
  loadEmploymentChangeRequests,
  loadEmploymentEpisodes,
  loadHeadcountAsOf,
} from "./employment-read.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import type { SqlExecutor } from "../db.ts";
import { AmbiguousRevisionError } from "./temporal.ts";

// Unit proof for the HRM read-surface loaders (headcount, episodes,
// change-request list, party resolution). The fake runner serves the REAL
// SQL each loader issues — including the real authorization and scope
// queries — so these tests pin behavior, not stubs. Public-boundary
// transactions and the feature gate are covered DB-backed in
// employment-read-surface.integration.test.ts.

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
  grants: string[];
  restriction: { mode: "all" } | { mode: "list"; subsidiaryIds: string[] };
}

interface FakeEmployment {
  id: string;
  workerPartyId: string;
  employerSubsidiaryId: string | null;
  revision: number;
}

interface FakeVersion {
  id: string;
  versionNo: number;
  status: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedUntil: string | null;
}

interface FakeAssignment {
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

interface FakeRequest {
  id: string;
  status: string;
  requestRevision: number;
  expectedEmploymentRevision: number;
  payloadSchemaVersion: string;
  reason: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  flowRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FakeState {
  users: Map<string, FakeUser>;
  employments: Map<string, FakeEmployment>;
  versions: Map<string, FakeVersion[]>;
  assignments: Map<string, FakeAssignment[]>;
  requests: Map<string, FakeRequest[]>;
  subsidiaries: Map<string, string>;
  departments: Map<string, string>;
}

function emptyState(): FakeState {
  return {
    users: new Map(),
    employments: new Map(),
    versions: new Map(),
    assignments: new Map(),
    requests: new Map(),
    subsidiaries: new Map(),
    departments: new Map(),
  };
}

function versionJson(employmentId: string, v: FakeVersion): Record<string, unknown> {
  return {
    id: v.id,
    employment_id: employmentId,
    version_no: v.versionNo,
    status: v.status,
    effective_from: v.effectiveFrom,
    effective_to: v.effectiveTo,
    recorded_at: v.recordedAt,
    recorded_until: v.recordedUntil,
  };
}

function assignmentJson(employmentId: string, v: FakeAssignment): Record<string, unknown> {
  return {
    id: v.id,
    employment_id: employmentId,
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
  };
}

function fakeExec(state: FakeState, org: string): SqlExecutor {
  return {
    execute: (async (query: unknown) => {
      const text = sqlText(query);
      const params = sqlParams(query);
      if (/from users/i.test(text)) {
        const user = state.users.get(str(params, 0));
        if (/party_id/i.test(text)) return { rows: user ? [{ id: str(params, 0), partyId: null }] : [] };
        return { rows: user ? [{ isSuperAdmin: false, isActive: true }] : [] };
      }
      if (/subsidiary_restriction/i.test(text)) {
        const user = state.users.get(str(params, 0));
        return { rows: [{ restriction: user?.restriction ?? { mode: "all" } }] };
      }
      if (/role_assignments assignment/i.test(text)) {
        const user = state.users.get(str(params, 0));
        return { rows: user ? [{ permissions: user.grants }] : [] };
      }
      if (/user_permission_overrides/i.test(text)) return { rows: [] };
      if (/hrm_employment_change_requests/i.test(text)) {
        // The select list interpolates the recorded-stamp format literal
        // before the ids — locate the employment param, never assume index 1.
        const employmentId = params.find((param) => typeof param === "string" && state.requests.has(param));
        const list = [...((typeof employmentId === "string" ? state.requests.get(employmentId) : undefined) ?? [])]
          // The loader orders newest-first; the fake honors the same contract.
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
        return {
          rows: list.map((r) => ({
            id: r.id,
            status: r.status,
            request_revision: r.requestRevision,
            expected_employment_revision: r.expectedEmploymentRevision,
            payload_schema_version: r.payloadSchemaVersion,
            reason: r.reason,
            submitted_by: r.submittedBy,
            submitted_at: r.submittedAt,
            flow_run_id: r.flowRunId,
            decision_snapshot: null,
            applied_at: null,
            applied_by: null,
            applied_employment_revision: null,
            applied_employment_change_id: null,
            created_at: r.createdAt,
            updated_at: r.updatedAt,
          })),
        };
      }
      // The single-employment snapshot mentions both version tables; the
      // batched headcount reads mention one each with an IN list.
      if (/worker_employment_versions/i.test(text)) {
        if (/\bin\s*\(/i.test(text)) {
          const rows: Record<string, unknown>[] = [];
          for (const [employmentId, list] of state.versions) rows.push(...list.map((v) => versionJson(employmentId, v)));
          return { rows };
        }
        const employmentId = str(params, 1);
        const record = state.employments.get(employmentId);
        return {
          rows: [{
            revision: record ? record.revision : null,
            employment_versions: (state.versions.get(employmentId) ?? []).map((v) => versionJson(employmentId, v)),
            assignment_versions: (state.assignments.get(employmentId) ?? []).map((v) => assignmentJson(employmentId, v)),
          }],
        };
      }
      if (/employment_assignment_versions/i.test(text)) {
        const rows: Record<string, unknown>[] = [];
        for (const [employmentId, list] of state.assignments) rows.push(...list.map((v) => assignmentJson(employmentId, v)));
        return { rows };
      }
      if (/for share/i.test(text)) {
        return { rows: state.employments.has(str(params, 1)) ? [{ one: 1 }] : [] };
      }
      if (/from worker_employments/i.test(text)) {
        // The authorization subject query also projects worker_party_id —
        // only the party-resolution query filters on it.
        if (/worker_party_id\s*=/i.test(text)) {
          return {
            rows: [...state.employments.values()]
              .filter((e) => e.workerPartyId === str(params, 1))
              .map((e) => ({ id: e.id, employerSubsidiaryId: e.employerSubsidiaryId })),
          };
        }
        if (params.length === 1) {
          // The headcount census: org scope only, no employment predicate.
          return {
            rows: [...state.employments.values()].map((e) => ({
              id: e.id,
              workerPartyId: e.workerPartyId,
              employerSubsidiaryId: e.employerSubsidiaryId,
              revision: e.revision,
            })),
          };
        }
        const record = state.employments.get(str(params, 1));
        return {
          rows: record
            ? [{
                id: record.id,
                orgId: org,
                workerPartyId: record.workerPartyId,
                employerSubsidiaryId: record.employerSubsidiaryId,
                revision: record.revision,
              }]
            : [],
        };
      }
      if (/from subsidiaries/i.test(text)) {
        if (/\bin\s*\(/i.test(text)) {
          return { rows: [...state.subsidiaries.entries()].map(([id, name]) => ({ id, name })) };
        }
        return { rows: [] };
      }
      if (/from departments/i.test(text)) {
        return { rows: [...state.departments.entries()].map(([id, name]) => ({ id, name })) };
      }
      throw new Error(`fake runner has no route for: ${text.slice(0, 120)}`);
    }) as SqlExecutor["execute"],
  };
}

const ORG = randomUUID();
const SUB_A = randomUUID();
const SUB_B = randomUUID();
const DEPT_SALES = randomUUID();

function seedReader(state: FakeState): string {
  const id = randomUUID();
  state.users.set(id, { grants: ["hrm.employment.read"], restriction: { mode: "all" } });
  return id;
}

function seedEmployment(
  state: FakeState,
  overrides: Partial<FakeEmployment> & { workerPartyId: string },
): FakeEmployment {
  const record: FakeEmployment = {
    id: randomUUID(),
    employerSubsidiaryId: SUB_A,
    revision: 1,
    ...overrides,
  };
  state.employments.set(record.id, record);
  state.subsidiaries.set(SUB_A, "Alpha");
  state.subsidiaries.set(SUB_B, "Beta");
  state.departments.set(DEPT_SALES, "Sales");
  return record;
}

function activeVersion(overrides: Partial<FakeVersion> = {}): FakeVersion {
  return {
    id: randomUUID(),
    versionNo: 1,
    status: "active",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.000001Z",
    recordedUntil: null,
    ...overrides,
  };
}

function primaryAssignment(overrides: Partial<FakeAssignment> = {}): FakeAssignment {
  return {
    id: randomUUID(),
    assignmentId: randomUUID(),
    assignmentKey: "primary",
    versionNo: 1,
    jobTitle: "Cashier",
    departmentId: DEPT_SALES,
    locationId: null,
    fte: "1.0000",
    isPrimary: true,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    recordedAt: "2026-01-01T00:00:00.000001Z",
    recordedUntil: null,
    ...overrides,
  };
}

const ASOF = { effectiveDate: "2026-06-15", knownAt: "2026-07-01T00:00:00.000001Z" };

test("headcount resolves through temporal primitives and groups by subsidiary and department", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const employment = seedEmployment(state, { workerPartyId: randomUUID() });
  state.versions.set(employment.id, [activeVersion()]);
  state.assignments.set(employment.id, [primaryAssignment()]);
  const dto = await loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF });
  assert.equal(dto.total, 1);
  assert.deepEqual(dto.groups, [{
    employerSubsidiaryId: SUB_A,
    employerSubsidiaryName: "Alpha",
    departmentId: DEPT_SALES,
    departmentName: "Sales",
    headcount: 1,
  }]);
});

test("headcount counts on-leave but not offered, suspended, or terminated revisions", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  for (const status of ["active", "on_leave", "offered", "suspended", "terminated"]) {
    const employment = seedEmployment(state, { workerPartyId: randomUUID() });
    state.versions.set(employment.id, [activeVersion({ status })]);
  }
  const dto = await loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF });
  assert.equal(dto.total, 2);
  assert.equal(dto.groups.reduce((sum, group) => sum + group.headcount, 0), 2);
});

test("headcount skips employments with no applicable revision instead of failing", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const future = seedEmployment(state, { workerPartyId: randomUUID() });
  state.versions.set(future.id, [activeVersion({ effectiveFrom: "2027-01-01", recordedAt: "2026-06-01T00:00:00.000001Z" })]);
  const dto = await loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF });
  assert.equal(dto.total, 0);
  assert.deepEqual(dto.groups, []);
});

test("headcount refuses on ambiguity instead of undercounting", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const employment = seedEmployment(state, { workerPartyId: randomUUID() });
  state.versions.set(employment.id, [
    activeVersion({ effectiveFrom: "2026-01-01", effectiveTo: null }),
    activeVersion({ versionNo: 2, effectiveFrom: "2026-03-01", effectiveTo: null, recordedAt: "2026-03-01T00:00:00.000001Z" }),
  ]);
  await assert.rejects(
    loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF }),
    AmbiguousRevisionError,
  );
});

test("headcount without the grant is a coded refusal, never a zero", async () => {
  const state = emptyState();
  const actor = randomUUID();
  state.users.set(actor, { grants: [], restriction: { mode: "all" } });
  const employment = seedEmployment(state, { workerPartyId: randomUUID() });
  state.versions.set(employment.id, [activeVersion()]);
  await assert.rejects(
    loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF }),
    HrmAuthorizationError,
  );
});

test("headcount filters employments outside the actor's subsidiary scope", async () => {
  const state = emptyState();
  const actor = randomUUID();
  state.users.set(actor, { grants: ["hrm.employment.read"], restriction: { mode: "list", subsidiaryIds: [SUB_A] } });
  const inside = seedEmployment(state, { workerPartyId: randomUUID(), employerSubsidiaryId: SUB_A });
  const outside = seedEmployment(state, { workerPartyId: randomUUID(), employerSubsidiaryId: SUB_B });
  state.versions.set(inside.id, [activeVersion()]);
  state.versions.set(outside.id, [activeVersion()]);
  const dto = await loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF });
  assert.equal(dto.total, 1);
  assert.equal(dto.groups[0]?.employerSubsidiaryId, SUB_A);
});

test("headcount refuses a count it cannot attribute to a named subsidiary", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const employment = seedEmployment(state, { workerPartyId: randomUUID() });
  state.versions.set(employment.id, [activeVersion()]);
  state.subsidiaries.delete(SUB_A);
  await assert.rejects(
    loadHeadcountAsOf(fakeExec(state, ORG), { orgId: ORG, actorId: actor, ...ASOF }),
    EmploymentReadError,
  );
});

test("episodes list every version oldest-first under the employment gate", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const employment = seedEmployment(state, { workerPartyId: randomUUID(), revision: 2 });
  state.versions.set(employment.id, [
    activeVersion({ versionNo: 2, status: "on_leave", effectiveFrom: "2026-04-01", recordedAt: "2026-04-01T00:00:00.000001Z" }),
    activeVersion(),
  ]);
  const dto = await loadEmploymentEpisodes(fakeExec(state, ORG), { orgId: ORG, actorId: actor, employmentId: employment.id });
  assert.equal(dto.employmentId, employment.id);
  assert.equal(dto.revision, 2);
  assert.deepEqual(dto.episodes.map((episode) => episode.versionNo), [1, 2]);
  assert.equal(dto.episodes[1]?.status, "on_leave");
});

test("episodes for an invisible employment refuse uniformly, never an empty list", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  await assert.rejects(
    loadEmploymentEpisodes(fakeExec(state, ORG), { orgId: ORG, actorId: actor, employmentId: randomUUID() }),
    HrmAuthorizationError,
  );
});

test("change requests list newest-first with revision binding and the run anchor", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  const employment = seedEmployment(state, { workerPartyId: randomUUID() });
  const runId = randomUUID();
  state.requests.set(employment.id, [
    {
      id: randomUUID(), status: "draft", requestRevision: 1, expectedEmploymentRevision: 1,
      payloadSchemaVersion: "1", reason: null, submittedBy: null, submittedAt: null, flowRunId: null,
      createdAt: "2026-06-01T00:00:00.000001Z", updatedAt: "2026-06-01T00:00:00.000001Z",
    },
    {
      id: randomUUID(), status: "pending_approval", requestRevision: 2, expectedEmploymentRevision: 1,
      payloadSchemaVersion: "1", reason: "promotion", submittedBy: randomUUID(),
      submittedAt: "2026-06-02T00:00:00.000001Z", flowRunId: runId,
      createdAt: "2026-06-02T00:00:00.000001Z", updatedAt: "2026-06-02T00:00:00.000001Z",
    },
  ]);
  const rows = await loadEmploymentChangeRequests(fakeExec(state, ORG), { orgId: ORG, actorId: actor, employmentId: employment.id });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.status, "pending_approval");
  assert.equal(rows[0]?.expectedEmploymentRevision, 1);
  assert.equal(rows[0]?.flowRunId, runId);
  assert.equal(rows[1]?.flowRunId, null);
});

test("change requests for an invisible employment refuse uniformly", async () => {
  const state = emptyState();
  const actor = seedReader(state);
  await assert.rejects(
    loadEmploymentChangeRequests(fakeExec(state, ORG), { orgId: ORG, actorId: actor, employmentId: randomUUID() }),
    HrmAuthorizationError,
  );
});

test("party resolution returns scoped ids and an honest empty, never null", async () => {
  const state = emptyState();
  const actor = randomUUID();
  state.users.set(actor, { grants: ["hrm.employment.read"], restriction: { mode: "list", subsidiaryIds: [SUB_A] } });
  const party = randomUUID();
  const inside = seedEmployment(state, { workerPartyId: party, employerSubsidiaryId: SUB_A });
  seedEmployment(state, { workerPartyId: party, employerSubsidiaryId: SUB_B });
  seedEmployment(state, { workerPartyId: party, employerSubsidiaryId: null });
  const ids = await loadEmploymentsByParty(fakeExec(state, ORG), { orgId: ORG, actorId: actor, workerPartyId: party });
  assert.deepEqual(ids, [inside.id]);
  assert.deepEqual(
    await loadEmploymentsByParty(fakeExec(state, ORG), { orgId: ORG, actorId: actor, workerPartyId: randomUUID() }),
    [],
  );
});
