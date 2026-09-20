import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { SessionUser } from "../auth";
import type { Authz } from "../authz";

// Same module-graph shim as tool-schema-lint: the tool module is
// server-only and transitively imports the `@/` alias.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
      }
      return nextResolve(path, context);
    }
    return nextResolve(specifier, context);
  },
});

const { ALLOCATIONS_TOOLS } = await import("./tools-allocations.ts");
const { canRunTool } = await import("./gate.ts");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-allocations.ts");

const TOOL_NAMES = [
  "list_allocation_rules",
  "get_allocation_rule",
  "list_allocation_drivers",
  "preview_driver_vector",
  "preview_allocation",
  "list_allocation_runs",
  "explain_allocation",
];

const READ_TOOL_NAMES = TOOL_NAMES.filter((name) => name !== "preview_allocation");

const UUID = "11111111-1111-4111-8111-111111111111";

function fakeAuthz(permissions: string[]): Authz {
  const userId = "00000000-0000-4000-8000-000000000001";
  const orgId = "00000000-0000-4000-8000-000000000002";
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Allocation gate prober",
    email: "alloc-gate@scratch.test",
    roles: [{ key: "ordinary-role", name: "Ordinary role" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds: null };
}

test("the module exports exactly the seven allocation tools", () => {
  assert.deepEqual(ALLOCATIONS_TOOLS.map((tool) => tool.name), TOOL_NAMES);
});

for (const name of READ_TOOL_NAMES) {
  test(`${name} carries the slice gate: allocations.read, allocations feature, module tier`, () => {
    const tool = ALLOCATIONS_TOOLS.find((candidate) => candidate.name === name)!;
    assert.deepEqual(tool.gate, { mode: "anyOf", perms: ["allocations.read"] });
    assert.equal(tool.feature, "allocations");
    assert.equal(tool.tier, "module");
    assert.ok(
      tool.category === "read" || tool.category === "search",
      `${name} must be read-only in the posting sense (no post/reverse tools in this slice)`,
    );
    assert.ok(
      tool.description.length > 0 && tool.description.length <= 220,
      `${name} description is ${tool.description.length} chars (slice ceiling is 220)`,
    );
  });
}

test("preview_allocation persists a run under the HTTP allocations.run write gate", () => {
  const tool = ALLOCATIONS_TOOLS.find((candidate) => candidate.name === "preview_allocation")!;
  assert.deepEqual(tool.gate, { mode: "anyOf", perms: ["allocations.run"] });
  assert.equal(tool.category, "write");
  assert.equal(tool.feature, "allocations");
  assert.equal(tool.tier, "module");
  assert.ok(
    tool.description.length > 0 && tool.description.length <= 220,
    `preview_allocation description is ${tool.description.length} chars (slice ceiling is 220)`,
  );
  assert.match(tools, /can\(authz, "allocations\.run"\)/);
});

test("preview_allocation refuses allocations.read without allocations.run or assistant.write", async () => {
  const tool = ALLOCATIONS_TOOLS.find((candidate) => candidate.name === "preview_allocation")!;
  const reader = fakeAuthz(["assistant.use", "allocations.read"]);
  assert.equal(
    canRunTool(reader, tool, { allocations: true }),
    false,
    "allocations.read must not expose a persist",
  );
  assert.deepEqual(await tool.execute({ ruleKey: "sweep", periodId: UUID }, reader), {
    ok: false,
    error: "forbidden",
  });
  assert.equal(
    canRunTool(fakeAuthz(["assistant.use", "allocations.read", "assistant.write"]), tool, { allocations: true }),
    false,
    "assistant.write without allocations.run must not expose a persist",
  );
  const runner = fakeAuthz(["assistant.use", "allocations.run", "assistant.write"]);
  assert.equal(
    canRunTool(runner, tool, { allocations: true }),
    true,
    "allocations.run plus assistant.write must still reach preview",
  );
  assert.equal(
    canRunTool(fakeAuthz(["assistant.use", "allocations.run"]), tool, { allocations: true }),
    false,
    "write-category persist still requires assistant.write",
  );
});

test("minimal valid inputs parse; addressing is runtime-enforced with stable codes", () => {
  // Schemas stay all-optional on purpose: a half-addressed call returns a
  // stable tool error (rule_id_or_key_required, …) instead of a
  // provider-level validation failure. The runtime refusals are pinned by
  // the integration test; here only genuinely invalid values must throw.
  const byName = new Map(ALLOCATIONS_TOOLS.map((tool) => [tool.name, tool] as const));
  byName.get("list_allocation_rules")!.inputSchema.parse({});
  byName.get("list_allocation_rules")!.inputSchema.parse({ mode: "period", activeOnly: true });
  assert.throws(() => byName.get("list_allocation_rules")!.inputSchema.parse({ mode: "sweep" }));
  byName.get("get_allocation_rule")!.inputSchema.parse({ ruleId: UUID });
  byName.get("get_allocation_rule")!.inputSchema.parse({ ruleKey: "sweep" });
  byName.get("get_allocation_rule")!.inputSchema.parse({});
  assert.throws(() => byName.get("get_allocation_rule")!.inputSchema.parse({ ruleId: "nope" }));
  byName.get("list_allocation_drivers")!.inputSchema.parse({});
  byName.get("preview_driver_vector")!.inputSchema.parse({ driverId: UUID, periodId: UUID });
  byName.get("preview_driver_vector")!.inputSchema.parse({ driverKey: "headcount", period: "last_fiscal_quarter" });
  byName.get("preview_driver_vector")!.inputSchema.parse({});
  assert.throws(() => byName.get("preview_driver_vector")!.inputSchema.parse({ period: "last Tuesday" }));
  byName.get("preview_allocation")!.inputSchema.parse({ ruleKey: "sweep", period: "last_fiscal_quarter" });
  byName.get("preview_allocation")!.inputSchema.parse({ ruleId: UUID, periodId: UUID });
  byName.get("preview_allocation")!.inputSchema.parse({ ruleKey: "sweep" });
  byName.get("list_allocation_runs")!.inputSchema.parse({});
  byName.get("list_allocation_runs")!.inputSchema.parse({ status: "posted", limit: 10 });
  assert.throws(() => byName.get("list_allocation_runs")!.inputSchema.parse({ status: "posted_draft" }));
  byName.get("explain_allocation")!.inputSchema.parse({ runId: UUID });
  byName.get("explain_allocation")!.inputSchema.parse({});
});

// Every tool reuses the engine/route service the screen calls — never a
// parallel SQL path to the same data.
test("allocation reads reuse the setup routes' engine services", () => {
  for (const service of [
    "listRuleHeads(",
    "getRuleDetail(",
    "getRuleVersion(",
    "listDrivers(",
    "previewDriverVector(",
    "runDriverReport",
    "postDriverResolver",
    "previewAllocationRun(",
    "listRuns(",
    "getRun(",
    "queryLineage(",
    "runSubsidiaryVisible(",
    "validateLineageAnchor(",
    "reportBookSelection(",
    "getDimensionValueLabels(",
    "vectorShares(",
  ]) {
    assert.ok(tools.includes(service), `tools-allocations.ts must reuse ${service}`);
  }
});

test("no parallel SQL path to allocation tables and no posting lifecycle", () => {
  assert.doesNotMatch(tools, /from allocation_/);
  assert.doesNotMatch(tools, /into allocation_/);
  assert.doesNotMatch(tools, /update allocation_/);
  assert.doesNotMatch(tools, /join allocation_/);
  assert.doesNotMatch(tools, /postAllocationRun|reverseAllocationRun|rerunAllocationRun/);
});

test("feature gate, subsidiary scope, and report-permission surfacing", () => {
  assert.match(tools, /isFeatureEnabled\(authz\.user\.orgId, "allocations"\)/);
  assert.match(tools, /allocations_feature_disabled/);
  // Runs reads carry the actor's subsidiary scope exactly as the routes do.
  assert.match(tools, /allowedSubsidiaryIds: authz\.allowedSubsidiaryIds/);
  assert.match(tools, /runSubsidiaryVisible\(authz\.allowedSubsidiaryIds/);
  assert.match(tools, /must be inside your scope/);
  // Report-definition drivers are enforced by the engine under the
  // triggering actor; the refusal surfaces instead of an opaque failure.
  assert.match(tools, /DriverNotAvailableError/);
  assert.match(tools, /postDriverResolver/);
  assert.match(tools, /\{ driverResolver: postDriverResolver \}/);
});

test("registrations: registry spread, scrape lists, matrix entry, playbook", () => {
  const registry = read("./registry.ts");
  assert.match(registry, /import \{ ALLOCATIONS_TOOLS \} from "\.\/tools-allocations"/);
  assert.match(registry, /\.\.\.ALLOCATIONS_TOOLS,/);
  const skillsTest = read("../mcp/skills.test.ts");
  assert.match(skillsTest, /tools-allocations\.ts/);
  const matrix = read("./coverage-matrix.test.ts");
  assert.match(matrix, /"\.\/tools-allocations\.ts",/);
  const entry = matrix.split("\n").find((line) => line.includes('prefix: "allocations"'));
  assert.ok(entry, "coverage matrix needs an allocations entry");
  for (const name of TOOL_NAMES) {
    assert.ok(entry.includes(`"${name}"`), `matrix allocations entry must cover ${name}`);
  }
  const skills = read("../mcp/skills.ts");
  for (const name of TOOL_NAMES) {
    assert.ok(skills.includes(name), `playbook must mention ${name}`);
  }
});
