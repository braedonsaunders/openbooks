import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

// F-t13-001: POST /api/pdf-templates with a taken name must answer 409 with
// the friendly "already exists" message — never a 500 echoing the raw INSERT.
// Drizzle wraps driver failures ("Failed query: <sql>", driver error in
// `cause`), so matching on the wrapper message misclassifies every unique
// violation. Mirrors route-patch-flags.integration.test.ts: mocked authz,
// real route, real cluster, scratch org only.

const stateKey = Symbol.for("openbooks.pdf-template-post-duplicate-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.pdf-template-post-duplicate-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // tsx does not apply web/tsconfig.json paths when run from the repo
    // root; map @/ to web/ explicitly (extension probing included).
    if (specifier.startsWith("@/")) {
      const base = join(process.cwd(), "web", specifier.slice(2));
      const hit = [".ts", ".tsx", "/index.ts"]
        .map((suffix) => base + suffix)
        .find((candidate) => existsSync(candidate));
      if (hit) return { shortCircuit: true, url: pathToFileURL(hit).href };
    }
    if (specifier === "../../../lib/authz" && context.parentURL?.includes("pdf-templates")) {
      return { url: "mock:authz-post-duplicate", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz-post-duplicate") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?pdf-template-post-duplicate-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);

async function seed(): Promise<{ orgId: string; actorId: string }> {
  // Scratch-org seeding bypasses row-level security (cluster rejects 42501
  // otherwise); the route calls under test run unwrapped, as in production.
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "Template Admin", "admin"));
  await withBypassContext(() => db.execute(sql`
    insert into pdf_templates (org_id, record_type, name, source_html, compiled_html, created_by, updated_by)
    values (${org.orgId}, 'customer_invoice', 'Standard', '<p>Hi</p>', '<p>Hi</p>', ${actorId}, ${actorId})`));
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/pdf-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test(
  "POST a taken template name answers 409, never a 500 with SQL",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    // Middleware establishes the tenant scope in production; mirror it here.
    const res = await withOrgContext(f.orgId, () =>
      POST(postRequest({ recordType: "customer_invoice", name: "Standard" })),
    );
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.match(String(body.error), /already exists/);
    assert.doesNotMatch(String(body.error), /insert into/i);
  },
);

test(
  "POST a fresh template name still creates",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await withOrgContext(f.orgId, () =>
      POST(postRequest({ recordType: "customer_invoice", name: "Standard 2" })),
    );
    assert.equal(res.status, 200);
    const created = (await res.json()) as { id: string };
    const stored = await withBypassContext(() => db.execute<{ name: string }>(sql`
      select name from pdf_templates where id = ${created.id} and org_id = ${f.orgId}`));
    assert.equal(stored.rows[0]?.name, "Standard 2");
  },
);
