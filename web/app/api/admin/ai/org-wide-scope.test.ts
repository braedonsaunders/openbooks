import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const stateKey = Symbol.for("openbooks.org-ai-scope-test");
const state: { writes: string[]; reads: string[]; allowedSubsidiaryIds: Set<string> | null } = {
  writes: [],
  reads: [],
  allowedSubsidiaryIds: null,
};
Object.assign(globalThis, { [stateKey]: state });

const virtual = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});
const realAuthz = pathToFileURL(`${process.cwd()}/web/lib/authz.ts`).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/lib/authz")) {
      return virtual(`
        export { guardUnrestrictedScope } from ${JSON.stringify(realAuthz)};
        const state = globalThis[Symbol.for("openbooks.org-ai-scope-test")];
        export async function guardPermission() {
          return { user: { orgId: "org-1", id: "actor-1" }, allowedSubsidiaryIds: state.allowedSubsidiaryIds };
        }
      `);
    }
    if (specifier.endsWith("/lib/setup/agents")) {
      return virtual(`
        const state = globalThis[Symbol.for("openbooks.org-ai-scope-test")];
        export async function saveSetupAgentPolicy() { state.writes.push("setup-agent"); return {}; }
      `);
    }
    if (specifier.endsWith("/lib/assistant/ai-config")) {
      return virtual(`
        const state = globalThis[Symbol.for("openbooks.org-ai-scope-test")];
        export const CONTINUOUS_CLOSE_DISABLED_REMEDY = "feature disabled";
        export async function saveOrgAiAgentSettings() { state.writes.push("ai-agent"); return {}; }
        export async function saveOrgAiSettings() { state.writes.push("ai-settings"); }
        export async function clearOrgAiKey() { state.writes.push("ai-key-delete"); }
        export async function getOrgAiSettings() { state.reads.push("ai-settings"); return {}; }
        export function normalizeAgentSettingsInput(value) { return value; }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const [setupAgent, aiAgent, ai, documentCapture] = await Promise.all([
  import("../setup/agents/[agentKey]/route.ts"), import("./agents/[agentKey]/route.ts"), import("./route.ts"), import("./document-capture/route.ts"),
]);
hooks.deregister();

const params = { params: Promise.resolve({ agentKey: "continuous_close_daily" }) };
const request = () => new Request("http://localhost/api/admin/ai", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});

test("restricted actors cannot write any org-wide AI or setup-agent policy", async () => {
  state.allowedSubsidiaryIds = new Set(["subsidiary-a"]); state.writes.length = 0;
  const deleteCapture = documentCapture.createDeleteDocumentCaptureHandler(
    async () => ({ user: { orgId: "org-1", id: "actor-1" }, allowedSubsidiaryIds: state.allowedSubsidiaryIds } as never),
    async () => { state.writes.push("document-capture-key-delete"); },
  );
  const cases: Array<[string, () => Promise<Response>]> = [
    ["setup agent policy", () => setupAgent.PUT(request(), params)], ["AI agent policy", () => aiAgent.PUT(request(), params)],
    ["AI settings", () => ai.PUT(request())], ["AI key deletion", () => ai.DELETE()], ["document capture key deletion", () => deleteCapture()],
  ];
  for (const [name, invoke] of cases) {
    const response = await invoke();
    assert.deepEqual({ status: response.status, body: await response.json() }, { status: 403, body: { error: "requires unrestricted subsidiary access" } }, `${name} must refuse a subsidiary-restricted actor`);
  }
  assert.deepEqual(state.writes, [], "no org-wide setting or key reaches a writer");
});

test("restricted actors cannot read org-wide AI settings", async () => {
  state.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  state.reads.length = 0;

  const response = await ai.GET();

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.deepEqual(state.reads, [], "org-wide settings are not loaded before refusing the reader");
});
