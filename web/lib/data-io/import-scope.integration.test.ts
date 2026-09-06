import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { dropScratchOrgReporting } from "@openbooks/engine/src/test-fixtures.ts";
import { seedAdoption } from "@openbooks/engine/src/payroll-filing-test-fixtures.ts";

/**
 * `/api/data/export` binds the caller's subsidiary fence before every read;
 * the import route bound nothing on the write side. A caller restricted to
 * one legal entity could load payroll carry-ins (which feed the next
 * cheque's CPP/EI room) for an employee of another entity, and the preview
 * reported that hidden employee as "created". The route now refuses
 * restricted callers for resources that cannot enforce the fence, and the
 * payroll resources enforce it row by row in both preview and commit.
 */
const stateKey = Symbol.for("openbooks.data-import-scope-test");
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
  const state = globalThis[Symbol.for('openbooks.data-import-scope-test')]
  export async function guardPermission() {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function can(authz, perm) { return authz.permissions.has(perm) }
`;

const webRoot = new URL("../../", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`.${specifier.slice(1)}.ts`, webRoot).href, context);
    }
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/data/import/")) {
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
const routeUrl = "../../app/api/data/import/route.ts?import-scope";
const { POST } = (await import(routeUrl)) as typeof import("../../app/api/data/import/route.ts");
hooks.deregister();

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://openbooks.test/api/data/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const carryIn = (mode: "preview" | "commit", employee: string) => ({
  mode,
  resource: "payroll-opening-balances",
  rows: [{ employee, taxYear: "2025", pensionableYtd: "5000.00", cppYtd: "100.00" }],
  mapping: {
    employee: "employee",
    taxYear: "taxYear",
    pensionableYtd: "pensionableYtd",
    cppYtd: "cppYtd",
  },
});

test(
  "the import route carries the caller's subsidiary fence onto every write",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const hidden = randomUUID();
      await db.execute(sql`insert into subsidiaries(id,org_id,name,base_currency,country,parent_id,is_elimination,is_active,custom)
        values(${hidden},${fx.orgId},'Other employer','CAD','CA',${fx.subsidiaryId},false,true,'{}'::jsonb)`);
      await db.execute(
        sql`update parties set subsidiary_id=${fx.subsidiaryId} where id=${fx.employeeId} and org_id=${fx.orgId}`,
      );
      const gate = (allowed: Set<string> | null) => ({
        user: { orgId: fx.orgId, id: fx.actorId },
        permissions: new Set(["data.import", "payroll.manage", "admin.setup.manage", "parties.manage"]),
        allowedSubsidiaryIds: allowed,
      });
      const carryInCount = async () =>
        Number((await db.execute<{ n: string }>(sql`
          select count(*)::text as n from payroll_opening_balances
           where org_id=${fx.orgId} and employee_party_id=${fx.employeeId}`)).rows[0]!.n);

      // A resource that cannot enforce the fence is refused for a restricted
      // caller in every mode, before any row is looked at.
      routeState.authz = gate(new Set([hidden]));
      for (const mode of ["preview", "commit"] as const) {
        const refused = await post({
          mode,
          resource: "accounts",
          rows: [{ number: "9999", name: "Smuggled" }],
          mapping: { number: "number", name: "name" },
        });
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), {
          error: "importing this resource requires organization-wide access",
        });
      }

      // The payroll carry-in resource enforces the fence per row: a hidden
      // employee fails in preview (no "would be created" disclosure) and in
      // commit (nothing written).
      for (const mode of ["preview", "commit"] as const) {
        const response = await post(carryIn(mode, fx.employeeName));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.outcome.created, 0);
        assert.equal(body.outcome.updated, 0);
        assert.equal(body.outcome.failed, 1);
        assert.match(body.outcome.errors[0].message, /outside the caller's subsidiary scope/);
      }
      assert.equal(await carryInCount(), 0);

      // The same rows from a caller whose scope covers the employee are written.
      routeState.authz = gate(new Set([fx.subsidiaryId]));
      const preview = await post(carryIn("preview", fx.employeeName));
      assert.equal((await preview.json()).outcome.created, 1);
      assert.equal(await carryInCount(), 0);
      const commit = await post(carryIn("commit", fx.employeeName));
      assert.equal(commit.status, 200);
      assert.equal((await commit.json()).outcome.created, 1);
      assert.equal(await carryInCount(), 1);

      // An unrestricted caller keeps every resource.
      routeState.authz = gate(null);
      const accounts = await post({
        mode: "preview",
        resource: "accounts",
        rows: [{ number: "9999", name: "Allowed" }],
        mapping: { number: "number", name: "name" },
      });
      assert.equal(accounts.status, 200);
    } finally {
      routeState.authz = null;
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
