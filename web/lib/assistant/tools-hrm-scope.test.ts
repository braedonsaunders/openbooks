import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

// Same module-graph shim as tool-schema-lint: the tool module is
// server-only and transitively imports the `@/` alias; the engine imports
// resolve through tsx with TSX_TSCONFIG_PATH=web/tsconfig.json (as the
// suite runner sets it).
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

const { HRM_TOOLS, hrmRefusal } = await import("./tools-hrm.ts");
const { canRunTool } = await import("./gate.ts");
const { LeaveError } = await import("@openbooks/engine/src/hrm/leave-errors.ts");
const { EmploymentReadError } = await import("@openbooks/engine/src/hrm/employment-read.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { AmbiguousRevisionError, NoRevisionError } = await import("@openbooks/engine/src/hrm/temporal.ts");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-hrm.ts");

const TOOL_NAMES = ["hrm_headcount", "hrm_employment_as_of", "hrm_change_requests", "hrm_positions_as_of", "hrm_processes"];

const TOOL_PERMS: Record<string, string> = {
  hrm_headcount: "hrm.employment.read",
  hrm_employment_as_of: "hrm.employment.read",
  hrm_change_requests: "hrm.employment.read",
  hrm_positions_as_of: "hrm.position.read",
  // The checklist tool carries the process gate, not the employment one:
  // checklist state is governed by hrm.process.read at every surface.
  hrm_processes: "hrm.process.read",
const TOOL_NAMES = ["hrm_headcount", "hrm_employment_as_of", "hrm_change_requests", "hrm_leave"];

const TOOL_GATE_PERMS: Record<string, string> = {
  hrm_headcount: "hrm.employment.read",
  hrm_employment_as_of: "hrm.employment.read",
  hrm_change_requests: "hrm.employment.read",
  hrm_leave: "hrm.leave.read",
};

const UUID = "11111111-1111-4111-8111-111111111111";

test("the module exports exactly the five HRM read tools", () => {
test("the module exports exactly the four HRM read tools", () => {
  assert.deepEqual(HRM_TOOLS.map((tool) => tool.name), TOOL_NAMES);
});

for (const name of TOOL_NAMES) {
  test(`${name} carries the slice gate: its read grant, hrm feature, module tier`, () => {
    const tool = HRM_TOOLS.find((candidate) => candidate.name === name)!;
    assert.deepEqual(tool.gate, { mode: "anyOf", perms: [TOOL_PERMS[name]] });
  test(`${name} carries the slice gate: ${TOOL_GATE_PERMS[name]}, hrm feature, module tier`, () => {
    const tool = HRM_TOOLS.find((candidate) => candidate.name === name)!;
    assert.deepEqual(tool.gate, { mode: "anyOf", perms: [TOOL_GATE_PERMS[name]] });
    assert.equal(tool.feature, "hrm");
    assert.equal(tool.tier, "module");
    assert.ok(
      tool.category === "read" || tool.category === "search",
      `${name} must be read-only in the authoring sense (authoring stays human-attested, no write tools)`,
    );
    assert.ok(
      tool.description.length > 0 && tool.description.length <= 220,
      `${name} description is ${tool.description.length} chars (slice ceiling is 220)`,
    );
    assert.match(tool.description, /Read-only\.$/);
  });
}

test("minimal valid inputs parse; addressing is runtime-enforced with stable codes", () => {
  // Schemas stay all-optional on purpose: a half-addressed call returns a
  // stable tool error (employment_or_party_required, invalid_period, …)
  // instead of a provider-level validation failure. The runtime refusals are
  // pinned by the integration test; here only genuinely invalid values throw.
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  byName.get("hrm_headcount")!.inputSchema.parse({});
  byName.get("hrm_headcount")!.inputSchema.parse({ asOf: "2026-06-15" });
  byName.get("hrm_headcount")!.inputSchema.parse({ period: "this_fiscal_year_to_date" });
  assert.throws(() => byName.get("hrm_headcount")!.inputSchema.parse({ period: "last Tuesday" }));
  assert.throws(() => byName.get("hrm_headcount")!.inputSchema.parse({ asOf: "tomorrow" }));
  byName.get("hrm_employment_as_of")!.inputSchema.parse({});
  byName.get("hrm_employment_as_of")!.inputSchema.parse({ employmentId: UUID });
  byName.get("hrm_employment_as_of")!.inputSchema.parse({ partyId: UUID, asOf: "2026-06-15" });
  assert.throws(() => byName.get("hrm_employment_as_of")!.inputSchema.parse({ employmentId: "nope" }));
  assert.throws(() => byName.get("hrm_employment_as_of")!.inputSchema.parse({ asOf: "2026-6-5" }));
  byName.get("hrm_change_requests")!.inputSchema.parse({});
  byName.get("hrm_change_requests")!.inputSchema.parse({ employmentId: UUID });
  byName.get("hrm_change_requests")!.inputSchema.parse({ status: "approved", limit: 10 });
  assert.throws(() => byName.get("hrm_change_requests")!.inputSchema.parse({ status: "posted_draft" }));
  assert.throws(() => byName.get("hrm_change_requests")!.inputSchema.parse({ limit: 0 }));
  byName.get("hrm_positions_as_of")!.inputSchema.parse({});
  byName.get("hrm_positions_as_of")!.inputSchema.parse({ asOf: "2026-06-15", status: "open" });
  byName.get("hrm_positions_as_of")!.inputSchema.parse({ period: "this_fiscal_year_to_date" });
  assert.throws(() => byName.get("hrm_positions_as_of")!.inputSchema.parse({ status: "recruiting" }));
  assert.throws(() => byName.get("hrm_positions_as_of")!.inputSchema.parse({ asOf: "tomorrow" }));
  byName.get("hrm_processes")!.inputSchema.parse({});
  byName.get("hrm_processes")!.inputSchema.parse({ processId: UUID });
  byName.get("hrm_processes")!.inputSchema.parse({ segment: "overdue", employmentId: UUID, limit: 10 });
  assert.throws(() => byName.get("hrm_processes")!.inputSchema.parse({ segment: "someday" }));
  assert.throws(() => byName.get("hrm_processes")!.inputSchema.parse({ processId: "nope" }));
  byName.get("hrm_leave")!.inputSchema.parse({});
  byName.get("hrm_leave")!.inputSchema.parse({ employmentId: UUID });
  byName.get("hrm_leave")!.inputSchema.parse({ status: "cancelled", includeBalances: true, limit: 10 });
  byName.get("hrm_leave")!.inputSchema.parse({ employmentId: UUID, asOf: "2026-06-15" });
  assert.throws(() => byName.get("hrm_leave")!.inputSchema.parse({ status: "taken" }));
  assert.throws(() => byName.get("hrm_leave")!.inputSchema.parse({ limit: 0 }));
});

// Every tool reuses the canonical read loaders the HRM tabs read
// through — never a parallel SQL path to versions or requests.
test("HRM reads reuse the canonical HRM read services", () => {
  for (const service of [
    "getHeadcountAsOf(",
    "getEmploymentAsOf(",
    "findEmploymentsByParty(",
    "loadEmploymentChangeRequests(",
    "getVacancyAsOf(",
    "getProcess(",
    "listProcesses(",
    "listLeaveRequests(",
    "listLeaveTypes(",
    "timeBalanceAsOf(",
    "resolveToolRange(",
    "AmbiguousRevisionError(",
    "hrmRefusal(",
  ]) {
    assert.ok(tools.includes(service), `tools-hrm.ts must reuse ${service}`);
  }
});

test("no parallel SQL path to versions or requests and no writes", () => {
  assert.doesNotMatch(tools, /from worker_employment_versions/);
  assert.doesNotMatch(tools, /from employment_assignment_versions/);
  assert.doesNotMatch(tools, /from hrm_employment_change_requests/);
  assert.doesNotMatch(tools, /from hrm_leave_requests/);
  assert.doesNotMatch(tools, /from hrm_absences/);
  assert.doesNotMatch(tools, /from hrm_payroll_inputs/);
  assert.doesNotMatch(tools, /from hrm_leave_types/);
  assert.doesNotMatch(tools, /from hrm_leave_policies/);
  assert.doesNotMatch(tools, /into worker_/);
  assert.doesNotMatch(tools, /update worker_/);
  assert.doesNotMatch(tools, /into hrm_/);
  assert.doesNotMatch(tools, /update hrm_/);
  assert.doesNotMatch(tools, /delete from/);
  // The one SQL here enumerates stable employment identities for the
  // org-wide request list — scoped, capped, versions never selected.
  assert.match(tools, /from worker_employments/);
  assert.match(tools, /employer_subsidiary_id is not null/);
  assert.match(tools, /subsidiaryVisibleFilter\(sql`employer_subsidiary_id`, allowedSubsidiaryIds\)/);
  assert.match(tools, /visibleEmploymentIds\(authz\.user\.orgId, authz\.allowedSubsidiaryIds/);
});

test("feature gate and refusal mapping", () => {
  assert.match(tools, /isFeatureEnabled\(orgId, "hrm"\)/);
  assert.match(tools, /hrm_feature_disabled/);
  assert.match(tools, /employment_or_party_required/);
  assert.match(tools, /balances_need_employment/);
  assert.match(tools, /LeaveError/);
});

// A computed refusal must reach the caller with its message intact; anything
// else stays private by rethrowing into executeAssistantTool's tool_failed.
test("hrmRefusal carries read-service refusals and rethrows the rest", () => {
  assert.deepEqual(hrmRefusal(new EmploymentReadError("gate is off: enable it first")), {
    ok: false,
    error: "gate is off: enable it first",
  });
  assert.deepEqual(
    hrmRefusal(new HrmAuthorizationError("Employment is not visible in this organization and legal-entity scope.")),
    { ok: false, error: "Employment is not visible in this organization and legal-entity scope." },
  );
  const missing = new NoRevisionError("2026-06-15", "2026-07-01T00:00:00.000000Z");
  const mapped = hrmRefusal(missing);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.ok === false && mapped.error, missing.message);
  const ambiguous = new AmbiguousRevisionError("2 employments are visible");
  const mappedAmbiguous = hrmRefusal(ambiguous);
  assert.equal(mappedAmbiguous.ok, false);
  assert.equal(mappedAmbiguous.ok === false && mappedAmbiguous.error, ambiguous.message);
  const leave = new LeaveError("REFUSED", "no active leave policy covers this employment on the requested dates");
  const mappedLeave = hrmRefusal(leave);
  assert.equal(mappedLeave.ok, false);
  assert.equal(mappedLeave.ok === false && mappedLeave.error, leave.message);
  assert.throws(() => hrmRefusal(new Error("SELECT * FROM secrets")), /SELECT/);
});

function fakeAuthz(permissions: string[]): Authz {
  const userId = "00000000-0000-4000-8000-000000000001";
  const user: SessionUser = {
    id: userId,
    orgId: "00000000-0000-4000-8000-000000000002",
    name: "HRM gate prober",
    email: "hrm-gate@scratch.test",
    roles: [{ key: "ordinary-role", name: "Ordinary role" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: "00000000-0000-4000-8000-000000000002",
    homeOrgId: "00000000-0000-4000-8000-000000000002",
    homeUserId: userId,
  };
  return { user, permissions: new Set(permissions), allowedSubsidiaryIds: null };
}

test("the registry gate admits only each tool's grant holders while hrm is on", () => {
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  for (const name of TOOL_NAMES) {
    const perm = TOOL_PERMS[name];
    assert.ok(perm, `${name} has a declared permission`);
test("the registry gate admits only slice-permission holders while hrm is on", () => {
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  for (const name of TOOL_NAMES) {
    const perm = TOOL_GATE_PERMS[name]!;
    const reader = fakeAuthz(["assistant.use", perm]);
    assert.equal(canRunTool(reader, byName.get(name)!, { hrm: true }), true, `${name} must run for a gated reader`);
    assert.equal(canRunTool(reader, byName.get(name)!, { hrm: false }), false, `${name} must hide while hrm is off`);
    assert.equal(
      canRunTool(fakeAuthz(["assistant.use"]), byName.get(name)!, { hrm: true }),
      false,
      `${name} must refuse without ${perm}`,
    );
    assert.equal(
      canRunTool(fakeAuthz([perm]), byName.get(name)!, { hrm: true }),
      false,
      `${name} still requires assistant.use`,
    );
    // The sibling slice's grant is not enough: leave tools need the leave
    // key and employment tools need the employment key.
    const sibling = perm === "hrm.leave.read" ? "hrm.employment.read" : "hrm.leave.read";
    assert.equal(
      canRunTool(fakeAuthz(["assistant.use", sibling]), byName.get(name)!, { hrm: true }),
      false,
      `${name} must refuse on the sibling slice's grant`,
    );
  }
  // Position grants are the admin-held establishment boundary: an
  // employment-only reader sees headcount, never the funded plan behind it.
  assert.equal(
    canRunTool(
      fakeAuthz(["assistant.use", "hrm.employment.read"]),
      byName.get("hrm_positions_as_of")!,
      { hrm: true },
    ),
    false,
    "hrm_positions_as_of must refuse an employment-only reader",
  );
});

test("registrations: registry spread, scrape lists, matrix entry, playbook, contract harness", () => {
  const registry = read("./registry.ts");
  assert.match(registry, /import \{ HRM_TOOLS \} from "\.\/tools-hrm"/);
  assert.match(registry, /\.\.\.HRM_TOOLS,/);
  const skillsTest = read("../mcp/skills.test.ts");
  assert.match(skillsTest, /tools-hrm\.ts/);
  const matrix = read("./coverage-matrix.test.ts");
  assert.match(matrix, /"\.\/tools-hrm\.ts",/);
  const entry = matrix.split("\n").find((line) => line.includes('prefix: "hrm"'));
  assert.ok(entry, "coverage matrix needs an hrm entry");
  for (const name of TOOL_NAMES) {
    assert.ok(entry.includes(`"${name}"`), `matrix hrm entry must cover ${name}`);
  }
  assert.ok(!entry.includes("uncovered"), "the hrm entry must map tools, never an uncovered gap");
  const skills = read("../mcp/skills.ts");
  for (const name of TOOL_NAMES) {
    assert.ok(skills.includes(name), `playbook must mention ${name}`);
  }
  const contract = read("./tool-contract.integration.test.ts");
  assert.match(contract, /"hrm\.employment\.read",/);
  assert.match(contract, /"hrm_feature_disabled",/);
  assert.match(contract, /hrm_employment_as_of: \{ employmentId: randomUUID\(\), asOf: "2026-06-15" \}/);
});
