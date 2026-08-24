import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  CLOSE_MODULES,
  CloseError,
  decidePeriodReopen,
  generateAccountingPeriods,
  recloseApprovedReopen,
  requestPeriodReopen,
  setPeriodLockState,
  type CloseModule,
} from "@openbooks/engine/src/close.ts";
import { guardPermission } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isFeatureEnabled } from "../../../../lib/features";

export const runtime = "nodejs";

type Body = Record<string, unknown>;

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
  const id =
    typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
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
    if (id) {
      const current = ((await tx.execute(sql`
        select c.*, exists(select 1 from accounting_periods p where p.fiscal_calendar_id = c.id and p.org_id = ${orgId}) as has_periods
          from fiscal_calendars c where c.id = ${id} and c.org_id = ${orgId} for update`)));
      const row = current.rows[0];
      if (!row) throw new CloseError("calendar not found");
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
      await tx.execute(sql`
        update fiscal_calendars set name = ${name}, cadence = ${cadence}, year_start_month = ${yearStartMonth},
               week_starts_on = ${weekStartsOn}, anchor_date = ${anchorDate},
               time_zone = ${text(body, "timeZone") ?? "UTC"},
               adjustment_period_enabled = ${bool(body, "adjustmentPeriodEnabled")},
               is_default = ${isDefault}, is_active = ${body.isActive !== false},
               config = ${JSON.stringify(object(body, "config"))}::jsonb,
               updated_at = now(), updated_by = ${actorId}
         where id = ${id} and org_id = ${orgId}`);
      return id;
    }
    const inserted = (await tx.execute(sql`
      insert into fiscal_calendars
        (org_id, name, cadence, year_start_month, week_starts_on, anchor_date, time_zone,
         adjustment_period_enabled, is_default, is_active, config, created_by, updated_by)
      values (${orgId}, ${name}, ${cadence}, ${yearStartMonth}, ${weekStartsOn}, ${anchorDate},
              ${text(body, "timeZone") ?? "UTC"}, ${bool(body, "adjustmentPeriodEnabled")},
              ${isDefault}, ${body.isActive !== false}, ${JSON.stringify(object(body, "config"))}::jsonb,
              ${actorId}, ${actorId}) returning id`)) as any;
    return inserted.rows[0].id as string;
  });
}

async function saveBlueprint(orgId: string, actorId: string, body: Body) {
  const sourceId =
    typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
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
    if (sourceId) {
      const source = ((await tx.execute(
        sql`select version from close_blueprints where id = ${sourceId} and org_id = ${orgId} for update`,
      )));
      if (!source.rows[0]) throw new CloseError("blueprint not found");
      version = Number(source.rows[0].version) + 1;
      await tx.execute(
        sql`update close_blueprints set is_active = false, is_default = false, updated_at = now(), updated_by = ${actorId} where id = ${sourceId} and org_id = ${orgId}`,
      );
    }
    if (isDefault)
      await tx.execute(
        sql`update close_blueprints set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    const inserted = (await tx.execute(sql`
      insert into close_blueprints
        (org_id, name, description, period_type, is_default, is_active, version, scope_rules, created_by, updated_by)
      values (${orgId}, ${name}, ${description}, ${periodType}, ${isDefault}, true, ${version},
              ${JSON.stringify(object(body, "scopeRules"))}::jsonb, ${actorId}, ${actorId}) returning id`)) as any;
    const blueprintId = inserted.rows[0].id as string;
    const ids = new Map<string, string>();
    for (const step of steps) {
      const result = (await tx.execute(sql`
        insert into close_blueprint_steps
          (org_id, blueprint_id, key, title, description, workstream, task_type, completion_mode,
           gate_type, due_offset_business_days, evidence_required, default_owner_role_key,
           default_reviewer_role_key, sort_order, applicability, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${step.key}, ${step.title}, ${step.description}, ${step.workstream},
                ${step.taskType}, ${step.completionMode}, ${step.gateType}, ${step.dueOffsetBusinessDays},
                ${step.evidenceRequired}, ${step.defaultOwnerRoleKey}, ${step.defaultReviewerRoleKey},
                ${step.sortOrder}, ${JSON.stringify(step.applicability)}::jsonb, ${actorId}, ${actorId}) returning id`)) as any;
      ids.set(step.key, result.rows[0].id as string);
    }
    for (const step of steps)
      for (const dependency of step.dependsOn) {
        await tx.execute(sql`
        insert into close_blueprint_dependencies
          (org_id, blueprint_id, step_id, depends_on_step_id, created_by, updated_by)
        values (${orgId}, ${blueprintId}, ${ids.get(step.key)!}, ${ids.get(dependency)!}, ${actorId}, ${actorId})`);
      }
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
  const result = (await db.execute(sql`
    insert into close_policies (org_id, code, name, description, policy_type, rules, is_active, created_by, updated_by)
    values (${orgId}, ${code}, ${text(body, "name", true)!}, ${text(body, "description")}, ${policyType},
            ${JSON.stringify(object(body, "rules"))}::jsonb, ${body.isActive !== false}, ${actorId}, ${actorId})
    on conflict (org_id, code) do update set name = excluded.name, description = excluded.description,
      policy_type = excluded.policy_type, rules = excluded.rules, is_active = excluded.is_active,
      updated_at = now(), updated_by = excluded.updated_by
    where close_policies.org_id = ${orgId} returning id`)) as any;
  return result.rows[0].id as string;
}

async function saveAutomation(orgId: string, actorId: string, body: Body) {
  const id =
    typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
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
    ].includes(action)
  )
    throw new CloseError("invalid automation action");
  if (id) {
    await db.execute(sql`update close_automation_rules set name = ${text(body, "name", true)!}, trigger = ${trigger}, action = ${action},
      conditions = ${JSON.stringify(object(body, "conditions"))}::jsonb, config = ${JSON.stringify(object(body, "config"))}::jsonb,
      is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${actorId} where id = ${id} and org_id = ${orgId}`);
    return id;
  }
  const result = (await db.execute(sql`insert into close_automation_rules
    (org_id, name, trigger, action, conditions, config, is_active, created_by, updated_by)
    values (${orgId}, ${text(body, "name", true)!}, ${trigger}, ${action}, ${JSON.stringify(object(body, "conditions"))}::jsonb,
            ${JSON.stringify(object(body, "config"))}::jsonb, ${body.isActive !== false}, ${actorId}, ${actorId}) returning id`)) as any;
  return result.rows[0].id as string;
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
  const id =
    typeof body.id === "string" && isUuid(body.id) ? body.id : undefined;
  const isDefault = body.isDefault === true;
  return db.transaction(async (tx) => {
    if (isDefault)
      await tx.execute(
        sql`update close_reporting_packages set is_default = false, updated_at = now(), updated_by = ${actorId} where org_id = ${orgId}`,
      );
    if (id) {
      await tx.execute(sql`update close_reporting_packages set name = ${text(body, "name", true)!}, description = ${text(body, "description")},
        reports = ${JSON.stringify(reports)}::jsonb,
        recipients = ${JSON.stringify(Array.isArray(body.recipients) ? body.recipients : [])}::jsonb,
        delivery = ${JSON.stringify(object(body, "delivery"))}::jsonb, is_default = ${isDefault},
        is_active = ${body.isActive !== false}, updated_at = now(), updated_by = ${actorId}
        where id = ${id} and org_id = ${orgId}`);
      return id;
    }
    const result = (await tx.execute(sql`insert into close_reporting_packages
      (org_id, name, description, reports, recipients, delivery, is_default, is_active, created_by, updated_by)
      values (${orgId}, ${text(body, "name", true)!}, ${text(body, "description")},
              ${JSON.stringify(reports)}::jsonb,
              ${JSON.stringify(Array.isArray(body.recipients) ? body.recipients : [])}::jsonb,
              ${JSON.stringify(object(body, "delivery"))}::jsonb, ${isDefault}, ${body.isActive !== false}, ${actorId}, ${actorId}) returning id`)) as any;
    return result.rows[0].id as string;
  });
}

export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body;
  const action = typeof body.action === "string" ? body.action : "";
  const permission = [
    "request-reopen",
    "decide-reopen",
    "reclose-reopen",
  ].includes(action)
    ? "close.reopen"
    : "periods.manage";
  const gate = await guardPermission(permission);
  if (gate instanceof NextResponse) return gate;
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
      if (!isUuid(packageId) || !isUuid(periodId) || !isUuid(bookId))
        throw new CloseError("invalid send target");
      try {
        const { enqueueCloseDelivery } = await import("@openbooks/jobs");
        await enqueueCloseDelivery({ orgId, packageId, periodId, bookId });
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
      return NextResponse.json({ error: error.message }, { status: 422 });
    throw error;
  }
}
