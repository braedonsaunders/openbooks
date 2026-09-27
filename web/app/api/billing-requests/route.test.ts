import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { stubModules } from "../../../testing/stub-modules";

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

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles cannot produce the refusals the real modules
// enforce ('canonicalDecimal() { return null }' refused every amount,
// valid or not, so no amount case behind it was ever really tested).
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../lib/authz": `
      const state = globalThis[Symbol.for('openbooks.billing-requests-route-test')]
      export async function guardPermission() {
        return {
          user: { id: 'user-1', orgId: 'org-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
    "../../../lib/projects-gate": `
      export async function guardProjectsFeature() { return null }
    `,
    "../../../lib/billing-requests": `
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
  },
});

const routeUrl = "./route.ts?billing-request-scope-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");

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
