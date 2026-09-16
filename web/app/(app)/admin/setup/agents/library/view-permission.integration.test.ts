import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader regression for /admin/setup/agents/library: the catalog lists every
// registered pack with its detector list, required permissions and install
// state — setup managers only. Auth is scripted; the read model and Postgres
// are live.
const stateKey = Symbol.for("openbooks.agents-library-loader-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.agents-library-loader-test')]
  export async function requirePermission(permission) {
    if (!state.user) throw new Error('NEXT_REDIRECT:/login');
    if (!permissionSetCovers(state.permissions, permission)) throw new Error('NEXT_REDIRECT:/');
    return { user: state.user, permissions: state.permissions, allowedSubsidiaryIds: null };
  }
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
    if (context.parentURL?.includes("/admin/setup/agents/library/view.ts")) {
      if (specifier === "../../../../../../lib/authz") {
        return { url: "mock:agents-library-authz", shortCircuit: true };
      }
      if (specifier === "next-intl/server") {
        return { url: "mock:agents-library-intl", shortCircuit: true };
      }
    }
    if (context.parentURL?.startsWith("mock:") && specifier.startsWith("@openbooks/")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:agents-library-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:agents-library-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { loadAgentsLibrary } = await import("./view.ts");
hooks.deregister();

const { withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { CONTINUOUS_CLOSE_AGENT_KEYS } = await import("../../../../../../lib/setup/agents.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("a setup manager sees every pack with detectors and install state", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000001" };
    loaderState.permissions = new Set(["admin.setup.manage"]);
    const data = await withBypassContext(() => loadAgentsLibrary());
    assert.deepEqual(
      data.packs.map((pack) => pack.agentKey).sort(),
      [...CONTINUOUS_CLOSE_AGENT_KEYS].sort(),
    );
    assert.equal(data.packs[0]?.featureEnabled, true);
    for (const pack of data.packs) {
      assert.ok(pack.name.startsWith("admin:setup.agents.packs."));
      assert.ok(pack.reads.startsWith("admin:setup.agents.packs."));
      assert.ok(pack.detectors.length > 0, `${pack.agentKey} must list its checks`);
      assert.ok(pack.permissions.length > 0, `${pack.agentKey} must name required permissions`);
      assert.equal(pack.installed, false, `${pack.agentKey} must default to uninstalled`);
      assert.ok(pack.installPolicy.agentKey === pack.agentKey);
      for (const detector of pack.detectors) {
        assert.equal(typeof detector.detectorKey, "string");
        assert.ok(detector.title.startsWith("admin:ai.agents.detectors."));
      }
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("without the setup key the library redirects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000002" };
    loaderState.permissions = new Set(["assistant.use"]);
    await assert.rejects(withBypassContext(() => loadAgentsLibrary()), /NEXT_REDIRECT:\//);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
