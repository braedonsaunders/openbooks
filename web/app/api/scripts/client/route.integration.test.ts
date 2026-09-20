import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// F-t05-007: saving a banking draft logged a console 404 for
// /api/scripts/client on every doctype. The route 404d whenever the
// scripts feature was off — but the client loader calls it on every save,
// and browsers log failed fetches however they are handled. Feature-off is
// a normal empty state: 200 with no scripts. These tests drive the REAL
// handler (only the session gate is stubbed) in a scratch org, where the
// scripts feature is off by default.

const stateKey = Symbol.for("openbooks.scripts-client-test");
interface RouteState {
  authz: { user: { orgId: string; id: string } } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.scripts-client-test')]
  export async function getAuthz() {
    return state.authz
  }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/authz") {
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

const { GET } = (await import("./route.ts")) as {
  GET: (req: Request) => Promise<Response>;
};
const { createScratchOrg, dropScratchOrg } = (await import(
  "../../../../../engine/src/testing/fixtures.ts"
)) as typeof import("../../../../../engine/src/testing/fixtures.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

test("scripts delivery answers the empty set with the feature off", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    routeState.authz = { user: { orgId: org.orgId, id: "00000000-0000-4000-8000-000000000001" } };
    const res = await GET(
      new Request("http://localhost/api/scripts/client?documentKind=transfer"),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { scripts: [] });
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
