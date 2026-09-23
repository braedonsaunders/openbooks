import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// OM-09b: POST /api/journals must refuse a contentful leg without an
// account with a 422 naming the line — and write nothing (no document, no
// burned JE number). createManualJournal names the line before the
// ownership lookup. Only the session gate is stubbed; handler and storage
// are real.

const stateKey = Symbol.for("openbooks.journal-create-accountless-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: string[] | null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.journal-create-accountless-test')]
  export async function guardPermission(_permission) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
  export function guardSubsidiaryScope() {
    return null
  }
  export function subsidiariesInScope() {
    return true
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../lib/authz") {
      return { url: "mock:create-authz", shortCircuit: true };
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
    if (url === "mock:create-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const createRouteUrl = "./route.ts?journal-create-accountless-test";
const { POST } = (await import(createRouteUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "journals POST refuses an account-less contentful leg with its line number and writes nothing",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
      routeState.authz = {
        user: { orgId: org.orgId, id: adminId },
        permissions: new Set(),
        allowedSubsidiaryIds: null,
      };
      const before = (await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where kind = 'journal' and org_id = ${org.orgId}
      `))).rows[0]!.n;
      const res = await withOrgContext(
        org.orgId,
        () =>
          POST(
            new Request("http://localhost/api/journals", {
              method: "POST",
              headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
              body: JSON.stringify({
                lines: [
                  { accountId: org.accounts.cogs, amount: "100", description: "leg one" },
                  { accountId: "", amount: "50", description: "mystery leg" },
                  { accountId: org.accounts.bank, amount: "-150", description: "leg three" },
                ],
              }),
            }),
          ),
      );
      assert.equal(res.status, 422, `expected 422, got ${res.status}`);
      const body = (await res.json()) as { error?: unknown };
      assert.match(
        String(body.error ?? ""),
        /Line 2: an account is required/,
        "the refusal must name the offending leg and the remedy",
      );
      const after = (await withOrgContext(org.orgId, () => db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents where kind = 'journal' and org_id = ${org.orgId}
      `))).rows[0]!.n;
      assert.equal(after, before, "a refused create must store no journal");
    } finally {
      routeState.authz = null;
      await dropScratchOrg(org.orgId);
    }
  },
);
