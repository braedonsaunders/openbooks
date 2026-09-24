import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { DuplicateProspectError } from "@openbooks/engine/src/hrm/recruiting/candidates.ts";
import { RecruitingError } from "@openbooks/engine/src/hrm/recruiting/errors.ts";

interface RouteState {
  denied: boolean;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-recruiting-attachments-route-test");
type TestFn = typeof nodeTest;
const test: TestFn = nodeTest;

const routeState: RouteState = { denied: false, featureOn: true, calls: [], serviceThrow: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-attachments-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingAttachmentsNextResponse
      export async function guardPermission(permission) {
        if (permission !== 'hrm.recruiting.manage') throw new Error('unexpected permission ' + permission)
        if (state.denied) return NextResponse.json({ error: 'denied' }, { status: 403 })
        return { user: { id: 'user-1', orgId: 'org-1' } }
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-attachments-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-attachments-route-test')]
      export async function attachCandidate(args) {
        state.calls.push({ fn: 'attach', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { candidate: { id: 'candidate-1' }, mergedInto: null, application: { id: 'application-1' } }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingAttachmentsNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/recruiting/applications.ts", "mock:service"],
]);

let attachRoute: typeof import("./route.ts") | undefined;
{
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
  const attachUrl = "./route.ts?hrm-recruiting-attachments";
  attachRoute = (await import(attachUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const REQUISITION_ID = "00000000-0000-4000-8000-000000000041";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000042";

function reset(): void {
  routeState.denied = false;
  routeState.featureOn = true;
  routeState.calls = [] as RouteState["calls"];
  routeState.serviceThrow = null;
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// F3-62: the attach route makes ONE service call that stores the prospect
// and the candidacy together — the island never splits them across POSTs.
// The error mapping runs for real: only authz and the service are doubled.
test("attach refuses without the manage grant before the service runs", async () => {
  reset();
  routeState.denied = true;
  const response = await attachRoute!.POST(
    jsonRequest("http://openbooks.test/api/hrm/recruiting/attachments", "POST", {
      requisitionId: REQUISITION_ID,
      displayName: "Ada",
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});

test("attach 404s with the feature off before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  const response = await attachRoute!.POST(
    jsonRequest("http://openbooks.test/api/hrm/recruiting/attachments", "POST", {
      requisitionId: REQUISITION_ID,
      displayName: "Ada",
    }),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("attach validates the body through the real parser before the service runs", async () => {
  reset();
  const url = "http://openbooks.test/api/hrm/recruiting/attachments";
  assert.equal((await attachRoute!.POST(jsonRequest(url, "POST", {}))).status, 400);
  assert.equal(
    (await attachRoute!.POST(jsonRequest(url, "POST", { requisitionId: REQUISITION_ID, displayName: "  " }))).status,
    400,
  );
  assert.equal(
    (
      await attachRoute!.POST(
        jsonRequest(url, "POST", { requisitionId: REQUISITION_ID, displayName: "Ada", mergeInto: "nope" }),
      )
    ).status,
    400,
  );
  assert.deepEqual(routeState.calls, []);
});

test("attach forwards org, actor, and body in one call, then 201s", async () => {
  reset();
  const response = await attachRoute!.POST(
    jsonRequest("http://openbooks.test/api/hrm/recruiting/attachments", "POST", {
      requisitionId: REQUISITION_ID,
      displayName: "Ada Candidate",
      email: "ada@example.test",
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    attached: { candidate: { id: "candidate-1" }, mergedInto: null, application: { id: "application-1" } },
  });
  assert.equal(routeState.calls.length, 1, "exactly one service call stores both rows");
  assert.deepEqual(routeState.calls[0]!.args, {
    orgId: "org-1",
    actorId: "user-1",
    requisitionId: REQUISITION_ID,
    displayName: "Ada Candidate",
    email: "ada@example.test",
    phone: undefined,
    mergeInto: undefined,
  });
});

test("a duplicate prospect maps to the 409 merge-retry shape, not a bare error", async () => {
  reset();
  routeState.serviceThrow = new DuplicateProspectError(CANDIDATE_ID, "Ada Candidate");
  const response = await attachRoute!.POST(
    jsonRequest("http://openbooks.test/api/hrm/recruiting/attachments", "POST", {
      requisitionId: REQUISITION_ID,
      displayName: "Ada Clone",
      email: "ada@example.test",
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "duplicate-email",
    candidate: { id: CANDIDATE_ID, displayName: "Ada Candidate" },
  });
});

test("engine refusals keep their message through the real error mapping", async () => {
  reset();
  routeState.serviceThrow = new RecruitingError(
    "BAD_STATE",
    "a cancelled requisition takes no new candidates — open it before attaching applications",
  );
  const response = await attachRoute!.POST(
    jsonRequest("http://openbooks.test/api/hrm/recruiting/attachments", "POST", {
      requisitionId: REQUISITION_ID,
      displayName: "Ada Candidate",
    }),
  );
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /cancelled requisition takes no new candidates/);
});
