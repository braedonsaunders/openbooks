import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "@openbooks/engine/platform/db";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { CLOSE_MODULES, CloseError } from "@openbooks/engine/periods/period-policy";
import { generateAccountingPeriods } from "@openbooks/engine/close/calendar";
import { isValidEmailAddress } from "@openbooks/emails";
import { isUuid } from "../list-params";
import { canonicalDecimal } from "../exact-decimal";
import { moneyRefusal } from "../payroll-decimal-refusal";

const closeObject = z.record(z.string(), z.json());
export function validateClosePolicy(
  body: { policyType: string; rules?: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  if (body.policyType !== "materiality") return;
  const amount = body.rules?.amount;
  if (typeof amount !== "string") {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "amount"],
      message: "Materiality amount must be a decimal string",
    });
  } else if (canonicalDecimal(amount, 4) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "amount"],
      message: moneyRefusal("Materiality threshold", amount),
    });
  }
  const percent = body.rules?.percent;
  if (
    percent !== undefined &&
    (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["rules", "percent"],
      message: "Materiality percent must be between 0 and 100",
    });
  }
}

const closePolicyFields = z.object({
  action: z.literal("save-policy").describe("Save a close policy."),
  code: z.string().trim().min(1).max(100).describe("Stable policy code."),
  name: z.string().trim().min(1).max(200).describe("Policy display name."),
  policyType: z.enum(["materiality", "lock", "evidence", "exception"]).describe("Policy category."),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Policy description, or null to clear."),
  rules: closeObject.optional().describe("Category-specific policy rules."),
  isActive: z.boolean().optional().describe("Whether the policy can apply to new close runs."),
});
const closePolicySchema = closePolicyFields.superRefine(validateClosePolicy);

export function validateCloseAutomation(
  body: { config?: Record<string, unknown> },
  ctx: z.RefinementCtx,
) {
  for (const key of ["reviewerUserId", "reviewerRoleKey"])
    if (Object.hasOwn(body.config ?? {}, key))
      ctx.addIssue({
        code: "custom",
        path: ["config", key],
        message:
          "Configure close task approvals in Flows; assignment rules only choose the preparation owner.",
      });
}
const closeAutomationFields = z.object({
  action: z.literal("save-automation").describe("Create or update a close automation rule."),
  id: uuidString()
    .optional()
    .describe("Existing automation id from list_close_setup_configuration."),
  name: z.string().trim().min(1).max(200).describe("Automation rule name."),
  trigger: z
    .enum(["run_started", "task_ready", "exception_opened", "deadline_approaching", "run_closed"])
    .describe("Event that triggers this rule."),
  automationAction: z
    .enum([
      "notify",
      "assign",
      "run_check",
      "complete_task",
      "create_task",
      "generate_report",
      "start_flow",
      "run_allocation",
    ])
    .describe("Action performed when the rule triggers."),
  conditions: closeObject.optional().describe("Conditions that must match before the action runs."),
  config: closeObject.optional().describe("Action-specific configuration."),
  isActive: z.boolean().optional().describe("Whether the automation runs."),
});
const closeAutomationSchema = closeAutomationFields.superRefine(validateCloseAutomation);
const closeStepSchema = z.strictObject({
  key: z.string().trim().min(1).max(100).describe("Unique lowercase key for this step."),
  title: z.string().trim().min(1).max(200).describe("Step title shown in the close run."),
  workstream: z
    .enum([
      "readiness",
      "banking",
      "sales",
      "ar",
      "ap",
      "assets",
      "tax",
      "payroll",
      "intercompany",
      "gl",
      "review",
      "publish",
    ])
    .describe("Close workstream that owns this step."),
  taskType: z
    .enum(["check", "action", "reconciliation", "journal", "approval", "report", "publish"])
    .optional()
    .describe("Optional task kind for this step."),
  completionMode: z
    .enum(["manual", "computed", "automatic"])
    .optional()
    .describe("How the step becomes complete."),
  gateType: z.enum(["none", "soft", "hard"]).optional().describe("Whether the step blocks close."),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Step instructions, or null to clear."),
  dueOffsetBusinessDays: z
    .number()
    .int()
    .optional()
    .describe("Business days from period end for the due date."),
  evidenceRequired: z.boolean().optional().describe("Whether completion requires evidence."),
  defaultOwnerRoleKey: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Default role key for task ownership."),
  applicability: closeObject
    .optional()
    .describe("Conditions that determine whether this step applies."),
  dependsOn: z
    .array(z.string().max(100))
    .max(200)
    .optional()
    .describe("Step keys that must complete first."),
});
const closeActionSchemas = [
  z.object({
    action: z.literal("save-calendar").describe("Create or update a fiscal calendar."),
    id: uuidString()
      .optional()
      .describe("Existing calendar id from list_close_setup_configuration."),
    name: z.string().trim().min(1).max(200).describe("Fiscal calendar name."),
    cadence: z
      .enum([
        "monthly",
        "four_four_five",
        "four_five_four",
        "five_four_four",
        "thirteen_period",
        "custom",
      ])
      .describe("Fiscal calendar cadence."),
    yearStartMonth: z
      .number()
      .int()
      .min(1)
      .max(12)
      .describe("Month in which the fiscal year starts."),
    weekStartsOn: z
      .number()
      .int()
      .min(0)
      .max(6)
      .optional()
      .describe("Week start day: Sunday 0 through Saturday 6."),
    anchorDate: z
      .string()
      .refine(isIsoCalendarDate)
      .nullable()
      .optional()
      .describe("Anchor date for week-based periods."),
    timeZone: z.string().max(100).optional().describe("IANA time zone used for calendar dates."),
    adjustmentPeriodEnabled: z
      .boolean()
      .optional()
      .describe("Whether to create an adjustment period."),
    isDefault: z.boolean().optional().describe("Whether this is the posting default calendar."),
    isActive: z.boolean().optional().describe("Whether the calendar can be used for new periods."),
    config: closeObject.optional().describe("Calendar-specific configuration."),
  }),
  z.object({
    action: z.literal("generate-periods").describe("Generate accounting periods."),
    calendarId: uuidString().describe("Fiscal calendar id from list_close_setup_configuration."),
    fiscalYear: z.number().int().min(1900).max(2200).describe("Fiscal year to generate."),
  }),
  z.object({
    action: z.literal("save-blueprint").describe("Create or update a close blueprint."),
    id: uuidString()
      .optional()
      .describe("Existing blueprint id from list_close_setup_configuration."),
    name: z.string().trim().min(1).max(200).describe("Blueprint name."),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Blueprint description, or null to clear."),
    periodType: z
      .enum(["month", "quarter", "year", "adjustment", "any"])
      .optional()
      .describe("Period types for which the blueprint applies."),
    steps: z.array(closeStepSchema).min(1).max(200).describe("Close tasks and their dependencies."),
    isDefault: z.boolean().optional().describe("Whether this is the default blueprint."),
  }),
  closePolicySchema,
  closeAutomationSchema,
  z.object({
    action: z.literal("save-package").describe("Create or update a close reporting package."),
    id: uuidString()
      .optional()
      .describe("Existing package id from list_close_setup_configuration."),
    name: z.string().trim().min(1).max(200).describe("Reporting package name."),
    description: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe("Package description, or null to clear."),
    reports: z
      .array(
        z
          .record(z.string(), z.json())
          .refine(
            (report) => typeof report.slug === "string" && report.slug.trim().length > 0,
            "report slug is required",
          ),
      )
      .min(1)
      .max(100)
      .describe("Reports included in the package; each report must have a slug."),
    recipients: z
      .array(z.string().trim().min(1).max(320))
      .max(100)
      .optional()
      .describe("Email addresses that receive the package."),
    delivery: closeObject.optional().describe("Delivery schedule and format settings."),
    isDefault: z.boolean().optional().describe("Whether this is the default reporting package."),
    isActive: z.boolean().optional().describe("Whether this package is available for close runs."),
  }),
  z.object({
    action: z.literal("send-package").describe("Queue delivery of a close reporting package."),
    packageId: uuidString().describe("Reporting package id from list_close_setup_configuration."),
    periodId: uuidString().describe("Accounting period id from the accounting period read."),
    bookId: uuidString().describe("Accounting book id from the accounting books read."),
    idempotencyKey: uuidString().describe("Unique retry key for this exact package delivery."),
  }),
  z.object({
    action: z.literal("set-lock").describe("Change one period module's lock state."),
    periodId: uuidString().describe("Accounting period id."),
    bookId: uuidString().describe("Accounting book id."),
    subsidiaryId: uuidString()
      .nullable()
      .optional()
      .describe("Legal entity id, or null for the organization-wide lock."),
    module: z.enum(CLOSE_MODULES).describe("Accounting module whose lock is changing."),
    state: z.enum(["open", "soft_closed", "closed"]).describe("New lock state."),
    reason: z.string().trim().min(1).max(2000).describe("Audit reason for the lock change."),
    bankingAcknowledgement: z
      .string()
      .max(2000)
      .optional()
      .describe("Acknowledgement for unresolved banking-close issues."),
  }),
  z.object({
    action: z.literal("close-period").describe("Close selected accounting period modules."),
    periodId: uuidString().describe("Accounting period id."),
    bookId: uuidString().describe("Accounting book id."),
    subsidiaryId: uuidString()
      .nullable()
      .optional()
      .describe("Legal entity id, or null for the organization-wide lock."),
    state: z
      .enum(["soft_closed", "closed"])
      .optional()
      .default("closed")
      .describe("Lock state applied to the selected modules."),
    modules: z
      .array(z.enum(CLOSE_MODULES))
      .min(1)
      .max(CLOSE_MODULES.length)
      .optional()
      .describe("Modules to close; omitted selects every module."),
    moduleReasons: z
      .record(z.enum(CLOSE_MODULES), z.string())
      .optional()
      .describe("Optional module-specific audit reasons."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("Audit reason for closing the period modules."),
    bankingAcknowledgement: z
      .string()
      .max(2000)
      .optional()
      .describe("Acknowledgement for unresolved banking-close issues."),
  }),
  z.object({
    action: z.literal("banking-close-status").describe("Read banking close readiness."),
    periodId: uuidString().describe("Accounting period id."),
    bookId: uuidString().describe("Accounting book id."),
    subsidiaryId: uuidString()
      .nullable()
      .optional()
      .describe("Legal entity id, or null for organization-wide status."),
  }),
  z.object({
    action: z.literal("request-reopen").describe("Request a governed period reopen."),
    periodId: uuidString().describe("Accounting period id."),
    bookId: uuidString().describe("Accounting book id."),
    subsidiaryId: uuidString()
      .nullable()
      .optional()
      .describe("Legal entity id, or null for the organization-wide period."),
    modules: z
      .array(z.enum(CLOSE_MODULES))
      .min(1)
      .max(CLOSE_MODULES.length)
      .describe("Modules requested for reopening."),
    reason: z.string().trim().min(1).max(2000).describe("Reason for the reopen request."),
    hours: z.number().int().positive().optional().describe("Requested reopen window in hours."),
  }),
  z.object({
    action: z.literal("submit-reopen").describe("Submit a period reopen request for approval."),
    requestId: uuidString().describe("Reopen request id from the close setup read."),
    hours: z.number().int().positive().optional().describe("Approved reopen window in hours."),
  }),
  z.object({
    action: z.literal("withdraw-reopen").describe("Withdraw a pending period reopen request."),
    requestId: uuidString().describe("Reopen request id from the close setup read."),
    reason: z.string().trim().min(10).max(500).describe("Reason for withdrawing the request."),
  }),
  z.object({
    action: z.literal("extend-reopen").describe("Extend an approved period reopen window."),
    requestId: uuidString().describe("Reopen request id from the close setup read."),
    additionalHours: z
      .number()
      .int()
      .min(0)
      .max(168)
      .optional()
      .describe("Additional hours, up to 168."),
    addModules: z
      .array(z.enum(CLOSE_MODULES))
      .max(CLOSE_MODULES.length)
      .optional()
      .describe("Additional modules to reopen."),
    reason: z.string().trim().min(1).max(500).describe("Reason for extending the reopen request."),
  }),
  z.object({
    action: z
      .literal("reclose-reopen")
      .describe("Reclose a period with an approved reopen request."),
    requestId: uuidString().describe("Reopen request id from the close setup read."),
    reason: z.string().trim().min(1).max(500).describe("Reason for reclosing the period."),
  }),
] as const;
export const requestBodySchema = z.discriminatedUnion("action", closeActionSchemas);
export type Body = Record<string, unknown>;

const CADENCES = new Set([
  "monthly",
  "four_four_five",
  "four_five_four",
  "five_four_four",
  "thirteen_period",
  "custom",
]);
const WORKSTREAMS = new Set([
  "readiness",
  "banking",
  "ar",
  "ap",
  "assets",
  "tax",
  "payroll",
  "intercompany",
  "gl",
  "review",
  "publish",
]);
const TASK_TYPES = new Set([
  "check",
  "action",
  "reconciliation",
  "journal",
  "approval",
  "report",
  "publish",
]);
const COMPLETION_MODES = new Set(["manual", "computed", "automatic"]);
const GATE_TYPES = new Set(["none", "soft", "hard"]);

/** A trimmed string field of a close settings body; required fields refuse when blank. */
export function text(body: Body, key: string, required = false): string | null {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  if (required && !value) throw new CloseError(`${key} is required`);
  return value || null;
}

function bool(body: Body, key: string): boolean {
  return body[key] === true;
}

/**
 * The active flag defaults on when omitted, but an explicitly supplied
 * value must be a real boolean: `!== false` coercion would otherwise let
 * isActive: "false" (or 0) silently ACTIVATE the row with a 200 — a live
 * automation or reporting package the admin tried to switch off keeps
 * running. Same boolean-flag contract as the admin setup PATCH routes.
 */
function optionalActive(body: Body): boolean {
  if (body.isActive === undefined) return true;
  if (typeof body.isActive !== "boolean") throw new CloseError("isActive must be a boolean");
  return body.isActive;
}

function optionalUuid(body: Body, key: string, label: string): string | undefined {
  if (body[key] === undefined) return undefined;
  if (typeof body[key] !== "string" || !isUuid(body[key])) {
    throw new CloseError(`invalid ${label} id`);
  }
  return body[key];
}

function object(body: Body, key: string): Record<string, unknown> {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateDependencies(steps: Array<{ key: string; dependsOn: string[] }>) {
  const keys = new Set(steps.map((step) => step.key));
  if (keys.size !== steps.length) throw new CloseError("blueprint step keys must be unique");
  const graph = new Map(steps.map((step) => [step.key, step.dependsOn]));
  for (const step of steps) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.key))
      throw new CloseError(`invalid step key: ${step.key}`);
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency))
        throw new CloseError(`${step.key} depends on unknown step ${dependency}`);
      if (dependency === step.key) throw new CloseError(`${step.key} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new CloseError(`blueprint contains a dependency cycle at ${key}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  }
  for (const key of keys) visit(key);
}

export async function saveCalendar(orgId: string, actorId: string, body: Body) {
  const id = optionalUuid(body, "id", "calendar");
  const isActive = optionalActive(body);
  const name = text(body, "name", true)!;
  const cadence = text(body, "cadence", true)!;
  if (!CADENCES.has(cadence)) throw new CloseError("invalid calendar cadence");
  const yearStartMonth = Number(body.yearStartMonth);
  const weekStartsOn = Number(body.weekStartsOn ?? 1);
  if (!Number.isInteger(yearStartMonth) || yearStartMonth < 1 || yearStartMonth > 12)
    throw new CloseError("yearStartMonth must be 1–12");
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 0 || weekStartsOn > 6)
    throw new CloseError("weekStartsOn must be 0–6");
  const anchorDate = text(body, "anchorDate");
  if (cadence !== "monthly" && cadence !== "custom" && !anchorDate)
    throw new CloseError("week-based calendars require an anchor date");
  const isDefault = bool(body, "isDefault");
  return db.transaction(async (tx) => {
    // Serialize concurrent calendar saves: two admins swapping the default
    // (or deactivating it) at once could each pass the stranded-periods
    // guard below and commit an org with periods but no active default.
    await tx.execute(sql`select id from fiscal_calendars where org_id = ${orgId} for update`);
    let before: Record<string, unknown> | null = null;
    let savedId: string;
    if (id) {
      const current = await tx.execute(
        sql`
        select c.*, exists(select 1 from accounting_periods p where p.fiscal_calendar_id = c.id and p.org_id = ${orgId}) as has_periods
          from fiscal_calendars c where c.id = ${id} and c.org_id = ${orgId} for update`,
        "objects",
      );
      const row = current[0];
      if (!row) throw new CloseError("calendar not found");
      before = row as Record<string, unknown>;
      if (
        row.has_periods &&
        (row.cadence !== cadence ||
          row.year_start_month !== yearStartMonth ||
          row.anchor_date !== anchorDate)
      ) {
        throw new CloseError(
          "a calendar with generated periods cannot change cadence, year start, or anchor; create a new calendar",
        );
      }
    }
    if (isDefault)
      await tx.execute(
        sql`update fiscal_calendars set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    if (id) {
      const updated = await tx.execute<Record<string, unknown>>(
        sql`
        update fiscal_calendars set name = ${name}, cadence = ${cadence}, year_start_month = ${yearStartMonth},
               week_starts_on = ${weekStartsOn}, anchor_date = ${anchorDate},
               time_zone = ${text(body, "timeZone") ?? "UTC"},
               adjustment_period_enabled = ${bool(body, "adjustmentPeriodEnabled")},
               is_default = ${isDefault}, is_active = ${isActive},
               config = ${JSON.stringify(object(body, "config"))}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where id = ${id} and org_id = ${orgId}
         returning *`,
        "objects",
      );
      const after = updated[0];
      if (!after) throw new CloseError("calendar not found");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fiscal_calendars', ${id}, 'update',
                ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
      savedId = id;
    } else {
      const inserted = await tx.execute<Record<string, unknown>>(
        sql`
        insert into fiscal_calendars
          (org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone,
           adjustment_period_enabled, is_default, is_active, config, created_by, updated_by)
        values (${orgId}, ${name}, ${cadence}, ${yearStartMonth}, ${weekStartsOn}, ${anchorDate},
                ${text(body, "timeZone") ?? "UTC"}, ${bool(body, "adjustmentPeriodEnabled")},
                ${isDefault}, ${isActive}, ${JSON.stringify(object(body, "config"))}::jsonb,
                ${actorId}, ${actorId}) returning *`,
        "objects",
      );
      const after = inserted[0];
      if (!after) throw new CloseError("calendar could not be created");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fiscal_calendars', ${after.id}, 'insert',
                ${JSON.stringify({ before: null, after })}::jsonb, ${actorId})`);
      savedId = after.id as string;
    }
    // Date-derived posting resolution reads the org's ACTIVE DEFAULT
    // calendar, so an org left with periods but no active default would
    // have every posting refused. Fail this save (rolling it back) and
    // name the fix: saving one ACTIVE calendar with the default flag on
    // performs the swap atomically through this same endpoint.
    const guard = await tx.execute<{ has_periods: boolean; has_default: boolean }>(
      sql`
      select exists(select 1 from accounting_periods where org_id = ${orgId}) as has_periods,
             exists(select 1 from fiscal_calendars
                     where org_id = ${orgId} and is_default and is_active) as has_default`,
      "objects",
    );
    if (guard[0]?.has_periods && !guard[0]?.has_default) {
      throw new CloseError(
        "this change would leave the organization with periods but no active default fiscal calendar, and new postings would be refused; save one active calendar with the default flag switched on first",
      );
    }
    return savedId;
  });
}

export async function saveBlueprint(orgId: string, actorId: string, body: Body) {
  const sourceId = optionalUuid(body, "id", "blueprint");
  const name = text(body, "name", true)!;
  const description = text(body, "description");
  const periodType = text(body, "periodType") ?? "any";
  if (!["month", "quarter", "year", "adjustment", "any"].includes(periodType))
    throw new CloseError("invalid period type");
  if (!Array.isArray(body.steps) || body.steps.length === 0)
    throw new CloseError("a blueprint needs at least one step");
  const steps = body.steps.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CloseError(`step ${index + 1} is invalid`);
    const step = value as Record<string, unknown>;
    const key = typeof step.key === "string" ? step.key.trim() : "";
    const title = typeof step.title === "string" ? step.title.trim() : "";
    const workstream = typeof step.workstream === "string" ? step.workstream : "";
    const taskType = typeof step.taskType === "string" ? step.taskType : "action";
    const completionMode = typeof step.completionMode === "string" ? step.completionMode : "manual";
    const gateType = typeof step.gateType === "string" ? step.gateType : "none";
    if (
      !key ||
      !title ||
      !WORKSTREAMS.has(workstream) ||
      !TASK_TYPES.has(taskType) ||
      !COMPLETION_MODES.has(completionMode) ||
      !GATE_TYPES.has(gateType)
    ) {
      throw new CloseError(`step ${index + 1} has invalid required fields`);
    }
    return {
      key,
      title,
      workstream,
      taskType,
      completionMode,
      gateType,
      description: typeof step.description === "string" ? step.description.trim() || null : null,
      dueOffsetBusinessDays: Number.isInteger(Number(step.dueOffsetBusinessDays))
        ? Number(step.dueOffsetBusinessDays)
        : 0,
      evidenceRequired: step.evidenceRequired === true,
      defaultOwnerRoleKey:
        typeof step.defaultOwnerRoleKey === "string" ? step.defaultOwnerRoleKey : null,
      applicability:
        step.applicability &&
        typeof step.applicability === "object" &&
        !Array.isArray(step.applicability)
          ? step.applicability
          : {},
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter((item): item is string => typeof item === "string")
        : [],
      sortOrder: (index + 1) * 10,
    };
  });
  validateDependencies(steps);
  const isDefault = body.isDefault === true;
  return db.transaction(async (tx) => {
    let version = 1;
    let sourceBefore: Record<string, unknown> | null = null;
    if (sourceId) {
      const source = await tx.execute(
        sql`select * from close_blueprints where id = ${sourceId} and org_id = ${orgId} for update`,
        "objects",
      );
      if (!source[0]) throw new CloseError("blueprint not found");
      sourceBefore = source[0] as Record<string, unknown>;
      version = Number(source[0].version) + 1;
      const deactivated = await tx.execute<Record<string, unknown>>(
        sql`
        update close_blueprints set is_active = false, is_default = false, updated_at = now(), updated_by = ${actorId}
         where id = ${sourceId} and org_id = ${orgId}
         returning *`,
        "objects",
      );
      const sourceAfter = deactivated[0];
      if (!sourceAfter) throw new CloseError("blueprint not found");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'close_blueprints', ${sourceId}, 'update',
                ${JSON.stringify({ before: sourceBefore, after: sourceAfter })}::jsonb, ${actorId})`);
    }
    if (isDefault)
      await tx.execute(
        sql`update close_blueprints set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    const inserted = await tx.execute<Record<string, unknown>>(
      sql`
      insert into close_blueprints
        (org_id, name, description, period_type, is_default, is_active, version, scope_rules, created_by, updated_by)
      values (${orgId}, ${name}, ${description}, ${periodType}, ${isDefault}, true, ${version},
              ${JSON.stringify(object(body, "scopeRules"))}::jsonb, ${actorId}, ${actorId}) returning *`,
      "objects",
    );
    const insertedBlueprint = inserted[0];
    if (!insertedBlueprint) throw new CloseError("blueprint could not be created");
    const blueprintId = insertedBlueprint.id as string;
    const ids = new Map<string, string>();
    for (const step of steps) {
      const result = await tx.execute<{ id: string }>(
        sql`
        insert into close_blueprint_steps
          (org_id, blueprint_id, key, title, description, workstream, task_type, completion_mode,
           gate_type, due_offset_business_days, evidence_required, default_owner_role_key,
           sort_order, applicability, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${step.key}, ${step.title}, ${step.description}, ${step.workstream},
                ${step.taskType}, ${step.completionMode}, ${step.gateType}, ${step.dueOffsetBusinessDays},
                ${step.evidenceRequired}, ${step.defaultOwnerRoleKey},
                ${step.sortOrder}, ${JSON.stringify(step.applicability)}::jsonb, ${actorId}, ${actorId}) returning id`,
        "objects",
      );
      ids.set(step.key, result[0]!.id);
    }
    for (const step of steps)
      for (const dependency of step.dependsOn) {
        await tx.execute(sql`
        insert into close_blueprint_dependencies
          (org_id, blueprint_id, step_id, depends_on_step_id, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${ids.get(step.key)!}, ${ids.get(dependency)!}, ${actorId}, ${actorId})`);
      }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_blueprints', ${blueprintId}, 'insert',
              ${JSON.stringify({ before: null, after: insertedBlueprint })}::jsonb, ${actorId})`);
    return blueprintId;
  });
}

export async function savePolicy(orgId: string, actorId: string, body: Body) {
  const code = text(body, "code", true)!;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code))
    throw new CloseError("policy code must be a stable kebab-case key");
  const policyType = text(body, "policyType", true)!;
  if (!["materiality", "lock", "evidence", "exception"].includes(policyType))
    throw new CloseError("invalid policy type");
  const isActive = optionalActive(body);
  return db.transaction(async (tx) => {
    const beforeResult = await tx.execute(
      sql`
      select * from close_policies
       where org_id = ${orgId} and code = ${code}
       for update`,
      "objects",
    );
    const before = beforeResult[0] ?? null;
    const result = await tx.execute<Record<string, unknown>>(
      sql`
      insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
      values (${orgId}, ${code}, ${text(body, "name", true)!}, ${text(body, "description")}, ${policyType},
              ${JSON.stringify(object(body, "rules"))}::jsonb, ${isActive}, ${actorId}, ${actorId})
      on conflict (org_id, code) do update set name = excluded.name, description = excluded.description,
        policy_type = excluded.policy_type, rules = excluded.rules, is_active = excluded.is_active,
        updated_at = now(), updated_by = excluded.updated_by
      where close_policies.org_id = ${orgId} returning *`,
      "objects",
    );
    const after = result[0];
    if (!after) throw new CloseError("close policy could not be saved");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_policies', ${after.id}, ${before ? "update" : "insert"},
              ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
    return after.id as string;
  });
}

export async function saveAutomation(orgId: string, actorId: string, body: Body) {
  const id = optionalUuid(body, "id", "automation");
  const isActive = optionalActive(body);
  const trigger = text(body, "trigger", true)!;
  const action = text(body, "automationAction", true)!;
  if (
    ![
      "run_started",
      "task_ready",
      "exception_opened",
      "deadline_approaching",
      "run_closed",
    ].includes(trigger)
  )
    throw new CloseError("invalid automation trigger");
  if (
    ![
      "notify",
      "assign",
      "run_check",
      "complete_task",
      "create_task",
      "generate_report",
      "start_flow",
      "run_allocation",
    ].includes(action)
  )
    throw new CloseError("invalid automation action");
  return db.transaction(async (tx) => {
    const beforeResult = id
      ? await tx.execute(
          sql`
          select * from close_automation_rules
           where id = ${id} and org_id = ${orgId}
           for update`,
          "objects",
        )
      : ([] as Record<string, unknown>[]);
    const before = beforeResult[0] ?? null;
    if (id && !before) throw new CloseError("automation not found");

    const result = id
      ? await tx.execute<Record<string, unknown>>(
          sql`
          update close_automation_rules set name = ${text(body, "name", true)!}, trigger = ${trigger}, action = ${action},
            conditions = ${JSON.stringify(object(body, "conditions"))}::jsonb, config = ${JSON.stringify(object(body, "config"))}::jsonb,
            is_active = ${isActive}, updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId}
           returning *`,
          "objects",
        )
      : await tx.execute<Record<string, unknown>>(
          sql`
          insert into close_automation_rules
            (org_id, name, trigger, action, conditions, config, is_active, created_by, updated_by)
          values (${orgId}, ${text(body, "name", true)!}, ${trigger}, ${action}, ${JSON.stringify(object(body, "conditions"))}::jsonb,
                  ${JSON.stringify(object(body, "config"))}::jsonb, ${isActive}, ${actorId}, ${actorId})
          returning *`,
          "objects",
        );
    const after = result[0];
    if (!after) throw new CloseError("close automation could not be saved");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_automation_rules', ${after.id}, ${before ? "update" : "insert"},
              ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
    return after.id as string;
  });
}

export async function savePackage(orgId: string, actorId: string, body: Body) {
  if (!Array.isArray(body.reports)) throw new CloseError("reports must be an array");
  const reports = body.reports.map((report) => {
    if (
      !report ||
      typeof report !== "object" ||
      Array.isArray(report) ||
      typeof (report as Record<string, unknown>).slug !== "string" ||
      !(report as Record<string, unknown>).slug
    ) {
      throw new CloseError("each report attachment requires a slug");
    }
    return report as Record<string, unknown>;
  });
  const id = optionalUuid(body, "id", "reporting package");
  const isActive = optionalActive(body);
  const isDefault = body.isDefault === true;
  // Fail closed at the save boundary: the delivery worker hands this list
  // straight to the email queue, whose provider validation throws on the
  // first invalid address only after every attached report was rendered.
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  for (const recipient of recipients) {
    if (typeof recipient !== "string" || !isValidEmailAddress(recipient.trim())) {
      throw new CloseError(
        `invalid recipient email address: ${typeof recipient === "string" ? recipient.trim() || "(blank)" : "(not an address)"}`,
      );
    }
  }
  return db.transaction(async (tx) => {
    let before: Record<string, unknown> | null = null;
    if (id) {
      const existing = await tx.execute(
        sql`
        select * from close_reporting_packages
         where id = ${id} and org_id = ${orgId}
         for update`,
        "objects",
      );
      if (!existing[0]) throw new CloseError("reporting package not found");
      before = existing[0] as Record<string, unknown>;
    }
    if (isDefault)
      await tx.execute(
        sql`update close_reporting_packages set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    if (id) {
      const updated = await tx.execute<Record<string, unknown>>(
        sql`update close_reporting_packages set name = ${text(body, "name", true)!}, description = ${text(body, "description")},
        reports = ${JSON.stringify(reports)}::jsonb,
        recipients = ${JSON.stringify(recipients)}::jsonb,
        delivery = ${JSON.stringify(object(body, "delivery"))}::jsonb, is_default = ${isDefault},
        is_active = ${isActive}, updated_at = now(), updated_by = ${actorId}
        where id = ${id} and org_id = ${orgId}
        returning *`,
        "objects",
      );
      const after = updated[0];
      if (!after) throw new CloseError("reporting package not found");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'close_reporting_packages', ${id}, 'update',
                ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
      return id;
    }
    const result = await tx.execute<Record<string, unknown>>(
      sql`insert into close_reporting_packages
      (org_id, name, description, reports, recipients, delivery, is_default, is_active, created_by, updated_by)
      values (${orgId}, ${text(body, "name", true)!}, ${text(body, "description")},
              ${JSON.stringify(reports)}::jsonb,
              ${JSON.stringify(recipients)}::jsonb,
              ${JSON.stringify(object(body, "delivery"))}::jsonb, ${isDefault}, ${isActive}, ${actorId}, ${actorId}) returning *`,
      "objects",
    );
    const after = result[0];
    if (!after) throw new CloseError("reporting package could not be created");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_reporting_packages', ${after.id}, 'insert',
              ${JSON.stringify({ before: null, after })}::jsonb, ${actorId})`);
    return after.id as string;
  });
}

export const ADMIN_CLOSE_ACTION_SCHEMAS = {
  saveCalendar: closeActionSchemas[0],
  generatePeriods: closeActionSchemas[1],
  saveBlueprint: closeActionSchemas[2],
  savePolicy: closeActionSchemas[3],
  savePolicyFields: closePolicyFields,
  saveAutomation: closeActionSchemas[4],
  saveAutomationFields: closeAutomationFields,
  savePackage: closeActionSchemas[5],
  sendPackage: closeActionSchemas[6],
  setLock: closeActionSchemas[7],
  closePeriod: closeActionSchemas[8],
  bankingCloseStatus: closeActionSchemas[9],
  requestReopen: closeActionSchemas[10],
  submitReopen: closeActionSchemas[11],
  withdrawReopen: closeActionSchemas[12],
  extendReopen: closeActionSchemas[13],
  recloseReopen: closeActionSchemas[14],
} as const;

export { generateAccountingPeriods };

/** Return the close setup records and identifiers shown in the native close setup page. */
export async function listCloseSetupConfiguration(orgId: string) {
  return withOrgContext(orgId, async () => {
    const [
      calendars,
      periods,
      blueprints,
      blueprintSteps,
      policies,
      automations,
      packages,
      reopenRequests,
    ] = await Promise.all([
      db.execute(
        sql`select * from fiscal_calendars where org_id = ${orgId} order by is_default desc, name limit 500`,
        "objects",
      ),
      db.execute(
        sql`select id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment
              from accounting_periods where org_id = ${orgId} order by starts_on desc, period_number limit 500`,
        "objects",
      ),
      db.execute(
        sql`select * from close_blueprints where org_id = ${orgId} order by is_active desc, is_default desc, name, version desc limit 500`,
        "objects",
      ),
      db.execute(
        sql`select s.*, coalesce(jsonb_agg(dep.key order by dep.key) filter (where dep.id is not null), '[]'::jsonb) as depends_on
              from close_blueprint_steps s
              left join close_blueprint_dependencies d on d.step_id = s.id and d.org_id = s.org_id
              left join close_blueprint_steps dep on dep.id = d.depends_on_step_id and dep.org_id = s.org_id
             where s.org_id = ${orgId} group by s.id order by s.blueprint_id, s.sort_order limit 2000`,
        "objects",
      ),
      db.execute(
        sql`select * from close_policies where org_id = ${orgId} and policy_type not in ('review', 'segregation') order by policy_type, name limit 500`,
        "objects",
      ),
      db.execute(
        sql`select * from close_automation_rules where org_id = ${orgId} order by is_active desc, name limit 500`,
        "objects",
      ),
      db.execute(
        sql`select * from close_reporting_packages where org_id = ${orgId} order by is_default desc, name limit 500`,
        "objects",
      ),
      db.execute(
        sql`select id, period_id, book_id, subsidiary_id, modules, status, reason, requested_by,
                   requested_at, approved_by, approved_at, expires_at, closed_at, cancelled_at
              from close_reopen_requests where org_id = ${orgId} order by requested_at desc limit 500`,
        "objects",
      ),
    ]);
    return {
      calendars,
      periods,
      blueprints,
      blueprintSteps,
      policies,
      automations,
      packages,
      reopenRequests,
    };
  });
}

export async function enqueueClosePackageDelivery(input: {
  orgId: string;
  packageId: string;
  periodId: string;
  bookId: string;
  actorId: string;
  idempotencyKey: string;
}): Promise<void> {
  try {
    const { closeDeliveryManualJobId, enqueueCloseDelivery } = await import("@openbooks/jobs");
    await enqueueCloseDelivery(
      {
        orgId: input.orgId,
        packageId: input.packageId,
        periodId: input.periodId,
        bookId: input.bookId,
        senderId: input.actorId,
        manualTrigger: true,
        idempotencyKey: input.idempotencyKey,
      },
      {
        jobId: closeDeliveryManualJobId({
          packageId: input.packageId,
          periodId: input.periodId,
          bookId: input.bookId,
          idempotencyKey: input.idempotencyKey,
        }),
      },
    );
  } catch {
    throw new CloseError("the delivery queue is unavailable");
  }
}
