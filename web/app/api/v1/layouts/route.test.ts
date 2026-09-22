import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-layouts-route-test");
interface RouteState {
  calls: Array<{ fn: string; input: unknown }>;
}
const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const v1Mock = `
  export async function withV1Request(request, label, operation) {
    const result = await operation(
      { user: { orgId: "org-1", id: "user-1" }, keyId: "key-1" },
      { authz: { user: { orgId: "org-1", id: "user-1" }, permissions: [] } },
    )
    return Response.json(result.body, { status: result.status })
  }
  export async function readV1JsonObject(request) { return await request.json() }
  export function requireV1IdempotencyKey(request) {
    const key = request.headers.get("idempotency-key")?.trim()
    if (!key) throw new Error("Idempotency-Key header is required")
    return key
  }
`;

const mockSources = new Map<string, string>([
  ["mock:v1", v1Mock],
  [
    "mock:errors",
    `export class ApplicationError extends Error {
      constructor(code, message, status) { super(message); this.code = code; this.status = status }
    }`,
  ],
  [
    "mock:layouts",
    `
      const state = globalThis[Symbol.for('openbooks.v1-layouts-route-test')]
      const record = (fn) => async (context, input) => {
        state.calls.push({ fn, input })
        return { [fn]: true }
      }
      export const describeLayoutVocabulary = async (context) => { state.calls.push({ fn: "vocabulary", input: null }); return { specVersion: "1" } };
      export const listLayouts = record("list")
      export const describePageLayout = record("describe")
      export const validateLayout = record("validate")
      export const previewLayout = record("preview")
      export const setLayout = record("set")
      export const listLayoutHistory = record("history")
      export const restoreLayout = record("restore")
      export const clearLayout = record("clear")
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/errors", "mock:errors"],
  ["../../../../lib/application/page-layouts", "mock:layouts"],
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/errors", "mock:errors"],
  ["../../../../../lib/application/page-layouts", "mock:layouts"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const main = (await import("./route.ts")) as typeof import("./route.ts");
const vocabulary = (await import("./vocabulary/route.ts")) as typeof import("./vocabulary/route.ts");
const describe = (await import("./describe/route.ts")) as typeof import("./describe/route.ts");
const validate = (await import("./validate/route.ts")) as typeof import("./validate/route.ts");
const preview = (await import("./preview/route.ts")) as typeof import("./preview/route.ts");
const history = (await import("./history/route.ts")) as typeof import("./history/route.ts");
const restore = (await import("./restore/route.ts")) as typeof import("./restore/route.ts");
hooks.deregister();

const jsonRequest = (url: string, method: string, body?: unknown) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const lastCall = () => routeState.calls[routeState.calls.length - 1];

test("GET /api/v1/layouts lists through listLayouts", async () => {
  const response = await main.GET(new Request("http://openbooks.test/api/v1/layouts"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, list: true });
});

test("PUT /api/v1/layouts stores through setLayout", async () => {
  const response = await main.PUT(jsonRequest("http://openbooks.test/api/v1/layouts", "PUT", {
    route: "/banking",
    spec: { kind: "page" },
    note: "tidy",
    scope: "user",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, set: true });
  assert.deepEqual(lastCall(), {
    fn: "set",
    input: { route: "/banking", spec: { kind: "page" }, note: "tidy", scope: "user" },
  });
});

test("PUT /api/v1/layouts refuses a missing route", async () => {
  await assert.rejects(
    () => main.PUT(jsonRequest("http://openbooks.test/api/v1/layouts", "PUT", { spec: {} })),
    /route is required/,
  );
});

test("DELETE /api/v1/layouts clears by query route", async () => {
  const response = await main.DELETE(new Request("http://openbooks.test/api/v1/layouts?route=/banking&scope=org"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, clear: true });
  assert.deepEqual(lastCall(), { fn: "clear", input: { route: "/banking", scope: "org" } });
});

test("DELETE /api/v1/layouts requires the route query parameter", async () => {
  await assert.rejects(
    () => main.DELETE(new Request("http://openbooks.test/api/v1/layouts")),
    /route query parameter is required/,
  );
});

test("GET /api/v1/layouts/vocabulary describes through describeLayoutVocabulary", async () => {
  const response = await vocabulary.GET(new Request("http://openbooks.test/api/v1/layouts/vocabulary"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, specVersion: "1" });
});

test("GET /api/v1/layouts/describe forwards route and parsed params", async () => {
  const response = await describe.GET(new Request(
    "http://openbooks.test/api/v1/layouts/describe?route=/apps/[key]&params=" +
      encodeURIComponent(JSON.stringify({ key: "shop" })),
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, describe: true });
  assert.deepEqual(lastCall(), {
    fn: "describe",
    input: { route: "/apps/[key]", params: { key: "shop" }, searchParams: undefined },
  });
});

test("GET /api/v1/layouts/describe requires the route query parameter", async () => {
  await assert.rejects(
    () => describe.GET(new Request("http://openbooks.test/api/v1/layouts/describe")),
    /route query parameter is required/,
  );
});

test("POST /api/v1/layouts/validate checks the draft spec", async () => {
  const response = await validate.POST(jsonRequest("http://openbooks.test/api/v1/layouts/validate", "POST", { spec: { kind: "page" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, validate: true });
  assert.deepEqual(lastCall(), { fn: "validate", input: { spec: { kind: "page" } } });
});

test("POST /api/v1/layouts/validate refuses a missing spec", async () => {
  await assert.rejects(
    () => validate.POST(jsonRequest("http://openbooks.test/api/v1/layouts/validate", "POST", {})),
    /spec is required/,
  );
});

test("POST /api/v1/layouts/preview stages the draft", async () => {
  const response = await preview.POST(jsonRequest("http://openbooks.test/api/v1/layouts/preview", "POST", {
    route: "/banking",
    spec: { kind: "page" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, preview: true });
  assert.deepEqual(lastCall(), { fn: "preview", input: { route: "/banking", spec: { kind: "page" }, params: undefined } });
});

test("GET /api/v1/layouts/history lists versions for the route", async () => {
  const response = await history.GET(new Request("http://openbooks.test/api/v1/layouts/history?route=/banking"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, history: true });
  assert.deepEqual(lastCall(), { fn: "history", input: { route: "/banking" } });
});

test("POST /api/v1/layouts/restore republishes by version id", async () => {
  const response = await restore.POST(jsonRequest("http://openbooks.test/api/v1/layouts/restore", "POST", {
    route: "/banking",
    versionId: "version-1",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, restore: true });
  assert.deepEqual(lastCall(), { fn: "restore", input: { route: "/banking", versionId: "version-1" } });
});

test("POST /api/v1/layouts/restore refuses a missing versionId", async () => {
  await assert.rejects(
    () => restore.POST(jsonRequest("http://openbooks.test/api/v1/layouts/restore", "POST", { route: "/banking" })),
    /versionId is required/,
  );
});
