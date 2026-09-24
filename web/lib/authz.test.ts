// source-pin-contract: API routes must answer auth failures with 401/403 JSON, never the page gate redirect; subjects derived by walking web/app/api
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextResponse } from "next/server";
import { resolveEffectivePermissions } from "./permissions";

const apiRoot = fileURLToPath(new URL("../app/api/", import.meta.url));

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  }));
  return nested.flat();
}

type GateMode = "allowed" | "forbidden" | "unauthorized";
type GateResult = NextResponse | {
  user: { id: string; orgId: string };
  permissions: Set<string>;
  allowedSubsidiaryIds: null;
};

const stateKey = Symbol.for("openbooks.authz-route-contract-test");
interface RouteState {
  gate: GateResult;
  gateCalls: string[];
  dbCalls: number;
}
const allowedGate: GateResult = {
  user: { id: "user-1", orgId: "org-1" },
  permissions: new Set(["documents.manage"]),
  allowedSubsidiaryIds: null,
};
const routeState: RouteState = { gate: allowedGate, gateCalls: [], dbCalls: 0 };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for("openbooks.authz-route-contract-test")];
      export async function guardPermission(permission) {
        state.gateCalls.push(permission);
        return state.gate;
      }
      // Faithful to web/lib/authz.ts: only an unrestricted caller passes.
      export function guardUnrestrictedScope(authz) {
        if (authz?.allowedSubsidiaryIds == null) return null;
        return new Response(JSON.stringify({ error: "requires unrestricted subsidiary access" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.authz-route-contract-test")];
      export const db = {
        execute: async () => {
          state.dbCalls += 1;
          return { rows: [] };
        },
        transaction: async (work) => {
          state.dbCalls += 1;
          return work({
            execute: async () => {
              state.dbCalls += 1;
              return { rows: [] };
            },
          });
        },
      };
      export function ambientTenantOrgId() { return null }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(work) { return work() }
    `,
  ],
]);

const webRoot = new URL("../", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@openbooks/engine/src/platform/db.ts") {
      return { shortCircuit: true, url: "mock:db" };
    }
    if (specifier === "../../../lib/authz") {
      return { shortCircuit: true, url: "mock:authz" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", shortCircuit: true, source };
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/dunning/route.ts?authz-route-contract";
const { GET, POST } = (await import(routeUrl)) as typeof import(
  "../app/api/dunning/route.ts"
);
hooks.deregister();

// The route-contract cases above stub guardPermission. Those stay green if
// can(), subsidiaryScopeAllows, or guardSubsidiaryScope starts with
// `return true` (or the HTTP twin, `return null`). Load the real module
// after the route mock is gone so the cases below call the functions.
const behavioralStateKey = Symbol.for("openbooks.authz-behavioral-test");
interface BehavioralState {
  user: import("./auth").SessionUser | null;
}
const behavioralState: BehavioralState = { user: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[behavioralStateKey] = behavioralState;

const behavioralHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "./auth" && context.parentURL?.includes("lib/authz.ts")) {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript," + encodeURIComponent(`
          const state = globalThis[Symbol.for("openbooks.authz-behavioral-test")];
          export async function currentUser() { return state.user; }
        `),
      };
    }
    return nextResolve(specifier, context);
  },
});

const behavioralUrl = './authz.ts?behavioral'
const {
  can,
  subsidiaryScopeAllows,
  guardSubsidiaryScope,
  guardUnrestrictedScope,
  subsidiariesInScope,
  getAuthz,
  guardPermission,
  assertCan,
  ForbiddenError,
} = (await import(behavioralUrl)) as typeof import('./authz.ts');
behavioralHooks.deregister();

type Authz = import("./authz.ts").Authz;
type SessionUser = import("./auth").SessionUser;

function sessionUser(): SessionUser {
  return {
    id: "user-1",
    email: "authz-probe@example.test",
    name: "Authz Probe",
    roles: [],
    orgId: "org-1",
    envKind: "production",
    productionOrgId: "org-1",
    isSuperAdmin: false,
    homeUserId: "user-1",
    homeOrgId: "org-1",
  };
}

function authzWith(
  permissions: Iterable<string>,
  allowedSubsidiaryIds: Set<string> | null = null,
): Authz {
  return { user: sessionUser(), permissions: new Set(permissions), allowedSubsidiaryIds };
}

function reset(mode: GateMode): void {
  routeState.gate = mode === "unauthorized"
    ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
    : mode === "forbidden"
      ? NextResponse.json(
        { error: "missing permission: documents.manage" },
        { status: 403 },
      )
      : allowedGate;
  routeState.gateCalls.length = 0;
  routeState.dbCalls = 0;
}

async function assertJsonError(
  response: Response,
  status: 401 | 403,
  error: string,
): Promise<void> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(response.headers.get("location"), null, "API denials must not redirect");
  assert.deepEqual(await response.json(), { error });
}

// Complete asynchronous setup before registering tests so --test-force-exit
// cannot finish the initial queue while later tests are still being loaded.
test("API routes never use the redirecting page authorization gate", async () => {
  const redirectGateImport = /import\s*\{[^}]*\brequirePermission\b[^}]*\}\s*from\s*["'][^"']*\/authz["']/s;
  const redirectGateCall = /(^|[^.\w])requirePermission\s*\(/m;
  const offenders: string[] = [];
  for (const file of await routeFiles(apiRoot)) {
    const source = await readFile(file, "utf8");
    if (redirectGateImport.test(source) || redirectGateCall.test(source)) {
      offenders.push(relative(apiRoot, file));
    }
  }
  assert.deepEqual(offenders, [], "API handlers must use guardPermission and return its JSON response");
});

test("a signed-out GET returns a 401 JSON response without reaching the database", async () => {
  reset("unauthorized");

  const response = await GET();

  await assertJsonError(response, 401, "unauthorized");
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 0);
});

test("a forbidden write returns a 403 JSON response without parsing or writing", async () => {
  reset("forbidden");
  const request = new Request("http://openbooks.test/api/dunning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Blocked policy", stages: [] }),
  });

  const response = await POST(request);

  await assertJsonError(response, 403, "missing permission: documents.manage");
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 0);
});

test("an allowed GET continues through the handler", async () => {
  reset("allowed");

  const response = await GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { policies: [] });
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 2);
});

async function assertNotFound(response: Response): Promise<void> {
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.deepEqual(await response.json(), { error: "not found" });
}

// ---------------------------------------------------------------------------
// Real guards. A function that starts with `return true` (or the HTTP allow
// `return null`) fails every deny case below. Source greps of the
// implementation would still pass after that early return.
// ---------------------------------------------------------------------------

test("can() is false for a missing grant", () => {
  assert.equal(can(authzWith([]), "ap.post"), false);
  assert.equal(can(authzWith(["ap.read"]), "ap.post"), false);
  assert.equal(can(authzWith(["ar.*"]), "ap.post"), false);
});

test("can() is false when a deny override wins", () => {
  const denied = authzWith(resolveEffectivePermissions({
    rolePermissionSets: [["ap.post", "ap.read"]],
    overrides: [{ permission: "ap.post", effect: "deny" }],
  }));
  assert.equal(can(denied, "ap.post"), false);
  assert.equal(can(denied, "ap.read"), true);

  const runtimeDeny = authzWith(["*", "!ap.post"]);
  assert.equal(can(runtimeDeny, "ap.post"), false);
  assert.equal(can(runtimeDeny, "ap.read"), true);
});

test("can() honors exact and wildcard grants", () => {
  assert.equal(can(authzWith(["ap.post"]), "ap.post"), true);
  assert.equal(can(authzWith(["ap.*"]), "ap.post"), true);
  assert.equal(can(authzWith(["ap.*"]), "ar.post"), false);
  assert.equal(can(authzWith(["*"]), "admin.users.manage"), true);
});

test("assertCan throws ForbiddenError only when can() is false", () => {
  assert.doesNotThrow(() => assertCan(authzWith(["ap.post"]), "ap.post"));
  assert.throws(() => assertCan(authzWith(["ap.read"]), "ap.post"), (err: unknown) => {
    assert.ok(err instanceof ForbiddenError);
    assert.equal(err.permission, "ap.post");
    assert.equal(err.status, 403);
    return true;
  });
});

test("subsidiaryScopeAllows fails closed on a restricted unknown or null subsidiary", () => {
  const scope = new Set(["sub-a"]);
  assert.equal(subsidiaryScopeAllows(scope, "sub-b"), false);
  assert.equal(subsidiaryScopeAllows(scope, null), false);
  assert.equal(subsidiaryScopeAllows(scope, undefined), false);
  assert.equal(subsidiaryScopeAllows(scope, ""), false);
  assert.equal(subsidiaryScopeAllows(new Set(), "sub-a"), false);
});

test("subsidiaryScopeAllows admits unrestricted callers and explicit allowlist members", () => {
  assert.equal(subsidiaryScopeAllows(null, "sub-b"), true);
  assert.equal(subsidiaryScopeAllows(null, null), true);
  assert.equal(subsidiaryScopeAllows(new Set(["sub-a"]), "sub-a"), true);
  assert.equal(subsidiaryScopeAllows(new Set(["sub-a"]), null, { orgWideNull: true }), true);
  assert.equal(subsidiaryScopeAllows(new Set(["sub-a"]), "sub-b", { orgWideNull: true }), false);
});

test("guardSubsidiaryScope returns 404 for an out-of-scope record", async () => {
  const restricted = authzWith(["documents.manage"], new Set(["sub-a"]));
  const denied = guardSubsidiaryScope(restricted, "sub-b");
  assert.ok(denied, "out-of-scope must not return the allow (null)");
  await assertNotFound(denied);
  await assertNotFound(guardSubsidiaryScope(restricted, null)!);
  await assertNotFound(guardSubsidiaryScope(restricted, undefined)!);
  await assertNotFound(guardSubsidiaryScope(restricted, "")!);
});

test("guardSubsidiaryScope returns null only when the record is in scope", () => {
  const restricted = authzWith(["documents.manage"], new Set(["sub-a"]));
  assert.equal(guardSubsidiaryScope(restricted, "sub-a"), null);
  assert.equal(guardSubsidiaryScope(restricted, null, { orgWideNull: true }), null);
  assert.equal(guardSubsidiaryScope(authzWith(["documents.manage"], null), "sub-b"), null);
});

test("guardUnrestrictedScope refuses restricted callers with the named 403 remedy", async () => {
  const scopes: ReadonlyArray<Set<string>> = [new Set(["sub-a"]), new Set<string>()];
  for (const scope of scopes) {
    const denied = guardUnrestrictedScope(authzWith(["admin.setup.manage"], scope));
    assert.ok(denied, "a restricted caller must not reach org-wide writes");
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "requires unrestricted subsidiary access" });
  }
});

test("guardUnrestrictedScope allows only the unrestricted caller", () => {
  assert.equal(guardUnrestrictedScope(authzWith(["admin.setup.manage"], null)), null);
});

test("subsidiariesInScope refuses assigning a record the caller cannot see", () => {
  const restricted = authzWith(["documents.manage"], new Set(["sub-a"]));
  assert.equal(subsidiariesInScope(restricted, ["sub-a"]), true);
  assert.equal(subsidiariesInScope(restricted, ["sub-a", "sub-b"]), false);
  assert.equal(subsidiariesInScope(restricted, [null]), false);
  assert.equal(subsidiariesInScope(restricted, [undefined]), false);
  assert.equal(subsidiariesInScope(restricted, [""]), false);
  assert.equal(subsidiariesInScope(authzWith(["documents.manage"], null), ["sub-b"]), true);
});

test("getAuthz and guardPermission fail closed when there is no signed-in user", async () => {
  behavioralState.user = null;
  assert.equal(await getAuthz(), null);

  const denied = await guardPermission("ap.post");
  assert.ok(denied instanceof NextResponse, "missing user must be a JSON response, not an Authz allow");
  await assertJsonError(denied, 401, "unauthorized");
});
