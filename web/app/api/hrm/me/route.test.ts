import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  perms: string[];
}

const stateKey = Symbol.for("openbooks.hrm-me-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
  perms: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-route-test')]
      export async function guardPermission(permission) {
        state.perms.push(permission)
        if (permission !== 'hrm.self.read' && permission !== 'hrm.self.request') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmMeRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    "mock:self-read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-route-test')]
      async function run(fn, args) {
        state.calls.push({ fn, args })
        if (state.serviceThrow) throw state.serviceThrow
        return { fn, ok: true }
      }
      export async function getMyProfile(args) { return run('profile', args) }
      export async function getMySteps(args) { return run('steps', args) }
      export async function getMyRequests(args) { return run('requests', args) }
    `,
  ],
  [
    "mock:team-read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-route-test')]
      export async function getTeamView(args) {
        state.calls.push({ fn: 'team', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { asOf: '2026-09-20', reports: [] }
      }
    `,
  ],
  [
    "mock:profile-changes",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-me-route-test')]
      export async function fileProfileChangeRequest(args) {
        state.calls.push({ fn: 'file', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { request: { id: 'request-1', status: 'pending_approval' } }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmMeRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/self-service/self-read.ts", "mock:self-read"],
  ["@openbooks/engine/src/hrm/self-service/team-read.ts", "mock:team-read"],
  ["@openbooks/engine/src/hrm/self-service/profile-changes.ts", "mock:profile-changes"],
]);

let profileRoute: typeof import("./profile/route.ts") | undefined;
let stepsRoute: typeof import("./steps/route.ts") | undefined;
let requestsRoute: typeof import("./requests/route.ts") | undefined;
let teamRoute: typeof import("./team/route.ts") | undefined;
let fileRoute: typeof import("./profile-changes/route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      // The real JSON boundary is pure (Request + schema → value) and runs
      // as-is; only its server-only marker needs a stand-in outside Next.
      // The real error mapping runs as-is too: refusals assert their real
      // statuses, not a mocked mapping.
      if (specifier === "server-only") {
        return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
      }
      const mocked = mockUrls.get(specifier);
      if (mocked) return { url: mocked, shortCircuit: true };
      return nextResolve(specifier);
    },
    load(url, _context, nextLoad) {
      const source = mockSources.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      return nextLoad(url);
    },
  });
  const profileRouteUrl = "./profile/route.ts?hrm-me-profile";
  profileRoute = (await import(profileRouteUrl)) as typeof import("./profile/route.ts");
  const stepsRouteUrl = "./steps/route.ts?hrm-me-steps";
  stepsRoute = (await import(stepsRouteUrl)) as typeof import("./steps/route.ts");
  const requestsRouteUrl = "./requests/route.ts?hrm-me-requests";
  requestsRoute = (await import(requestsRouteUrl)) as typeof import("./requests/route.ts");
  const teamRouteUrl = "./team/route.ts?hrm-me-team";
  teamRoute = (await import(teamRouteUrl)) as typeof import("./team/route.ts");
  const fileRouteUrl = "./profile-changes/route.ts?hrm-me-file";
  fileRoute = (await import(fileRouteUrl)) as typeof import("./profile-changes/route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.perms = [];
}

function postFile(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/me/profile-changes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a missing feature flag 404s before any service runs", async () => {
  reset();
  routeState.featureOn = false;
  assert.equal((await profileRoute!.GET()).status, 404);
  assert.equal((await stepsRoute!.GET()).status, 404);
  assert.equal((await requestsRoute!.GET()).status, 404);
  assert.equal((await teamRoute!.GET()).status, 404);
  assert.equal(
    (await fileRoute!.POST(postFile({ employmentId: EMPLOYMENT_ID, changes: { kind: "profile_change" }, reason: "x" }))).status,
    404,
  );
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches a service", async () => {
  reset();
  routeState.gate = { status: 401 };
  assert.equal((await profileRoute!.GET()).status, 401);
  assert.equal((await teamRoute!.GET()).status, 401);
  assert.equal(
    (await fileRoute!.POST(postFile({ employmentId: EMPLOYMENT_ID, changes: { kind: "profile_change" }, reason: "x" }))).status,
    401,
  );
  assert.deepEqual(routeState.calls, []);
});

test("reads forward org and actor and return the service payload", async () => {
  reset();
  const profile = await profileRoute!.GET();
  assert.equal(profile.status, 200);
  assert.deepEqual(await profile.json(), { profile: { fn: "profile", ok: true } });
  const team = await teamRoute!.GET();
  assert.equal(team.status, 200);
  assert.deepEqual((await team.json()).team.asOf, "2026-09-20");
  assert.deepEqual(routeState.calls, [
    { fn: "profile", args: { orgId: "org-1", actorId: "user-1" } },
    { fn: "team", args: { orgId: "org-1", actorId: "user-1" } },
  ]);
  assert.deepEqual(routeState.perms, ["hrm.self.read", "hrm.self.read"]);
});

test("filing validates the body before the service runs, then 201s", async () => {
  reset();
  const good = { employmentId: EMPLOYMENT_ID, changes: { kind: "profile_change", phone: "x" }, reason: "moved" };
  assert.equal((await fileRoute!.POST(postFile({}))).status, 400);
  assert.equal((await fileRoute!.POST(postFile({ ...good, employmentId: "nope" }))).status, 400);
  assert.equal((await fileRoute!.POST(postFile({ ...good, reason: "  " }))).status, 400);
  assert.equal((await fileRoute!.POST(postFile({ ...good, changes: {} }))).status, 400);
  assert.deepEqual(routeState.calls, []);
  const response = await fileRoute!.POST(postFile(good));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { request: { id: "request-1", status: "pending_approval" } });
  assert.deepEqual(routeState.calls, [
    {
      fn: "file",
      args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID, changes: good.changes, reason: "moved" },
    },
  ]);
  assert.ok(routeState.perms.length > 0 && routeState.perms.every((perm) => perm === "hrm.self.request"));
});

test("a no-link refusal reaches the caller as a 403 with the remedy intact", async () => {
  reset();
  const { SelfServiceError } = await import(
    "@openbooks/engine/src/hrm/self-service/actor.ts"
  );
  routeState.serviceThrow = new SelfServiceError(
    "NO_LINK",
    "no person is linked to this login — ask an administrator to link your person in Admin → Users → Link person before using self-service",
  );
  const response = await profileRoute!.GET();
  assert.equal(response.status, 403);
  assert.match((await response.json()).error as string, /Admin → Users → Link person/);
});

test("a report-less team refusal reaches the caller as a 403", async () => {
  reset();
  const { SelfServiceError } = await import(
    "@openbooks/engine/src/hrm/self-service/actor.ts"
  );
  routeState.serviceThrow = new SelfServiceError("NO_TEAM", "no direct reports as of 2026-09-20 — team visibility follows the current line");
  const response = await teamRoute!.GET();
  assert.equal(response.status, 403);
  assert.match((await response.json()).error as string, /no direct reports/);
});

test("malformed proposals map to 400 and unknown rows to 404", async () => {
  reset();
  const { SelfServiceError } = await import(
    "@openbooks/engine/src/hrm/self-service/actor.ts"
  );
  routeState.serviceThrow = new SelfServiceError("REFUSED", "profile change refused: phone must not be blank");
  assert.equal((await stepsRoute!.GET()).status, 400);
  routeState.serviceThrow = new SelfServiceError("NOT_FOUND", "the person linked to this login has no party record in this organization");
  assert.equal((await profileRoute!.GET()).status, 404);
});

test("a nested change-request refusal keeps the shared mapping", async () => {
  reset();
  const { HrmChangeRequestError } = await import("@openbooks/engine/src/hrm/change-requests.ts");
  routeState.serviceThrow = new HrmChangeRequestError("INVALID_PAYLOAD", "change payload invalid: foo");
  const response = await fileRoute!.POST(
    postFile({ employmentId: EMPLOYMENT_ID, changes: { kind: "profile_change", phone: "x" }, reason: "moved" }),
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error as string, /change payload invalid/);
});
