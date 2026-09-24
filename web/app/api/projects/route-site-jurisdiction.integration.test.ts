import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The project's site jurisdiction drives lien-waiver coverage: a waiver
// releases payment only when its jurisdiction matches the site. The column
// has to be fillable through the project API, validated like the waiver's.

const stateKey = Symbol.for("openbooks.projects-site-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.projects-site-integration')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() { return undefined }
  export function subsidiariesInScope() { return true }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.endsWith("/lib/authz")) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href, context);
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

const { POST } = await import("./route.ts");
const { PATCH } = await import("./[id]/route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await createScratchOrg();
  const { adminId } = await seedFlowActors(org.orgId);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{features,projects}',
             to_jsonb(true::boolean), true)
     where id = ${org.orgId}`);
  routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };
  return org;
}

const postRequest = (body: unknown) =>
  new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify(body),
  });

const siteOf = async (id: string) =>
  (
    await db.execute<{ site_jurisdiction: string | null }>(
      sql`select site_jurisdiction from projects where id = ${id}`,
    )
  ).rows[0]!.site_jurisdiction;

test("project creation refuses an unknown site jurisdiction without writing", { skip: !DB }, async () => {
  const org = await fixture();
  try {
    const response = await POST(postRequest({ name: "Site job", siteJurisdiction: "Atlantis" }));
    const json = (await response.json().catch(() => null)) as { error?: string } | null;
    assert.equal(response.status, 422, `expected 422, got ${response.status}: ${JSON.stringify(json)}`);
    assert.match(json?.error ?? "", /unknown site jurisdiction/, `expected a named refusal, got: ${JSON.stringify(json)}`);
    const count = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from projects where org_id = ${org.orgId}`)
    ).rows[0]!.n;
    assert.equal(count, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project creation stores a canonicalised site jurisdiction, nullable by default", { skip: !DB }, async () => {
  const org = await fixture();
  try {
    const createdSite = await POST(postRequest({ name: "Site job", siteJurisdiction: "us-ca" }));
    const withSite = (await createdSite.json().catch(() => null)) as { project: { id: string } } | null;
    assert.equal(createdSite.status, 201, JSON.stringify(withSite));
    assert.equal(await siteOf(withSite!.project.id), "US-CA");
    const createdBare = await POST(postRequest({ name: "Unsurveyed job" }));
    const withoutSite = (await createdBare.json().catch(() => null)) as { project: { id: string } } | null;
    assert.equal(createdBare.status, 201, JSON.stringify(withoutSite));
    assert.equal(await siteOf(withoutSite!.project.id), null);
    const patched = await PATCH(
      new Request(`http://localhost/api/projects/${withSite!.project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteJurisdiction: "us-ny" }),
      }),
      { params: Promise.resolve({ id: withSite!.project.id }) },
    );
    assert.equal(patched.status, 200, JSON.stringify(await patched.json().catch(() => null)));
    assert.equal(await siteOf(withSite!.project.id), "US-NY");
    const refused = await PATCH(
      new Request(`http://localhost/api/projects/${withSite!.project.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteJurisdiction: "XX-YY" }),
      }),
      { params: Promise.resolve({ id: withSite!.project.id }) },
    );
    assert.equal(refused.status, 422, JSON.stringify(await refused.json().catch(() => null)));
    assert.equal(await siteOf(withSite!.project.id), "US-NY");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
