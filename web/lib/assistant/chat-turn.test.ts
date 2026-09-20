import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

// Same module-graph shim as tool-schema-lint: the registry is server-only
// and transitively imported app modules use the `@/` alias.
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

const { buildChatTurn, chatCatalogTiers, createChatPrepareStep } = await import("./registry");
const { FEATURES } = await import("@openbooks/engine/src/organization/feature-registry.ts");
const { activateTurnModules } = await import("./tool-router");

/**
 * Chat-turn wiring (shard b01): the full gated catalog stays registered
 * while each step only SENDS core ∪ pre-routed ∪ activated tools. No model
 * and no database: the apps feature stays off so the async registry never
 * leaves the pure path.
 */

function adminAuthz(): Authz {
  const userId = "00000000-0000-4000-8000-000000000001";
  const orgId = "00000000-0000-4000-8000-000000000002";
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Turn harness",
    email: "turn-harness@scratch.test",
    roles: [{ key: "turn-admin", name: "Turn admin" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(["*", "assistant.use", "assistant.write"]), allowedSubsidiaryIds: null };
}

function allFeaturesExceptApps(): Record<string, boolean> {
  return Object.fromEntries(FEATURES.map((f) => [f.key, f.key === "apps" ? false : true]));
}

test("a payroll question pre-routes payroll but not inventory", async () => {
  const turn = await buildChatTurn(adminAuthz(), allFeaturesExceptApps(), "Summarize our most recent pay run.");
  const active = turn.activeTools();
  assert.ok(active.includes("list_pay_runs"), "pre-routed payroll tool missing");
  assert.ok(active.includes("whoami"), "core tool missing");
  assert.ok(!active.includes("inventory_levels"), "unrelated module leaked into the payload");
  assert.ok(!active.includes("correct_document"), "heavy mutation leaked into the payload");
  // Registration still carries everything the gates allow.
  assert.ok("inventory_levels" in turn.tools, "full catalog must stay registered");
  assert.ok("correct_document" in turn.tools, "full catalog must stay registered");
});

test("a greeting sends core tools only", async () => {
  const turn = await buildChatTurn(adminAuthz(), allFeaturesExceptApps(), "Hello.");
  const tiers = new Map(chatCatalogTiers().map((t) => [t.name, t.tier]));
  for (const name of turn.activeTools()) {
    assert.equal(tiers.get(name), "core", `${name} sent without activation`);
  }
  assert.ok(!turn.activeTools().includes("list_pay_runs"));
  assert.ok(!turn.activeTools().includes("general_ledger"));
});

test("prior conversation tools keep their module pre-routed", async () => {
  const turn = await buildChatTurn(adminAuthz(), allFeaturesExceptApps(), "And the second location?", [
    "inventory_levels",
  ]);
  assert.ok(turn.activeTools().includes("inventory_movements"), "follow-up lost its module");
});

test("mid-turn activation grows the sent set (the find_tools hook path)", async () => {
  const turn = await buildChatTurn(adminAuthz(), allFeaturesExceptApps(), "Hello.");
  assert.ok(!turn.activeTools().includes("inventory_levels"));
  activateTurnModules(turn.scope, ["inventory"]);
  assert.ok(turn.activeTools().includes("inventory_levels"), "activated module not sent");
  assert.ok(turn.activeTools().includes("whoami"), "core dropped after activation");
});

test("the step policy answers on the final step and filters every step", () => {
  const step = createChatPrepareStep(3, () => ["whoami"]);
  assert.deepEqual(step({ stepNumber: 0 }), { activeTools: ["whoami"] });
  assert.deepEqual(step({ stepNumber: 2 }), { toolChoice: "none", activeTools: ["whoami"] });
});

test("without a resolver the step policy sends everything (background behaviour)", () => {
  const step = createChatPrepareStep(3);
  assert.deepEqual(step({ stepNumber: 0 }), {});
  assert.deepEqual(step({ stepNumber: 2 }), { toolChoice: "none" });
});

test("the static snapshot covers the registered catalog exactly", async () => {
  const turn = await buildChatTurn(adminAuthz(), allFeaturesExceptApps(), "Hello.");
  const staticNames = new Set(chatCatalogTiers().map((t) => t.name));
  for (const name of Object.keys(turn.tools)) {
    // App tools are dynamic; everything else must have a tier and module.
    if (name.startsWith("app_")) continue;
    assert.ok(staticNames.has(name), `${name} registered without a tier/module snapshot`);
  }
  for (const entry of chatCatalogTiers()) {
    assert.ok(entry.module.length > 0, `${entry.name} has no module`);
  }
});
