import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

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
const { EmploymentReadError } = await import("@openbooks/engine/src/hrm/employment-read.ts");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");
const { AmbiguousRevisionError, NoRevisionError } = await import("@openbooks/engine/src/hrm/temporal.ts");
const { HrmPerformanceError } = await import("@openbooks/engine/src/hrm/performance/errors.ts");
const { HrmQualificationError } = await import("@openbooks/engine/src/hrm/qualifications/errors.ts");
const { HrmDocumentsError } = await import("@openbooks/engine/src/hrm/documents/errors.ts");
const { CompensationError } = await import("@openbooks/engine/src/hrm/compensation/errors.ts");

const UUID = "11111111-1111-4111-8111-111111111111";

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
  // HR-19 begin: documents filter to a declared status/category; results
  // half-address to the survey id (addressing is runtime-enforced);
  // the chart half-addresses to asOf/search. Genuinely invalid values
  // throw; a missing survey id throws (the read cannot run without it).
  byName.get("hrm_documents")!.inputSchema.parse({});
  byName.get("hrm_documents")!.inputSchema.parse({ status: "signed", categoryKey: "contract" });
  assert.throws(() => byName.get("hrm_documents")!.inputSchema.parse({ status: "archived" }));
  byName.get("hrm_survey_results")!.inputSchema.parse({ surveyId: UUID });
  assert.throws(() => byName.get("hrm_survey_results")!.inputSchema.parse({}));
  assert.throws(() => byName.get("hrm_survey_results")!.inputSchema.parse({ surveyId: "nope" }));
  byName.get("hrm_org_chart")!.inputSchema.parse({});
  byName.get("hrm_org_chart")!.inputSchema.parse({ asOf: "2026-09-01", search: "Eng" });
  assert.throws(() => byName.get("hrm_org_chart")!.inputSchema.parse({ asOf: "tomorrow" }));
  // HR-19 end
  // HR-17 begin: continuous tools parse minimal inputs; genuinely invalid values throw.
  byName.get("hrm_one_on_ones")!.inputSchema.parse({});
  byName.get("hrm_one_on_ones")!.inputSchema.parse({ employmentId: UUID });
  byName.get("hrm_one_on_ones")!.inputSchema.parse({ status: "held", limit: 10 });
  assert.throws(() => byName.get("hrm_one_on_ones")!.inputSchema.parse({ status: "archived" }));
  assert.throws(() => byName.get("hrm_one_on_ones")!.inputSchema.parse({ employmentId: "nope" }));
  assert.throws(() => byName.get("hrm_one_on_ones")!.inputSchema.parse({ limit: 0 }));
  byName.get("hrm_feedback")!.inputSchema.parse({});
  byName.get("hrm_feedback")!.inputSchema.parse({ subjectEmploymentId: UUID });
  byName.get("hrm_feedback")!.inputSchema.parse({ kind: "praise", limit: 10 });
  assert.throws(() => byName.get("hrm_feedback")!.inputSchema.parse({ kind: "rumor" }));
  assert.throws(() => byName.get("hrm_feedback")!.inputSchema.parse({ limit: 0 }));
  byName.get("hrm_calibration")!.inputSchema.parse({});
  byName.get("hrm_calibration")!.inputSchema.parse({ sessionId: UUID });
  byName.get("hrm_calibration")!.inputSchema.parse({ cycleId: UUID });
  assert.throws(() => byName.get("hrm_calibration")!.inputSchema.parse({ sessionId: "nope" }));
  // HR-17 end
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
  // HR-19 begin: a computed documents refusal (undeclared category)
  // reaches the caller intact — never a parse error, never silence.
  assert.deepEqual(
    hrmRefusal(new HrmDocumentsError("VALIDATION", 'category "offer" is not declared — declare it under Setup → Workforce → Document Categories first')),
    {
      ok: false,
      error: 'category "offer" is not declared — declare it under Setup → Workforce → Document Categories first',
    },
  );
  // HR-19 end
  // F15 begin: the placement gate's refusals (uniform not-found for
  // unknown/foreign/hidden employments, the named-remedy refusal for
  // grant-less callers) reach the assistant caller with their message
  // intact — never empty results, never a throw.
  assert.deepEqual(hrmRefusal(new CompensationError("NOT_FOUND", "employment is not visible in this organization")), {
    ok: false,
    error: "employment is not visible in this organization",
  });
  assert.deepEqual(
    hrmRefusal(
      new CompensationError(
        "REFUSED",
        "band placement for another employment requires the hrm.compensation.read permission — ask an administrator to grant it in /admin/roles, or read your own placement under /me/compensation",
      ),
    ),
    {
      ok: false,
      error:
        "band placement for another employment requires the hrm.compensation.read permission — ask an administrator to grant it in /admin/roles, or read your own placement under /me/compensation",
    },
  );
  // F15 end
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

// HR-18 begin: recruiting depth reads ride hrm_recruiting (names and
// states only, never PII), each refusing by name while its sub-switch is
// off, through the canonical depth services — never parallel SQL.
test("hrm_recruiting depth inputs accept valid IDs and reject malformed IDs", () => {
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  const recruiting = byName.get("hrm_recruiting")!;
  recruiting.inputSchema.parse({ interviewId: UUID });
  recruiting.inputSchema.parse({ offerId: UUID });
  recruiting.inputSchema.parse({ requisitionId: UUID, includePostings: true });
  assert.throws(() => recruiting.inputSchema.parse({ interviewId: "nope" }));
  assert.throws(() => recruiting.inputSchema.parse({ offerId: "nope" }));

});
// HR-18 end
test("HR-21 tool inputs parse; refusals stay tool errors, never throws", () => {
  const byName = new Map(HRM_TOOLS.map((tool) => [tool.name, tool] as const));
  byName.get("hrm_explain_pay")!.inputSchema.parse({ employmentId: UUID });
  byName.get("payroll_anomalies")!.inputSchema.parse({ action: "list", status: "open" });
  assert.throws(() => byName.get("payroll_anomalies")!.inputSchema.parse({ action: "levitate" }));
  byName.get("ai_draft")!.inputSchema.parse({ kind: "review_self", subjectId: UUID });
  assert.throws(() => byName.get("ai_draft")!.inputSchema.parse({ kind: "sonnet", subjectId: UUID }));
  byName.get("nl_report")!.inputSchema.parse({
    action: "preview",
    question: "total net pay by month",
    definitionJson: '{"entity":"x","columns":[]}',
  });
});
// HR-21 end
