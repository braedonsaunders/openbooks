import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "@openbooks/engine/src/testing/fixtures.ts";
import type { SessionUser } from "../auth.ts";
import type { Authz } from "../authz.ts";
import { isFeatureEnabled } from "../features.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

// Same module-graph shim as tool-schema-lint: the tool module is
// server-only and transitively imports the `@/` alias.
const { RESOURCING_TOOLS, createResourcingTools } = await import("./tools-resourcing.ts");
const { canRunTool } = await import("./gate.ts");

const EXPECTED: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["get_resourcing_assignment", "resourcing.read", "resourcing", "resourcing_feature_disabled", "Resourcing"],
  ["list_resourcing_assignments", "resourcing.read", "resourcing", "resourcing_feature_disabled", "Resourcing"],
  ["list_resource_requests", "resourcing.read", "resourceRequests", "resource_requests_feature_disabled", "Resource requests"],
  ["get_staffing_demand", "resourcing.read", "resourcing", "resourcing_feature_disabled", "Resourcing"],
  ["list_retainers", "retainers.read", "retainerBilling", "retainer_billing_feature_disabled", "Retainer billing"],
  ["get_retainer_balances", "retainers.read", "retainerBilling", "retainer_billing_feature_disabled", "Retainer billing"],
  ["get_staffing_board", "resourcing.read", "resourcing", "resourcing_feature_disabled", "Resourcing"],
  ["get_bench_summary", "resourcing.read", "resourcing", "resourcing_feature_disabled", "Resourcing"],
];
function countedTools(featureLookup: typeof isFeatureEnabled = isFeatureEnabled) {
  const featureCalls: Array<[string, string]> = [];
  const calls = { readEntityListPage: 0, loadAssignmentDrawerData: 0, loadDemandWeeks: 0, loadRetainerKpis: 0,
    loadResourcingBoard: 0, loadBench: 0, loadRolloffs: 0, businessToday: 0 };
  const fail = (name: keyof typeof calls) => async () => {
    calls[name]++;
    throw new Error(`Unexpected data access: ${name}`);
  };
  const tools = createResourcingTools({
    isFeatureEnabled: async (orgId, key) => { featureCalls.push([orgId, key]); return featureLookup(orgId, key); },
    readEntityListPage: fail("readEntityListPage"), loadAssignmentDrawerData: fail("loadAssignmentDrawerData"),
    loadDemandWeeks: fail("loadDemandWeeks"), loadRetainerKpis: fail("loadRetainerKpis"),
    loadResourcingBoard: fail("loadResourcingBoard"), loadBench: fail("loadBench"),
    loadRolloffs: fail("loadRolloffs"), businessToday: fail("businessToday"),
  });
  return { tools, calls, featureCalls };
}

function fakeAuthz(permissions: string[]): Authz {
  const user = { id: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002" } as SessionUser;
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds: null };
}

test("registry exposes exactly the eight contracted tools with their gates", () => {
  assert.deepEqual(RESOURCING_TOOLS.map((t) => t.name).sort(), EXPECTED.map((e) => e[0]).sort());
  for (const [name, perm, feature] of EXPECTED) {
    const tool = RESOURCING_TOOLS.find((t) => t.name === name)!;
    assert.equal(tool.feature, feature);
    assert.deepEqual(tool.gate, { mode: "anyOf", perms: [perm] });
    assert.equal(canRunTool(fakeAuthz(["assistant.use"]), tool, {}), false, `${name} hidden without grants`);
    assert.equal(canRunTool(fakeAuthz(["assistant.use", perm]), tool, {}), false, `${name} hidden without feature`);
    assert.equal(canRunTool(fakeAuthz(["assistant.use"]), tool, { [feature]: true }), false, `${name} hidden without permission`);
    assert.equal(canRunTool(fakeAuthz(["assistant.use", perm]), tool, { [feature]: true }), true, `${name} visible with both`);
  }
});

test("real handlers deny without permission with zero loader calls", async () => {
  for (const [name, perm] of EXPECTED) {
    const { tools, calls, featureCalls } = countedTools(async () => { assert.fail(`${name}: feature lookup before permission`); });
    const tool = tools.find((t) => t.name === name)!;
    assert.deepEqual(await tool.execute({}, fakeAuthz(["assistant.use"])), {
      ok: false, error: `forbidden: ${perm} is required`,
    }, `${name} denies without permission`);
    assert.deepEqual(featureCalls, [], name);
    for (const [dependency, count] of Object.entries(calls)) assert.equal(count, 0, `${name}: ${dependency}`);
  }
});

test("tool surface imports only the safe reader — no SQL, no trusted helper", () => {
  const src = readFileSync(new URL("./tools-resourcing.ts", import.meta.url), "utf8");
  assert.ok(src.includes("readEntityListPage"));
  for (const banned of ["readResolvedEntityListPageForView", "scopePredicate", "db.execute", "db.select", "drizzle-orm"]) {
    assert.equal(src.includes(banned), false, `banned surface: ${banned}`);
  }
});

test("feature-off beats malformed input for all eight handlers with zero loader calls", enabled, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actor = await withBypassContext(() => createScratchUser(org.orgId, "Dark", "dark-role"));
    const authz: Authz = { user: { id: actor, orgId: org.orgId } as SessionUser, permissions: new Set(["assistant.use", "resourcing.read", "retainers.read"]), allowedSubsidiaryIds: null };
    for (const [name, , feature, code, label] of EXPECTED) {
      const { tools, calls, featureCalls } = countedTools();
      const tool = tools.find((t) => t.name === name)!;
      assert.equal(await isFeatureEnabled(org.orgId, feature), false, `${name}: authoritative feature off`);
      assert.equal(tool.inputSchema.safeParse(null).success, false, `${name}: genuinely malformed input`);
      assert.deepEqual(await tool.execute(null, authz), { ok: false, error: `${code}: turn on ${label} under Company Settings → Features` }, name);
      assert.deepEqual(featureCalls, [[org.orgId, feature]], name);
      for (const [dependency, count] of Object.entries(calls)) assert.equal(count, 0, `${name}: ${dependency}`);
    }
  } finally { await dropScratchOrgReporting(org.orgId); }
});

test("authority outages propagate unchanged for all eight handlers without data access", async () => {
  const outage = new Error("Feature authority unavailable");
  for (const [name, perm, feature] of EXPECTED) {
    const authz = fakeAuthz(["assistant.use", perm]);
    const { tools, calls, featureCalls } = countedTools(async () => { throw outage; });
    await assert.rejects(tools.find((t) => t.name === name)!.execute(null, authz), (error) => error === outage, name);
    assert.deepEqual(featureCalls, [[authz.user.orgId, feature]], name);
    for (const [dependency, count] of Object.entries(calls)) assert.equal(count, 0, `${name}: ${dependency}`);
  }
});
