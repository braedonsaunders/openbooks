import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// The capture upload endpoint reads the org's document-capture runtime
// config, which is null when unconfigured but THROWS for a misconfigured
// endpoint or an unseal failure. Only null maps to the 409: a throw surfaces
// with its own message so operators are not sent to reconfigure a correctly
// configured endpoint. This drives the real route and the real config reader
// against a scratch org: only the session boundary is stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const state: { gate: { user: { id: string; orgId: string } } | null } = {
  gate: null,
};
(globalThis as Record<symbol, unknown>)[Symbol.for("openbooks.ap-capture-config-refusal")] = state;

const permissionsUrl = new URL("../../../lib/permissions.ts", import.meta.url).href;
const subsidiaryScopeUrl = new URL(
  "../../../../engine/src/organization/subsidiary-scope.ts",
  import.meta.url,
).href;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz" || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:ap-capture-authz" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:ap-capture-authz") {
      return {
        shortCircuit: true,
        format: "module",
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.ap-capture-config-refusal')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.gate }
          export async function guardPermission(permission) {
            if (permission !== 'ap.create') throw new Error('unexpected permission ' + permission)
            if (!state.gate) return Response.json({ error: 'unauthorized' }, { status: 401 })
            return state.gate
          }`,
      };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?ap-capture-config";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

function postRequest(): Request {
  return new Request("http://openbooks.test/api/ap-capture", { method: "POST" });
}

test("an unconfigured org is refused as not-configured", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    state.gate = { user: { id: randomUUID(), orgId: org.orgId } };

    const response = await POST(postRequest());

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "capture_not_configured" });
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a misconfigured endpoint surfaces its own message, never not-configured", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update orgs set settings = jsonb_set(
        coalesce(settings, '{}'::jsonb), '{ai}',
        '{"enabled": true, "documentCapture": {"enabled": true, "endpoint": "http://internal.local/ocr"}}'
      ) where id = ${org.orgId}`);
    state.gate = { user: { id: randomUUID(), orgId: org.orgId } };

    const response = await POST(postRequest());

    assert.equal(response.status, 500);
    const body = (await response.json()) as { error?: string };
    assert.equal(body.error, "Document provider endpoint must use HTTPS");
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
