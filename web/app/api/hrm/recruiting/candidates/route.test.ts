import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-recruiting-candidates-route-test");
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
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-candidates-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.recruiting.read' && permission !== 'hrm.recruiting.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRecruitingCandidatesNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-candidates-route-test')]
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
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-candidates-route-test')]
      export async function createCandidate(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { candidate: { id: 'candidate-1' }, mergedInto: null }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-candidates-route-test')]
      export async function getCandidateDetail(args) {
        state.calls.push({ fn: 'get', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.candidateId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-candidates-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingCandidatesNextResponse
      export function recruitingErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingCandidatesNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/recruiting/candidates.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/recruiting/recruiting-read.ts", "mock:read"],
  ["../_lib", "mock:lib"],
  ["../../_lib", "mock:lib"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
let itemRoute: typeof import("./[id]/route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
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
  const collectionUrl = "./route.ts?hrm-recruiting-candidates-collection";
  collectionRoute = (await import(collectionUrl)) as typeof import("./route.ts");
  const itemUrl = "./[id]/route.ts?hrm-recruiting-candidates-item";
  itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
  hooks.deregister();
}

const CANDIDATE_ID = "00000000-0000-4000-8000-000000000031";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [] as RouteState["calls"];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("candidates routes gate on the hrm feature and the recruiting permissions", async () => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.manage"\)/);
    assert.match(readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.read"\)/);
  });
} else {
  test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    assert.equal((await collectionRoute!.POST(jsonRequest("http://openbooks.test/x", "POST", {}))).status, 404);
    assert.equal(
      (await itemRoute!.GET(new Request("http://openbooks.test/x"), { params: Promise.resolve({ id: CANDIDATE_ID }) })).status,
      404,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("create validates the body through the real parser before the service runs", async () => {
    reset();
    const url = "http://openbooks.test/api/hrm/recruiting/candidates";
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", {}))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { displayName: "Ada", source: "newspaper" }))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { displayName: "Ada", mergeInto: "nope" }))).status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("create forwards org, actor, and body, then 201s", async () => {
    reset();
    const response = await collectionRoute!.POST(
      jsonRequest("http://openbooks.test/api/hrm/recruiting/candidates", "POST", {
        displayName: "Ada Candidate",
        email: "ada@example.test",
        source: "direct",
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { candidate: { id: "candidate-1" }, mergedInto: null });
    assert.equal(routeState.calls[0]!.fn, "create");
    assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).displayName, "Ada Candidate");
  });

  test("item GET validates the id and resolves the drawer", async () => {
    reset();
    assert.equal(
      (await itemRoute!.GET(new Request("http://openbooks.test/x"), { params: Promise.resolve({ id: "nope" }) })).status,
      400,
    );
    const response = await itemRoute!.GET(new Request("http://openbooks.test/x"), {
      params: Promise.resolve({ id: CANDIDATE_ID }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { candidate: { id: CANDIDATE_ID } });
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("a candidate with this email already exists (Ada)");
    routeState.serviceThrow = refusal;
    const response = await collectionRoute!.POST(
      jsonRequest("http://openbooks.test/api/hrm/recruiting/candidates", "POST", { displayName: "Ada Clone", email: "ada@example.test" }),
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
