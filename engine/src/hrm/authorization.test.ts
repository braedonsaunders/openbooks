import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";

// Static imports evaluate before the module body, so in-file assignments
// cannot guard the import-time database-environment resolution in db.ts.
// The launch command MUST set OPENBOOKS_DB_URL= (and the migration URL)
// explicitly; these assignments only re-assert that for anything resolved
// lazily afterwards. These tests never touch a real database — a
// missing-user or cross-org super-admin case cannot be proven on this
// fake (actorIdentity falls back to the global db when its local row is
// absent). Those cases live in authorization.integration.test.ts so the
// integration partition selects them.
process.env.OPENBOOKS_DB_URL = "";
process.env.OPENBOOKS_MIGRATION_DB_URL = "";

const {
  checkApprovalIdentitySeparation,
  HrmAuthorizationError,
  loadActorPerson,
  loadApprovalPerson,
  loadPartyEmployerSubsidiaries,
  requireEmploymentRowInScope,
  requireHrmEmploymentApprove,
  requireHrmEmploymentManage,
  requireHrmEmploymentRead,
  requirePartyInScope,
  requireRowSubjectInScope,
  requireUnrestrictedHrmScope,
} = await import("./authorization.ts");
const { UnrestrictedScopeError } = await import("../organization/subsidiary-scope.ts");

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

interface FakeState {
  users: Map<string, FakeUser>;
  roleGrants: Map<string, string[]>;
  denies: Map<string, string[]>;
  restrictions: Map<string, { mode: "all" } | { mode: "list"; subsidiaryIds: string[] }>;
  employments: Map<string, FakeEmployment>;
}

function emptyState(): FakeState {
  return { users: new Map(), roleGrants: new Map(), denies: new Map(), restrictions: new Map(), employments: new Map() };
}

/** Literal SQL text from a drizzle query (same approach as revenue-recognition.test.ts). */
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

/** Bound parameter values, in order, from a drizzle query. */
function sqlParams(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] } | null)?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const out: unknown[] = [];
  for (const c of chunks) {
    // This drizzle version inlines interpolated values as raw strings
    // between StringChunks; keep the older Param-object shape too.
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

/** Fake runner: routes the real helpers' SQL to in-memory state. */
function fakeExec(state: FakeState): SqlExecutor {
  return {
    execute: (async (query: unknown) => {
      const text = sqlText(query);
      const params = sqlParams(query);
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
          const restriction = state.restrictions.get(str(params, 0)) ?? { mode: "all" as const };
          return { rows: [{ restriction }] };
        }
        const grants = state.roleGrants.get(str(params, 0)) ?? [];
        return { rows: grants.length ? [{ permissions: grants }] : [] };
      }
      if (/user_permission_overrides/i.test(text)) {
        const denyList = state.denies.get(str(params, 0)) ?? [];
        return { rows: denyList.map((permission) => ({ permission, effect: "deny" as const })) };
      }
      if (/from subsidiaries/i.test(text)) return { rows: [] };
      if (/from worker_employments/i.test(text)) {
        if (/distinct employer_subsidiary_id/i.test(text)) {
          const seen = new Set<string>();
          const rows: { employerSubsidiaryId: string }[] = [];
          for (const record of state.employments.values()) {
            if (record.orgId !== str(params, 0) || record.workerPartyId !== str(params, 1)) continue;
            if (seen.has(record.employerSubsidiaryId)) continue;
            seen.add(record.employerSubsidiaryId);
            rows.push({ employerSubsidiaryId: record.employerSubsidiaryId });
          }
          return { rows };
        }
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
const SUB_A = randomUUID();
const SUB_B = randomUUID();

function seedEmployment(state: FakeState, orgId = ORG, subsidiaryId = SUB_A): FakeEmployment {
  const record: FakeEmployment = {
    id: randomUUID(),
    orgId,
    workerPartyId: randomUUID(),
    employerSubsidiaryId: subsidiaryId,
    revision: 3,
  };
  state.employments.set(`${orgId}:${record.id}`, record);
  return record;
}

function seedUser(state: FakeState, grants: string[], partyId: string | null = randomUUID()): string {
  const id = randomUUID();
  state.users.set(id, { isSuperAdmin: false, isActive: true, partyId });
  state.roleGrants.set(id, grants);
  return id;
}

test("read resolves through the real grant chain and returns the trusted record", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  const subject = await requireHrmEmploymentRead(exec, ORG, actor, record.id);
  assert.equal(subject.id, record.id);
  assert.equal(subject.workerPartyId, record.workerPartyId);
  assert.equal(subject.employerSubsidiaryId, SUB_A);
  assert.equal(subject.revision, 3);
});

test("inactive actor is refused even with the grant", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  state.users.get(actor)!.isActive = false;
  await assert.rejects(requireHrmEmploymentRead(exec, ORG, actor, record.id), HrmAuthorizationError);
});

test("active actor without the grant is refused", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["gl.read", "payroll.read", "parties.read"]);
  await assert.rejects(
    requireHrmEmploymentRead(exec, ORG, actor, record.id),
    /requires the hrm\.employment\.read permission/,
  );
});

test("deny override wins over the role grant", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const actor = seedUser(state, ["hrm.employment.read"]);
  state.denies.set(actor, ["hrm.employment.read"]);
  await assert.rejects(requireHrmEmploymentRead(exec, ORG, actor, record.id), HrmAuthorizationError);
});

test("employment from another org is not visible", async () => {
  const otherOrg = randomUUID();
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state, otherOrg);
  const actor = seedUser(state, ["hrm.employment.read"]);
  await assert.rejects(
    requireHrmEmploymentRead(exec, ORG, actor, record.id),
    /not visible in this organization/,
  );
});

test("manage enforces the employer subsidiary scope", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state, ORG, SUB_B);
  const actor = seedUser(state, ["hrm.employment.manage"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await assert.rejects(
    requireHrmEmploymentManage(exec, ORG, actor, record.id),
    /not visible in this organization/,
  );
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A, SUB_B] });
  const subject = await requireHrmEmploymentManage(exec, ORG, actor, record.id);
  assert.equal(subject.employerSubsidiaryId, SUB_B);
});

test("keys are strict: manage grants no read, read grants no approve", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const manager = seedUser(state, ["hrm.employment.manage"]);
  await assert.rejects(requireHrmEmploymentRead(exec, ORG, manager, record.id), HrmAuthorizationError);
  const reader = seedUser(state, ["hrm.employment.read"]);
  await assert.rejects(requireHrmEmploymentApprove(exec, ORG, reader, record.id), HrmAuthorizationError);
  const approver = seedUser(state, ["hrm.employment.approve"]);
  const subject = await requireHrmEmploymentApprove(exec, ORG, approver, record.id);
  assert.equal(subject.id, record.id);
});

test("super admin holds the permission half but stays bound by scope and identity", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state, ORG, SUB_B);
  const admin = randomUUID();
  state.users.set(admin, { isSuperAdmin: true, isActive: true, partyId: randomUUID() });
  const subject = await requireHrmEmploymentApprove(exec, ORG, admin, record.id);
  assert.equal(subject.id, record.id);
  // Platform scope is not personhood: a super admin who IS the worker still
  // fails the identity invariant.
  const selfAdmin = randomUUID();
  state.users.set(selfAdmin, { isSuperAdmin: true, isActive: true, partyId: record.workerPartyId });
  assert.throws(
    () =>
      checkApprovalIdentitySeparation({
        approver: { userId: selfAdmin, partyId: record.workerPartyId },
        submitter: { userId: randomUUID(), partyId: randomUUID() },
        subjectWorkerPartyId: record.workerPartyId,
      }),
    /affected worker cannot approve/,
  );
});

test("identity invariant refuses unresolved approver person identity", () => {
  assert.throws(
    () =>
      checkApprovalIdentitySeparation({
        approver: { userId: randomUUID(), partyId: null },
        submitter: { userId: randomUUID(), partyId: randomUUID() },
        subjectWorkerPartyId: randomUUID(),
      }),
    /no resolved person identity/,
  );
});

test("identity invariant refuses submitter self-approval by user and by party", () => {
  const subjectParty = randomUUID();
  const sharedParty = randomUUID();
  assert.throws(
    () =>
      checkApprovalIdentitySeparation({
        approver: { userId: "u-1", partyId: randomUUID() },
        submitter: { userId: "u-1", partyId: randomUUID() },
        subjectWorkerPartyId: subjectParty,
      }),
    /submitter cannot approve/,
  );
  assert.throws(
    () =>
      checkApprovalIdentitySeparation({
        approver: { userId: "u-1", partyId: sharedParty },
        submitter: { userId: "u-2", partyId: sharedParty },
        subjectWorkerPartyId: subjectParty,
      }),
    /submitter cannot approve/,
  );
});

test("identity invariant passes an independent approver", () => {
  assert.doesNotThrow(() =>
    checkApprovalIdentitySeparation({
      approver: { userId: randomUUID(), partyId: randomUUID() },
      submitter: { userId: randomUUID(), partyId: randomUUID() },
      subjectWorkerPartyId: randomUUID(),
    }),
  );
});

test("person loaders fail closed on unknown or inactive identity", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  await assert.rejects(loadApprovalPerson(exec, ORG, randomUUID()), HrmAuthorizationError);
  const actor = seedUser(state, ["hrm.employment.read"]);
  state.users.get(actor)!.isActive = false;
  await assert.rejects(loadActorPerson(exec, ORG, actor), HrmAuthorizationError);
  const person = await loadApprovalPerson(exec, ORG, actor);
  assert.equal(person.partyId, state.users.get(actor)!.partyId);
});

test("party lens admits a shared employer and refuses a foreign party with the uniform message", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const inScope = seedEmployment(state, ORG, SUB_A);
  const foreign = seedEmployment(state, ORG, SUB_B);
  const actor = seedUser(state, ["hrm.documents.read"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await requirePartyInScope(exec, ORG, actor, inScope.workerPartyId);
  await assert.rejects(
    requirePartyInScope(exec, ORG, actor, foreign.workerPartyId),
    /not visible in this organization/,
  );
  const employers = await loadPartyEmployerSubsidiaries(exec, ORG, inScope.workerPartyId);
  assert.deepEqual(employers, [SUB_A]);
});

test("party lens refuses a party with no employment row, even with no other signal", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const actor = seedUser(state, ["hrm.documents.read"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await assert.rejects(
    requirePartyInScope(exec, ORG, actor, randomUUID()),
    /not visible in this organization/,
  );
});

test("party lens passes unrestricted actors without demanding an employment row", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const actor = seedUser(state, ["hrm.documents.read"]);
  await requirePartyInScope(exec, ORG, actor, randomUUID());
  await requirePartyInScope(exec, ORG, actor, null);
});

test("party lens refuses a delinked subject to restricted actors", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const actor = seedUser(state, ["hrm.documents.read"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await assert.rejects(
    requirePartyInScope(exec, ORG, actor, null),
    /not visible in this organization/,
  );
});

test("employment-row gate checks that employment, never the party's other employments", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const foreign = seedEmployment(state, ORG, SUB_B);
  const actor = seedUser(state, ["hrm.documents.read"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await assert.rejects(
    requireEmploymentRowInScope(exec, ORG, actor, foreign.id),
    /not visible in this organization/,
  );
  await assert.rejects(requireEmploymentRowInScope(exec, ORG, actor, randomUUID()), /not visible in this organization/);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A, SUB_B] });
  await requireEmploymentRowInScope(exec, ORG, actor, foreign.id);
});

test("row dispatcher uses the employment link when present, the party lens otherwise", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  // One person employed by both entities: the B-employment row is out of
  // an A-only actor's reach even though the party lens would admit them.
  const sharedParty = randomUUID();
  const empA: FakeEmployment = {
    id: randomUUID(),
    orgId: ORG,
    workerPartyId: sharedParty,
    employerSubsidiaryId: SUB_A,
    revision: 1,
  };
  const empB: FakeEmployment = {
    id: randomUUID(),
    orgId: ORG,
    workerPartyId: sharedParty,
    employerSubsidiaryId: SUB_B,
    revision: 1,
  };
  state.employments.set(`${ORG}:${empA.id}`, empA);
  state.employments.set(`${ORG}:${empB.id}`, empB);
  const actor = seedUser(state, ["hrm.documents.read"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await requireRowSubjectInScope(exec, ORG, actor, { employmentId: empA.id, partyId: sharedParty });
  await assert.rejects(
    requireRowSubjectInScope(exec, ORG, actor, { employmentId: empB.id, partyId: sharedParty }),
    /not visible in this organization/,
  );
  await requireRowSubjectInScope(exec, ORG, actor, { employmentId: null, partyId: sharedParty });
  await assert.rejects(
    requireRowSubjectInScope(exec, ORG, actor, { employmentId: null, partyId: randomUUID() }),
    /not visible in this organization/,
  );
});

test("unrestricted-scope gate delegates to the canonical 403", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const actor = seedUser(state, ["hrm.documents.manage"]);
  state.restrictions.set(actor, { mode: "list", subsidiaryIds: [SUB_A] });
  await assert.rejects(
    requireUnrestrictedHrmScope(exec, ORG, actor),
    (e: unknown) => e instanceof UnrestrictedScopeError && /requires unrestricted subsidiary access/.test(e.message),
  );
  state.restrictions.set(actor, { mode: "all" });
  await requireUnrestrictedHrmScope(exec, ORG, actor);
});
