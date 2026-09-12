import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// ID4 — the enterOrg server action is reachable from any signed-in client
// component. It must validate the org id before the resolver casts it to uuid
// (a Postgres 22P02 otherwise surfaces as a 500), delegate the access decision
// to resolveActiveEnv (the same resolver currentUser() runs per request), and
// set the workspace cookie under the shared secure-cookie policy.
const stateKey = Symbol.for("openbooks.sandbox-session-test");
interface State {
  authz: unknown;
  resolveCalls: string[];
  resolved: { orgId: string } | null;
  cookieSets: { name: string; value: string; options: Record<string, unknown> }[];
  cookieDeletes: string[];
}
const state: State = { authz: null, resolveCalls: [], resolved: null, cookieSets: [], cookieDeletes: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const HOME_ORG = "00000000-0000-4000-8000-00000000d001";
const HOME_USER = "00000000-0000-4000-8000-00000000d002";
const SANDBOX_ORG = "00000000-0000-4000-8000-00000000d003";

const mocks = new Map<string, string>([
  ["mock:headers", `
    const state = globalThis[Symbol.for('openbooks.sandbox-session-test')]
    export async function cookies() {
      return {
        set(name, value, options) { state.cookieSets.push({ name, value, options }) },
        delete(name) { state.cookieDeletes.push(name) },
      }
    }
  `],
  ["mock:navigation", `
    export function redirect(to) { throw new Error('NEXT_REDIRECT:' + to) }
  `],
  ["mock:auth", `
    export const ACTIVE_ENV_COOKIE_NAME = 'ob_active_env'
    export const SESSION_TTL_S = 1209600
    export function makeEnvToken(orgId) { return 'signed:' + orgId }
  `],
  ["mock:authz", `
    const state = globalThis[Symbol.for('openbooks.sandbox-session-test')]
    export async function getAuthz() { return state.authz }
  `],
  ["mock:org-access", `
    const state = globalThis[Symbol.for('openbooks.sandbox-session-test')]
    export async function resolveActiveEnv(_home, orgId) {
      state.resolveCalls.push(orgId)
      return state.resolved
    }
  `],
]);
const mockUrls = new Map<string, string>([
  ["next/headers", "mock:headers"],
  ["next/navigation", "mock:navigation"],
  ["./auth", "mock:auth"],
  ["./authz", "mock:authz"],
  ["./org-access", "mock:org-access"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked && context.parentURL?.includes("/sandbox-session.ts")) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const moduleUrl = "./sandbox-session.ts?sandbox-session-test";
const { enterOrg } = (await import(moduleUrl)) as typeof import("./sandbox-session.ts");
hooks.deregister();

function reset(): void {
  state.authz = { user: { homeUserId: HOME_USER, homeOrgId: HOME_ORG, isSuperAdmin: false } };
  state.resolveCalls = [];
  state.resolved = null;
  state.cookieSets = [];
  state.cookieDeletes = [];
}

test("enterOrg rejects a non-uuid workspace id before the resolver sees it", async () => {
  reset();
  for (const bad of ["not-a-uuid", "", `${SANDBOX_ORG}'--`, "../etc"]) {
    await assert.rejects(() => enterOrg(bad), /invalid/i, `orgId ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(state.resolveCalls, [], "the resolver never received an unvalidated id");
  assert.deepEqual(state.cookieSets, []);
});

test("enterOrg refuses a workspace the resolver does not admit", async () => {
  reset();
  state.resolved = null;
  await assert.rejects(() => enterOrg(SANDBOX_ORG), /no access/i);
  assert.deepEqual(state.resolveCalls, [SANDBOX_ORG]);
  assert.deepEqual(state.cookieSets, []);
});

test("enterOrg sets the workspace cookie under the shared secure-cookie policy", async () => {
  reset();
  state.resolved = { orgId: SANDBOX_ORG };
  const previous = process.env.OPENBOOKS_COOKIE_SECURE;
  process.env.OPENBOOKS_COOKIE_SECURE = "1";
  try {
    await assert.rejects(() => enterOrg(SANDBOX_ORG), /NEXT_REDIRECT:\//);
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
  assert.equal(cookie!.options.secure, true, "OPENBOOKS_COOKIE_SECURE=1 must produce a Secure cookie outside production");
});

test("enterOrg clears the cookie when returning home", async () => {
  reset();
  state.resolved = { orgId: HOME_ORG };
  await assert.rejects(() => enterOrg(HOME_ORG), /NEXT_REDIRECT:\//);
  assert.deepEqual(state.cookieDeletes, ["ob_active_env"]);
  assert.deepEqual(state.cookieSets, []);
});


test("enterOrg opens the real preview route and refuses external redirect destinations", async () => {
  reset();
  state.resolved = { orgId: SANDBOX_ORG };
  await assert.rejects(() => enterOrg(SANDBOX_ORG, "/reports/pnl?layoutPreview=1"), /^Error: NEXT_REDIRECT:\/reports\/pnl\?layoutPreview=1$/);
  for (const target of ["//outside.test", "/\\outside.test", "https://outside.test", "/\noutside"]) {
    await assert.rejects(() => enterOrg(SANDBOX_ORG, target), /^Error: NEXT_REDIRECT:\/$/);
  }
});
