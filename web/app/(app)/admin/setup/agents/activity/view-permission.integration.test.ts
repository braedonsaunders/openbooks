import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader regression for /admin/setup/agents/activity: run envelopes across
// packs with re-run affordances — setup managers only. Auth is scripted; the
// read model (listAgentRuns) and Postgres are live.
const stateKey = Symbol.for("openbooks.agents-activity-loader-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.agents-activity-loader-test')]
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
    if (context.parentURL?.includes("/admin/setup/agents/activity/view.ts")) {
      if (specifier === "../../../../../../lib/authz") {
        return { url: "mock:agents-activity-authz", shortCircuit: true };
      }
      if (specifier === "next-intl/server") {
        return { url: "mock:agents-activity-intl", shortCircuit: true };
      }
    }
    if (context.parentURL?.startsWith("mock:") && specifier.startsWith("@openbooks/")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:agents-activity-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:agents-activity-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { loadAgentsActivity } = await import("./view.ts");
hooks.deregister();

const { withBypassContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { CONTINUOUS_CLOSE_AGENT_KEYS, runSetupAgentNow, saveSetupAgentPolicy } = await import(
  "../../../../../../lib/setup/agents.ts"
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const ENABLE_ACCOUNTING = {
  enabled: true,
  automaticRuns: false,
  cadence: "daily",
  materialityThreshold: "500",
  detectors: [],
  analysis: { rootCauseAnalysis: false, recommendations: false, narrative: false, modelTier: "fast", maxToolSteps: 4 },
};

test("a setup manager sees runs, the pack filter and paging", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Activity Admin", "admin");
    loaderState.user = { orgId: org.orgId, id: userId };
    loaderState.permissions = new Set(["admin.setup.manage"]);
    const empty = await withBypassContext(() => loadAgentsActivity({}));
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.total, 0);
    assert.equal(empty.empty, true);
    assert.equal(empty.hasRows, false);
    assert.deepEqual(
      empty.filterOptions.map((option) => option.value).sort(),
      [...CONTINUOUS_CLOSE_AGENT_KEYS].sort(),
    );

    await withBypassContext(() =>
      saveSetupAgentPolicy(org.orgId, userId, "accounting", ENABLE_ACCOUNTING),
    );
    await withBypassContext(() => runSetupAgentNow(org.orgId, userId, "accounting"));
    const data = await withBypassContext(() => loadAgentsActivity({}));
    assert.equal(data.total, 1);
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0]!.agentKey, "accounting");
    assert.ok(data.rows[0]!.packName.startsWith("admin:setup.agents.packs."));
    assert.equal(data.rows[0]!.triggerLabel, "admin:setup.agents.activity.triggers.manual");
    assert.equal(data.currentPage, 1);

    const filtered = await withBypassContext(() => loadAgentsActivity({ agent: "finance" }));
    assert.equal(filtered.total, 0);
    assert.deepEqual(filtered.rows, []);

    const unknown = await withBypassContext(() => loadAgentsActivity({ agent: "nope" }));
    assert.equal(unknown.total, 1, "an unknown pack filter degrades to unfiltered");

    const beyond = await withBypassContext(() => loadAgentsActivity({ page: "2" }));
    assert.equal(beyond.total, 1);
    assert.deepEqual(beyond.rows, [], "page 2 of 1 total is empty, not an error");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("without the setup key the activity redirects", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    loaderState.user = { orgId: org.orgId, id: "00000000-0000-0000-0000-000000000002" };
    loaderState.permissions = new Set(["assistant.use"]);
    await assert.rejects(withBypassContext(() => loadAgentsActivity()), /NEXT_REDIRECT:\//);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
