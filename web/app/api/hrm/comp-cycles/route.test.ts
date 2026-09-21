import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { CompensationError } from "@openbooks/engine/src/hrm/compensation/errors.ts";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  features: Record<string, boolean>;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  expectedPermission: string;
}

const stateKey = Symbol.for("openbooks.hrm-comp-cycles-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  features: { hrmCompensation: true, hrmMeritCycles: true },
  calls: [],
  serviceThrow: null,
  expectedPermission: "",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-comp-cycles-route-test')]
      export async function guardPermission(permission) {
        if (permission !== state.expectedPermission) {
          throw new Error('unexpected permission ' + permission + ' (expected ' + state.expectedPermission + ')')
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmCompCyclesRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-comp-cycles-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        return state.features[key] === true
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
    "mock:cycles",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-comp-cycles-route-test')]
      export async function listCycles(args) {
        state.calls.push({ fn: 'listCycles', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function createCycle(args) {
        state.calls.push({ fn: 'createCycle', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'cycle-1' }
      }
      export async function getCycle(args) {
        state.calls.push({ fn: 'getCycle', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
      export async function listCycleLines(args) {
        state.calls.push({ fn: 'listCycleLines', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function cyclePacing(orgId, cycleId) {
        state.calls.push({ fn: 'cyclePacing', args: { orgId, cycleId } })
        if (state.serviceThrow) throw state.serviceThrow
        return { totalPct: null, overBudget: false }
      }
      export async function openCycle(args) {
        state.calls.push({ fn: 'openCycle', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { cycle: { id: args.cycleId }, lines: 0 }
      }
      export async function submitCycleForApproval(args) {
        state.calls.push({ fn: 'submit', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
      export async function pushCycle(args) {
        state.calls.push({ fn: 'push', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { pushed: 1, skipped: 0, retroReviewDue: false }
      }
      export async function closeCycle(args) {
        state.calls.push({ fn: 'close', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
      export async function cancelCycle(args) {
        state.calls.push({ fn: 'cancel', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.cycleId }
      }
      export async function setCycleBudgets(args) {
        state.calls.push({ fn: 'budgets', args })
        if (state.serviceThrow) throw state.serviceThrow
      }
      export async function proposeLine(args) {
        state.calls.push({ fn: 'proposeLine', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.lineId }
      }
      export async function approveLine(args) {
        state.calls.push({ fn: 'approveLine', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.lineId }
      }
      export async function rejectLine(args) {
        state.calls.push({ fn: 'rejectLine', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.lineId }
      }
      export async function reopenLine(args) {
        state.calls.push({ fn: 'reopenLine', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.lineId }
      }
    `,
  ],
  [
    "mock:json",
    `
      export const jsonObject = { safeParse: (data) => ({ success: true, data }) }
      export async function parseJsonBody(req, schema) {
        let data
        try {
          data = await req.json()
        } catch {
          const NextResponse = globalThis.openbooksHrmCompCyclesRouteNextResponse
          return { ok: false, response: NextResponse.json({ error: 'invalid json' }, { status: 400 }) }
        }
        const parsed = schema.safeParse(data)
        if (!parsed.success) {
          const NextResponse = globalThis.openbooksHrmCompCyclesRouteNextResponse
          return { ok: false, response: NextResponse.json({ error: 'invalid body' }, { status: 400 }) }
        }
        return { ok: true, data: parsed.data }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmCompCyclesRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["../../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/compensation/cycles.ts", "mock:cycles"],
  ["@/lib/api/json", "mock:json"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
let itemRoute: typeof import("./[id]/route.ts") | undefined;
let lineRoute: typeof import("./[id]/lines/[lineId]/route.ts") | undefined;
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
  const collectionUrl = "./route.ts?hrm-comp-cycles-collection";
  const itemUrl = "./[id]/route.ts?hrm-comp-cycles-item";
  const lineUrl = "./[id]/lines/[lineId]/route.ts?hrm-comp-cycles-line";
  collectionRoute = (await import(collectionUrl)) as typeof import("./route.ts");
  itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
  lineRoute = (await import(lineUrl)) as typeof import("./[id]/lines/[lineId]/route.ts");
  hooks.deregister();
}

const CYCLE_ID = "00000000-0000-4000-8000-000000000081";
const LINE_ID = "00000000-0000-4000-8000-000000000082";

function reset(permission: string): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.features = { hrmCompensation: true, hrmMeritCycles: true };
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.expectedPermission = permission;
}

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("comp cycles gate reads on compensation.read and writes on manage", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.compensation\.read"\)/);
    assert.match(source, /guardPermission\("hrm\.compensation\.manage"\)/);
    assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrmMeritCycles"\)/);
  });
} else {
  test("cycles 404 while hrmMeritCycles is off — the feature-off refusal", async () => {
    reset("hrm.compensation.read");
    routeState.features = { hrmCompensation: true, hrmMeritCycles: false };
    const response = await collectionRoute!.GET();
    assert.equal(response.status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("cycle creation validates the body before the service runs", async () => {
    reset("hrm.compensation.manage");
    assert.equal(
      (await collectionRoute!.POST(postRequest("http://openbooks.test/api/hrm/comp-cycles", { name: "x" }))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    const created = await collectionRoute!.POST(
      postRequest("http://openbooks.test/api/hrm/comp-cycles", {
        name: "Merit 2025",
        kind: "merit",
        effectiveOn: "2025-04-01",
        currency: "CAD",
        guidelineKind: "matrix",
        guideline: { rows: [] },
      }),
    );
    assert.equal(created.status, 201);
  });

  test("cycle moves map engine refusals by code", async () => {
    reset("hrm.compensation.manage");
    const params = { params: Promise.resolve({ id: CYCLE_ID }) };
    routeState.serviceThrow = new CompensationError("BAD_STATE", "a draft cycle cannot push");
    const mapped = await itemRoute!.POST(postRequest(`http://openbooks.test/api/hrm/comp-cycles/${CYCLE_ID}`, { action: "push" }), params as never);
    assert.equal(mapped.status, 409);
    routeState.serviceThrow = new CompensationError("REFUSED", "3 lines still await decision");
    const refused = await itemRoute!.POST(postRequest(`http://openbooks.test/api/hrm/comp-cycles/${CYCLE_ID}`, { action: "push" }), params as never);
    assert.equal(refused.status, 422);
    routeState.serviceThrow = null;
  });

  test("line propose rides the read grant while decide needs approve", async () => {
    reset("hrm.compensation.read");
    const params = { params: Promise.resolve({ id: CYCLE_ID, lineId: LINE_ID }) };
    const proposed = await lineRoute!.PATCH(
      patchRequest(`http://openbooks.test/api/hrm/comp-cycles/${CYCLE_ID}/lines/${LINE_ID}?action=propose`, {
        proposedPct: 3,
      }),
      params as never,
    );
    assert.equal(proposed.status, 200);
    assert.deepEqual(routeState.calls, [
      {
        fn: "proposeLine",
        args: { orgId: "org-1", actorId: "user-1", lineId: LINE_ID, proposedPct: 3, proposedRate: null, reason: null },
      },
    ]);
    reset("hrm.compensation.approve");
    const approved = await lineRoute!.PATCH(
      patchRequest(`http://openbooks.test/api/hrm/comp-cycles/${CYCLE_ID}/lines/${LINE_ID}?action=approve`, {}),
      params as never,
    );
    assert.equal(approved.status, 200);
    reset("hrm.compensation.approve");
    const rejected = await lineRoute!.PATCH(
      patchRequest(`http://openbooks.test/api/hrm/comp-cycles/${CYCLE_ID}/lines/${LINE_ID}?action=reject`, {}),
      params as never,
    );
    assert.equal(rejected.status, 400);
  });
}
