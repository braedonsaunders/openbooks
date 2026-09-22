import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The unsaved-create write path at the real boundary: only the session gate
// is stubbed. Opening the drawer (?projectNew=1) writes nothing by
// construction (no endpoint is hit), Cancel writes nothing (router-only), and
// this POST is the single write — idempotent, tenant-scoped, audited, and
// fenced against a concurrent projects-feature disable.

const stateKey = Symbol.for("openbooks.projects-create-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.projects-create-integration')]
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
    if (specifier === "../../../lib/authz") {
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

const postRouteUrl = "./route.ts?projects-create-integration";
const { POST } = (await import(postRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

function postRequest(key: string, body: unknown): Request {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

/**
 * Set the Projects gate explicitly.
 *
 * `projects` is defaultEnabled: true in the feature registry, so a fresh
 * scratch org already has it ON — a test that wants to exercise the refusal
 * must turn it OFF rather than assume a disabled default.
 *
 * jsonb_set, not `||`: a top-level concat of {"features":{...}} REPLACES the
 * whole features object, silently dropping the payroll flag the shared
 * fixture seeds.
 */
async function setProjectsFeature(orgId: string, enabled: boolean): Promise<void> {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb), '{features,projects}',
             to_jsonb(${enabled}::boolean), true)
     where id = ${orgId}
  `);
}

async function enableProjects(orgId: string): Promise<void> {
  await setProjectsFeature(orgId, true);
}

async function auditInserts(orgId: string, rowId: string): Promise<{ request_id: string | null; actor_id: string | null }[]> {
  return (
    await db.execute<{ request_id: string | null; actor_id: string | null }>(sql`
      select request_id, actor_id from audit_log
       where org_id = ${orgId} and table_name = 'projects' and row_id = ${rowId} and action = 'insert'
       order by at asc
    `)
  ).rows;
}

test(
  "projects POST creates one active project and one audit row under the feature gate",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      await enableProjects(org.orgId);
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };

      const key = randomUUID();
      const created = await POST(postRequest(key, { name: "Harbourview Tower" }));
      assert.equal(created.status, 201);
      const payload = (await created.json()) as { project: { id: string; name: string; is_active: boolean } };
      assert.equal(payload.project.id, key);
      assert.equal(payload.project.name, "Harbourview Tower");
      assert.equal(payload.project.is_active, true);

      const audits = await auditInserts(org.orgId, key);
      assert.equal(audits.length, 1, "exactly one insert audit row");
      assert.equal(audits[0]?.request_id, key, "the audit row carries the idempotency key");
      assert.equal(audits[0]?.actor_id, adminId, "the audit row carries the actor");

      const replay = await POST(postRequest(key, { name: "Harbourview Tower" }));
      assert.equal(replay.status, 200);
      assert.equal((await auditInserts(org.orgId, key)).length, 1, "a replay writes no second audit row");

      const changed = await POST(postRequest(key, { name: "Harbourview Renamed" }));
      assert.equal(changed.status, 409);
      assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });

      const placeholders = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from projects
           where org_id = ${org.orgId} and name = 'New project'
        `)
      ).rows[0]?.n;
      assert.equal(placeholders, 0, "no inactive placeholder survives the create path");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "projects POST refuses while the feature is off and claims nothing across orgs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const { adminId } = await seedFlowActors(org.orgId);
      const { adminId: otherAdmin } = await seedFlowActors(other.orgId);
      await enableProjects(org.orgId);

      // Feature off in `other`: the entry guard refuses before any write.
      // Turned off explicitly — the registry default is ON.
      await setProjectsFeature(other.orgId, false);
      routeState.authz = { user: { orgId: other.orgId, id: otherAdmin }, allowedSubsidiaryIds: null };
      const refused = await POST(postRequest(randomUUID(), { name: "Harbourview Tower" }));
      assert.equal(refused.status, 404);

      // A key minted in `org` cannot be claimed from `other`: enable the
      // feature there so the refusal comes from the tenant check, not the
      // feature gate.
      routeState.authz = { user: { orgId: org.orgId, id: adminId }, allowedSubsidiaryIds: null };
      const key = randomUUID();
      assert.equal((await POST(postRequest(key, { name: "Harbourview Tower" }))).status, 201);

      await enableProjects(other.orgId);
      routeState.authz = { user: { orgId: other.orgId, id: otherAdmin }, allowedSubsidiaryIds: null };
      const claimed = await POST(postRequest(key, { name: "Harbourview Tower" }));
      assert.equal(claimed.status, 404);
      const leaked = (
        await db.execute<{ n: number }>(sql`
          select count(*)::int as n from projects where id = ${key} and org_id = ${other.orgId}
        `)
      ).rows[0]?.n;
      assert.equal(leaked, 0, "the other org gains no row from the foreign key");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
