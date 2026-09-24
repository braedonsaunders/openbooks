import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader contract for the rebuilt /admin/setup/agents overview: the spec
// table sorts server-side from `?sort=`/`?dir=` and the KPI strip reads one
// aggregate plus the overview rows. Auth is scripted; the read models
// (lib/setup/agents) and Postgres are live.
const stateKey = Symbol.for("openbooks.agents-overview-spec-loader-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mockAuthz = `
  import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
  const state = globalThis[Symbol.for('openbooks.agents-overview-spec-loader-test')]
  export async function requirePermission(permission) {
    if (!state.user) throw new Error('NEXT_REDIRECT:/login');
    if (!permissionSetCovers(state.permissions, permission)) throw new Error('NEXT_REDIRECT:/');
    return { user: state.user, permissions: state.permissions, allowedSubsidiaryIds: null };
  }
`;

// getTranslations echoes `namespace:key` (ignoring interpolation values) so
// sort/KPI assertions stay locale-free while still proving the loader routes
// every display string through the catalog.
const mockIntl = `
  export async function getTranslations(namespace) {
    // Interpolates {vars} like the real catalog so loader-computed values
    // (money, counts) stay assertable while labels stay locale-free.
    return (key, vars) => {
      let out = namespace + ':' + key;
      if (vars) for (const [k, v] of Object.entries(vars)) out += '|' + k + '=' + String(v);
      return out;
    };
  }
  export async function getLocale() {
    return 'en';
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (context.parentURL?.includes("/admin/setup/agents/view.ts")) {
      if (specifier === "../../../../../lib/authz") {
        return { url: "mock:agents-overview-spec-authz", shortCircuit: true };
      }
      if (specifier === "next-intl/server") {
        return { url: "mock:agents-overview-spec-intl", shortCircuit: true };
      }
    }
    if (context.parentURL?.startsWith("mock:") && specifier.startsWith("@openbooks/")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:agents-overview-spec-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    if (url === "mock:agents-overview-spec-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { loadAgentsOverview } = await import("./view.ts");
hooks.deregister();

const { withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { runSetupAgentNow, saveSetupAgentPolicy } = await import(
  "../../../../../lib/setup/agents.ts"
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function asManager(orgId: string) {
  loaderState.user = { orgId, id: "00000000-0000-0000-0000-000000000001" };
  loaderState.permissions = new Set(["admin.setup.manage"]);
}

test("the overview resolves KPI labels and one row per pack", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    asManager(org.orgId);
    const data = await withBypassContext(() => loadAgentsOverview({}));
    assert.equal(data.kpis.length, 4);
    assert.deepEqual(
      data.kpis.map((kpi) => kpi.label.split("|")[0]),
      [
        "admin:setup.agents.overview.kpis.enabled",
        "admin:setup.agents.overview.kpis.openFindings",
        "admin:setup.agents.overview.kpis.runs7d",
        "admin:setup.agents.overview.kpis.failed7d",
      ],
    );
    assert.ok(data.kpis[0]!.value.includes("total="), "the enabled KPI carries its total");
    assert.ok(data.rows.length > 0);
    for (const row of data.rows) {
      assert.equal(row.id, row.agentKey);
      assert.ok(row.name.startsWith("admin:setup.agents.packs."));
      assert.ok(row.configureHref.endsWith(`/${row.agentKey}`));
      assert.match(row.detectorsLine, /0\.00/, "materiality formats as money, not raw scale-4");
      assert.doesNotMatch(row.detectorsLine, /\.0000/);
    }
    assert.equal(data.sort, "pack");
    assert.equal(data.dir, "asc");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the overview sorts by findings descending", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    asManager(org.orgId);
    const data = await withBypassContext(() =>
      loadAgentsOverview({ sort: "findings", dir: "desc" }),
    );
    assert.equal(data.sort, "findings");
    assert.equal(data.dir, "desc");
    const counts = data.rows.map((row) => row.openFindings);
    assert.deepEqual([...counts].sort((a, b) => b - a), counts);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a fresh run resolves a relative last-run cell", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, "Overview Admin", "admin"));
    asManager(org.orgId);
    await withBypassContext(() =>
      saveSetupAgentPolicy(org.orgId, userId, "accounting", {
        agentKey: "accounting",
        enabled: true,
        automaticRuns: false,
        cadence: "daily",
        materialityThreshold: "1000",
        detectors: [],
      }),
    );
    await withBypassContext(() => runSetupAgentNow(org.orgId, userId, "accounting", null /* test setup: system provenance, unrestricted */));
    const data = await withBypassContext(() => loadAgentsOverview({}));
    const row = data.rows.find((entry) => entry.agentKey === "accounting")!;
    assert.equal(row.lastRun.hasRun, true);
    assert.equal(row.lastRun.statusLabel, "admin:setup.agents.runStatuses.completed");
    assert.equal(row.lastRun.statusVariant, "success");
    assert.match(row.lastRun.dateLine, /ago|today|yesterday/i);
    const idle = data.rows.find((entry) => entry.agentKey === "finance")!;
    assert.equal(idle.lastRun.hasRun, false);
    assert.ok(idle.lastRun.dateLine.startsWith("admin:setup.agents.overview.neverRun"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unknown sort falls back to pack ascending", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    asManager(org.orgId);
    const data = await withBypassContext(() => loadAgentsOverview({ sort: "nope" }));
    assert.equal(data.sort, "pack");
    assert.equal(data.dir, "asc");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
