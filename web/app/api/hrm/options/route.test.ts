import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-options-route-test");

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-options-route-test')]
      export async function getAuthz() { return { user: { id: 'user-1', orgId: 'org-1' } } }
      export async function guardPermission() { return state.gate }
      export function guardRootSubsidiaryScope() { return null }; export function guardUnrestrictedScope() { return null }
    `,
  ],
  [
    "mock:feature-gates",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-options-route-test')]
      const NextResponse = globalThis.openbooksHrmOptionsNextResponse
      export async function guardFeaturePermission(permission, feature) {
        if ((permission !== 'hrm.employment.read' && permission !== 'hrm.position.read' && permission !== 'hrm.leave.manage' && permission !== 'hrm.leave.request') || feature !== 'hrm') {
          throw new Error('unexpected gate ' + permission + ' ' + feature)
        }
        if (state.gate && 'status' in state.gate) {
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        if (!state.featureOn) {
          return NextResponse.json({ error: 'not_found' }, { status: 404 })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:authz-engine",
    `
      export class HrmAuthorizationError extends Error {
        constructor(message) {
          super(message)
          this.name = 'HrmAuthorizationError'
        }
      }
      globalThis.openbooksHrmOptionsErrors = {
        ...(globalThis.openbooksHrmOptionsErrors ?? {}),
        HrmAuthorizationError,
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-options-route-test')]
      export class EmploymentReadError extends Error {
        constructor(message) {
          super(message)
          this.name = 'EmploymentReadError'
        }
      }
      globalThis.openbooksHrmOptionsErrors = {
        ...(globalThis.openbooksHrmOptionsErrors ?? {}),
        EmploymentReadError,
      }
      export async function listEmploymentOptions(args) {
        state.calls.push({ fn: 'employments', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ employmentId: 'employment-1', label: 'Alice Holder · Main · Cashier' }]
      }
      export async function listLocationOptions(args) {
        state.calls.push({ fn: 'locations', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ locationId: 'location-1', label: 'HQ · Headquarters' }]
      }
      export async function listPositionOptions(args) {
        state.calls.push({ fn: 'positions', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ positionId: 'position-1', label: 'ENG-1042 · Engineer · open' }]
      }
      export async function listPeopleOptions(args) {
        state.calls.push({ fn: 'people', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ partyId: 'party-1', label: 'Alice Holder' }]
      }
      export async function listHireablePeopleOptions(args) {
        state.calls.push({ fn: 'hireable-people', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ partyId: 'party-9', label: 'No Employment Yet' }]
      }
      export async function listEmployablePeopleOptions(args) {
        state.calls.push({ fn: 'employable-people', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ partyId: 'party-7', label: 'Vendor Val', hasEmployeeRole: false }]
      }
      export async function listEmployerSubsidiaryOptions(args) {
        state.calls.push({ fn: 'employer-subsidiaries', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ subsidiaryId: 'sub-1', label: 'Main Co' }]
      }
    `,
  ],
  [
    "mock:leave-read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-options-route-test')]
      export async function listLeaveTypeOptions(orgId) {
        return [{ id: 'type-1', label: 'VAC — Vacation' }]
      }
      export async function listLeaveFilingEmploymentOptions(args) {
        state.calls.push({ fn: 'leave-filing-employments', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ employmentId: 'employment-9', label: 'Quinn Vidal · Main · Nurse' }]
      }
      export async function listOwnLeaveEmploymentOptions(args) {
        state.calls.push({ fn: 'leave-own-employments', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ employmentId: 'employment-1', label: 'Quinn Vidal · Main · Nurse' }]
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmOptionsNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["@openbooks/engine/src/hrm/authorization.ts", "mock:authz-engine"],
  ["@openbooks/engine/src/hrm/employment-read.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/positions-read.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/leave-read.ts", "mock:leave-read"],
]);

registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked = mockUrls.get(specifier) ?? (specifier === "@/lib/authz" ? "mock:authz" : undefined);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url);
  },
});
const routeUrl = "./route.ts?hrm-options";
const optionsRoute = (await import(routeUrl)) as typeof import("./route.ts");

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function getRequest(params: string): Request {
  return new Request(`http://openbooks.test/api/hrm/options${params}`);
}

function errors(): { EmploymentReadError: new (message: string) => Error; HrmAuthorizationError: new (message: string) => Error } {
  return (globalThis as typeof globalThis & Record<string, unknown>)
    .openbooksHrmOptionsErrors as {
    EmploymentReadError: new (message: string) => Error;
    HrmAuthorizationError: new (message: string) => Error;
  };
}

test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    const response = await optionsRoute!.GET(getRequest("?source=employments"));
    assert.equal(response.status, 404);
    assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
    reset();
    routeState.gate = { status: 401 };
    const response = await optionsRoute!.GET(getRequest("?source=employments"));
    assert.equal(response.status, 401);
    assert.deepEqual(routeState.calls, []);
});

test("an unknown source is refused before the service runs", async () => {
    reset();
    assert.equal((await optionsRoute!.GET(getRequest(""))).status, 400);
    assert.equal((await optionsRoute!.GET(getRequest("?source=roster"))).status, 400);
    assert.deepEqual(routeState.calls, []);
});

test("a non-integer limit and a non-uuid include are refused", async () => {
    reset();
    assert.equal((await optionsRoute!.GET(getRequest("?source=employments&limit=many"))).status, 400);
    assert.equal((await optionsRoute!.GET(getRequest("?source=locations&include=nope"))).status, 400);
    assert.deepEqual(routeState.calls, []);
});

  test("employments forwards org, actor, search, page, and pin, then 200s", async () => {
    reset();
    const include = "00000000-0000-4000-8000-000000000031";
    const response = await optionsRoute!.GET(
      getRequest(`?source=employments&q=ali&limit=10&include=${include}`),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      options: [{ employmentId: "employment-1", label: "Alice Holder · Main · Cashier" }],
    });
    assert.deepEqual(routeState.calls, [
      {
        fn: "employments",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          q: "ali",
          limit: 10,
          includeEmploymentId: include,
        },
      },
    ]);
  });

  test("locations forwards the pin under its own key", async () => {
    reset();
    const include = "00000000-0000-4000-8000-000000000032";
    const response = await optionsRoute!.GET(getRequest(`?source=locations&include=${include}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      options: [{ locationId: "location-1", label: "HQ · Headquarters" }],
    });
    assert.deepEqual(routeState.calls, [
      {
        fn: "locations",
        args: { orgId: "org-1", actorId: "user-1", q: undefined, includeLocationId: include },
      },
    ]);
  });

  test("an authorization refusal is a 403 carrying the uniform message", async () => {
    reset();
    routeState.serviceThrow = new (errors().HrmAuthorizationError)("Employment access requires the hrm.employment.read permission");
    const response = await optionsRoute!.GET(getRequest("?source=employments"));
    assert.equal(response.status, 403);
    assert.match((await response.json() as { error: string }).error, /hrm\.employment\.read/);
  });

  test("a computed refusal is a 422 carrying the remedy", async () => {
    reset();
    routeState.serviceThrow = new (errors().EmploymentReadError)(
      "options limit must be an integer from 1 to 100 — the picker pages, it never dumps the roster",
    );
    const response = await optionsRoute!.GET(getRequest("?source=locations&limit=500"));
    assert.equal(response.status, 422);
    assert.match((await response.json() as { error: string }).error, /pages/);
  });

  test("positions forwards the pin under its own key behind the position grant", async () => {
    reset();
    const include = "00000000-0000-4000-8000-000000000033";
    const response = await optionsRoute!.GET(
      getRequest(`?source=positions&q=eng&limit=10&include=${include}`),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      options: [{ positionId: "position-1", label: "ENG-1042 · Engineer · open" }],
    });
    assert.deepEqual(routeState.calls, [
      {
        fn: "positions",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          q: "eng",
          limit: 10,
          includePositionId: include,
        },
      },
    ]);
  });

  test("leave-filing-employments sits behind the manage grant and projects to id/label", async () => {
    reset();
    const include = "00000000-0000-4000-8000-000000000034";
    const response = await optionsRoute!.GET(
      getRequest(`?source=leave-filing-employments&q=qui&limit=10&include=${include}`),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      options: [{ id: "employment-9", label: "Quinn Vidal · Main · Nurse" }],
    });
    assert.deepEqual(routeState.calls, [
      {
        fn: "leave-filing-employments",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          q: "qui",
          limit: 10,
          includeEmploymentId: include,
        },
      },
    ]);
  });

  test("leave-own-employments projects the caller's employments to id/label", async () => {
    reset();
    const response = await optionsRoute!.GET(getRequest("?source=leave-own-employments"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      options: [{ id: "employment-1", label: "Quinn Vidal · Main · Nurse" }],
    });
    assert.deepEqual(routeState.calls, [{ fn: "leave-own-employments", args: { orgId: "org-1", actorId: "user-1" } }]);
  });

  test("leave option sources without their grants never reach the service", async () => {
    reset();
    routeState.gate = { status: 403 };
    assert.equal((await optionsRoute!.GET(getRequest("?source=leave-filing-employments"))).status, 403);
    assert.equal((await optionsRoute!.GET(getRequest("?source=leave-own-employments"))).status, 403);
    assert.deepEqual(routeState.calls, []);
  });

test("people forwards the pin under its own key for the exit-interviewer picker", async () => {
  reset();
  const include = "00000000-0000-4000-8000-000000000033";
  const response = await optionsRoute!.GET(getRequest(`?source=people&include=${include}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    options: [{ partyId: "party-1", label: "Alice Holder" }],
  });
  assert.deepEqual(routeState.calls, [
    {
      fn: "people",
      args: { orgId: "org-1", actorId: "user-1", q: undefined, includePartyId: include },
    },
  ]);
});

test("hireable-people forwards the pin under its own key for the Hire person picker", async () => {
  reset();
  const include = "00000000-0000-4000-8000-000000000039";
  const response = await optionsRoute!.GET(getRequest(`?source=hireable-people&include=${include}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    options: [{ partyId: "party-9", label: "No Employment Yet" }],
  });
  assert.deepEqual(routeState.calls, [
    {
      fn: "hireable-people",
      args: { orgId: "org-1", actorId: "user-1", q: undefined, includePartyId: include },
    },
  ]);
});

test("employable-people forwards the pin under its own key for the existing-person picker", async () => {
  reset();
  const include = "00000000-0000-4000-8000-000000000047";
  const response = await optionsRoute!.GET(getRequest(`?source=employable-people&include=${include}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    options: [{ partyId: "party-7", label: "Vendor Val", hasEmployeeRole: false }],
  });
  assert.deepEqual(routeState.calls, [
    {
      fn: "employable-people",
      args: { orgId: "org-1", actorId: "user-1", q: undefined, includePartyId: include },
    },
  ]);
});

test("employer-subsidiaries forwards the pin under its own key for the Hire employer picker", async () => {
  reset();
  const include = "00000000-0000-4000-8000-000000000041";
  const response = await optionsRoute!.GET(getRequest(`?source=employer-subsidiaries&include=${include}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    options: [{ subsidiaryId: "sub-1", label: "Main Co" }],
  });
  assert.deepEqual(routeState.calls, [
    {
      fn: "employer-subsidiaries",
      args: { orgId: "org-1", actorId: "user-1", q: undefined, includeSubsidiaryId: include },
    },
  ]);
});


test('active-only employment browsing forwards the policy for both search and pinned selections', async () => {
  reset()
  const include = '00000000-0000-4000-8000-000000000031'
  const response = await optionsRoute!.GET(getRequest(`?source=employments&active=true&include=${include}`))
  assert.equal(response.status, 200)
  const args = routeState.calls[0]!.args as Record<string, unknown>
  assert.equal(args.activeOnly, true)
  assert.equal(args.includeEmploymentId, include)
  reset()
  assert.equal((await optionsRoute!.GET(getRequest('?source=employments&active=maybe'))).status, 400)
  assert.deepEqual(routeState.calls, [])
})
