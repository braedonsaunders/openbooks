import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  authz: {
    user: { id: string; orgId: string };
    allowedSubsidiaryIds: Set<string> | null;
  };
  gate: {
    id: string;
    org_id: string;
    status: string;
    assignee_user_id: string | null;
    assignee_role: string | null;
    subsidiary_id: string | null;
  } | null;
  scopeChecks: Array<string | null>;
  decisions: Array<Record<string, unknown>>;
}

const stateKey = Symbol.for("openbooks.flow-decide-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;
const routeState: RouteState = {
  authz: {
    user: {
      id: "00000000-0000-4000-8000-000000000010",
      orgId: "00000000-0000-4000-8000-000000000011",
    },
    allowedSubsidiaryIds: new Set(),
  },
  gate: {
    id: "00000000-0000-4000-8000-000000000012",
    org_id: "00000000-0000-4000-8000-000000000011",
    status: "pending",
    assignee_user_id: "00000000-0000-4000-8000-000000000010",
    assignee_role: null,
    subsidiary_id: "00000000-0000-4000-8000-000000000013",
  },
  scopeChecks: [],
  decisions: [],
};
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.flow-decide-route-test')]
      const NextResponse = globalThis.openbooksFlowDecideNextResponse
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        state.scopeChecks.push(subsidiaryId ?? null)
        if (authz.allowedSubsidiaryIds !== null &&
            (subsidiaryId === null || !authz.allowedSubsidiaryIds.has(subsidiaryId))) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
        return null
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return typeof value === 'string' && value.length > 0
      }
    `,
  ],
  [
    "mock:engine",
    `
      const state = globalThis[Symbol.for('openbooks.flow-decide-route-test')]
      export async function decideGate(args) {
        state.decisions.push(args)
        return { ok: true, resumed: 'approve', runStatus: 'completed' }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.flow-decide-route-test')]
      export async function requireFlowsSession() { return state.authz }
      export async function loadGateHeader() { return state.gate }
      export function gateErrorResponse(error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500 })
      }
    `,
  ],
]);

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksFlowDecideNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/flows/index.ts", "mock:engine"],
  ["../../_lib", "mock:lib"],
]);

let postRoute: typeof import("./route.ts").POST | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
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

  const routeUrl = "./route.ts?flow-decide-subsidiary-scope";
  postRoute = (await import(routeUrl) as typeof import("./route.ts")).POST;
  hooks.deregister();
}

const GATE_ID = "00000000-0000-4000-8000-000000000012";
const SUBJECT_SUBSIDIARY = "00000000-0000-4000-8000-000000000013";

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.authz.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.gate = {
    id: GATE_ID,
    org_id: routeState.authz.user.orgId,
    status: "pending",
    assignee_user_id: routeState.authz.user.id,
    assignee_role: null,
    subsidiary_id: SUBJECT_SUBSIDIARY,
  };
  routeState.scopeChecks = [];
  routeState.decisions = [];
}

function request(): Request {
  return new Request("http://openbooks.test/api/flows/gates/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gateId: GATE_ID, decision: "approved" }),
  });
}

if (isVitest) {
  // Vitest does not install the repository's Node ESM resolve hooks, and this
  // Next route intentionally uses the production @/ alias. Keep the exact
  // command useful in that runner with a source-boundary check; the normal
  // node:test invocation above exercises the route end to end with mocks.
  const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  test("the decision route enforces and forwards subsidiary scope", () => {
    assert.match(routeSource, /guardSubsidiaryScope\(authz, gate\.subsidiary_id\)/);
    assert.match(routeSource, /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/);
  });
} else {
  test("a restricted approver cannot decide a gate for another subsidiary", async () => {
    reset(new Set(["00000000-0000-4000-8000-000000000099"]));

    const response = await postRoute!(request());

    assert.equal(response.status, 404);
    assert.deepEqual(routeState.scopeChecks, [SUBJECT_SUBSIDIARY]);
    assert.deepEqual(routeState.decisions, []);
  });

  test("an in-scope approver carries the subsidiary scope into the engine", async () => {
    reset(new Set([SUBJECT_SUBSIDIARY]));

    const response = await postRoute!(request());

    assert.equal(response.status, 200);
    assert.deepEqual(routeState.decisions, [
      {
        gateId: GATE_ID,
        decision: "approved",
        userId: routeState.authz.user.id,
        allowedSubsidiaryIds: routeState.authz.allowedSubsidiaryIds,
        comment: undefined,
        signature: undefined,
      },
    ]);
  });
}
