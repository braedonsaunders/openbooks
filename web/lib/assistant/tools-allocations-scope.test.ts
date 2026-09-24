import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

const UUID = "11111111-1111-4111-8111-111111111111";

function fakeAuthz(
  permissions: string[],
  allowedSubsidiaryIds: Set<string> | null = null,
): Authz {
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
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds };
}

test("preview_allocation refuses an omitted subsidiary pin before persist", async () => {
  const tool = ALLOCATIONS_TOOLS.find((candidate) => candidate.name === "preview_allocation")!;
  const restricted = fakeAuthz(
    ["assistant.use", "allocations.run", "assistant.write"],
    new Set([UUID]),
  );
  // Restricted + omitted pin must be a named refusal, never previewAllocationRun.
  assert.deepEqual(await tool.execute({ ruleKey: "sweep", periodId: UUID }, restricted), {
    ok: false,
    error: "a subsidiary pin is required for subsidiary-restricted callers",
  });
  assert.deepEqual(
    await tool.execute(
      { ruleKey: "sweep", periodId: UUID, subsidiaryId: "22222222-2222-4222-8222-222222222222" },
      restricted,
    ),
    { ok: false, error: "subsidiary outside the caller's scope" },
  );
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
