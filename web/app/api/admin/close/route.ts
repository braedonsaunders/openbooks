import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { guardCloseScope } from "@/lib/close-scope";

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { CLOSE_MODULES, CloseError, type CloseModule } from "@openbooks/engine/src/periods/period-policy.ts";
import { decidePeriodReopen, recloseApprovedReopen, requestPeriodReopen } from "@openbooks/engine/src/close/reopening.ts";
import { generateAccountingPeriods } from "@openbooks/engine/src/close/calendar.ts";
import { closePeriodAllModules, setPeriodLockState } from "@openbooks/engine/src/periods/period-locks.ts";
import { can, getAuthz, guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isFeatureEnabled } from "../../../../lib/features";
import { isValidEmailAddress } from "@openbooks/emails";
import { isIsoCalendarDate } from "@openbooks/engine/src/platform/business-date.ts";
import { canonicalDecimal } from "../../../../lib/exact-decimal";
import { moneyRefusal } from "../../../../lib/payroll-decimal-refusal";

const closeObject = z.record(z.string(), z.json());
const closePolicySchema = z.object({
  action: z.literal("save-policy"), code: z.string().trim().min(1), name: z.string().trim().min(1),
  policyType: z.enum(["materiality", "lock", "review", "segregation", "exception"]),
  description: z.string().nullable().optional(), rules: closeObject.optional(), isActive: z.boolean().optional(),
}).superRefine((body, ctx) => {
  if (body.policyType !== "materiality") return;
  const amount = body.rules?.amount;
  if (typeof amount !== "string") {
    ctx.addIssue({ code: "custom", path: ["rules", "amount"], message: "Materiality amount must be a decimal string" });
  } else if (canonicalDecimal(amount, 4) === null) {
    ctx.addIssue({ code: "custom", path: ["rules", "amount"], message: moneyRefusal("Materiality threshold", amount) });
  }
  const percent = body.rules?.percent;
  if (percent !== undefined && (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100)) {
    ctx.addIssue({ code: "custom", path: ["rules", "percent"], message: "Materiality percent must be between 0 and 100" });
  }
});
const closeStepSchema = z.object({
  key: z.string().trim().min(1), title: z.string().trim().min(1),
  workstream: z.enum(["readiness", "banking", "ar", "ap", "assets", "tax", "payroll", "intercompany", "gl", "review", "publish"]),
  taskType: z.enum(["check", "action", "reconciliation", "journal", "approval", "report", "publish"]).optional(),
  completionMode: z.enum(["manual", "computed", "automatic"]).optional(),
  gateType: z.enum(["none", "soft", "hard"]).optional(),
  description: z.string().nullable().optional(), dueOffsetBusinessDays: z.number().int().optional(),
  evidenceRequired: z.boolean().optional(), defaultOwnerRoleKey: z.string().nullable().optional(),
  defaultReviewerRoleKey: z.string().nullable().optional(), applicability: closeObject.optional(),
  dependsOn: z.array(z.string()).optional(),
});
const closeActionSchemas = [
  z.object({ action: z.literal("save-calendar"), id: z.string().uuid().optional(), name: z.string().trim().min(1), cadence: z.enum(["monthly", "four_four_five", "four_five_four", "five_four_four", "thirteen_period", "custom"]), yearStartMonth: z.number().int().min(1).max(12), weekStartsOn: z.number().int().min(0).max(6).optional(), anchorDate: z.string().refine(isIsoCalendarDate).nullable().optional(), timeZone: z.string().optional(), adjustmentPeriodEnabled: z.boolean().optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional(), config: closeObject.optional() }),
  z.object({ action: z.literal("generate-periods"), calendarId: z.string().uuid(), fiscalYear: z.number().int().min(1900).max(2200) }),
  z.object({ action: z.literal("save-blueprint"), id: z.string().uuid().optional(), name: z.string().trim().min(1), description: z.string().nullable().optional(), periodType: z.enum(["month", "quarter", "year", "adjustment", "any"]).optional(), steps: z.array(closeStepSchema).min(1).max(200), isDefault: z.boolean().optional() }),
  closePolicySchema,
  z.object({ action: z.literal("save-automation"), id: z.string().uuid().optional(), name: z.string().trim().min(1), trigger: z.enum(["run_started", "task_ready", "exception_opened", "deadline_approaching", "run_closed"]), automationAction: z.enum(["notify", "assign", "run_check", "complete_task", "create_task", "generate_report", "start_flow", "run_allocation"]), conditions: closeObject.optional(), config: closeObject.optional(), isActive: z.boolean().optional() }),
  z.object({ action: z.literal("save-package"), id: z.string().uuid().optional(), name: z.string().trim().min(1), description: z.string().nullable().optional(), reports: z.array(z.record(z.string(), z.json()).refine((report) => typeof report.slug === "string" && report.slug.trim().length > 0, "report slug is required")).min(1), recipients: z.array(z.string().trim().min(1).max(320)).optional(), delivery: closeObject.optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() }),
  z.object({ action: z.literal("send-package"), packageId: z.string().uuid(), periodId: z.string().uuid(), bookId: z.string().uuid(), idempotencyKey: z.string().uuid() }),
  z.object({ action: z.literal("set-lock"), periodId: z.string().uuid(), bookId: z.string().uuid(), subsidiaryId: z.string().uuid().nullable().optional(), module: z.enum(CLOSE_MODULES), state: z.enum(["open", "soft_closed", "closed"]), reason: z.string().trim().min(1), }),
  z.object({ action: z.literal("close-period"), periodId: z.string().uuid(), bookId: z.string().uuid(), subsidiaryId: z.string().uuid().nullable().optional(), state: z.enum(["soft_closed", "closed"]).optional().default("closed"), modules: z.array(z.enum(CLOSE_MODULES)).min(1).optional(), moduleReasons: z.record(z.enum(CLOSE_MODULES), z.string()).optional(), reason: z.string().trim().min(1), }),
  z.object({ action: z.literal("request-reopen"), periodId: z.string().uuid(), bookId: z.string().uuid(), subsidiaryId: z.string().uuid().nullable().optional(), modules: z.array(z.enum(CLOSE_MODULES)).min(1), reason: z.string().trim().min(1) }),
  z.object({ action: z.literal("decide-reopen"), requestId: z.string().uuid(), approve: z.boolean(), hours: z.number().positive().max(168).optional() }),
  z.object({ action: z.literal("reclose-reopen"), requestId: z.string().uuid(), reason: z.string().trim().min(1) }),
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

function validateDependencies(
  steps: Array<{ key: string; dependsOn: string[] }>,
) {
  const keys = new Set(steps.map((step) => step.key));
  if (keys.size !== steps.length)
    throw new CloseError("blueprint step keys must be unique");
  const graph = new Map(steps.map((step) => [step.key, step.dependsOn]));
  for (const step of steps) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(step.key))
      throw new CloseError(`invalid step key: ${step.key}`);
    for (const dependency of step.dependsOn) {
      if (!keys.has(dependency))
        throw new CloseError(
          `${step.key} depends on unknown step ${dependency}`,
        );
      if (dependency === step.key)
        throw new CloseError(`${step.key} cannot depend on itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key))
      throw new CloseError(`blueprint contains a dependency cycle at ${key}`);
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
  if (
    !Number.isInteger(yearStartMonth) ||
    yearStartMonth < 1 ||
    yearStartMonth > 12
  )
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
    await tx.execute(
      sql`select id from fiscal_calendars where org_id = ${orgId} for update`,
    );
    let before: Record<string, unknown> | null = null;
    let savedId: string;
    if (id) {
      const current = ((await tx.execute(sql`
        select c.*, exists(select 1 from accounting_periods p where p.fiscal_calendar_id = c.id and p.org_id = ${orgId}) as has_periods
          from fiscal_calendars c where c.id = ${id} and c.org_id = ${orgId} for update`)));
      const row = current.rows[0];
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
      const updated = (await tx.execute(sql`
        update fiscal_calendars set name = ${name}, cadence = ${cadence}, year_start_month = ${yearStartMonth},
               week_starts_on = ${weekStartsOn}, anchor_date = ${anchorDate},
               time_zone = ${text(body, "timeZone") ?? "UTC"},
               adjustment_period_enabled = ${bool(body, "adjustmentPeriodEnabled")},
               is_default = ${isDefault}, is_active = ${isActive},
               config = ${JSON.stringify(object(body, "config"))}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where id = ${id} and org_id = ${orgId}
         returning *`)) as { rows: Array<Record<string, unknown>> };
      const after = updated.rows[0];
      if (!after) throw new CloseError("calendar not found");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'fiscal_calendars', ${id}, 'update',
                ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
      savedId = id;
    } else {
      const inserted = (await tx.execute(sql`
        insert into fiscal_calendars
          (org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone,
           adjustment_period_enabled, is_default, is_active, config, created_by, updated_by)
        values (${orgId}, ${name}, ${cadence}, ${yearStartMonth}, ${weekStartsOn}, ${anchorDate},
                ${text(body, "timeZone") ?? "UTC"}, ${bool(body, "adjustmentPeriodEnabled")},
                ${isDefault}, ${isActive}, ${JSON.stringify(object(body, "config"))}::jsonb,
                ${actorId}, ${actorId}) returning *`)) as { rows: Array<Record<string, unknown>> };
      const after = inserted.rows[0];
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
    const guard = (await tx.execute(sql`
      select exists(select 1 from accounting_periods where org_id = ${orgId}) as has_periods,
             exists(select 1 from fiscal_calendars
                     where org_id = ${orgId} and is_default and is_active) as has_default`)) as {
      rows: Array<{ has_periods: boolean; has_default: boolean }>;
    };
    if (guard.rows[0]?.has_periods && !guard.rows[0]?.has_default) {
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
    const workstream =
      typeof step.workstream === "string" ? step.workstream : "";
    const taskType =
      typeof step.taskType === "string" ? step.taskType : "action";
    const completionMode =
      typeof step.completionMode === "string" ? step.completionMode : "manual";
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
      description:
        typeof step.description === "string"
          ? step.description.trim() || null
          : null,
      dueOffsetBusinessDays: Number.isInteger(
        Number(step.dueOffsetBusinessDays),
      )
        ? Number(step.dueOffsetBusinessDays)
        : 0,
      evidenceRequired: step.evidenceRequired === true,
      defaultOwnerRoleKey:
        typeof step.defaultOwnerRoleKey === "string"
          ? step.defaultOwnerRoleKey
          : null,
      defaultReviewerRoleKey:
        typeof step.defaultReviewerRoleKey === "string"
          ? step.defaultReviewerRoleKey
          : null,
      applicability:
        step.applicability &&
        typeof step.applicability === "object" &&
        !Array.isArray(step.applicability)
          ? step.applicability
          : {},
      dependsOn: Array.isArray(step.dependsOn)
        ? step.dependsOn.filter(
            (item): item is string => typeof item === "string",
          )
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
      const source = (await tx.execute(
        sql`select * from close_blueprints where id = ${sourceId} and org_id = ${orgId} for update`,
      ));
      if (!source.rows[0]) throw new CloseError("blueprint not found");
      sourceBefore = source.rows[0] as Record<string, unknown>;
      version = Number(source.rows[0].version) + 1;
      const deactivated = (await tx.execute(sql`
        update close_blueprints set is_active = false, is_default = false, updated_at = now(), updated_by = ${actorId}
         where id = ${sourceId} and org_id = ${orgId}
         returning *`)) as { rows: Array<Record<string, unknown>> };
      const sourceAfter = deactivated.rows[0];
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
    const inserted = (await tx.execute(sql`
      insert into close_blueprints
        (org_id, name, description, period_type, is_default, is_active, version, scope_rules, created_by, updated_by)
      values (${orgId}, ${name}, ${description}, ${periodType}, ${isDefault}, true, ${version},
              ${JSON.stringify(object(body, "scopeRules"))}::jsonb, ${actorId}, ${actorId}) returning *`)) as { rows: Array<Record<string, unknown>> };
    const insertedBlueprint = inserted.rows[0];
    if (!insertedBlueprint) throw new CloseError("blueprint could not be created");
    const blueprintId = insertedBlueprint.id as string;
    const ids = new Map<string, string>();
    for (const step of steps) {
      const result = (await tx.execute<{ id: string }>(sql`
        insert into close_blueprint_steps
          (org_id, blueprint_id, key, title, description, workstream, task_type, completion_mode,
           gate_type, due_offset_business_days, evidence_required, default_owner_role_key,
           default_reviewer_role_key, sort_order, applicability, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${step.key}, ${step.title}, ${step.description}, ${step.workstream},
                ${step.taskType}, ${step.completionMode}, ${step.gateType}, ${step.dueOffsetBusinessDays},
                ${step.evidenceRequired}, ${step.defaultOwnerRoleKey}, ${step.defaultReviewerRoleKey},
                ${step.sortOrder}, ${JSON.stringify(step.applicability)}::jsonb, ${actorId}, ${actorId}) returning id`));
      ids.set(step.key, result.rows[0]!.id);
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
  if (
    !["materiality", "lock", "review", "segregation", "exception"].includes(
      policyType,
    )
  )
    throw new CloseError("invalid policy type");
  const isActive = optionalActive(body);
  return db.transaction(async (tx) => {
    const beforeResult = await tx.execute(sql`
      select * from close_policies
       where org_id = ${orgId} and code = ${code}
       for update`);
    const before = beforeResult.rows[0] ?? null;
    const result = (await tx.execute(sql`
      insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
      values (${orgId}, ${code}, ${text(body, "name", true)!}, ${text(body, "description")}, ${policyType},
              ${JSON.stringify(object(body, "rules"))}::jsonb, ${isActive}, ${actorId}, ${actorId})
      on conflict (org_id, code) do update set name = excluded.name, description = excluded.description,
        policy_type = excluded.policy_type, rules = excluded.rules, is_active = excluded.is_active,
        updated_at = now(), updated_by = excluded.updated_by
      where close_policies.org_id = ${orgId} returning *`)) as { rows: Array<Record<string, unknown>> };
    const after = result.rows[0];
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
      ? await tx.execute(sql`
          select * from close_automation_rules
           where id = ${id} and org_id = ${orgId}
           for update`)
      : { rows: [] as Record<string, unknown>[] };
    const before = beforeResult.rows[0] ?? null;
    if (id && !before) throw new CloseError("automation not found");

    const result = (id
      ? await tx.execute(sql`
          update close_automation_rules set name = ${text(body, "name", true)!}, trigger = ${trigger}, action = ${action},
            conditions = ${JSON.stringify(object(body, "conditions"))}::jsonb, config = ${JSON.stringify(object(body, "config"))}::jsonb,
            is_active = ${isActive}, updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId}
           returning *`)
      : await tx.execute(sql`
          insert into close_automation_rules
            (org_id, name, trigger, action, conditions, config, is_active, created_by, updated_by)
          values (${orgId}, ${text(body, "name", true)!}, ${trigger}, ${action}, ${JSON.stringify(object(body, "conditions"))}::jsonb,
                  ${JSON.stringify(object(body, "config"))}::jsonb, ${isActive}, ${actorId}, ${actorId})
          returning *`)) as { rows: Array<Record<string, unknown>> };
    const after = result.rows[0];
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
      !report
      || typeof report !== "object"
      || Array.isArray(report)
      || typeof (report as Record<string, unknown>).slug !== "string"
      || !(report as Record<string, unknown>).slug
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
      const existing = await tx.execute(sql`
        select * from close_reporting_packages
         where id = ${id} and org_id = ${orgId}
         for update`);
      if (!existing.rows[0]) throw new CloseError("reporting package not found");
      before = existing.rows[0] as Record<string, unknown>;
    }
    if (isDefault)
      await tx.execute(
        sql`update close_reporting_packages set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    if (id) {
      const updated = (await tx.execute(sql`update close_reporting_packages set name = ${text(body, "name", true)!}, description = ${text(body, "description")},
        reports = ${JSON.stringify(reports)}::jsonb,
        recipients = ${JSON.stringify(recipients)}::jsonb,
        delivery = ${JSON.stringify(object(body, "delivery"))}::jsonb, is_default = ${isDefault},
        is_active = ${isActive}, updated_at = now(), updated_by = ${actorId}
        where id = ${id} and org_id = ${orgId}
        returning *`)) as { rows: Array<Record<string, unknown>> };
      const after = updated.rows[0];
      if (!after) throw new CloseError("reporting package not found");
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'close_reporting_packages', ${id}, 'update',
                ${JSON.stringify({ before, after })}::jsonb, ${actorId})`);
      return id;
    }
    const result = (await tx.execute(sql`insert into close_reporting_packages
      (org_id, name, description, reports, recipients, delivery, is_default, is_active, created_by, updated_by)
      values (${orgId}, ${text(body, "name", true)!}, ${text(body, "description")},
              ${JSON.stringify(reports)}::jsonb,
              ${JSON.stringify(recipients)}::jsonb,
              ${JSON.stringify(object(body, "delivery"))}::jsonb, ${isDefault}, ${isActive}, ${actorId}, ${actorId}) returning *`)) as { rows: Array<Record<string, unknown>> };
    const after = result.rows[0];
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
      if (typeof payload === "object" && payload !== null && "action" in payload && typeof payload.action === "string") action = payload.action;
    } catch {
      // The declared body schema answers malformed bodies once scope passes.
    }
    if (action !== "set-lock") {
      const denied = guardCloseScope(session);
      if (denied) return denied;
    }
    return session;
  },
  feature: { none: "Close has no route-wide feature gate; the handler enforces per-action permission, close scope, and the Advanced close feature." },
  body: requestBodySchema,
  handler: async ({ body: parsedBody, authz: routeAuthz }) => {
    const body = parsedBody as Body;




    const action = typeof body.action === "string" ? body.action : "";
    const permission = [
      "request-reopen",
      "decide-reopen",
      "reclose-reopen",
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
      const advancedActions = new Set(["save-blueprint", "save-policy", "save-automation", "save-package", "send-package"]);
      if (advancedActions.has(action) && !(await isFeatureEnabled(orgId, "advancedClose"))) {
        throw new CloseError("enable Advanced close controls to manage blueprints, policies, automation, or reporting packages");
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
          ...(await generateAccountingPeriods(
            orgId,
            calendarId,
            Number(body.fiscalYear),
            actorId,
          )),
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
          const { closeDeliveryManualJobId, enqueueCloseDelivery } = await import("@openbooks/jobs");
          await enqueueCloseDelivery(
            { orgId, packageId, periodId, bookId, senderId: actorId, manualTrigger: true, idempotencyKey },
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
        const state = text(body, "state", true)! as
          "open" | "soft_closed" | "closed";
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
        await setPeriodLockState({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          module,
          state,
          actorId,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: true });
      }
      if (action === "close-period") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (
          !isUuid(periodId) ||
          !isUuid(bookId) ||
          (subsidiaryId && !isUuid(subsidiaryId))
        )
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
        const { results } = await closePeriodAllModules({
          orgId,
          periodId,
          bookId,
          subsidiaryId: subsidiaryId ?? undefined,
          actorId,
          state: scoped.state ?? "closed",
          modules: scoped.modules,
          moduleReasons: scoped.moduleReasons,
          reason: text(body, "reason", true)!,
        });
        return NextResponse.json({ ok: results.every((result) => result.ok), results });
      }
      if (action === "request-reopen") {
        const periodId = text(body, "periodId", true)!;
        const bookId = text(body, "bookId", true)!;
        const subsidiaryId = text(body, "subsidiaryId");
        if (
          !isUuid(periodId) ||
          !isUuid(bookId) ||
          (subsidiaryId && !isUuid(subsidiaryId))
        )
          throw new CloseError("invalid reopen scope");
        const modules = Array.isArray(body.modules)
          ? body.modules.filter(
              (item): item is CloseModule =>
                typeof item === "string" &&
                CLOSE_MODULES.includes(item as CloseModule),
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
        });
        return NextResponse.json({ ok: true, requestId });
      }
      if (action === "decide-reopen") {
        const requestId = text(body, "requestId", true)!;
        if (!isUuid(requestId)) throw new CloseError("invalid reopen request");
        await decidePeriodReopen({
          orgId,
          requestId,
          actorId,
          approve: body.approve === true,
          hours: body.hours == null ? undefined : Number(body.hours),
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
      return NextResponse.json(
        { error: "unknown close setup action" },
        { status: 400 },
      );
    } catch (error) {
      if (error instanceof CloseError)
        return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
