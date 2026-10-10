import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The foreman picker and both write paths share the manager's internal-
// person predicate: a non-employee person or an employed employee runs the
// crew, while customers, vendors, companies, and other orgs' parties
// refuse. Only the session gate is stubbed; the routes, engine validation,
// and database stay real.

const stateKey = Symbol.for("openbooks.projects-foreman-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.projects-foreman-integration')]
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

const postRouteUrl = "./route.ts?projects-foreman-integration";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors, seedActiveEmployment } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
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

test("projects POST accepts a non-employee internal person as foreman", async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const partner = await seedParty(org.orgId, "person", "Dana Partner", org.subsidiaryId);
    const created = await POST(postRequest(randomUUID(), { name: "Studio Loft", foremanId: partner }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const payload = (await created.json()) as { project: { foreman_id: string }; foremanName: string | null };
    assert.equal(payload.project.foreman_id, partner);
    assert.equal(payload.foremanName, "Dana Partner");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("projects POST accepts an employed employee and refuses customers, vendors, and companies as foreman", async () => {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const employee = await seedParty(org.orgId, "employee", "Erin Employee", org.subsidiaryId);
    await seedActiveEmployment(org.orgId, employee);
    const employed = await POST(postRequest(randomUUID(), { name: "Employed Job", foremanId: employee }));
    assert.equal(employed.status, 201, JSON.stringify(await employed.clone().json()));

    for (const [kind, name] of [["customer", "Acme Customer"], ["vendor", "Vera Vendor"], ["company", "C-Corp"]]) {
      const outsider = await seedParty(org.orgId, kind, name, org.subsidiaryId);
      const refused = await POST(postRequest(randomUUID(), { name: `Refused ${name}`, foremanId: outsider }));
      assert.equal(refused.status, 422);
      const body = (await refused.json()) as { error: string; field?: string };
      assert.match(body.error, /must be an active employee or internal person/);
      assert.equal(body.field, "foremanId");
    }

    const unhired = await seedParty(org.orgId, "employee", "Uma Unhired", org.subsidiaryId);
    const unhiredRefused = await POST(postRequest(randomUUID(), { name: "Unhired Job", foremanId: unhired }));
    assert.equal(unhiredRefused.status, 422);
    assert.equal(((await unhiredRefused.json()) as { field?: string }).field, "foremanId");

    const stored = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from projects where org_id = ${org.orgId} and foreman_id = ${unhired}
    `)).rows[0]?.n;
    assert.equal(stored, 0, "a refused foreman persists no project row");
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("projects POST still refuses another org's person and an inactive person as foreman", async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await enableProjects(org.orgId);
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

    const foreign = await seedParty(other.orgId, "person", "Farah Foreign", null);
    const foreignRefused = await POST(postRequest(randomUUID(), { name: "Foreign Job", foremanId: foreign }));
    assert.equal(foreignRefused.status, 422);
    assert.match(((await foreignRefused.json()) as { error: string }).error, /Foreman not found/);

    const inactive = await seedParty(org.orgId, "person", "Ina Inactive", org.subsidiaryId, false);
    const inactiveRefused = await POST(postRequest(randomUUID(), { name: "Inactive Job", foremanId: inactive }));
    assert.equal(inactiveRefused.status, 422);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
