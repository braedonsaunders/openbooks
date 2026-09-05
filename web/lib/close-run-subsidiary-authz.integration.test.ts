import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// Live-Postgres route regression: close-run creation must never turn a
// restricted caller's omitted, malformed, empty, or out-of-scope subsidiary
// selection into the engine's org-wide [] sentinel. Authorization is mocked at
// the route seam; the real route and close engine persist the accepted scope.
const stateKey = Symbol.for("openbooks.close-run-subsidiary-authz-test");
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
  const state = globalThis[Symbol.for('openbooks.close-run-subsidiary-authz-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("/api/close/runs/route")) {
      return { url: "mock:close-run-authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href,
        context,
      );
    }
    if (specifier.startsWith("@openbooks/engine/") && context.parentURL?.includes("/api/close/runs/route")) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(
          parentDir.slice(0, webRoot + 1)
            + "engine/"
            + specifier.slice("@openbooks/engine/".length),
        ).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:close-run-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/close/runs/route.ts?close-run-subsidiary-authz";
const { POST } = (await import(routeUrl)) as typeof import("../app/api/close/runs/route.ts");
hooks.deregister();

const { db, env } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/test-fixtures.ts",
);

const DB = !!env.OPENBOOKS_DB_URL;

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request("http://openbooks.test/api/close/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function setAuthz(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: Set<string> | null,
): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    permissions: new Set(["close.run"]),
    allowedSubsidiaryIds,
  };
}

test(
  "close-run creation is fail-closed at the subsidiary authorization boundary",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actors = await seedFlowActors(org.orgId);
    const otherSubsidiaryId = randomUUID();
    try {
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values
          (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Restricted Branch', 'CAD', 'CA',
           '{}'::jsonb, false, true, '{}'::jsonb)`);

      const validBody = { periodId: org.periodId, bookId: org.bookId };

      // A concrete target cannot grant access to the engine's organization-wide
      // diagnostics and evidence. Refuse before any run is persisted.
      setAuthz(org.orgId, actors.adminId, new Set([org.subsidiaryId]));
      const omitted = await post(validBody);
      assert.equal(omitted.status, 404);
      const omittedRun = (await db.execute<{ scope: { subsidiaryIds?: string[] } }>(sql`
        select scope from close_runs where org_id = ${org.orgId}
          and period_id = ${org.periodId} and book_id = ${org.bookId}`)).rows[0];
      assert.equal(omittedRun, undefined);

      // Invalid UUIDs are rejected instead of silently filtered to an empty,
      // org-wide request, and an active but unauthorized entity is rejected.
      const malformed = await post({ ...validBody, subsidiaryIds: ["bad"] });
      assert.equal(malformed.status, 400);
      const outOfScope = await post({ ...validBody, subsidiaryIds: [otherSubsidiaryId] });
      assert.equal(outOfScope.status, 403);

      // An empty restricted policy has no legal close scope and omission must
      // fail closed rather than widening to the organization.
      setAuthz(org.orgId, actors.adminId, new Set());
      const emptyRestricted = await post(validBody);
      assert.equal(emptyRestricted.status, 403);

      // Only the null sentinel requests an org-wide scope for an unrestricted
      // caller; [] is rejected so an accidental empty list cannot widen scope.
      setAuthz(org.orgId, actors.adminId, null);
      const emptyUnrestricted = await post({ ...validBody, subsidiaryIds: [] });
      assert.equal(emptyUnrestricted.status, 400);
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
