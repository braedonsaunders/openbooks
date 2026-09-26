import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";
import { z } from "zod";

const stateKey = Symbol.for("openbooks.route-factory-test");
const state: { permission: "allow" | "deny401" | "deny403"; feature: "on" | "off"; scope: "allow" | "deny"; session: boolean; calls: string[] }
  = { permission: "allow", feature: "on", scope: "allow", session: true, calls: [] };
(globalThis as Record<symbol, unknown>)[stateKey] = state;
(globalThis as Record<string, unknown>).openbooksRouteFactoryNextResponse = NextResponse;

const mockSources = new Map<string, string>([
  ["mock:authz", `
    const state = globalThis[Symbol.for('openbooks.route-factory-test')];
    const NextResponse = globalThis.openbooksRouteFactoryNextResponse;
    const gate = () => ({ user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(), allowedSubsidiaryIds: null });
    export async function getAuthz() { state.calls.push('session'); return state.session ? gate() : null; }
    export async function guardPermission() {
      state.calls.push('permission');
      if (state.permission !== 'allow') return NextResponse.json({ error: state.permission }, { status: state.permission === 'deny401' ? 401 : 403 });
      return gate();
    }
    export function guardUnrestrictedScope() {
      state.calls.push('scope');
      if (state.scope === 'deny') return NextResponse.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 });
      return null;
    }
    export async function guardRootSubsidiaryScope() {
      state.calls.push('scope');
      if (state.scope === 'deny') return NextResponse.json({ error: 'not_found' }, { status: 404 });
      return null;
    }
  `],
  ["mock:feature-gates", `
    const state = globalThis[Symbol.for('openbooks.route-factory-test')];
    const NextResponse = globalThis.openbooksRouteFactoryNextResponse;
    export async function guardFeaturePermission(permission) {
      const gate = await (await import('mock:authz')).guardPermission(permission);
      if (gate instanceof NextResponse) return gate;
      state.calls.push('feature');
      if (state.feature === 'off') return NextResponse.json({ error: 'not found' }, { status: 404 });
      return gate;
    }
  `],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/authz") return { shortCircuit: true, url: "mock:authz" };
    if (specifier === "@/lib/feature-gates") return { shortCircuit: true, url: "mock:feature-gates" };
    if (specifier === "mock:authz") return { shortCircuit: true, url: "mock:authz" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { defineRoute } = await import("./route.ts");
// Hooks stay registered for the factory's per-request gate import.

class NamedRefusal extends Error {
  status = 422;
  code = "name_required";
  remedy = "Send a name.";
  constructor() { super("name_required"); this.name = "NamedRefusal"; }
}

function reset(overrides: Partial<typeof state> = {}): void {
  Object.assign(state, { permission: "allow", feature: "on", scope: "allow", session: true, calls: [] }, overrides);
}

const get = (url = "http://test.local/api/thing"): Request => new Request(url, { method: "GET" });

const post = (body: unknown): Request => new Request("http://test.local/api/thing", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const ok = () => NextResponse.json({ ok: true });

test("public token routes skip every gate", async () => {
  reset();
  const handler = defineRoute({ public: "token", handler: async ({ authz }) => NextResponse.json({ ok: true, authz }) });
  const response = await handler(get());
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await response.json(), { ok: true, authz: null });
});

test("public session routes require a session but no permission", async () => {
  reset({ session: false });
  const handler = defineRoute({ public: "session", handler: async () => ok() });
  assert.equal((await handler(get())).status, 401);
  reset();
  assert.equal((await handler(get())).status, 200);
});

test("permission refusals pass through before the feature gate runs", async () => {
  for (const permission of ["deny401", "deny403"] as const) {
    reset({ permission });
    const handler = defineRoute({ permission: "x", feature: "timeTracking", handler: async () => ok() });
    const response = await handler(get());
    assert.equal(response.status, permission === "deny401" ? 401 : 403);
    assert.deepEqual(state.calls, ["permission"]);
  }
});

test("a disabled feature answers 404 without naming the feature", async () => {
  reset({ feature: "off" });
  const handler = defineRoute({ permission: "x", feature: "timeTracking", handler: async () => ok() });
  const response = await handler(get());
  assert.equal(response.status, 404);
  assert.deepEqual(state.calls, ["permission", "feature"]);
  // The legacy gate spells its 404 "not found"; the factory unifies it.
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("an always-on surface documents its reason and skips the feature gate", async () => {
  reset();
  const handler = defineRoute({
    permission: "x",
    feature: { none: "self-service profile; no feature key governs it" },
    handler: async () => ok(),
  });
  assert.equal((await handler(get())).status, 200);
  assert.deepEqual(state.calls, ["permission"]);
});

test("restricted scope is refused after permission and feature pass", async () => {
  for (const scope of ["unrestricted", "root"] as const) {
    reset({ scope: "deny" });
    const handler = defineRoute({ permission: "x", feature: "timeTracking", scope, handler: async () => ok() });
    const response = await handler(get());
    assert.equal(response.status, scope === "unrestricted" ? 403 : 404);
    assert.deepEqual(state.calls, ["permission", "feature", "scope"]);
  }
});

test("an unknown scope fails closed instead of running unscoped", async () => {
  reset();
  let ran = false;
  const handler = defineRoute({
    permission: "x",
    feature: { none: "test surface" },
    scope: "subsidiary" as never,
    handler: async () => { ran = true; return ok(); },
  });
  await assert.rejects(() => handler(get()), /unknown scope/);
  assert.equal(ran, false);
});

test("invalid route params fail closed with 400", async () => {
  reset();
  const handler = defineRoute({
    permission: "x",
    feature: { none: "test surface" },
    params: z.object({ id: z.string().uuid() }),
    handler: async ({ params }) => NextResponse.json({ id: params.id }),
  });
  const bad = await handler(get(), { params: Promise.resolve({ id: "nope" }) });
  assert.equal(bad.status, 400);
  const good = await handler(get(), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }) });
  assert.deepEqual(await good.json(), { id: "00000000-0000-4000-8000-000000000001" });
});

test("invalid bodies fail through the shared JSON boundary", async () => {
  reset();
  const handler = defineRoute({
    permission: "x",
    feature: { none: "test surface" },
    body: z.object({ name: z.string() }),
    handler: async ({ body }) => NextResponse.json({ name: body.name }),
  });
  const bad = await handler(post({}));
  assert.equal(bad.status, 400);
  const good = await handler(post({ name: "Cash" }));
  assert.deepEqual(await good.json(), { name: "Cash" });
});

test("typed refusals become 4xx carrying code and remedy", async () => {
  reset();
  const handler = defineRoute({
    permission: "x",
    feature: { none: "test surface" },
    handler: async () => {
      throw new NamedRefusal();
    },
  });
  const response = await handler(get());
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "name_required",
    code: "name_required",
    remedy: "Send a name.",
  });
});

test("unknown errors rethrow instead of becoming a response", async () => {
  reset();
  const handler = defineRoute({
    permission: "x",
    feature: { none: "test surface" },
    handler: async () => {
      throw new Error("boom");
    },
  });
  await assert.rejects(() => handler(get()), /boom/);
});
