import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { guardCloseScope } from "@/lib/close-scope";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  CLOSE_MODULES,
  CloseError,
  type CloseModule,
} from "@openbooks/engine/periods/period-policy";
import {
  consumeReopenRequestsForClosedModules,
  submitPeriodReopen,
  extendReopenRequest,
  recloseApprovedReopen,
  requestPeriodReopen,
  withdrawPeriodReopen,
} from "@openbooks/engine/close/reopening";
import { generateAccountingPeriods } from "@openbooks/engine/close/calendar";
import { closePeriodAllModules, setPeriodLockState } from "@openbooks/engine/periods/period-locks";
import {
  auditBankingModuleClose,
  bankingCloseStatus,
  bankingUnmatchedStatementLines,
  evaluateBankingModuleClose,
} from "@openbooks/engine/close/banking-close";
import { can, getAuthz, guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isFeatureEnabled } from "../../../../lib/features";
import { isValidEmailAddress } from "@openbooks/emails";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../lib/payroll-decimal-refusal";

const closeObject = z.record(z.string(), z.json());
const closePolicySchema = z
  .object({
    action: z.literal("save-policy"),
    code: z.string().trim().min(1),
    name: z.string().trim().min(1),
    policyType: z.enum(["materiality", "lock", "evidence", "exception"]),
    description: z.string().nullable().optional(),
    rules: closeObject.optional(),
    isActive: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
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
  });
const closeStepSchema = z.strictObject({
  key: z.string().trim().min(1),
  title: z.string().trim().min(1),
  workstream: z.enum([
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
  ]),
  taskType: z
    .enum(["check", "action", "reconciliation", "journal", "approval", "report", "publish"])
    .optional(),
  completionMode: z.enum(["manual", "computed", "automatic"]).optional(),
  gateType: z.enum(["none", "soft", "hard"]).optional(),
  description: z.string().nullable().optional(),
  dueOffsetBusinessDays: z.number().int().optional(),
  evidenceRequired: z.boolean().optional(),
  defaultOwnerRoleKey: z.string().nullable().optional(),
  applicability: closeObject.optional(),
  dependsOn: z.array(z.string()).optional(),
});
const closeActionSchemas = [
  z.object({
    action: z.literal("save-calendar"),
    id: uuidString().optional(),
    name: z.string().trim().min(1),
    cadence: z.enum([
      "monthly",
      "four_four_five",
      "four_five_four",
      "five_four_four",
      "thirteen_period",
      "custom",
    ]),
    yearStartMonth: z.number().int().min(1).max(12),
    weekStartsOn: z.number().int().min(0).max(6).optional(),
    anchorDate: z.string().refine(isIsoCalendarDate).nullable().optional(),
    timeZone: z.string().optional(),
    adjustmentPeriodEnabled: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
    config: closeObject.optional(),
  }),
  z.object({
    action: z.literal("generate-periods"),
    calendarId: uuidString(),
    fiscalYear: z.number().int().min(1900).max(2200),
  }),
  z.object({
    action: z.literal("save-blueprint"),
    id: uuidString().optional(),
    name: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    periodType: z.enum(["month", "quarter", "year", "adjustment", "any"]).optional(),
    steps: z.array(closeStepSchema).min(1).max(200),
    isDefault: z.boolean().optional(),
  }),
  closePolicySchema,
  z
    .object({
      action: z.literal("save-automation"),
      id: uuidString().optional(),
      name: z.string().trim().min(1),
      trigger: z.enum([
        "run_started",
        "task_ready",
        "exception_opened",
        "deadline_approaching",
        "run_closed",
      ]),
      automationAction: z.enum([
        "notify",
        "assign",
        "run_check",
        "complete_task",
        "create_task",
        "generate_report",
        "start_flow",
        "run_allocation",
      ]),
      conditions: closeObject.optional(),
      config: closeObject.optional(),
      isActive: z.boolean().optional(),
    })
    .superRefine((body, ctx) => {
      for (const key of ["reviewerUserId", "reviewerRoleKey"])
        if (Object.hasOwn(body.config ?? {}, key))
          ctx.addIssue({
            code: "custom",
            path: ["config", key],
            message:
              "Configure close task approvals in Flows; assignment rules only choose the preparation owner.",
          });
    }),
  z.object({
    action: z.literal("save-package"),
    id: uuidString().optional(),
    name: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    reports: z
      .array(
        z
          .record(z.string(), z.json())
          .refine(
            (report) => typeof report.slug === "string" && report.slug.trim().length > 0,
            "report slug is required",
          ),
      )
      .min(1),
    recipients: z.array(z.string().trim().min(1).max(320)).optional(),
    delivery: closeObject.optional(),
    isDefault: z.boolean().optional(),
    isActive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("send-package"),
    packageId: uuidString(),
    periodId: uuidString(),
    bookId: uuidString(),
    idempotencyKey: uuidString(),
  }),
  z.object({
    action: z.literal("set-lock"),
    periodId: uuidString(),
    bookId: uuidString(),
    subsidiaryId: uuidString().nullable().optional(),
    module: z.enum(CLOSE_MODULES),
    state: z.enum(["open", "soft_closed", "closed"]),
    reason: z.string().trim().min(1),
    bankingAcknowledgement: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("close-period"),
    periodId: uuidString(),
    bookId: uuidString(),
    subsidiaryId: uuidString().nullable().optional(),
    state: z.enum(["soft_closed", "closed"]).optional().default("closed"),
    modules: z.array(z.enum(CLOSE_MODULES)).min(1).optional(),
    moduleReasons: z.record(z.enum(CLOSE_MODULES), z.string()).optional(),
    reason: z.string().trim().min(1),
    bankingAcknowledgement: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal("banking-close-status"),
    periodId: uuidString(),
    bookId: uuidString(),
    subsidiaryId: uuidString().nullable().optional(),
  }),
  z.object({
    action: z.literal("request-reopen"),
    periodId: uuidString(),
    bookId: uuidString(),
    subsidiaryId: uuidString().nullable().optional(),
    modules: z.array(z.enum(CLOSE_MODULES)).min(1),
    reason: z.string().trim().min(1),
    hours: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("submit-reopen"),
    requestId: uuidString(),
    hours: z.number().int().positive().optional(),
  }),
  z.object({
    action: z.literal("withdraw-reopen"),
    requestId: uuidString(),
    reason: z.string().trim().min(10).max(500),
  }),
  z.object({
    action: z.literal("extend-reopen"),
    requestId: uuidString(),
    additionalHours: z.number().int().min(0).max(168).optional(),
    addModules: z.array(z.enum(CLOSE_MODULES)).optional(),
    reason: z.string().trim().min(1),
  }),
  z.object({
    action: z.literal("reclose-reopen"),
    requestId: uuidString(),
    reason: z.string().trim().min(1),
  }),
] as const;
const requestBodySchema = z.discriminatedUnion("action", closeActionSchemas);
type Body = Record<string, unknown>;

export const runtime = "nodejs";

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

function text(body: Body, key: string, required = false): string | null {
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

async function saveCalendar(orgId: string, actorId: string, body: Body) {
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

async function saveBlueprint(orgId: string, actorId: string, body: Body) {
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

async function savePolicy(orgId: string, actorId: string, body: Body) {
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
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_policies', ${after?.id}, ${before ? "update" : "insert"},
              ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
    return after?.id as string;
  });
}

async function saveAutomation(orgId: string, actorId: string, body: Body) {
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
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'close_automation_rules', ${after?.id}, ${before ? "update" : "insert"},
              ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
    return after?.id as string;
  });
}

async function savePackage(orgId: string, actorId: string, body: Body) {
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

export const POST = defineRoute({
  // Close scope is capability-blind: a selected subsidiary must see 404 for
  // every organization-wide close action, including a malformed one, before
  // the typed body is validated. Per-action permission stays in the handler.
  authorize: async ({ request }) => {
    const session = await getAuthz();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    let action = "";
    try {
      const payload: unknown = await request.clone().json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        typeof payload.action === "string"
      )
        action = payload.action;
    } catch {
      // The declared body schema answers malformed bodies once scope passes.
    }
    if (action !== "set-lock") {
      const denied = guardCloseScope(session);
      if (denied) return denied;
    }
    return session;
  },
  feature: {
    none: "Close has no route-wide feature gate; the handler enforces per-action permission, close scope, and the Advanced close feature.",
  },
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body: parsedBody, authz: routeAuthz }) => {
    const body = parsedBody as Body;

    const action = typeof body.action === "string" ? body.action : "";
    const permission = [
      "request-reopen",
      "submit-reopen",
      "withdraw-reopen",
      "reclose-reopen",
      "extend-reopen",
    ].includes(action)
      ? "close.reopen"
      : "periods.manage";
    const gate = routeAuthz;
    if (!can(gate, permission)) {
      return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
    }

    // Only a direct lock has entity-local effects. Reopen invalidates the
    // organization-wide close review and configuration/delivery is shared.
    if (action !== "set-lock") {
      const denied = guardCloseScope(gate);
      if (denied) return denied;
    }
    const { orgId, id: actorId } = gate.user;
    try {
      const advancedActions = new Set([
        "save-blueprint",
        "save-policy",
        "save-automation",
        "save-package",
        "send-package",
      ]);
      if (advancedActions.has(action) && !(await isFeatureEnabled(orgId, "advancedClose"))) {
        throw new CloseError(
          "enable Advanced close controls to manage blueprints, policies, automation, or reporting packages",
        );
      }
      if (action === "save-calendar")
        return NextResponse.json({
          ok: true,
          id: await saveCalendar(orgId, actorId, body),
        });
      if (action === "generate-periods") {
        const calendarId = text(body, "calendarId", true)!;
        if (!isUuid(calendarId)) throw new CloseError("invalid calendarId");
        return NextResponse.json({
          ok: true,
          ...(await generateAccountingPeriods(orgId, calendarId, Number(body.fiscalYear), actorId)),
        });
      }
      if (action === "save-blueprint")
        return NextResponse.json({
          ok: true,
          id: await saveBlueprint(orgId, actorId, body),
        });
      if (action === "save-policy")
        return NextResponse.json({
          ok: true,
          id: await savePolicy(orgId, actorId, body),
        });
      if (action === "save-automation")
        return NextResponse.json({
          ok: true,
          id: await saveAutomation(orgId, actorId, body),
        });
      if (action === "save-package")
        return NextResponse.json({
          ok: true,
          id: await savePackage(orgId, actorId, body),
        });
      if (action === "send-package") {
        const packageId = text(body, "packageId", true)!;
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        // The send intent key comes from the request (one dialog instance,
        // rotated after success): a double-click reuses it and dedupes in
        // BullMQ and in the email worker, instead of sending both mails.
        const idempotencyKey = text(body, "idempotencyKey", true)!;
        if (!isUuid(packageId) || !isUuid(periodId) || !isUuid(bookId) || !isUuid(idempotencyKey))
          throw new CloseError("invalid send target");
        try {
          const { closeDeliveryManualJobId, enqueueCloseDelivery } =
            await import("@openbooks/jobs");
          await enqueueCloseDelivery(
            {
              orgId,
              packageId,
              periodId,
              bookId,
              senderId: actorId,
              manualTrigger: true,
              idempotencyKey,
            },
            { jobId: closeDeliveryManualJobId({ packageId, periodId, bookId, idempotencyKey }) },
          );
        } catch {
          throw new CloseError("the delivery queue is unavailable");
        }
        return NextResponse.json({ ok: true });
      }
      if (action === "set-lock") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        const module = text(body, "module", true)! as CloseModule;
        const state = text(body, "state", true)! as "open" | "soft_closed" | "closed";
        if (
          !isUuid(periodId) ||
          !isUuid(bookId) ||
          (subsidiaryId && !isUuid(subsidiaryId)) ||
          !CLOSE_MODULES.includes(module) ||
          !["open", "soft_closed", "closed"].includes(state)
        )
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        const lockReason = text(body, "reason", true)!;
        const acknowledgement =
          typeof body.bankingAcknowledgement === "string" ? body.bankingAcknowledgement : null;
        // A Banking close names every account's reconciliation status first:
        // unsigned or stale reconciliations refuse under a strict org policy
        // and otherwise require the explicit acknowledgement audited below.
        const bankingEvaluation =
          module === "banking" && state !== "open"
            ? await evaluateBankingModuleClose(orgId, {
                periodId,
                bookId,
                subsidiaryId: subsidiaryId ?? undefined,
                actorId,
                acknowledgement,
              })
            : null;
        await setPeriodLockState({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          module,
          state,
          actorId,
          reason: lockReason,
        });
        if (bankingEvaluation && bankingEvaluation.issues.length > 0) {
          await auditBankingModuleClose(orgId, {
            periodId,
            bookId,
            subsidiaryId: subsidiaryId ?? undefined,
            actorId,
            reason: lockReason,
            acknowledgement: acknowledgement!.trim(),
            evaluation: bankingEvaluation,
          });
        }
        // Re-closing a module ends the reopen windows it supersedes: a
        // request whose modules are all closed here is marked reclosed,
        // audited, and stops counting for overlap.
        const reopenConsumed =
          state !== "open"
            ? (
                await consumeReopenRequestsForClosedModules({
                  orgId,
                  periodId,
                  bookId,
                  subsidiaryId: subsidiaryId ?? undefined,
                  actorId,
                  reason: lockReason,
                })
              ).consumed
            : [];
        return NextResponse.json({
          ok: true,
          banking: bankingEvaluation
            ? {
                accounts: bankingEvaluation.accounts,
                strict: bankingEvaluation.strict,
              }
            : undefined,
          reopenConsumed,
        });
      }
      if (action === "close-period") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        // Modules, reasons and state arrive schema-validated above; the
        // engine orders modules GL-last and reports each module's outcome.
        const scoped = body as {
          modules?: CloseModule[];
          moduleReasons?: Partial<Record<CloseModule, string>>;
          state?: "soft_closed" | "closed";
        };
        const periodReason = text(body, "reason", true)!;
        const closesBanking = (scoped.modules ?? [...CLOSE_MODULES]).includes("banking");
        // The Banking gate runs before any module closes so a refusal leaves
        // every module untouched instead of a half-closed period.
        const periodBanking = closesBanking
          ? await evaluateBankingModuleClose(orgId, {
              periodId,
              bookId,
              subsidiaryId: subsidiaryId ?? undefined,
              actorId,
              acknowledgement:
                typeof body.bankingAcknowledgement === "string"
                  ? body.bankingAcknowledgement
                  : null,
            })
          : null;
        const { results } = await closePeriodAllModules({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          actorId,
          state: scoped.state ?? "closed",
          modules: scoped.modules,
          moduleReasons: scoped.moduleReasons,
          reason: periodReason,
        });
        if (periodBanking && periodBanking.issues.length > 0) {
          await auditBankingModuleClose(orgId, {
            periodId,
            bookId,
            subsidiaryId: subsidiaryId ?? undefined,
            actorId,
            reason: periodReason,
            acknowledgement: (typeof body.bankingAcknowledgement === "string"
              ? body.bankingAcknowledgement
              : ""
            ).trim(),
            evaluation: periodBanking,
          });
        }
        const reopenConsumed = results.some((result) => result.ok)
          ? (
              await consumeReopenRequestsForClosedModules({
                orgId,
                periodId,
                bookId,
                subsidiaryId: subsidiaryId ?? undefined,
                actorId,
                reason: periodReason,
              })
            ).consumed
          : [];
        return NextResponse.json({
          ok: results.every((result) => result.ok),
          results,
          banking: periodBanking
            ? {
                accounts: periodBanking.accounts,
                strict: periodBanking.strict,
              }
            : undefined,
          reopenConsumed,
        });
      }
      if (action === "banking-close-status") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid lock scope or state");
        const denied = guardSubsidiaryScope(gate, subsidiaryId);
        if (denied) return denied;
        const accounts = await bankingCloseStatus(orgId, {
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          actorId,
        });
        const unmatchedStatementLines = await bankingUnmatchedStatementLines(orgId, {
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
        });
        return NextResponse.json({
          ok: true,
          accounts,
          issues: accounts.filter((account) => account.status !== "signed_off" || account.stale),
          unmatchedStatementLines,
        });
      }
      if (action === "request-reopen") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (!isUuid(periodId) || !isUuid(bookId) || (subsidiaryId && !isUuid(subsidiaryId)))
          throw new CloseError("invalid reopen scope");
        const modules = Array.isArray(body.modules)
          ? body.modules.filter(
              (item): item is CloseModule =>
                typeof item === "string" && CLOSE_MODULES.includes(item as CloseModule),
            )
          : [];
        const requestId = await requestPeriodReopen({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          modules,
          reason: text(body, "reason", true)!,
          actorId,
          hours: body.hours == null ? undefined : Number(body.hours),
        });
        return NextResponse.json({ ok: true, requestId });
      }
      if (action === "submit-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        const result = await submitPeriodReopen({
          orgId,
          requestId,
          actorId,
          hours: body.hours == null ? undefined : Number(body.hours),
        });
        return NextResponse.json({ ok: true, ...result });
      }
      if (action === "withdraw-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        await withdrawPeriodReopen({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "reclose-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        await recloseApprovedReopen({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "extend-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        const addModules = Array.isArray(body.addModules)
          ? body.addModules.filter(
              (item): item is CloseModule =>
                typeof item === "string" && CLOSE_MODULES.includes(item as CloseModule),
            )
          : undefined;
        const extended = await extendReopenRequest({
          orgId,
          requestId,
          actorId,
          reason: text(body, "reason", true)!,
          additionalHours: body.additionalHours == null ? undefined : Number(body.additionalHours),
          addModules,
        });
        return NextResponse.json({ ok: true, ...extended });
      }
      return NextResponse.json({ error: "unknown close setup action" }, { status: 400 });
    } catch (error) {
      if (error instanceof CloseError) return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
