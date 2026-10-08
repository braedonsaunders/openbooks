import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { PgDialect } from "drizzle-orm/pg-core";
import test from "node:test";
import { FEATURES } from "../../organization/feature-registry.ts";
import type { SqlExecutor } from "../../platform/db.ts";

const uuid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;
const orgId = uuid(1), actorId = uuid(2), partyId = uuid(3), subsidiaryA = uuid(4), subsidiaryB = uuid(5);
const dialect = new PgDialect();
type Subject = { id: string; orgId: string; workerPartyId: string; subsidiaryId: string | null; revision: number };
let subjects: Subject[] = [];
let meetings: Record<string, unknown>[] = [];
let agenda: Record<string, unknown>[] = [];
let active = true, unrestricted = true;
let failure: Error | null = null;
const queries: { sql: string; params: unknown[] }[] = [];
const boundary = {
  async execute(query: Parameters<PgDialect["sqlToQuery"]>[0]) {
    const compiled = dialect.sqlToQuery(query), text = compiled.sql;
    const params = compiled.params.map(p => typeof p === "string" ? p.toLowerCase() : p);
    queries.push(compiled);
    assert.ok(compiled.params.includes(orgId), "every read and lock must name the organization");
    if (text.includes("from orgs")) return { rows: [{ features: Object.fromEntries(FEATURES.map(f => [f.key, true])), time_zone: "UTC" }] };
    if (text.includes("from users")) return { rows: [{ id: actorId, partyId, isActive: active, isSuperAdmin: unrestricted }] };
    if (text.includes("subsidiary_restriction")) return { rows: [{ restriction: { mode: "list", subsidiaryIds: [subsidiaryA] } }] };
    if (text.includes("role_assignments")) return { rows: [{ permissions: ["hrm.performance.read"] }] };
    if (text.includes("user_permission_overrides")) return { rows: [] };
    if (text.includes("from subsidiaries")) return { rows: [{ id: subsidiaryA, parentId: null }, { id: subsidiaryB, parentId: null }] };
    if (text.includes("from worker_employments") && text.includes("for update")) {
      if (failure) throw failure;
      assert.match(text, /where e\.org_id =/);
      assert.match(text, /order by e\.id\s+for update of e/);
      return { rows: subjects.filter(row => row.orgId === orgId && params.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)) };
    }
    if (text.includes("from worker_employments")) return { rows: [] };
    if (text.includes("from hrm_one_on_one_items")) {
      return { rows: agenda.filter(row => params.includes(row.one_on_one_id)) };
    }
    if (text.includes("from hrm_one_on_ones")) {
      const selected = params.find(p => meetings.some(m => m.id === p));
      return { rows: selected ? meetings.filter(m => m.id === selected) : meetings };
    }
    throw new Error("Unexpected query: " + text);
  },
};
const exec = boundary as unknown as SqlExecutor;
(globalThis as typeof globalThis & { employmentBatchBoundary?: typeof boundary }).employmentBatchBoundary = boundary;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/engine/src/") &&
      (specifier.endsWith("/platform/db.ts") || (specifier === "./db.ts" && context.parentURL.includes("/platform/")))) {
      return { shortCircuit: true, url: "mock:employment-batch-db" };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:employment-batch-db") return { shortCircuit: true, format: "module", source: `
      export const db = globalThis.employmentBatchBoundary;
      export const withOrgTransaction = async (_org, work) => work(db);
      export const withBypassContext = async work => work();
    ` };
    return next(url, context);
  },
});
const { listOneOnOnes, getOneOnOne } = await import("./one-on-ones.ts");
const { lockEmploymentsForScope, HrmAuthorizationError } = await import("../authorization.ts");
hooks.deregister();

function reset() {
  subjects = []; meetings = []; agenda = []; queries.length = 0;
  active = true; unrestricted = true; failure = null;
}
function employment(id: string, subsidiaryId: string | null = subsidiaryA): Subject {
  return { id, orgId, workerPartyId: uuid(90), subsidiaryId, revision: 7 };
}
function meeting(id: string, reportId: string) {
  return { id, manager_employment_id: uuid(91), report_employment_id: reportId,
    report_employer_subsidiary_id: subsidiaryA, manager_party_id: uuid(92), report_party_id: uuid(90),
    manager_name: "Manager", report_name: "Employee", scheduled_at: "2026-10-01T10:00:00Z",
    held_at: "2026-10-01T10:00:00Z", status: "held", skip_reason: null, recurrence: null, series_id: null };
}
function item(id: string, meetingId: string, visibility: string, author: string) {
  return { id, one_on_one_id: meetingId, kind: "note", author_party_id: author, body: "Agenda content",
    visibility, status: "open", assignee_party_id: null, due_on: null, position: 1, carried_from_item_id: null };
}

test("one-on-one lists read agendas once for all meetings and preserve author-private notes", async () => {
  reset();
  for (let n = 100; n < 120; n++) {
    const id = uuid(n), reportId = uuid(n + 100);
    subjects.push(employment(reportId)); meetings.push(meeting(id, reportId));
    agenda.push(item(uuid(n + 200), id, "shared", uuid(90)), item(uuid(n + 300), id, "private", partyId), item(uuid(n + 400), id, "private", uuid(90)));
  }
  const rows = await listOneOnOnes({ orgId, actorId });
  assert.equal(rows.length, 20);
  assert.ok(rows.every(row => row.items.length === 2 && row.items.every(i => i.visibility === "shared" || i.authorPartyId === partyId)));
  assert.equal(queries.filter(q => q.sql.includes("from hrm_one_on_one_items")).length, 1);
  assert.equal(queries.filter(q => q.sql.includes("for update of e")).length, 1);
});

test("selected meeting reads preserve private notes and accept native UUID case variants", async () => {
  reset();
  const id = uuid(175), reportId = uuid(275);
  subjects.push(employment(reportId)); meetings.push(meeting(id, reportId));
  agenda.push(item(uuid(375), id, "shared", uuid(90)), item(uuid(475), id, "private", uuid(90)), item(uuid(575), id, "private", partyId));
  const row = await getOneOnOne({ orgId, actorId, id: id.toUpperCase() });
  assert.deepEqual(row.items.map(i => i.id), [uuid(375), uuid(575)]);
});

test("employment lists deduplicate locks, return locked revisions, and refresh employer and actor authority", async () => {
  reset(); unrestricted = false;
  const a = uuid(10), b = uuid(11), unknown = uuid(12), missingEmployer = uuid(13), foreign = uuid(14);
  subjects = [employment(a), employment(b, subsidiaryB), employment(missingEmployer, null), { ...employment(foreign), orgId: uuid(99) }];
  const scope = { orgId, actorId, outOfScope: "filter" as const };
  const rows = await lockEmploymentsForScope(exec, [b, a.toUpperCase(), a, unknown, missingEmployer, foreign], scope);
  assert.deepEqual(rows.map(row => [row.id, row.employerSubsidiaryId, row.revision]), [[a, subsidiaryA, 7]]);
  assert.equal(queries.filter(q => q.sql.includes("worker_employments")).length, 1);
  subjects[0] = employment(a, subsidiaryB);
  assert.deepEqual(await lockEmploymentsForScope(exec, [a], scope), []);
  subjects[0] = employment(a); active = false;
  assert.deepEqual(await lockEmploymentsForScope(exec, [a], scope), []);
});

test("employment writes uniformly refuse missing, cross-organization, unassigned and out-of-scope subjects", async () => {
  reset(); unrestricted = false;
  subjects = [employment(uuid(10), subsidiaryB), employment(uuid(11), null), { ...employment(uuid(12)), orgId: uuid(99) }];
  for (const id of [uuid(10), uuid(11), uuid(12), uuid(13)]) {
    await assert.rejects(lockEmploymentsForScope(exec, [id], { orgId, actorId }), HrmAuthorizationError);
  }
});

test("empty lists avoid subject reads and lock failures preserve their cause", async () => {
  reset();
  assert.deepEqual(await listOneOnOnes({ orgId, actorId }), []);
  assert.equal(queries.filter(q => q.sql.includes("from hrm_one_on_one_items") || q.sql.includes("for update of e")).length, 0);
  failure = new Error("lock unavailable");
  await assert.rejects(lockEmploymentsForScope(exec, [uuid(10)], { orgId, actorId }), error => error === failure);
});
