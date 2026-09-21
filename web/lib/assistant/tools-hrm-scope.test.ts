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
const { EmploymentReadError } = await import("@openbooks/engine/src/hrm/employment-read.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { AmbiguousRevisionError, NoRevisionError } = await import("@openbooks/engine/src/hrm/temporal.ts");
const { HrmPerformanceError } = await import("@openbooks/engine/src/hrm/performance/errors.ts");
const { HrmQualificationError } = await import("@openbooks/engine/src/hrm/qualifications/errors.ts");

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const tools = read("./tools-hrm.ts");

const TOOL_NAMES = ["hrm_headcount", "hrm_employment_as_of", "hrm_change_requests", "hrm_positions_as_of", "hrm_processes", "hrm_leave", "hrm_recruiting", "hrm_performance_cycles", "hrm_turnover", "hrm_benefits", "hrm_me", "automations_status", "hrm_compliance_findings", "hrm_certified_payroll", "hrm_compensation", "hrm_pay_equity", "hrm_qualifications", "hrm_dispatch_check"];

const TOOL_PERMS: Record<string, string> = {
  // Elections and windows read through the benefits read service under
  // the benefits gate at every surface.
  hrm_benefits: "hrm.benefits.read",
  hrm_headcount: "hrm.employment.read",
  hrm_employment_as_of: "hrm.employment.read",
  hrm_change_requests: "hrm.employment.read",
  hrm_positions_as_of: "hrm.position.read",
  // The checklist tool carries the process gate, not the employment one:
  // checklist state is governed by hrm.process.read at every surface.
  hrm_processes: "hrm.process.read",
  hrm_leave: "hrm.leave.read",
  // Cycle reads reuse the privacy-scoped read service; turnover is HR-only
  // through the retention read gate at every surface.
  hrm_performance_cycles: "hrm.performance.read",
  hrm_turnover: "hrm.retention.read",
  // The funnel tool carries the recruiting gate: requisitions, candidates,
  // interviews and offers are governed by hrm.recruiting.read at every
  // surface, and contact PII never leaves through it.
  hrm_recruiting: "hrm.recruiting.read",
  // The self-service summary scopes by the party behind the login, so it
  // carries the self grant every built-in role holds — never employment.read.
  hrm_me: "hrm.self.read",
  // HR-16 begin: the automation status tool carries the automations read
  // grant behind the automations switch — never an HR key.
  automations_status: "automations.read",
  // HR-16 end
  // HR-13 begin: compliance reads carry the construction grant at every
  // surface, never the employment one.
  hrm_compliance_findings: "hrm.construction.read",
  hrm_certified_payroll: "hrm.construction.read",
  // HR-13 end
  // HR-12 begin: bands, cycles, plans and equity snapshots carry the
  // compensation read grant at every surface; per-person pay never
  // leaves through the equity tool.
  hrm_compensation: "hrm.compensation.read",
  hrm_pay_equity: "hrm.compensation.read",
  // HR-12 end
  // HR-14 begin: the register and the readiness check carry the
  // certifications read grant at every surface; license numbers and
  // notes never leave through the register tool.
  hrm_qualifications: "hrm.certifications.read",
  hrm_dispatch_check: "hrm.certifications.read",
  // HR-14 end
};

const UUID = "11111111-1111-4111-8111-111111111111";

test("the module exports exactly the slice tools plus the core inbox tool", () => {
  assert.deepEqual(HRM_TOOLS.map((tool) => tool.name), [...TOOL_NAMES, "inbox_items"]);
});

test("inbox_items is the core own-scope tool: self grant, no feature, read-only", () => {
  const tool = HRM_TOOLS.find((candidate) => candidate.name === "inbox_items")!;
  assert.deepEqual(tool.gate, { mode: "anyOf", perms: ["hrm.self.read"] });
  assert.equal(tool.feature, undefined);
  assert.equal(tool.tier, "module");
  assert.equal(tool.category, "read");
  assert.ok(
    tool.description.length > 0 && tool.description.length <= 220,
    `inbox_items description is ${tool.description.length} chars (slice ceiling is 220)`,
  );
  assert.match(tool.description, /Read-only\.$/);
  assert.doesNotMatch(tool.description, /Approvals/, "the place is the inbox, not approvals");
  tool.inputSchema.parse({});
  tool.inputSchema.parse({ filter: "notices", limit: 10 });
  assert.throws(() => tool.inputSchema.parse({ filter: "someday" }));
  assert.throws(() => tool.inputSchema.parse({ limit: 0 }));
});

// HR-13 begin: construction tools sit behind the construction switch, not
// the bare hrm switch — a general-business org never sees them.
const TOOL_FEATURES: Record<string, string> = {
  hrm_compliance_findings: "hrmConstructionCompliance",
  hrm_certified_payroll: "hrmConstructionCompliance",
  // HR-16: the automations recipe tool rides the automations switch.
  automations_status: "automations",
  // HR-14 begin: the register rides hrmCertifications, the readiness
  // check rides hrmDispatchGating.
  hrm_qualifications: "hrmCertifications",
  hrm_dispatch_check: "hrmDispatchGating",
  // HR-14 end
};
// HR-13 end

for (const name of TOOL_NAMES) {
  test(`${name} carries the slice gate: its read grant, feature, module tier`, () => {
    const tool = HRM_TOOLS.find((candidate) => candidate.name === name)!;
    assert.deepEqual(tool.gate, { mode: "anyOf", perms: [TOOL_PERMS[name]] });
    // HR-12/HR-13 merged: construction and automations tools carry
    // their own switch (TOOL_FEATURES above); compensation tools gate
    // on their sub-switches; everything else rides hrm alone.
    const expectedFeature =
      TOOL_FEATURES[name] ??
      (name === "hrm_compensation"
        ? "hrmCompensation"
        : name === "hrm_pay_equity"
          ? "hrmPayTransparency"
          : "hrm");
    assert.equal(tool.feature, expectedFeature);
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
  byName.get("hrm_performance_cycles")!.inputSchema.parse({});
  byName.get("hrm_performance_cycles")!.inputSchema.parse({ cycleId: UUID });
  byName.get("hrm_performance_cycles")!.inputSchema.parse({ status: "calibrating", limit: 10 });
  assert.throws(() => byName.get("hrm_performance_cycles")!.inputSchema.parse({ status: "archived" }));
  assert.throws(() => byName.get("hrm_performance_cycles")!.inputSchema.parse({ cycleId: "nope" }));
  byName.get("hrm_turnover")!.inputSchema.parse({});
  byName.get("hrm_turnover")!.inputSchema.parse({ departmentId: UUID });
  byName.get("hrm_turnover")!.inputSchema.parse({ periods: [{ start: "2026-01-01", end: "2026-01-31" }] });
  assert.throws(() => byName.get("hrm_turnover")!.inputSchema.parse({ periods: [] }));
  assert.throws(() => byName.get("hrm_turnover")!.inputSchema.parse({ departmentId: "nope" }));
  byName.get("hrm_recruiting")!.inputSchema.parse({});
  byName.get("hrm_recruiting")!.inputSchema.parse({ requisitionId: UUID });
  byName.get("hrm_recruiting")!.inputSchema.parse({ segment: "filled", limit: 10 });
  assert.throws(() => byName.get("hrm_recruiting")!.inputSchema.parse({ segment: "archived" }));
  assert.throws(() => byName.get("hrm_recruiting")!.inputSchema.parse({ requisitionId: "nope" }));
  assert.throws(() => byName.get("hrm_recruiting")!.inputSchema.parse({ limit: 0 }));
  // HR-14 begin: half-addressed calls parse (addressing is
  // runtime-enforced with stable codes); genuinely invalid values throw.
  byName.get("hrm_qualifications")!.inputSchema.parse({});
  byName.get("hrm_qualifications")!.inputSchema.parse({ employmentId: UUID, status: "expiring" });
  assert.throws(() => byName.get("hrm_qualifications")!.inputSchema.parse({ employmentId: "nope" }));
  assert.throws(() => byName.get("hrm_qualifications")!.inputSchema.parse({ status: "lapsed" }));
  byName.get("hrm_dispatch_check")!.inputSchema.parse({});
  byName.get("hrm_dispatch_check")!.inputSchema.parse({ employmentId: UUID, subjectKind: "equipment", subjectId: UUID, on: "2026-09-01" });
  assert.throws(() => byName.get("hrm_dispatch_check")!.inputSchema.parse({ subjectKind: "crew" }));
  assert.throws(() => byName.get("hrm_dispatch_check")!.inputSchema.parse({ subjectId: "nope" }));
  assert.throws(() => byName.get("hrm_dispatch_check")!.inputSchema.parse({ on: "tomorrow" }));
  // HR-14 end
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
    "listCycleProgress(",
    "getCycleDetail(",
    "getTurnover(",
    "getRetentionOverview(",
    "listRequisitions(",
    "getRequisitionDetail(",
    "resolveToolRange(",
    "AmbiguousRevisionError(",
    "hrmRefusal(",
    // HR-12 begin
    "listPayBands(",
    "listCycles(",
    "listPlans(",
    "compaRatioFor(",
    "latestGapSnapshot(",
    // HR-12 end
    // HR-14 begin
    "listQualifications(",
    "checkAssignment(",
    // HR-14 end
  ]) {
    assert.ok(tools.includes(service), `tools-hrm.ts must reuse ${service}`);
  }
});

test("no parallel SQL path to versions or requests and no writes", () => {
  assert.doesNotMatch(tools, /from worker_employment_versions/);
  assert.doesNotMatch(tools, /from hrm_leave_requests/);
  assert.doesNotMatch(tools, /from hrm_leave_types/);
  assert.doesNotMatch(tools, /from hrm_leave_policies/);
  assert.doesNotMatch(tools, /from employment_assignment_versions/);
  assert.doesNotMatch(tools, /from hrm_employment_change_requests/);
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
  assert.deepEqual(hrmRefusal(new HrmPerformanceError("REFUSED", "review cycle has no required question")), {
    ok: false,
    error: "review cycle has no required question",
  });
  // HR-14 begin: a computed qualification refusal names the remedy and
  // reaches the caller intact — never a parse error, never silence.
  // (Message quoted verbatim from recordQualification.)
  assert.deepEqual(
    hrmRefusal(new HrmQualificationError('Qualification type "CPSA-1" requires evidence — attach the certificate or license file before recording.')),
    {
      ok: false,
      error: 'Qualification type "CPSA-1" requires evidence — attach the certificate or license file before recording.',
    },
  );
  // HR-14 end
  const missing = new NoRevisionError("2026-06-15", "2026-07-01T00:00:00.000000Z");
  const mapped = hrmRefusal(missing);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.ok === false && mapped.error, missing.message);
  const ambiguous = new AmbiguousRevisionError("2 employments are visible");
  const mappedAmbiguous = hrmRefusal(ambiguous);
  assert.equal(mappedAmbiguous.ok, false);
  assert.equal(mappedAmbiguous.ok === false && mappedAmbiguous.error, ambiguous.message);
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

test("the registry gate admits only each tool's grant holders while its feature is on", () => {
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  // HR-13 begin: construction tools need their full switch path resolved
  // (parent hrm plus the payroll/projects/time-tracking requirements).
  const TOOL_FEATURE_STATE: Record<string, Record<string, boolean>> = {
    hrm_compliance_findings: { hrm: true, payroll: true, projects: true, timeTracking: true, hrmConstructionCompliance: true },
    hrm_certified_payroll: { hrm: true, payroll: true, projects: true, timeTracking: true, hrmConstructionCompliance: true },
    // HR-14 begin: the register needs the hrm → hrmCertifications path;
    // the readiness check needs the full dispatch path (certifications
    // plus the projects/projectScheduling requirements).
    hrm_qualifications: { hrm: true, hrmCertifications: true },
    hrm_dispatch_check: { hrm: true, hrmCertifications: true, projects: true, projectScheduling: true, hrmDispatchGating: true },
    // HR-14 end
  };
  // HR-13 end
  for (const name of TOOL_NAMES) {
    const perm = TOOL_PERMS[name];
    assert.ok(perm, `${name} has a declared permission`);
    const tool = byName.get(name)!;
    // HR-12/HR-13/HR-16 merged: each tool runs under its own full switch
    // path — the explicit per-tool state where declared (construction
    // tools need the payroll/projects/time-tracking requirements),
    // automations_status rides automations, compensation tools add their
    // parent, everything else rides hrm alone.
    const state: Record<string, boolean> = TOOL_FEATURE_STATE[name] ??
      (name === "automations_status"
        ? { automations: true }
        : tool.feature === "hrm"
          ? { hrm: true }
          : { hrm: true, hrmCompensation: true, [tool.feature as string]: true });
    const reader = fakeAuthz(["assistant.use", perm]);
    assert.equal(canRunTool(reader, tool, state), true, `${name} must run for a gated reader`);
    assert.equal(canRunTool(reader, tool, { hrm: false }), false, `${name} must hide while hrm is off`);
    assert.equal(
      canRunTool(reader, tool, { ...state, [tool.feature as string]: false }),
      false,
      `${name} must hide while its own feature is off`,
    );
    assert.equal(
      canRunTool(fakeAuthz(["assistant.use"]), tool, state),
      false,
      `${name} must refuse without ${perm}`,
    );
    assert.equal(
      canRunTool(fakeAuthz([perm]), tool, state),
      false,
      `${name} still requires assistant.use`,
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
    // HR-16 begin: automations_status covers the automations prefixes, not hrm.
    if (name === "automations_status") {
      assert.ok(matrix.includes('prefix: "admin/automations"'), "coverage matrix needs an automations entry");
      assert.ok(matrix.includes('"automations_status"'), "matrix automations entry must cover automations_status");
      continue;
    }
    // HR-16 end
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
