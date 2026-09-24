import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql, type SQL } from "drizzle-orm";

// Every name-bearing API route validates its name through the shared zod
// name boundary: a non-string name refuses 400 naming the field before any
// storage is touched, and a valid name passes the boundary (reaching the
// route's own lookup, never a 400). Only the auth boundary is stubbed, in
// the real Authz shape with an unrestricted scope; parsing, lookups, and
// the database are real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz" || specifier.endsWith("/lib/authz")) {
      return { shortCircuit: true, url: "mock:name-gate" };
    }
    if (specifier.startsWith("@/")) {
      const path = `../../${specifier.slice(2)}`;
      return {
        shortCircuit: true,
        url: new URL(path.endsWith(".ts") ? path : `${path}.ts`, import.meta.url).href,
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:name-gate") {
      return {
        format: "module",
        shortCircuit: true,
        source: `import { subsidiaryScopeAllows } from '${engineScopeUrl}'
          export { subsidiaryScopeAllows }
          const key = Symbol.for('openbooks.name-gate')
          const gate = () => globalThis[key] ?? null
          export async function guardPermission() { return gate() }
          export async function getAuthz() { return gate() }
          export function can() { return true }
          export function guardSubsidiaryScope() { return null }
          export function guardUnrestrictedScope(authz) {
            if (authz && authz.allowedSubsidiaryIds) {
              return new Response('{"error":"unrestricted scope required"}', { status: 403 })
            }
            return null
          }
          export function subsidiariesInScope(authz, ids) { return ids }`,
      };
    }
    return nextLoad(url, context);
  },
});

const gateKey = Symbol.for("openbooks.name-gate");
const engineScopeUrl = new URL(
  "../../../engine/src/organization/subsidiary-scope.ts",
  import.meta.url,
).href;
const { withBypassContext: withBypass } = await import(
  "@openbooks/engine/src/platform/db.ts"
);
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const routes = [
  { file: "../../app/api/accounts/[id]/route.ts", method: "PATCH", params: true },
  { file: "../../app/api/customization/form-layouts/[id]/route.ts", method: "PATCH", params: true },
  { file: "../../app/api/customization/list-views/[id]/route.ts", method: "PATCH", params: true },
  { file: "../../app/api/insights/cards/[id]/route.ts", method: "PATCH", params: true },
  { file: "../../app/api/insights/dashboards/[id]/route.ts", method: "PATCH", params: true },
  { file: "../../app/api/labor-rate-cards/[id]/route.ts", method: "PUT", params: true },
  { file: "../../app/api/labor-rate-cards/route.ts", method: "POST", params: false },
  { file: "../../app/api/projects/[id]/route.ts", method: "PATCH", params: true },
] as const;

const handlers = new Map<string, (req: Request, ctx?: never) => Promise<Response>>();
for (const route of routes) {
  const module = (await import(route.file)) as Record<string, (req: Request, ctx: unknown) => Promise<Response>>;
  handlers.set(route.file, module[route.method] as (req: Request, ctx?: never) => Promise<Response>);
}

function call(
  file: string,
  method: string,
  body: unknown,
  params: boolean,
  id: string = randomUUID(),
): Promise<Response> {
  const handler = handlers.get(file)!;
  const req = new Request(`http://openbooks.test/${file}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ctx = params ? { params: Promise.resolve({ id }) } : undefined;
  return handler(req, ctx as never);
}

test("name-bearing routes refuse a non-string name with the field path", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
      user: { id: "name-test", orgId: scratch.orgId },
      permissions: new Set(["*"]),
      allowedSubsidiaryIds: null,
    };
    const { db } = await import("@openbooks/engine/src/platform/db.ts");
    // Most of these PATCH routes read the row before parsing, so each needs
    // a real id to reach the shared boundary. Feature-gated routes also need
    // the projects feature switched on for the scratch org.
    await withBypass(() =>
      db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,projects}', 'true'::jsonb)
         where id = ${scratch.orgId}
      `),
    );
    const ids: Record<string, string> = {};
    const seed = async (file: string, insert: (id: string) => SQL) => {
      const id = randomUUID();
      await withBypass(() => db.execute(insert(id)));
      ids[file] = id;
    };
    await seed(
      "../../app/api/accounts/[id]/route.ts",
      (id) => sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active)
        values (${id}, ${scratch.orgId}, 'NME-1', 'Boundary probe', 'asset_bank', false, true)
      `,
    );
    await seed(
      "../../app/api/customization/form-layouts/[id]/route.ts",
      (id) => sql`
        insert into form_layouts (id, org_id, record_type, name, layout)
        values (${id}, ${scratch.orgId}, 'vendor_bill', 'Boundary layout', '{}'::jsonb)
      `,
    );
    await seed(
      "../../app/api/customization/list-views/[id]/route.ts",
      (id) => sql`
        insert into list_views (id, org_id, record_type, name, scope, config)
        values (${id}, ${scratch.orgId}, 'vendor_bill', 'Boundary view', 'org', '{}'::jsonb)
      `,
    );
    await seed(
      "../../app/api/insights/cards/[id]/route.ts",
      (id) => sql`
        insert into insight_cards (id, org_id, name)
        values (${id}, ${scratch.orgId}, 'Boundary card')
      `,
    );
    await seed(
      "../../app/api/insights/dashboards/[id]/route.ts",
      (id) => sql`
        insert into insight_dashboards (id, org_id, name)
        values (${id}, ${scratch.orgId}, 'Boundary dashboard')
      `,
    );
    await seed(
      "../../app/api/projects/[id]/route.ts",
      (id) => sql`
        insert into projects (id, org_id, name, customer_id, subsidiary_id, status, contract_value, is_active)
        values (${id}, ${scratch.orgId}, 'Boundary project', ${scratch.customerId}, ${scratch.subsidiaryId}, 'active', 1000, true)
      `,
    );
    for (const route of routes) {
      const id = ids[route.file] ?? randomUUID();
      const response = await call(route.file, route.method, { name: 123 }, route.params, id);
      assert.equal(response.status, 400, `${route.file} accepted a numeric name`);
      const payload = (await response.json()) as { issues: { path: string }[] };
      assert.ok(
        payload.issues.some((issue) => String(issue.path).includes("name")),
        `${route.file} 400 names no name path`,
      );
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});

test("name-bearing routes pass a valid name through the shared boundary", async () => {
  const scratch = await withBypass(() => createScratchOrg());
  try {
    (globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = {
      user: { id: "name-test", orgId: scratch.orgId },
      permissions: new Set(["*"]),
      allowedSubsidiaryIds: null,
    };
    for (const route of routes) {
      const response = await call(route.file, route.method, { name: "ok" }, route.params);
      assert.notEqual(response.status, 400, `${route.file} refused a valid name at the boundary`);
    }
  } finally {
    await withBypass(() => dropScratchOrg(scratch.orgId));
  }
});
