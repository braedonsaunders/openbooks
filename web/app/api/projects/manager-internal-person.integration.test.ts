import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Project roles are internal people: the manager picker and both write
// paths share one predicate, so a non-employee person manages projects
// while customers, vendors, and other orgs' parties refuse. Only the
// session gate is stubbed; the routes, engine validation, and database
// stay real.

const stateKey = Symbol.for("openbooks.projects-manager-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.projects-manager-integration')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() { return undefined }
  export function subsidiariesInScope() { return true }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier === "./authz" && (context.parentURL ?? "").includes("web/lib/feature-gates.ts")) {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const postRouteUrl = "./route.ts?projects-manager-integration";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedActiveEmployment } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { listInternalPersonOptions } = await import(
  "@openbooks/engine/src/organization/internal-person.ts"
);

function postRequest(key: string, body: unknown): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

async function enableProjects(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{features,projects}',
             to_jsonb(${true}::boolean), true)
     where id = ${orgId}
  `);
}

async function seedParty(
  orgId: string,
  kind: string,
  displayName: string,
  subsidiaryId: string | null,
  isActive = true,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active)
    values (${id}, ${orgId}, ${kind}, ${displayName}, ${subsidiaryId}, ${isActive})
  `);
  return id;
}

test.after(() => hooks.deregister());

test("projects POST accepts a non-employee internal person as manager", async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const partner = await seedParty(org.orgId, "person", "Dana Partner", org.subsidiaryId);
    const created = await POST(postRequest(randomUUID(), { name: "Studio Loft", managerId: partner }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const payload = (await created.json()) as { project: { manager_id: string }; managerName: string | null };
    assert.equal(payload.project.manager_id, partner);
    assert.equal(payload.managerName, "Dana Partner");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("projects POST accepts an employed employee and refuses customers, vendors, and companies", async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const employee = await seedParty(org.orgId, "employee", "Erin Employee", org.subsidiaryId);
    await seedActiveEmployment(org.orgId, employee);
    const employed = await POST(postRequest(randomUUID(), { name: "Employed Job", managerId: employee }));
    assert.equal(employed.status, 201, JSON.stringify(await employed.clone().json()));

    for (const [kind, name] of [["customer", "Acme Customer"], ["vendor", "Vera Vendor"], ["company", "C-Corp"]]) {
      const outsider = await seedParty(org.orgId, kind, name, org.subsidiaryId);
      const refused = await POST(postRequest(randomUUID(), { name: `Refused ${name}`, managerId: outsider }));
      assert.equal(refused.status, 422);
      const body = (await refused.json()) as { error: string; field?: string };
      assert.match(body.error, /must be an active employee or internal person/);
      assert.equal(body.field, "managerId");
    }

    const unhired = await seedParty(org.orgId, "employee", "Uma Unhired", org.subsidiaryId);
    const unhiredRefused = await POST(postRequest(randomUUID(), { name: "Unhired Job", managerId: unhired }));
    assert.equal(unhiredRefused.status, 422);
    assert.equal(((await unhiredRefused.json()) as { field?: string }).field, "managerId");

    const stored = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from projects where org_id = ${org.orgId} and manager_id = ${unhired}
    `)).rows[0]?.n;
    assert.equal(stored, 0, "a refused manager persists no project row");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("projects POST still refuses another org's person and an inactive person as unknown", async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const foreign = await seedParty(other.orgId, "person", "Farah Foreign", null);
    const foreignRefused = await POST(postRequest(randomUUID(), { name: "Foreign Job", managerId: foreign }));
    assert.equal(foreignRefused.status, 422);
    assert.match(((await foreignRefused.json()) as { error: string }).error, /Manager not found/);

    const inactive = await seedParty(org.orgId, "person", "Ina Inactive", org.subsidiaryId, false);
    const inactiveRefused = await POST(postRequest(randomUUID(), { name: "Inactive Job", managerId: inactive }));
    assert.equal(inactiveRefused.status, 422);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});

test("manager picker options admit internal people and hide everyone else", async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const person = await seedParty(org.orgId, "person", "Ava Person", org.subsidiaryId);
    const employee = await seedParty(org.orgId, "employee", "Ben Employee", org.subsidiaryId);
    await seedActiveEmployment(org.orgId, employee);
    const unhired = await seedParty(org.orgId, "employee", "Cy Unhired", org.subsidiaryId);
    const customer = await seedParty(org.orgId, "customer", "Dan Customer", org.subsidiaryId);
    const vendor = await seedParty(org.orgId, "vendor", "Eve Vendor", org.subsidiaryId);
    const company = await seedParty(org.orgId, "company", "Fox Company", org.subsidiaryId);
    const inactive = await seedParty(org.orgId, "person", "Gus Gone", org.subsidiaryId, false);
    const foreign = await seedParty(other.orgId, "person", "Hal Foreign", null);

    const options = await listInternalPersonOptions(db, org.orgId, null);
    const ids = new Set(options.map((row) => row.id));
    assert.ok(ids.has(person), "active person without employment is offered");
    assert.ok(ids.has(employee), "employed employee is offered");
    for (const hidden of [unhired, customer, vendor, company, inactive, foreign]) {
      assert.ok(!ids.has(hidden), `party ${hidden} is not offered as a manager`);
    }
    const names = options.map((row) => row.display_name);
    assert.deepEqual(names, [...names].sort(), "options arrive in display order");
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
