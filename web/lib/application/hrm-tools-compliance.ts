import "server-only";
import { z } from "zod";
import { db } from "@openbooks/engine/platform/db";
import {
  acknowledgeFinding,
  addScheduleLine,
  amendRun,
  approveEntry,
  assignClassification,
  checkDay,
  classify,
  computeForWeek,
  computeTravelForWeek,
  createCompRule,
  dailySplit,
  generate,
  listClassifications,
  listCompClasses,
  listCompRules,
  listEntries,
  listFindings,
  listFormats,
  listPolicies,
  listRuns,
  listScheduleLines,
  listSchedules,
  resolveFinding,
  resolveWage,
  submitRun,
  updateScheduleScope,
  voidEntry,
} from "@openbooks/engine/hrm/construction";
import {
  addScheduleLineBody,
  assignClassificationBody,
  checkDayBody,
  computeWeekBody,
  createCompRuleBody,
  generateCertifiedBody,
  resolveWageBody,
  splitBody,
  updateScheduleScopeBody,
} from "../../app/api/hrm/compliance/bodies";
import {
  describeObjectFields,
  hrmMutation,
  hrmRead,
  HRM_DATE,
  HRM_UUID,
  hrmShortText,
} from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";

const readFilter = (field: string, description: string) => ({
  [field]: hrmShortText(description, 80).optional(),
});
const providerAppliesTo = z
  .object({
    employer_subsidiary_id: HRM_UUID.nullable()
      .optional()
      .describe("Legal subsidiary id included in the schedule scope."),
    department_id: HRM_UUID.nullable().optional().describe("Department id included in the scope."),
    project_ids: z
      .array(HRM_UUID)
      .max(500)
      .nullable()
      .optional()
      .describe("Project ids included in the schedule scope, up to 500."),
    location_ids: z
      .array(HRM_UUID)
      .max(500)
      .nullable()
      .optional()
      .describe("Location ids included in the schedule scope, up to 500."),
  })
  .default({})
  .describe("Effective schedule scope filters.");
const certifiedGenerateInput = describeObjectFields(
  generateCertifiedBody.extend({ projectId: HRM_UUID, weekEnding: HRM_DATE }),
);
const computeInput = describeObjectFields(
  computeWeekBody.extend({ employmentId: HRM_UUID, weekStart: HRM_DATE }),
);
const scheduleLineInput = describeObjectFields(
  addScheduleLineBody.extend({
    scheduleId: HRM_UUID,
    classificationId: HRM_UUID,
    effectiveFrom: HRM_DATE,
    effectiveTo: HRM_DATE.nullable().optional(),
  }),
);
const scheduleScopeInput = describeObjectFields(
  updateScheduleScopeBody.extend({ scheduleId: HRM_UUID, appliesTo: providerAppliesTo }),
);
const wageResolveInput = describeObjectFields(
  resolveWageBody.extend({
    employmentId: HRM_UUID,
    projectId: HRM_UUID.nullable().optional(),
    workedOn: HRM_DATE,
  }),
);
const compRuleInput = describeObjectFields(createCompRuleBody.extend({ compClassId: HRM_UUID }));
const dailySplitInput = describeObjectFields(
  splitBody.extend({ projectId: HRM_UUID, workedOn: HRM_DATE }),
);

export const HRM_COMPLIANCE_TOOLS: ApplicationToolDefinition[] = [
  hrmRead({
    name: "list_certified_payroll_formats",
    title: "List Certified Payroll Formats",
    description:
      "List the labor compliance formats declared by the organization's payroll pack before generating a certified payroll filing. This uses the same native format read as the Compliance workspace.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      formats: await listFormats(db, context.authz.user.orgId, context.authz.user.id),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "list_certified_payroll_runs",
    title: "List Certified Payroll Runs",
    description:
      "List certified payroll filings, optionally scoped to a project, to find run ids for submit or amend actions. Results use the native Compliance run read.",
    input: z.object({
      projectId: HRM_UUID.nullable()
        .optional()
        .describe("Optional project id to filter the run list."),
    }),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      runs: await listRuns(db, context.authz.user.orgId, context.authz.user.id, input.projectId),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "generate_certified_payroll_run",
    title: "Generate Certified Payroll Run",
    description:
      "Freeze a project's wages for a week into a certified payroll filing using a format declared by the installed payroll pack. Find formats with list_certified_payroll_formats and verify the generated run with list_certified_payroll_runs.",
    input: certifiedGenerateInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const run = await generate(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, run, runId: run.id, status: run.status, href: "/hrm/compliance" };
    },
  }),
  hrmMutation({
    name: "submit_certified_payroll_run",
    title: "Submit Certified Payroll Run",
    description:
      "Submit a generated certified payroll run to the declared filing state. Read the run with list_certified_payroll_runs first; the native service refuses runs outside scope or in the wrong state.",
    input: z.object({
      runId: HRM_UUID.describe("Generated run id from list_certified_payroll_runs."),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const run = await submitRun(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        runId: input.runId,
      });
      return { ok: true, run, runId: run.id, status: run.status, href: "/hrm/compliance" };
    },
  }),
  hrmMutation({
    name: "amend_certified_payroll_run",
    title: "Amend Certified Payroll Run",
    description:
      "Create an amended filing from a submitted certified payroll run while preserving the original filing. Read the run with list_certified_payroll_runs first and verify the amended run there.",
    input: z.object({
      runId: HRM_UUID.describe("Submitted run id from list_certified_payroll_runs."),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const run = await amendRun(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        runId: input.runId,
      });
      return { ok: true, run, runId: run.id, status: run.status, href: "/hrm/compliance" };
    },
  }),
  hrmRead({
    name: "list_work_compensation_classes",
    title: "List Workers Compensation Classes",
    description:
      "List active workers compensation classes used by construction compliance and find their ids for classification rules. Results use the native Comp Classes read.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      classes: await listCompClasses(db, context.authz.user.orgId, context.authz.user.id),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "list_work_compensation_rules",
    title: "List Workers Compensation Rules",
    description:
      "List active workers compensation match rules and their priorities before adding a rule. This is the native Compliance rule read.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      rules: await listCompRules(db, context.authz.user.orgId, context.authz.user.id),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "create_work_compensation_rule",
    title: "Create Workers Compensation Rule",
    description:
      "Add a priority-matched workers compensation rule that maps payroll facts to an existing class. Read classes and rules first with list_work_compensation_classes and list_work_compensation_rules.",
    input: compRuleInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const rule = await createCompRule(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
        match: input.match as never,
      });
      return { ok: true, rule, href: "/hrm/compliance" };
    },
  }),
  hrmRead({
    name: "classify_workers_compensation_day",
    title: "Classify Workers Compensation Day",
    description:
      "Resolve the workers compensation class for a project's work date without writing a record. Use list_work_compensation_classes and the project read to find ids; this calculation shares the native Compliance endpoint's manage permission.",
    input: dailySplitInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      compClass: await classify(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      }),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "preview_workers_compensation_daily_split",
    title: "Preview Workers Compensation Daily Split",
    description:
      "Calculate the native workers compensation split for a project's work date without recording payroll. Find project ids in the native Projects read; results use the Compliance calculation.",
    input: dailySplitInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      split: await dailySplit(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      }),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "list_construction_work_classifications",
    title: "List Construction Work Classifications",
    description:
      "List work classifications, including apprenticeship relationships, to find classification ids for employment assignments. Results use the native construction classification read.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      classifications: await listClassifications(
        db,
        context.authz.user.orgId,
        context.authz.user.id,
      ),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "assign_employment_construction_classification",
    title: "Assign Employment Construction Classification",
    description:
      "Assign a construction classification and optional home rate schedule to an employment from an effective date. Read the employment and classification with hrm_employment_as_of and list_construction_work_classifications first.",
    input: describeObjectFields(
      assignClassificationBody.extend({
        employmentId: HRM_UUID,
        classificationId: HRM_UUID,
        effectiveFrom: HRM_DATE,
        homeScheduleId: HRM_UUID.nullable().optional(),
      }),
    ),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const assignment = await assignClassification(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        assignment,
        employmentId: assignment.employmentId,
        href: "/hrm/compliance",
      };
    },
  }),
  hrmRead({
    name: "list_construction_rate_schedules",
    title: "List Construction Rate Schedules",
    description:
      "List prevailing wage, union and organization-declared rate schedules to find schedule ids. Results use the native Compliance schedule read and apply the caller's subsidiary scope.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      schedules: await listSchedules(db, context.authz.user.orgId, context.authz.user.id),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "get_construction_rate_schedule",
    title: "Get Construction Rate Schedule",
    description:
      "Read a rate schedule and its effective-dated lines before changing scope or adding a line. Find schedule ids with list_construction_rate_schedules; the result uses the native schedule editor read.",
    input: z.object({
      scheduleId: HRM_UUID.describe("Schedule id from list_construction_rate_schedules."),
    }),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      schedule: await listScheduleLines(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        scheduleId: input.scheduleId,
      }),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "update_construction_rate_schedule_scope",
    title: "Update Construction Rate Schedule Scope",
    description:
      "Change the declared subsidiaries, departments, projects or locations covered by a rate schedule. Read the schedule with get_construction_rate_schedule first; the native service enforces organization and subsidiary scope.",
    input: scheduleScopeInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const schedule = await updateScheduleScope(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        scheduleId: input.scheduleId,
        appliesTo: input.appliesTo ?? {},
      });
      return { ok: true, schedule, scheduleId: input.scheduleId, href: "/hrm/compliance" };
    },
  }),
  hrmMutation({
    name: "add_construction_rate_schedule_line",
    title: "Add Construction Rate Schedule Line",
    description:
      "Add effective-dated exact-decimal wage and fringe rates for a classification on a schedule. Read the schedule and construction classifications first; verify the new line with get_construction_rate_schedule.",
    input: scheduleLineInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const lineId = await addScheduleLine(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, lineId, scheduleId: input.scheduleId, href: "/hrm/compliance" };
    },
  }),
  hrmRead({
    name: "resolve_construction_wage",
    title: "Resolve Construction Wage",
    description:
      "Resolve the effective wage schedule for an employment and work date without recording a payroll transaction. Find ids with hrm_employment_as_of and the native Projects read; the calculation enforces construction scope.",
    input: wageResolveInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      wage: await resolveWage(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        projectId: input.projectId ?? null,
        workedOn: input.workedOn,
      }),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "list_per_diem_policies",
    title: "List Per Diem Policies",
    description:
      "List effective-dated organization per diem policies before computing an allowance week. Results use the native Compliance policy read.",
    input: z.object({}),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context) => ({
      policies: await listPolicies(db, context.authz.user.orgId, context.authz.user.id),
      href: "/hrm/compliance",
    }),
  }),
  hrmRead({
    name: "list_per_diem_entries",
    title: "List Per Diem Entries",
    description:
      "List per diem and travel allowance entries, optionally filtered by status, to find entry ids for approval or void. The native read restricts results to the caller's subsidiary scope.",
    input: z.object(readFilter("status", "Entry status to filter by.")),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      entries: await listEntries(db, context.authz.user.orgId, context.authz.user.id, input.status),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "compute_per_diem_week",
    title: "Compute Per Diem Week",
    description:
      "Compute per diem or travel entries for an employment week using the effective native policy. Find the employment with hrm_employment_as_of and verify generated entries with list_per_diem_entries.",
    input: computeInput,
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const entries =
        input.kind === "travel"
          ? await computeTravelForWeek(db, {
              orgId: context.authz.user.orgId,
              actorId: context.authz.user.id,
              employmentId: input.employmentId,
              weekStart: input.weekStart,
              mode: input.travelMode ?? "hourly",
            })
          : await computeForWeek(db, {
              orgId: context.authz.user.orgId,
              actorId: context.authz.user.id,
              employmentId: input.employmentId,
              weekStart: input.weekStart,
            });
      return { ok: true, entries, href: "/hrm/compliance" };
    },
  }),
  hrmMutation({
    name: "approve_per_diem_entry",
    title: "Approve Per Diem Entry",
    description:
      "Approve a generated per diem or travel entry so payroll can consume it. Find the entry with list_per_diem_entries and verify its new status through the same read.",
    input: z.object({
      entryId: HRM_UUID.describe("Entry id from list_per_diem_entries."),
      kind: z.enum(["per_diem", "travel"]).describe("Entry kind from the native entry read."),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const entry = await approveEntry(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        entryId: input.entryId,
        kind: input.kind,
      });
      return {
        ok: true,
        entry,
        entryId: input.entryId,
        status: entry.status,
        href: "/hrm/compliance",
      };
    },
  }),
  hrmMutation({
    name: "void_per_diem_entry",
    title: "Void Per Diem Entry",
    description:
      "Void an unconsumed per diem or travel entry with an audit reason. Read the entry with list_per_diem_entries first; committed payroll consumption may make it immutable.",
    input: z.object({
      entryId: HRM_UUID.describe("Entry id from list_per_diem_entries."),
      kind: z.enum(["per_diem", "travel"]).describe("Entry kind from the native entry read."),
      reason: hrmShortText("Reason for voiding the entry.", 2000).optional(),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    destructive: true,
    execute: async (context, input) => {
      const entry = await voidEntry(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        entryId: input.entryId,
        kind: input.kind,
        reason: input.reason ?? "voided from the Compliance page",
      });
      return {
        ok: true,
        entry,
        entryId: input.entryId,
        status: entry.status,
        href: "/hrm/compliance",
      };
    },
  }),
  hrmRead({
    name: "list_hr_compliance_findings",
    title: "List HR Compliance Findings",
    description:
      "List construction compliance findings, optionally by status, to find findings for acknowledgment or resolution. Results use the native Compliance findings read.",
    input: z.object(readFilter("status", "Finding status to filter by.")),
    permission: "hrm.construction.read",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      findings: await listFindings(
        db,
        context.authz.user.orgId,
        context.authz.user.id,
        input.status,
      ),
      href: "/hrm/compliance",
    }),
  }),
  hrmMutation({
    name: "acknowledge_hr_compliance_finding",
    title: "Acknowledge HR Compliance Finding",
    description:
      "Acknowledge an open construction compliance finding to record that it has been reviewed. Find the finding with list_hr_compliance_findings; resolution remains a separate audited action.",
    input: z.object({
      findingId: HRM_UUID.describe("Finding id from list_hr_compliance_findings."),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const finding = await acknowledgeFinding(
        db,
        context.authz.user.orgId,
        context.authz.user.id,
        input.findingId,
      );
      return {
        ok: true,
        finding,
        findingId: input.findingId,
        status: finding.status,
        href: "/hrm/compliance",
      };
    },
  }),
  hrmMutation({
    name: "resolve_hr_compliance_finding",
    title: "Resolve HR Compliance Finding",
    description:
      "Resolve a construction compliance finding with a reason recorded in history. Read the finding with list_hr_compliance_findings first; the native service refuses a finding that cannot be resolved.",
    input: z.object({
      findingId: HRM_UUID.describe("Finding id from list_hr_compliance_findings."),
      reason: hrmShortText("Reason for resolving the finding.", 2000).optional(),
    }),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => {
      const finding = await resolveFinding(
        db,
        context.authz.user.orgId,
        context.authz.user.id,
        input.findingId,
        input.reason ?? "resolved from the Compliance page",
      );
      return {
        ok: true,
        finding,
        findingId: input.findingId,
        status: finding.status,
        href: "/hrm/compliance",
      };
    },
  }),
  hrmRead({
    name: "check_apprentice_ratio_day",
    title: "Check Apprentice Ratio Day",
    description:
      "Calculate apprentice ratio compliance for a project's work date without changing records. Find project ids in the native Projects read; this shares the native construction manage permission and feature gate.",
    input: describeObjectFields(checkDayBody.extend({ projectId: HRM_UUID, workedOn: HRM_DATE })),
    permission: "hrm.construction.manage",
    featureKey: "hrmConstructionCompliance",
    execute: async (context, input) => ({
      results: await checkDay(db, {
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      }),
      href: "/hrm/compliance",
    }),
  }),
];
