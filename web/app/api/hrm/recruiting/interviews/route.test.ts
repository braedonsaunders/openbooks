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

const stateKey = Symbol.for("openbooks.hrm-recruiting-interviews-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-interviews-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.recruiting.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRecruitingInterviewsNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-interviews-route-test')]
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
        return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-interviews-route-test')]
      export async function scheduleInterview(args) {
        state.calls.push({ fn: 'schedule', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'interview-1' }
      }
      export async function completeInterview(args) {
        state.calls.push({ fn: 'complete', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.interviewId }
      }
      export async function cancelInterview(args) {
        state.calls.push({ fn: 'cancel', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.interviewId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-interviews-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingInterviewsNextResponse
      export function recruitingErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingInterviewsNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/recruiting/interviews.ts", "mock:service"],
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
  collectionRoute = (await import("./route.ts?hrm-recruiting-interviews-collection")) as typeof import("./route.ts");
  itemRoute = (await import("./[id]/route.ts?hrm-recruiting-interviews-item")) as typeof import("./[id]/route.ts");
  hooks.deregister();
}

const APPLICATION_ID = "00000000-0000-4000-8000-000000000021";
const INTERVIEW_ID = "00000000-0000-4000-8000-000000000022";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
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
  test("interviews routes gate on the hrm feature and the manage permission", async () => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.manage"\)/);
    assert.match(readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.manage"\)/);
  });
} else {
  test("schedule validates the body through the real parser before the service runs", async () => {
    reset();
    const url = "http://openbooks.test/api/hrm/recruiting/interviews";
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", {}))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { applicationId: APPLICATION_ID, kind: "coffee" }))).status, 400);
    assert.equal(
      (await collectionRoute!.POST(jsonRequest(url, "POST", { applicationId: APPLICATION_ID, kind: "video" }))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    const response = await collectionRoute!.POST(
      jsonRequest(url, "POST", { applicationId: APPLICATION_ID, kind: "video", scheduledAt: "2026-09-25T14:00:00Z" }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { interview: { id: "interview-1" } });
  });

  test("item PATCH validates the action union through the real parser", async () => {
    reset();
    const params = { params: Promise.resolve({ id: INTERVIEW_ID }) };
    assert.equal((await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "complete" }), params)).status, 400);
    assert.equal(
      (await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "complete", outcome: "maybe" }), params)).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    assert.equal(
      (await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "complete", outcome: "advance" }), params)).status,
      200,
    );
    assert.equal(routeState.calls[0]!.fn, "complete");
    routeState.calls = [];
    assert.equal((await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "cancel" }), params)).status, 200);
    assert.equal(routeState.calls[0]!.fn, "cancel");
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("a panel member is not an employee in this organization");
    routeState.serviceThrow = refusal;
    const response = await collectionRoute!.POST(
      jsonRequest("http://openbooks.test/api/hrm/recruiting/interviews", "POST", {
        applicationId: APPLICATION_ID,
        kind: "video",
        scheduledAt: "2026-09-25T14:00:00Z",
      }),
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
