import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
// Refusal paths never reach the database or the commands. Pure featureEnabled is real.
const stateKey = Symbol.for("openbooks.setup-command-route-test");
const routeState = { manage: false, features: {} as Record<string, boolean> };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
const authzStub = `const s = globalThis[Symbol.for('openbooks.setup-command-route-test')]; const perms = () => new Set([...(s.manage ? ['funds.manage'] : []), ...(s.setup ? ['admin.setup.manage'] : [])]); export async function getAuthz() { return { user: { orgId: 'org-1', id: 'user-1' }, permissions: perms(), allowedSubsidiaryIds: null }; } export async function guardPermission(p) { const a = await getAuthz(); if (!a.permissions.has(p)) return new Response(null, { status: 403 }); return a; } export function can(a, p) { return a.permissions.has(p); }`;
const featuresStub = `export { featureEnabled } from "@openbooks/engine/src/organization/feature-registry.ts"; export async function resolvedFeatureState() { return globalThis[Symbol.for('openbooks.setup-command-route-test')].features; }`;
const dbStub = `const fail = () => { throw new Error("no database in this test") }; const bomb = new Proxy({}, { get: fail }); export const db = bomb; export const inDbTransaction = (...a) => fail(); export const withOrgTransaction = (...a) => fail(); export const withOrgContext = (...a) => fail();`;
registerHooks({
  resolve(s, c, n) {
    const u = s === "@/lib/authz" || s === "../authz" ? "mock:cmd-authz" : s === "@/lib/features" ? "mock:cmd-features" : s.endsWith("platform/db.ts") ? "mock:cmd-db" : null;
    return u ? { shortCircuit: true, format: "module", url: u } : n(s, c);
  },
  load(u, c, n) {
    const s = u === "mock:cmd-authz" ? authzStub : u === "mock:cmd-features" ? featuresStub : u === "mock:cmd-db" ? dbStub : null;
    return s ? { format: "module", source: s, shortCircuit: true } : n(u, c);
  },
});
const { POST, commandRefusalResponse } = await import("./route.ts");
const call = (entity: string, body: string) => POST(new Request(`http://localhost/api/admin/setup/${entity}/command`, { method: "POST", headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" }, body }), { params: Promise.resolve({ entity }) });
test("permission and unknown-entity refusals precede body parsing", async () => {
  routeState.manage = false;
  const forbidden = await call("no-such-entity", "{");
  assert.equal(forbidden.status, 403);
  const denial = (await forbidden.json()) as { error?: string };
  assert.match(denial.error ?? "", /funds\.manage.*Admin → Users & Roles/s);
  routeState.manage = true;
  const blind = await call("no-such-entity", "{");
  assert.equal(blind.status, 404);
  assert.deepEqual(await blind.json(), { error: "not_found" });
});
test("computed refusals keep typed status with message, code, remedy, field", () => {
  const bad = (status: number) => Object.assign(new Error("x"), { status });
  assert.deepEqual(commandRefusalResponse(Object.assign(bad(422), { code: "c", remedy: "r.", field: "f" })), { status: 422, body: { error: "x", code: "c", remedy: "r.", field: "f" } });
  assert.equal(commandRefusalResponse(bad(500)), null);
});
