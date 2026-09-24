import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Opening a filing resolves the subsidiary before anything is computed: a
// malformed id is a 400 (never an org-wide filing), an out-of-scope id is
// indistinguishable from missing, and a well-formed id outside the org is a
// 404 — all before the first filing row. This drives the real route and the
// real scope gate against a scratch org: only the session boundary is
// stubbed.

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const stateKey = Symbol.for("openbooks.info-returns-route-test");
const state: {
  gate: {
    user: { id: string; orgId: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
} = { gate: null };
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const permissionsUrl = new URL("../../../../lib/permissions.ts", import.meta.url).href;
const subsidiaryScopeUrl = new URL(
  "../../../../../engine/src/organization/subsidiary-scope.ts",
  import.meta.url,
).href;
const jsonUrl = new URL("../../../../lib/api/json.ts", import.meta.url).href;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz" || /(^|\/)lib\/authz$/.test(specifier)) {
      return { shortCircuit: true, url: "mock:info-returns-authz" };
    }
    if (specifier === "@/lib/api/json") {
      return nextResolve(jsonUrl, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:info-returns-authz") {
      return {
        shortCircuit: true,
        format: "module",
        source: `import { permissionSetCovers } from '${permissionsUrl}'
          import { subsidiaryScopeAllows } from '${subsidiaryScopeUrl}'
          const state = globalThis[Symbol.for('openbooks.info-returns-route-test')]
          export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
          export { subsidiaryScopeAllows }
          export async function getAuthz() { return state.gate }
          export async function guardPermission(permission) {
            const gate = state.gate
            if (!gate) return Response.json({ error: 'unauthorized' }, { status: 401 })
            if (!permissionSetCovers(gate.permissions, permission)) {
              return Response.json({ error: 'missing permission: ' + permission }, { status: 403 })
            }
            return gate
          }
          export function guardSubsidiaryScope(gate, subsidiaryId, opts) {
            if (subsidiaryScopeAllows(gate.allowedSubsidiaryIds, subsidiaryId, opts)) return null
            return Response.json({ error: 'not found' }, { status: 404 })
          }`,
      };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?info-returns-scope";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

function gate(orgId: string, allowedSubsidiaryIds: Set<string> | null) {
  state.gate = {
    user: { id: randomUUID(), orgId },
    permissions: new Set(["compliance.read", "compliance.manage"]),
    allowedSubsidiaryIds,
  };
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/compliance/information-returns", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function filingBody(subsidiaryId: string | null | undefined) {
  const body: Record<string, unknown> = { taxYear: 2020, formType: "1099-NEC" };
  if (subsidiaryId !== undefined) body.subsidiaryId = subsidiaryId;
  return body;
}

async function filingCount(orgId: string): Promise<number> {
  const rows = (
    await db.execute<{ n: string }>(
      sql`select count(*)::text as n from information_return_filings where org_id = ${orgId}`,
    )
  ).rows;
  return Number(rows[0]?.n ?? 0);
}

async function enableCompliance(orgId: string): Promise<void> {
  await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,subcontractorCompliance}', 'true') where id = ${orgId}`);
}

test("a malformed subsidiary id is a 400, never an org-wide filing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCompliance(org.orgId);
    gate(org.orgId, null);

    const response = await POST(postRequest(filingBody("nope")));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "subsidiaryId must be a valid UUID" });
    assert.equal(await filingCount(org.orgId), 0);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("an out-of-scope subsidiary reads as missing with nothing filed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCompliance(org.orgId);
    gate(org.orgId, new Set([org.subsidiaryId]));

    const response = await POST(postRequest(filingBody(randomUUID())));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(await filingCount(org.orgId), 0);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a well-formed id outside the org is a 404, not an org-wide filing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableCompliance(org.orgId);
    gate(org.orgId, null);

    const response = await POST(postRequest(filingBody(randomUUID())));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(await filingCount(org.orgId), 0);
  } finally {
    state.gate = null;
    await dropScratchOrg(org.orgId);
  }
});
