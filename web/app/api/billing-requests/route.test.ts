import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

type Scope = Set<string> | null;

interface RouteState {
  allowedSubsidiaryIds: Scope;
  projectSubsidiaryId: string;
  listCalls: Array<{
    orgId: string;
    projectId: string;
    allowedSubsidiaryIds: Scope;
  }>;
  createCalls: Array<{
    orgId: string;
    userId: string;
    projectId: string;
    allowedSubsidiaryIds: Scope;
  }>;
}

const stateKey = Symbol.for("openbooks.billing-requests-route-test");
const routeState: RouteState = {
  allowedSubsidiaryIds: null,
  projectSubsidiaryId: "sub-visible",
  listCalls: [],
  createCalls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksBillingRequestsNextResponse = NextResponse;

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
      const state = globalThis[Symbol.for('openbooks.billing-requests-route-test')]
      export async function guardPermission() {
        return {
          user: { id: 'user-1', orgId: 'org-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    "mock:projects-gate",
    `
      export async function guardProjectsFeature() { return null }
    `,
  ],
  [
    "mock:exact-decimal",
    `
      export function canonicalDecimal() { return null }
    `,
  ],
  [
    "mock:money",
    `
      export function normalizeMoney(value) { return String(value) }
    `,
  ],
  [
    "mock:billing-requests",
    `
      const state = globalThis[Symbol.for('openbooks.billing-requests-route-test')]
      const visible = (allowed) =>
        allowed === null || allowed === undefined || allowed.has(state.projectSubsidiaryId)

      export async function listBillingRequests(orgId, projectId, allowedSubsidiaryIds) {
        state.listCalls.push({ orgId, projectId, allowedSubsidiaryIds })
        return visible(allowedSubsidiaryIds)
          ? [{ id: 'request-1', projectId }]
          : []
      }

      export async function createBillingRequest(orgId, userId, input, allowedSubsidiaryIds) {
        if (!visible(allowedSubsidiaryIds)) throw new Error('Project not found')
        state.createCalls.push({
          orgId,
          userId,
          projectId: input.projectId,
          allowedSubsidiaryIds,
        })
        return { id: 'request-1', projectId: input.projectId }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/list-params", "mock:list-params"],
  ["../../../lib/projects-gate", "mock:projects-gate"],
  ["../../../lib/exact-decimal", "mock:exact-decimal"],
  ["@openbooks/engine/src/money.ts", "mock:money"],
  ["../../../lib/billing-requests", "mock:billing-requests"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { format: "module", shortCircuit: true, url: "mock:server-only" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { format: "module", shortCircuit: true, url: mocked };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    if (url === "mock:server-only")
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?billing-request-scope-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";

function reset(
  allowedSubsidiaryIds: Scope,
  projectSubsidiaryId = "sub-visible",
) {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds;
  routeState.projectSubsidiaryId = projectSubsidiaryId;
  routeState.listCalls = [];
  routeState.createCalls = [];
}

function get() {
  return GET(
    new Request(
      `http://openbooks.test/api/billing-requests?projectId=${PROJECT_ID}`,
    ),
  );
}

function post(body: Record<string, unknown>) {
  return POST(
    new Request("http://openbooks.test/api/billing-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("GET does not enumerate requests for a project outside the caller subsidiary scope", async () => {
  reset(new Set(["sub-visible"]), "sub-hidden");

  const response = await get();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { requests: [] });
  assert.deepEqual(routeState.listCalls, [
    {
      orgId: "org-1",
      projectId: PROJECT_ID,
      allowedSubsidiaryIds: new Set(["sub-visible"]),
    },
  ]);
});

test("GET lists requests for a project inside the caller subsidiary scope", async () => {
  reset(new Set(["sub-visible"]));

  const response = await get();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    requests: [{ id: "request-1", projectId: PROJECT_ID }],
  });
});

test("POST refuses to create a request for a project outside the caller subsidiary scope", async () => {
  reset(new Set(["sub-visible"]), "sub-hidden");

  const response = await post({ projectId: PROJECT_ID });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.deepEqual(routeState.createCalls, []);
});

test("POST creates a request for a project inside the caller subsidiary scope", async () => {
  reset(new Set(["sub-visible"]));

  const response = await post({ projectId: PROJECT_ID });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: "request-1",
    projectId: PROJECT_ID,
  });
  assert.deepEqual(routeState.createCalls, [
    {
      orgId: "org-1",
      userId: "user-1",
      projectId: PROJECT_ID,
      allowedSubsidiaryIds: new Set(["sub-visible"]),
    },
  ]);
});
