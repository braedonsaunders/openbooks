import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader regression for /admin/setup/agents: the overview configures packs,
// so its loader must demand `admin.setup.manage` — a holder sees one row per
// registered pack (defaults when never configured), anyone else is redirected.
// Auth is scripted; the read model (lib/setup/agents) and Postgres are live.
const stateKey = Symbol.for("openbooks.agents-overview-loader-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.agents-overview-loader-test')]
  export async function requirePermission(permission) {
    if (!state.user) throw new Error('NEXT_REDIRECT:/login');
    if (!permissionSetCovers(state.permissions, permission)) throw new Error('NEXT_REDIRECT:/');
    return { user: state.user, permissions: state.permissions, allowedSubsidiaryIds: null };
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (
      context.parentURL?.includes("/admin/setup/agents/view.ts") &&
      specifier === "../../../../../lib/authz"
    ) {
      return { url: "mock:agents-overview-authz", shortCircuit: true };
    }
    if (context.parentURL?.startsWith("mock:") && specifier.startsWith("@openbooks/")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:agents-overview-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { loadAgentsOverview } = await import("./view.ts");
hooks.deregister();

const { withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { CONTINUOUS_CLOSE_AGENT_KEYS } = await import(
  "@openbooks/engine/src/continuous-close-config.ts"
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function asManager(orgId: string) {
  loaderState.user = { orgId, id: "00000000-0000-0000-0000-000000000001" };
  loaderState.permissions = new Set(["admin.setup.manage"]);
}

test("a setup manager sees one overview row per registered pack", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    asManager(org.orgId);
    const data = await withBypassContext(() => loadAgentsOverview());
    assert.deepEqual(
      data.rows.map((row) => row.agentKey).sort(),
      [...CONTINUOUS_CLOSE_AGENT_KEYS].sort(),
    );
    assert.equal(data.featureEnabled, true, "the module switch defaults on");
    for (const row of data.rows) {
      assert.equal(row.policy.enabled, false, `${row.agentKey} must default to disabled`);
      assert.equal(row.lastRun, null);
      assert.equal(row.openFindings, 0);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("without the setup key the overview redirects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000002" };
    loaderState.permissions = new Set(["assistant.use"]);
    await assert.rejects(withBypassContext(() => loadAgentsOverview()), /NEXT_REDIRECT:\//);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
