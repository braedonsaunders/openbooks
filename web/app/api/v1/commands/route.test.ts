import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-commands-route-test");
interface RouteState {
  listed: boolean;
}

const routeState: RouteState = { listed: false };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1" } } },
        )
        return Response.json(result.body, { status: result.status })
      }
    `,
  ],
  [
    "mock:tools",
    `
      const state = globalThis[Symbol.for('openbooks.v1-commands-route-test')]
      export const APPLICATION_TOOLS = [
        { name: "list_records", title: "List Records", description: "list", readOnly: true, destructive: false },
        { name: "post_journal", title: "Post Journal", description: "post", readOnly: false, destructive: false },
      ]
      export function applicationTool() { return undefined }
    `,
  ],
  [
    "mock:visible",
    `
      const state = globalThis[Symbol.for('openbooks.v1-commands-route-test')]
      export function applicationToolVisible() { state.listed = true; return true }
    `,
  ],
  [
    "mock:features",
    `export async function resolvedFeatureState() { return {} }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../lib/application/tool-catalog", "mock:tools"],
  ["../../../../lib/assistant/registry", "mock:visible"],
  ["../../../../lib/features", "mock:features"],
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

const { GET } = (await import("./route.ts?v1-commands-list")) as typeof import("./route.ts");
hooks.deregister();

test("GET /api/v1/commands lists the visible application catalog", async () => {
  routeState.listed = false;
  const response = await GET(
    new Request("http://openbooks.test/api/v1/commands", {
      headers: { authorization: "Bearer test-key" },
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { commands: Array<{ name: string; href: string }> };
  assert.deepEqual(
    body.commands.map((command) => command.name),
    ["list_records", "post_journal"],
  );
  assert.equal(body.commands[1]?.href, "/api/v1/commands/post_journal");
  assert.equal(routeState.listed, true, "visibility must be evaluated before a command is advertised");
});
