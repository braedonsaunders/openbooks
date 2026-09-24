import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { Authz } from "../authz.ts";

// The assistant registry is server-only, but this wiring test runs with
// Node's plain test runner. Keep the module graph identical to the other
// application tests by shimming only the marker package (same shim as
// web/lib/application/tool-catalog.test.ts). The `@/lib` alias resolves via
// TSX_TSCONFIG_PATH=web/tsconfig.json, which scripts/test-suite.mjs sets.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { buildToolRegistry, executeAssistantTool } = await import("./registry.ts");
const { FEATURES } = await import("../../../engine/src/organization/feature-registry.ts");

type SessionUser = import("../auth.ts").SessionUser;
type FeatureState = Record<string, boolean>;

function sessionUser(): SessionUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "parity-test@example.com",
    name: "Parity Test",
    roles: [],
    orgId: "00000000-0000-4000-8000-000000000002",
    envKind: "production",
    productionOrgId: "00000000-0000-4000-8000-000000000002",
    isSuperAdmin: false,
    homeUserId: "00000000-0000-4000-8000-000000000001",
    homeOrgId: "00000000-0000-4000-8000-000000000002",
  };
}

function authzWith(permissions: string[]): Authz {
  return { user: sessionUser(), permissions: new Set(permissions), allowedSubsidiaryIds: null };
}

const ALL_KEYS = FEATURES.map((f) => f.key);
const allOn: FeatureState = Object.fromEntries(ALL_KEYS.map((k) => [k, true]));
const bankingOff: FeatureState = { ...allOn, banking: false };
const appsOff: FeatureState = { ...allOn, apps: false };
const advancedCloseOff: FeatureState = { ...allOn, advancedClose: false };

/** Exercise tool visibility through the same registry used by chat requests. */

test("feature-off tools vanish from the chat registry", () => {
  const bankingOp = authzWith(["assistant.use", "banking.read", "banking.reconcile"]);
  const offKeys = new Set(Object.keys(buildToolRegistry(bankingOp, bankingOff)));
  for (const name of ["list_bank_reconciliations", "get_bank_reconciliation", "list_unmatched_bank_lines", "cash_position"]) {
    assert.ok(!offKeys.has(name), `banking-off must hide ${name}`);
  }
  const setupAdmin = authzWith(["assistant.use", "assistant.write", "admin.setup.manage", "apps.use"]);
  const noApps = new Set(Object.keys(buildToolRegistry(setupAdmin, appsOff)));
  for (const name of ["list_app_packages", "describe_app_vocabulary", "draft_app"]) {
    assert.ok(!noApps.has(name), `apps-off must hide ${name}`);
  }
  const closer = authzWith(["assistant.use", "assistant.write", "close.run"]);
  const noAdvanced = new Set(Object.keys(buildToolRegistry(closer, advancedCloseOff)));
  assert.ok(!noAdvanced.has("publish_close_package"), "advancedClose-off must hide publish_close_package");
  assert.ok(noAdvanced.has("refresh_close_run"), "advancedClose-off must keep refresh_close_run");
});

test("gated tools refuse without executing (no throw, no DB touch)", async () => {
  const reader = authzWith(["assistant.use", "reports.read"]);
  assert.deepEqual(await executeAssistantTool(reader, "draft_journal_entry", {}, allOn), { ok: false, error: "forbidden" });
  assert.deepEqual(await executeAssistantTool(authzWith(["reports.read"]), "whoami", {}, allOn), { ok: false, error: "forbidden" });
  const bankingOp = authzWith(["assistant.use", "banking.read"]);
  assert.deepEqual(await executeAssistantTool(bankingOp, "list_bank_reconciliations", {}, bankingOff), { ok: false, error: "forbidden" });
});
