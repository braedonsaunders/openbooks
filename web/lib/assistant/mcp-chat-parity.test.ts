import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

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

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const {
  ASSISTANT_TOOLS,
  applicationToolVisible,
  buildToolRegistry,
  executeAssistantTool,
} = await import("./registry.ts");
const { APPLICATION_TOOLS } = await import("../application/tool-catalog.ts");
const { can } = await import("../authz.ts");
const { canRunTool } = await import("./gate.ts");
const { FEATURES } = await import("../../../engine/src/organization/feature-registry.ts");

type SessionUser = import("../auth.ts").SessionUser;
type Authz = import("../authz.ts").Authz;
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
const allOff: FeatureState = Object.fromEntries(ALL_KEYS.map((k) => [k, false]));
const bankingOff: FeatureState = { ...allOn, banking: false };
const appsOff: FeatureState = { ...allOn, apps: false };
const advancedCloseOff: FeatureState = { ...allOn, advancedClose: false };

const ACTORS: [string, Authz][] = [
  ["reader", authzWith(["assistant.use", "reports.read"])],
  ["writer", authzWith(["assistant.use", "assistant.write", "ap.pay", "ar.pay", "gl.post", "close.run"])],
  ["bankingOp", authzWith(["assistant.use", "banking.read", "banking.reconcile"])],
  ["setupAdmin", authzWith(["assistant.use", "assistant.write", "admin.setup.manage", "admin.users.manage"])],
  ["noAssistant", authzWith(["reports.read"])],
  ["super", authzWith(["*"])],
];

const STATES: [string, FeatureState][] = [
  ["allOn", allOn],
  ["allOff", allOff],
  ["bankingOff", bankingOff],
  ["appsOff", appsOff],
  ["advancedCloseOff", advancedCloseOff],
];

/**
 * Chat/MCP parity. The chat builds its catalog with buildToolRegistry; the
 * MCP server registers `visible: canRunTool(…)` for assistant tools and
 * `visible: applicationToolVisible(…)` for application tools (see the
 * source pins below). Both transports therefore expose exactly the
 * predicate-computed sets asserted here — with ONE documented difference:
 * the chat additionally requires assistant.write for mutating application
 * tools, while MCP relies on key grants + per-tool visibleTo + service
 * asserts + audit. That difference is pinned, not papered over.
 */

test("mcp and chat mount the same predicates (source pins)", () => {
  const server = read("../mcp/server.ts");
  assert.ok(
    server.includes("visible: (context) => canRunTool(context.authz, definition, features)"),
    "MCP assistant catalog must stay on canRunTool",
  );
  assert.ok(
    server.includes("visible: (context) => applicationToolVisible(definition, context.authz, features)"),
    "MCP application catalog must stay on applicationToolVisible",
  );
  assert.ok(
    server.includes("executeAssistantTool(context.authz, definition.name, input, features)"),
    "MCP assistant execution must stay on executeAssistantTool",
  );
  const registry = read("./registry.ts");
  assert.ok(
    registry.includes("ASSISTANT_TOOLS.filter((t) => canRunTool(authz, t, features))"),
    "chat assistant set must stay on canRunTool",
  );
  assert.ok(
    registry.includes("applicationToolVisible(definition, authz, features)"),
    "chat application set must stay on applicationToolVisible",
  );
  assert.ok(
    registry.includes('(definition.readOnly || can(authz, "assistant.write"))'),
    "chat mutating-application rule must stay explicit",
  );
});

test("chat registry exposes exactly the predicate-computed assistant set", () => {
  assert.ok(ASSISTANT_TOOLS.length > 20, "assistant catalog extraction looks broken");
  for (const [actorName, authz] of ACTORS) {
    for (const [stateName, features] of STATES) {
      const keys = Object.keys(buildToolRegistry(authz, features)).sort();
      const expectedAssistant = ASSISTANT_TOOLS.filter((t) => canRunTool(authz, t, features))
        .map((t) => t.name).sort();
      for (const name of expectedAssistant) {
        assert.ok(keys.includes(name), `${actorName}/${stateName}: chat hides ${name} the predicates allow`);
      }
      const appExpected = APPLICATION_TOOLS.filter((d) =>
        applicationToolVisible(d, authz, features) && (d.readOnly || can(authz, "assistant.write")),
      ).map((d) => d.name);
      for (const name of appExpected) {
        assert.ok(keys.includes(name), `${actorName}/${stateName}: chat hides application tool ${name}`);
      }
      assert.equal(keys.length, expectedAssistant.length + appExpected.length, `${actorName}/${stateName}: chat exposes extras`);
    }
  }
});

test("mutating application tools are the only chat/MCP difference, and it is exact", () => {
  for (const [actorName, authz] of ACTORS) {
    for (const [stateName, features] of STATES) {
      const mcpApp = APPLICATION_TOOLS.filter((d) => applicationToolVisible(d, authz, features));
      const chatKeys = new Set(Object.keys(buildToolRegistry(authz, features)));
      const hasWrite = can(authz, "assistant.write");
      for (const definition of mcpApp) {
        if (definition.readOnly || hasWrite) {
          assert.ok(chatKeys.has(definition.name), `${actorName}/${stateName}: chat must show ${definition.name}`);
        } else {
          assert.ok(!chatKeys.has(definition.name), `${actorName}/${stateName}: chat must hide mutating ${definition.name} without assistant.write`);
        }
      }
      const onlyInMcp = mcpApp.filter((d) => !chatKeys.has(d.name)).map((d) => d.name).sort();
      const expectedHidden = hasWrite
        ? []
        : mcpApp.filter((d) => !d.readOnly).map((d) => d.name).sort();
      assert.deepEqual(onlyInMcp, expectedHidden, `${actorName}/${stateName}: MCP/chat delta must be exactly the mutating set`);
    }
  }
});

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

test("no actor turns the registry empty-by-crash and no name shadows another", () => {
  const allNames = [...ASSISTANT_TOOLS.map((t) => t.name), ...APPLICATION_TOOLS.map((d) => d.name)];
  assert.equal(new Set(allNames).size, allNames.length, "a collision would silently shadow a tool in Object.fromEntries");
  for (const [, authz] of ACTORS) {
    for (const [, features] of STATES) {
      assert.doesNotThrow(() => buildToolRegistry(authz, features));
    }
  }
  // A permissionless actor still sees the open-doorway READ tools (visibleTo:
  // `visible`, no featureKey) on both surfaces — the chat route itself
  // requires assistant.use upstream, and every such tool enforces its real
  // permission inside execute (records per-type asserts, vitals approve-path
  // doorway, page-layout admin.customization.manage). What must never happen
  // is a mutating tool being reachable with no grant at all.
  const bareKeys = new Set(Object.keys(buildToolRegistry(authzWith([]), allOff)));
  assert.ok(bareKeys.size > 0, "open-doorway reads are visible by design");
  const byName = new Map(APPLICATION_TOOLS.map((d) => [d.name, d]));
  for (const name of bareKeys) {
    const definition = byName.get(name);
    assert.ok(definition && definition.readOnly, `${name}: reachable with no permissions must be read-only`);
  }
});

test("gated tools refuse without executing (no throw, no DB touch)", async () => {
  const reader = authzWith(["assistant.use", "reports.read"]);
  assert.deepEqual(await executeAssistantTool(reader, "draft_journal_entry", {}, allOn), { ok: false, error: "forbidden" });
  assert.deepEqual(await executeAssistantTool(authzWith(["reports.read"]), "whoami", {}, allOn), { ok: false, error: "forbidden" });
  const bankingOp = authzWith(["assistant.use", "banking.read"]);
  assert.deepEqual(await executeAssistantTool(bankingOp, "list_bank_reconciliations", {}, bankingOff), { ok: false, error: "forbidden" });
});
