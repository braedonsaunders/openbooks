import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The workspace endpoint is reachable from any signed-in tab. The switch must
// validate the org id before the resolver casts it to uuid, delegate the
// access decision to resolveActiveEnv (the same resolver currentUser() runs per
// request), and write the workspace cookie under the shared secure-cookie
// policy, clearing it for the home organization.
const stateKey = Symbol.for("openbooks.active-workspace-test");
interface State {
  resolveCalls: string[];
  resolved: { orgId: string } | null;
  cookieSets: { name: string; value: string; options: Record<string, unknown> }[];
  cookieDeletes: string[];
}
const state: State = { resolveCalls: [], resolved: null, cookieSets: [], cookieDeletes: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const HOME_ORG = "00000000-0000-4000-8000-00000000d001";
const HOME_USER = "00000000-0000-4000-8000-00000000d002";
const SANDBOX_ORG = "00000000-0000-4000-8000-00000000d003";

const mocks = new Map<string, string>([
  [
    "mock:headers",
    `
    const state = globalThis[Symbol.for('openbooks.active-workspace-test')]
    export async function cookies() {
      return {
        set(name, value, options) { state.cookieSets.push({ name, value, options }) },
        delete(name) { state.cookieDeletes.push(name) },
      }
    }
  `,
  ],
  [
    "mock:auth",
    `
    export const ACTIVE_ENV_COOKIE_NAME = 'ob_active_env'
    export const SESSION_TTL_S = 1209600
    export function makeEnvToken(orgId) { return 'signed:' + orgId }
  `,
  ],
  [
    "mock:org-access",
    `
    const state = globalThis[Symbol.for('openbooks.active-workspace-test')]
    export async function resolveActiveEnv(home, orgId) {
      state.resolveCalls.push(orgId)
      return state.resolved
    }
  `,
  ],
]);
const mockUrls = new Map<string, string>([
  ["next/headers", "mock:headers"],
  ["./auth", "mock:auth"],
  ["./org-access", "mock:org-access"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked && context.parentURL?.includes("/active-workspace.ts"))
      return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const moduleUrl = "./active-workspace.ts?active-workspace-test";
const { switchActiveWorkspace } = (await import(
  moduleUrl
)) as typeof import("./active-workspace.ts");
hooks.deregister();

const authz = {
  user: { homeUserId: HOME_USER, homeOrgId: HOME_ORG, isSuperAdmin: false },
} as Parameters<typeof switchActiveWorkspace>[0];

function reset(): void {
  state.resolveCalls = [];
  state.resolved = null;
  state.cookieSets = [];
  state.cookieDeletes = [];
}

test("a malformed workspace id is refused before the resolver sees it", async () => {
  reset();
  for (const bad of ["not-a-uuid", "", `${SANDBOX_ORG}'--`, "../etc", null, 42]) {
    assert.deepEqual(
      await switchActiveWorkspace(authz, bad),
      { ok: false, reason: "invalid" },
      `orgId ${JSON.stringify(bad)}`,
    );
  }
  assert.deepEqual(state.resolveCalls, [], "the resolver never received an unvalidated id");
  assert.deepEqual(state.cookieSets, []);
  assert.deepEqual(state.cookieDeletes, []);
});

test("a workspace the resolver does not admit is refused and the cookie is untouched", async () => {
  reset();
  assert.deepEqual(await switchActiveWorkspace(authz, SANDBOX_ORG), {
    ok: false,
    reason: "no-access",
  });
  assert.deepEqual(state.resolveCalls, [SANDBOX_ORG]);
  assert.deepEqual(state.cookieSets, []);
  assert.deepEqual(state.cookieDeletes, []);
});

test("entering another workspace sets the signed cookie under the shared secure-cookie policy", async () => {
  reset();
  state.resolved = { orgId: SANDBOX_ORG };
  const previous = process.env.OPENBOOKS_COOKIE_SECURE;
  process.env.OPENBOOKS_COOKIE_SECURE = "1";
  try {
    assert.deepEqual(await switchActiveWorkspace(authz, SANDBOX_ORG), {
      ok: true,
      orgId: SANDBOX_ORG,
    });
  } finally {
    if (previous === undefined) delete process.env.OPENBOOKS_COOKIE_SECURE;
    else process.env.OPENBOOKS_COOKIE_SECURE = previous;
  }
  assert.equal(state.cookieSets.length, 1);
  const [cookie] = state.cookieSets;
  assert.equal(cookie!.name, "ob_active_env");
  assert.equal(cookie!.value, `signed:${SANDBOX_ORG}`);
  assert.equal(cookie!.options.httpOnly, true);
  assert.equal(cookie!.options.sameSite, "lax");
  assert.equal(cookie!.options.path, "/");
  assert.equal(
    cookie!.options.secure,
    true,
    "OPENBOOKS_COOKIE_SECURE=1 must produce a Secure cookie outside production",
  );
});

test("returning to the home organization clears the cookie", async () => {
  reset();
  state.resolved = { orgId: HOME_ORG };
  assert.deepEqual(await switchActiveWorkspace(authz, HOME_ORG), { ok: true, orgId: HOME_ORG });
  assert.deepEqual(state.cookieDeletes, ["ob_active_env"]);
  assert.deepEqual(state.cookieSets, []);
});
