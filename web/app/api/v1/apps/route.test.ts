import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-apps-route-test");
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
    "mock:extensions",
    `
      const state = globalThis[Symbol.for('openbooks.v1-apps-route-test')]
      const record = (fn) => async (context, input) => {
        state.calls.push({ fn, input: input === undefined ? null : input })
        return { [fn]: true }
      }
      export const listExtensions = async (context) => { state.calls.push({ fn: "list", input: null }); return { extensions: [] } };
      export const describeExtensionVocabulary = async (context) => { state.calls.push({ fn: "vocabulary", input: null }); return { preferredRenderer: "native" } };
      export const draftExtension = record("draft")
      export const getExtensionDraft = async (context, id) => { state.calls.push({ fn: "getDraft", input: id }); return { id } };
      export const activateExtensionDraft = record("activate")
      export const discardExtensionDraft = record("discard")
      export const getExtensionPackage = record("package")
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/extensions", "mock:extensions"],
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/errors", "mock:errors"],
  ["../../../../../lib/application/extensions", "mock:extensions"],
  ["../../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../../lib/application/extensions", "mock:extensions"],
  ["../../../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../../../lib/application/errors", "mock:errors"],
  ["../../../../../../../lib/application/extensions", "mock:extensions"],
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
const drafts = (await import("./drafts/route.ts")) as typeof import("./drafts/route.ts");
const draft = (await import("./drafts/[id]/route.ts")) as typeof import("./drafts/[id]/route.ts");
const activate = (await import("./drafts/[id]/activate/route.ts")) as typeof import("./drafts/[id]/activate/route.ts");
const discard = (await import("./drafts/[id]/discard/route.ts")) as typeof import("./drafts/[id]/discard/route.ts");
const pkg = (await import("./[key]/route.ts")) as typeof import("./[key]/route.ts");
hooks.deregister();

const jsonRequest = (url: string, method: string, body?: unknown) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const lastCall = () => routeState.calls[routeState.calls.length - 1];
const draftParams = { params: Promise.resolve({ id: "draft-1" }) };
const packageParams = { params: Promise.resolve({ key: "shop" }) };

test("GET /api/v1/apps lists through listExtensions", async () => {
  const response = await main.GET(new Request("http://openbooks.test/api/v1/apps"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, extensions: [] });
});

test("GET /api/v1/apps/vocabulary describes through describeExtensionVocabulary", async () => {
  const response = await vocabulary.GET(new Request("http://openbooks.test/api/v1/apps/vocabulary"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, preferredRenderer: "native" });
});

test("POST /api/v1/apps/drafts drafts through draftExtension", async () => {
  const response = await drafts.POST(jsonRequest("http://openbooks.test/api/v1/apps/drafts", "POST", {
    bundle: { manifest: {}, files: [] },
    reason: "first revision",
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { ok: true, draft: true });
  assert.deepEqual(lastCall(), {
    fn: "draft",
    input: {
      bundle: { manifest: {}, files: [] },
      reason: "first revision",
      expectedBaseVersionId: undefined,
      sourceDraft: undefined,
    },
  });
});

test("POST /api/v1/apps/drafts refuses a missing reason", async () => {
  await assert.rejects(
    () => drafts.POST(jsonRequest("http://openbooks.test/api/v1/apps/drafts", "POST", { bundle: {} })),
    /reason is required/,
  );
});

test("GET /api/v1/apps/drafts/[id] reads through getExtensionDraft", async () => {
  const response = await draft.GET(new Request("http://openbooks.test/api/v1/apps/drafts/draft-1"), draftParams);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, draft: { id: "draft-1" } });
  assert.deepEqual(lastCall(), { fn: "getDraft", input: "draft-1" });
});

test("POST /api/v1/apps/drafts/[id]/activate binds the path draft id", async () => {
  const response = await activate.POST(
    jsonRequest("http://openbooks.test/api/v1/apps/drafts/draft-1/activate", "POST", { contentHash: "abc" }),
    draftParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, activate: true });
  assert.deepEqual(lastCall(), { fn: "activate", input: { draftId: "draft-1", contentHash: "abc" } });
});

test("POST /api/v1/apps/drafts/[id]/activate refuses a missing contentHash", async () => {
  await assert.rejects(
    () => activate.POST(jsonRequest("http://openbooks.test/api/v1/apps/drafts/draft-1/activate", "POST", {}), draftParams),
    /contentHash is required/,
  );
});

test("POST /api/v1/apps/drafts/[id]/discard binds the path draft id", async () => {
  const response = await discard.POST(
    jsonRequest("http://openbooks.test/api/v1/apps/drafts/draft-1/discard", "POST", { contentHash: "abc" }),
    draftParams,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, discard: true });
  assert.deepEqual(lastCall(), { fn: "discard", input: { draftId: "draft-1", contentHash: "abc" } });
});

test("GET /api/v1/apps/[key] reads through getExtensionPackage", async () => {
  const response = await pkg.GET(new Request("http://openbooks.test/api/v1/apps/shop?versionId=version-1"), packageParams);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, package: true });
  assert.deepEqual(lastCall(), { fn: "package", input: { key: "shop", versionId: "version-1" } });
});
