import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { z } from "zod";
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

const { ASSISTANT_TOOLS, buildToolRegistry } = await import("./registry");
const { APPLICATION_TOOLS } = await import("../application/tool-catalog");
const { FEATURES } = await import("@openbooks/engine/src/feature-registry.ts");
const { moduleOfTool } = await import("./tool-router");

/**
 * Chat-payload budget (shard b01). A turn sends ~45k tokens of tool
 * definitions today; the two-stage catalog must hold a typical turn to
 * ≤ 12k (core ≤ 9k) with a ≤ 20k worst case. Token counts use the same
 * bytes/4 estimator as tmp/tool-budget.mts so the ledger numbers compare.
 */

function adminAuthz(): Authz {
  const userId = "00000000-0000-4000-8000-000000000001";
  const user: SessionUser = {
    id: userId,
    orgId: "00000000-0000-4000-8000-000000000002",
    name: "Budget harness",
    email: "budget-harness@scratch.test",
    roles: [{ key: "budget-admin", name: "Budget admin" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: "00000000-0000-4000-8000-000000000002",
    homeOrgId: "00000000-0000-4000-8000-000000000002",
    homeUserId: userId,
  };
  // Wildcard covers every gate (see permissionSetCovers).
  return { user, permissions: new Set(["*", "assistant.use", "assistant.write"]), allowedSubsidiaryIds: null };
}

function payloadTokens(entries: { name: string; description: string; inputSchema: unknown }[]): number {
  let bytes = 0;
  for (const entry of entries) {
    bytes += Buffer.byteLength(
      JSON.stringify({
        name: entry.name,
        description: entry.description,
        parameters: z.toJSONSchema(entry.inputSchema as never),
      }),
      "utf8",
    );
  }
  return Math.round(bytes / 4);
}

const { coreEntries, inventoryEntries, fullEntries } = (() => {
  const authz = adminAuthz();
  const features = Object.fromEntries(FEATURES.map((f) => [f.key, true]));
  // buildToolRegistry applies the same permission + feature gates the chat
  // turn is built with, so the budget measures what the model would see.
  const visible = new Set(Object.keys(buildToolRegistry(authz, features)));
  const catalog = [
    ...ASSISTANT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      tier: t.tier,
      module: moduleOfTool(t.name, t.feature),
      visible: visible.has(t.name),
    })),
    ...APPLICATION_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      tier: t.tier,
      module: moduleOfTool(t.name, t.featureKey),
      visible: visible.has(t.name),
    })),
  ].filter((t) => t.visible);
  return {
    coreEntries: catalog.filter((t) => t.tier === "core"),
    inventoryEntries: catalog.filter((t) => t.tier === "core" || t.module === "inventory"),
    fullEntries: catalog,
  };
})();

test("core tier stays within its 9k token budget", () => {
  const tokens = payloadTokens(coreEntries);
  console.log(`[budget] core: ${coreEntries.length} tools, ${tokens} tokens`);
  assert.ok(tokens <= 9000, `core payload is ${tokens} tokens (budget 9000)`);
});

test("a find_tools(inventory) turn stays within the 12k typical budget", () => {
  const tokens = payloadTokens(inventoryEntries);
  console.log(`[budget] core+inventory: ${inventoryEntries.length} tools, ${tokens} tokens`);
  assert.ok(tokens <= 12000, `core+inventory payload is ${tokens} tokens (budget 12000)`);
});

test("full catalog size is recorded so regressions show in the log", () => {
  const tokens = payloadTokens(fullEntries);
  console.log(`[budget] full: ${fullEntries.length} tools, ${tokens} tokens`);
  assert.ok(fullEntries.length >= 100, `catalog extraction looks broken (${fullEntries.length} tools)`);
  assert.ok(tokens > 9000, "full catalog fits the core budget — tiers are doing nothing");
});

test("core tier is exactly the justified capability list", () => {
  const names = coreEntries.map((t) => t.name).sort();
  // find_tools joins this list with the meta-tool commit (b01 commit 3).
  const expected = [
    "aging", "balance_sheet", "cash_position", "create_payment", "describe_capabilities",
    "draft_journal_entry", "financial_periods", "find_accounts", "find_documents",
    "find_journal_entries", "find_parties", "get_company_settings", "get_document",
    "get_journal_entry", "list_features", "list_open_items", "list_report_definitions",
    "post_payment", "profit_and_loss", "project_profitability", "rank_projects",
    "run_report", "trial_balance", "whoami",
  ].sort();
  assert.deepEqual(names, expected);
});

test("the heaviest mutation schemas stay out of the core payload", () => {
  const names = new Set(coreEntries.map((t) => t.name));
  for (const heavy of ["correct_document", "update_payment", "update_budget_cells"]) {
    assert.ok(!names.has(heavy), `${heavy} rides every chat step`);
  }
});
