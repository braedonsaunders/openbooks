import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The session gate and the close-run command are the boundaries; the route's
// body schema and scope parsing run for real.
const stateKey = Symbol.for("openbooks.close-run-route-test");
const routeState = { calls: [] as Record<string, unknown>[] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const gateStub = `export async function guardFeaturePermission() { return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['close.run']), allowedSubsidiaryIds: null }; }`;
const realRunStartUrl = import.meta.resolve("@openbooks/engine/close/run-start");
const runStartStub = `export * from ${JSON.stringify(realRunStartUrl)}; export async function startCloseRun(input) { globalThis[Symbol.for('openbooks.close-run-route-test')].calls.push(input); return 'run-1'; }`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/feature-gates")
      return { shortCircuit: true, format: "module", url: "mock:close-run-gate" };
    if (specifier === "@openbooks/engine/close/run-start")
      return { shortCircuit: true, format: "module", url: "mock:close-run-start" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:close-run-gate")
      return { format: "module", source: gateStub, shortCircuit: true };
    if (url === "mock:close-run-start")
      return { format: "module", source: runStartStub, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { POST } = await import("./route.ts");

const post = (body: Record<string, unknown>) =>
  POST(
    new Request("http://openbooks.test/api/close/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

// Sandbox and sample organizations derive ids as md5(seed:source)::uuid, so
// their version/variant nibbles are arbitrary hex (here "d" and "0").
const derivedId = (n: number) =>
  `435d3903-de4c-da3a-0183-ee5f8be57b${n.toString(16).padStart(2, "0")}`;

test("starting a close accepts sandbox-derived period, book and scope ids", async () => {
  routeState.calls = [];
  const response = await post({
    periodId: derivedId(1),
    bookId: derivedId(2),
    blueprintId: derivedId(3),
    reportingPackageId: derivedId(4),
    subsidiaryIds: [derivedId(5), derivedId(6)],
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { ok: true, runId: "run-1" });
  assert.deepEqual(routeState.calls, [
    {
      orgId: "org-1",
      actorId: "user-1",
      periodId: derivedId(1),
      bookId: derivedId(2),
      blueprintId: derivedId(3),
      reportingPackageId: derivedId(4),
      targetCloseDate: undefined,
      subsidiaryIds: [derivedId(5), derivedId(6)],
    },
  ]);
});

test("starting a close still refuses ids that are not 8-4-4-4-12 hex", async () => {
  routeState.calls = [];
  for (const body of [
    { periodId: "period-1", bookId: derivedId(2) },
    { periodId: derivedId(1), bookId: `${derivedId(2)}0` },
    { periodId: derivedId(1), bookId: derivedId(2), subsidiaryIds: ["-".repeat(36)] },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(routeState.calls, []);
});
