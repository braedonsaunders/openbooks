import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const stateKey = Symbol.for("openbooks.org-ai-scope-test");
const state: { writes: string[]; allowedSubsidiaryIds: Set<string> | null } = {
  writes: [],
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
    if (specifier === "server-only") return virtual("export {}");
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
        export async function getOrgAiSettings() { return {}; }
        export function normalizeAgentSettingsInput(value) { return value; }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const setupAgent = await import("../setup/agents/[agentKey]/route.ts");
const aiAgent = await import("./agents/[agentKey]/route.ts");
const ai = await import("./route.ts");
hooks.deregister();

const params = { params: Promise.resolve({ agentKey: "continuous_close_daily" }) };
const request = () => new Request("http://localhost/api/admin/ai", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
});

test("restricted actors cannot write any org-wide AI or setup-agent policy", async () => {
  state.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  state.writes.length = 0;
  const cases: Array<[string, () => Promise<Response>]> = [
    ["setup agent policy", () => setupAgent.PUT(request(), params)],
    ["AI agent policy", () => aiAgent.PUT(request(), params)],
    ["AI settings", () => ai.PUT(request())],
    ["AI key deletion", () => ai.DELETE()],
  ];
  for (const [name, invoke] of cases) {
    const response = await invoke();
    assert.equal(response.status, 403, `${name} must refuse a subsidiary-restricted actor`);
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  }
  assert.deepEqual(state.writes, [], "no org-wide setting or key reaches a writer");
});
