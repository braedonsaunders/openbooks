import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { SqlExecutor } from "../platform/db.ts";

// Static imports evaluate before the module body, so in-file assignments
// cannot guard the import-time database-environment resolution in db.ts.
// The unit launch command sets OPENBOOKS_DB_URL=. Keep a supplied URL so
// the missing-user integration case can run against an isolated testdb;
// re-assert emptiness only when nothing was supplied.
const integrationDbUrl = process.env.OPENBOOKS_DB_URL?.trim() ?? "";
if (!integrationDbUrl) {
  process.env.OPENBOOKS_DB_URL = "";
  process.env.OPENBOOKS_MIGRATION_DB_URL = "";
}

const {
  checkApprovalIdentitySeparation,
  HrmAuthorizationError,
  loadActorPerson,
  loadApprovalPerson,
  requireHrmEmploymentApprove,
  requireHrmEmploymentManage,
  requireHrmEmploymentRead,
} = await import("./authorization.ts");

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

test("missing actor is refused without planting a local user in the fake", async () => {
  const state = emptyState();
  const exec = fakeExec(state);
  const record = seedEmployment(state);
  const missing = randomUUID();
  // No users row. If this path went fail-open, the gate would return the
  // seeded employment as a trusted subject.
  await assert.rejects(
    requireHrmEmploymentRead(exec, ORG, missing, record.id),
    /identity behind this action is not established/,
  );
  await assert.rejects(
    requireHrmEmploymentManage(exec, ORG, missing, record.id),
    /identity behind this action is not established/,
  );
  await assert.rejects(
    requireHrmEmploymentApprove(exec, ORG, missing, record.id),
    /identity behind this action is not established/,
  );
  await assert.rejects(
    loadActorPerson(exec, ORG, missing),
    /identity behind this action is not established/,
  );
});

test("nonexistent actor id is refused against a real organization", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { sql } = await import("drizzle-orm");
  const { db } = await import("../platform/db.ts");
  const { createScratchOrg, dropScratchOrg } = await import("../testing/fixtures.ts");
  const org = await createScratchOrg();
  try {
    const partyId = (await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name)
      values (${org.orgId}, 'person', 'Missing-actor worker')
      returning id
    `)).rows[0]!.id;
    const employmentId = (await db.execute<{ id: string }>(sql`
      insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
      values (${org.orgId}, ${partyId}, ${org.subsidiaryId})
      returning id
    `)).rows[0]!.id;
    const missing = randomUUID();
    await assert.rejects(
      requireHrmEmploymentRead(db, org.orgId, missing, employmentId),
      /identity behind this action is not established/,
    );
    await assert.rejects(
      loadActorPerson(db, org.orgId, missing),
      /identity behind this action is not established/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
