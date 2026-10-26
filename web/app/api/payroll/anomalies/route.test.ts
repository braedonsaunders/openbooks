import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const stateKey = Symbol.for("openbooks.payroll-anomaly-post-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
  features: Record<string, boolean>;
  scans: Array<Record<string, unknown>>;
  baselines: Array<Record<string, unknown>>;
}
const state: RouteState = { authz: null, features: {}, scans: [], baselines: [] };
(globalThis as Record<symbol, unknown>)[stateKey] = state;

const mocks = new Map<string, string>([
  [
    "mock:authz",
    `
    const state = globalThis[Symbol.for("openbooks.payroll-anomaly-post-route-test")];
    export async function getAuthz() { return state.authz; }
    export function can(authz, permission) { return authz.permissions.has("*") || authz.permissions.has(permission); }
  `,
  ],
  [
    "mock:features",
    `
    const state = globalThis[Symbol.for("openbooks.payroll-anomaly-post-route-test")];
    export async function isFeatureEnabled(_orgId, feature) { return state.features[feature] === true; }
  `,
  ],
  [
    "mock:anomalies",
    `
    const state = globalThis[Symbol.for("openbooks.payroll-anomaly-post-route-test")];
    export async function listFlags() { return []; }
    export async function runAnomalyScan(input) { state.scans.push(input); return { created: 0 }; }
    export async function computeAnomalyBaselines(input) { state.baselines.push(input); return { computed: 0 }; }
  `,
  ],
  [
    "mock:ai-rails",
    `
    export function aiRailsErrorResponse(error) { return Response.json({ error: error.message }, { status: 422 }); }
  `,
  ],
  [
    "mock:responses",
    `
    export function notFound() { return Response.json({ error: "not_found" }, { status: 404 }); }
  `,
  ],
  [
    "mock:preview-invalidation",
    `
    export async function invalidateAnalyticsPreviews() {}
  `,
  ],
]);

const testDir = dirname(fileURLToPath(import.meta.url));
const realRouteUrl = pathToFileURL(join(testDir, "../../../../lib/api/route.ts")).href;
const realJsonUrl = pathToFileURL(join(testDir, "../../../../lib/api/json.ts")).href;
const realTemporalUrl = pathToFileURL(
  join(testDir, "../../../../../engine/src/hrm/temporal.ts"),
).href;
const modules = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/ai-rails", "mock:ai-rails"],
  ["@openbooks/engine/hrm/ai/anomalies", "mock:anomalies"],
  ["@/lib/api/responses", "mock:responses"],
  ["@/lib/analytics/preview-invalidation", "mock:preview-invalidation"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export%20{}" };
    if (specifier === "@/lib/api/route") return { shortCircuit: true, url: realRouteUrl };
    if (specifier === "@/lib/api/json") return { shortCircuit: true, url: realJsonUrl };
    if (specifier === "@openbooks/engine/hrm/temporal")
      return { shortCircuit: true, url: realTemporalUrl };
    const mock = modules.get(specifier);
    if (mock) return { shortCircuit: true, format: "module", url: mock };
    return nextResolve(specifier, context);
  },
  load(url, _context, nextLoad) {
    const source = mocks.get(url);
    return source === undefined
      ? nextLoad(url, _context)
      : { shortCircuit: true, format: "module", source };
  },
});

const routeUrl = "./route.ts?payroll-anomaly-post-route-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
after(() => hooks.deregister());

function setup(permissions: string[], features: Record<string, boolean>) {
  state.authz = {
    user: { orgId: "org-1", id: "user-1" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
  state.features = features;
  state.scans = [];
  state.baselines = [];
}

function post(body: unknown) {
  return POST(
    new Request("http://openbooks.test/api/payroll/anomalies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("an unrestricted time approver can run a time-only scan without Payroll", async () => {
  setup(["time.approve"], { timeTracking: true, payroll: false });
  const response = await post({ timeOnly: true, periodFrom: "2026-05-01", periodTo: "2026-05-31" });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(state.scans[0], {
    orgId: "org-1",
    actorId: "user-1",
    periodFrom: "2026-05-01",
    periodTo: "2026-05-31",
    options: { timeOnly: true },
  });
});

test("baseline recomputation needs no scan period", async () => {
  setup(["payroll.manage"], { payroll: true, timeTracking: false });
  const response = await post({ action: "compute_baselines", windowPeriods: 4 });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(state.baselines[0], { orgId: "org-1", actorId: "user-1", windowPeriods: 4 });
});

test("time-only scan needs Time tracking and valid civil dates", async () => {
  setup(["time.approve"], { timeTracking: true, payroll: false });
  const invalid = await post({ timeOnly: true, periodFrom: "2026-02-30", periodTo: "2026-03-01" });
  assert.equal(invalid.status, 422, await invalid.clone().text());
  assert.equal(state.scans.length, 0);
});
