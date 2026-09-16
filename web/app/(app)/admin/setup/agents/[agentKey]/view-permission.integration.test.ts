import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader regression for /admin/setup/agents/[agentKey]: one pack's schedule,
// detector controls, analysis tier and finding routing — setup managers only,
// unknown keys 404. Auth and navigation are scripted; the read model and
// Postgres are live.
const stateKey = Symbol.for("openbooks.agent-policy-loader-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.agent-policy-loader-test')]
  export async function requirePermission(permission) {
    if (!state.user) throw new Error('NEXT_REDIRECT:/login');
    if (!permissionSetCovers(state.permissions, permission)) throw new Error('NEXT_REDIRECT:/');
    return { user: state.user, permissions: state.permissions, allowedSubsidiaryIds: null };
  }
`;

const mockNavigation = `
  export function notFound() { throw new Error('NEXT_NOT_FOUND'); }
  export function redirect(to) { throw new Error('NEXT_REDIRECT:' + to); }
`;

const mockIntl = `
  export async function getTranslations(namespace) {
    return (key, _vars) => namespace + ':' + key;
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    // Brackets percent-encode in file URLs (%5BagentKey%5D) — decode first.
    const parent = decodeURIComponent(context.parentURL ?? "");
    if (parent.includes("/admin/setup/agents/[agentKey]/view.ts")) {
      if (specifier === "../../../../../../lib/authz") {
        return { url: "mock:agent-policy-authz", shortCircuit: true };
      }
      if (specifier === "next/navigation") {
        return { url: "mock:agent-policy-navigation", shortCircuit: true };
      }
      if (specifier === "next-intl/server") {
        return { url: "mock:agent-policy-intl", shortCircuit: true };
      }
    }
    if (context.parentURL?.startsWith("mock:") && specifier.startsWith("@openbooks/")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:agent-policy-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:agent-policy-navigation") {
      return { format: "module", source: mockNavigation, shortCircuit: true };
    }
    if (url === "mock:agent-policy-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { loadAgentPolicy } = await import("./view.ts");
hooks.deregister();

const { withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { detectorSpecsForAgent } = await import(
  "@openbooks/engine/src/continuous-close-config.ts"
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("a setup manager gets the pack policy, specs and routing targets", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Policy Admin", "admin");
    loaderState.user = { orgId: org.orgId, id: userId };
    loaderState.permissions = new Set(["admin.setup.manage"]);
    const data = await withBypassContext(() => loadAgentPolicy("accounting"));
    assert.equal(data.pack.agentKey, "accounting");
    assert.equal(data.pack.policy.enabled, false);
    assert.equal(data.title, "admin:setup.agents.packs.accounting.title");
    assert.equal(data.backHref, "/admin/setup/agents");
    assert.equal(data.hasFeatureOff, false);
    assert.ok(data.description.startsWith("admin:setup.agents.packs.accounting."));
    assert.ok(data.runLine.startsWith("admin:setup.agents.overview."));
    assert.deepEqual(
      data.specs.map((spec) => spec.detectorKey),
      detectorSpecsForAgent("accounting").map((spec) => spec.detectorKey),
    );
    for (const spec of data.specs) {
      assert.ok(Array.isArray(spec.parameters), `${spec.detectorKey} must carry its parameter specs`);
    }
    assert.equal(data.notification, null);
    assert.equal(data.featureEnabled, true);
    assert.ok(data.roles.some((role) => role.name.toLowerCase().includes("admin")), "must list org roles");
    assert.ok(data.users.some((user) => user.id === userId), "must list org people");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unknown pack key 404s", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000001" };
    loaderState.permissions = new Set(["admin.setup.manage"]);
    await assert.rejects(withBypassContext(() => loadAgentPolicy("nope")), /NEXT_NOT_FOUND/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("without the setup key the policy redirects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000002" };
    loaderState.permissions = new Set(["assistant.use"]);
    await assert.rejects(withBypassContext(() => loadAgentPolicy("accounting")), /NEXT_REDIRECT:\//);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
