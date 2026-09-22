import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { featureEnabled } from "../organization/feature-registry.ts";
import { AUTOMATION_STATUSES } from "@openbooks/schema/src/hrm-automations.ts";
import {
  assertPublishableAutomationActions,
  parseAutomationActions,
  parseAutomationConditions,
  parseAutomationRules,
  parseAutomationTrigger,
} from "./triggers.ts";
import type { ApprovalSettings } from "./approvals.ts";

/**
 * HR-16 automation recipe CRUD + approval-settings writes + shipped recipes.
 *
 * Every edit bumps version (runs record the version they executed).
 * Status transitions validate: enabling requires a valid trigger and at
 * least one action (parse-or-refuse up front, so a broken recipe can
 * never be enabled). Authorization: automations.read / automations.manage
 * (built-in admin roles, not HR roles).
 */

export class AutomationServiceError extends Error {}

/**
 * Engine-side feature read (orgs.settings.features, registry defaults).
 * API routes 404 first, but the tick and the executor refuse here too —
 * a switched-off capability never fires, no matter the caller.
 */
export async function automationsFeatureOn(orgId: string): Promise<boolean> {
  return hrmFeatureOn(orgId, "automations");
}

export async function hrmFeatureOn(orgId: string, key: string): Promise<boolean> {
  const rows = await db.execute<{ features: Record<string, boolean> | null }>(sql`
    select settings -> 'features' as features from orgs where id = ${orgId} limit 1
  `);
  const features = rows.rows[0]?.features ?? {};
  return featureEnabled(features, key);
}

const automationBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  trigger: z.unknown(),
  rules: z.unknown().nullish(),
  conditions: z.unknown().nullish(),
  actions: z.unknown(),
  priority: z.number().int().min(0).max(1000).default(100),
});

export type AutomationDTO = {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  status: string;
  trigger: unknown;
  rules: unknown;
  conditions: unknown;
  actions: unknown;
  priority: number;
  lastRunAt: string | null;
  errorMessage: string | null;
  version: number;
};

async function requireAutomations(orgId: string, actorId: string, permission: "automations.read" | "automations.manage"): Promise<void> {
  const ok = await actorHasPermission(db, orgId, actorId, permission);
  if (!ok) {
    throw new AutomationServiceError(
      `automations require the ${permission} permission — ask an administrator to grant it in /admin/roles`,
    );
  }
}

export async function listAutomations(orgId: string, actorId: string): Promise<AutomationDTO[]> {
  await requireAutomations(orgId, actorId, "automations.read");
  return withOrg(orgId, async () => {
    const rows = await db.execute<AutomationDTO>(sql`
      select id, org_id as "orgId", name, description, status, trigger, rules,
             conditions, actions, priority,
             last_run_at as "lastRunAt", error_message as "errorMessage", version
        from automations where org_id = ${orgId} order by name
    `);
    return rows.rows;
  });
}

export async function createAutomation(input: {
  orgId: string;
  actorId: string;
  name: string;
  description?: string | null;
  trigger: unknown;
  rules?: unknown;
  conditions?: unknown;
  actions: unknown;
  priority?: number;
}): Promise<AutomationDTO> {
  await requireAutomations(input.orgId, input.actorId, "automations.manage");
  const parsed = automationBody.safeParse({
    name: input.name,
    description: input.description,
    trigger: input.trigger,
    rules: input.rules,
    conditions: input.conditions,
    actions: input.actions,
    priority: input.priority ?? 100,
  });
  if (!parsed.success) {
    throw new AutomationServiceError(
      `automation is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  // Parse-or-refuse every recipe part before anything is stored.
  const trigger = parseAutomationTrigger(parsed.data.trigger);
  const rules = parseAutomationRules(parsed.data.rules);
  const conditions = parseAutomationConditions(parsed.data.conditions);
  const actions = parseAutomationActions(parsed.data.actions);
  assertPublishableAutomationActions(actions);
  return withOrgTransaction(input.orgId, async () => {
    const rows = await db.execute<AutomationDTO>(sql`
      insert into automations
        (org_id, name, description, status, trigger, rules, conditions, actions, priority, created_by, updated_by)
      values (${input.orgId}, ${parsed.data.name}, ${parsed.data.description ?? null}, 'draft',
              ${JSON.stringify(trigger)}::jsonb, ${JSON.stringify(rules)}::jsonb,
              ${JSON.stringify(conditions)}::jsonb, ${JSON.stringify(actions)}::jsonb,
              ${parsed.data.priority}, ${input.actorId}, ${input.actorId})
      returning id, org_id as "orgId", name, description, status, trigger, rules,
                conditions, actions, priority,
                last_run_at as "lastRunAt", error_message as "errorMessage", version
    `);
    const row = rows.rows[0];
    if (!row) throw new AutomationServiceError("the automation was not stored — nothing was written; retry the save");
    return row;
  });
}

export async function updateAutomation(input: {
  orgId: string;
  actorId: string;
  automationId: string;
  name?: string;
  description?: string | null;
  trigger?: unknown;
  rules?: unknown;
  conditions?: unknown;
  actions?: unknown;
  priority?: number;
}): Promise<AutomationDTO> {
  await requireAutomations(input.orgId, input.actorId, "automations.manage");
  return withOrgTransaction(input.orgId, async () => {
    const current = await db.execute<{ version: number }>(sql`
      select version from automations where org_id = ${input.orgId} and id = ${input.automationId} for update
    `);
    if (current.rows.length === 0) {
      throw new AutomationServiceError("automation not found — reload the list and try again");
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    void sets;
    void params;
    const patch: Record<string, string> = {};
    if (input.name !== undefined) {
      if (!input.name.trim()) throw new AutomationServiceError("the automation needs a non-blank name");
      patch["name"] = input.name.trim();
    }
    if (input.description !== undefined) patch["description"] = input.description ?? "";
    if (input.trigger !== undefined) patch["trigger"] = JSON.stringify(parseAutomationTrigger(input.trigger));
    if (input.rules !== undefined) patch["rules"] = JSON.stringify(parseAutomationRules(input.rules));
    if (input.conditions !== undefined) patch["conditions"] = JSON.stringify(parseAutomationConditions(input.conditions));
    if (input.actions !== undefined) {
      const actions = parseAutomationActions(input.actions);
      assertPublishableAutomationActions(actions);
      patch["actions"] = JSON.stringify(actions);
    }
    if (input.priority !== undefined) patch["priority"] = String(input.priority);
    const rows = await db.execute<AutomationDTO>(sql`
      update automations
         set name = coalesce(${patch["name"] ?? null}::text, name),
             description = case when ${patch["description"] !== undefined} then ${patch["description"] ?? null}::text else description end,
             trigger = coalesce(${patch["trigger"] ?? null}::jsonb, trigger),
             rules = coalesce(${patch["rules"] ?? null}::jsonb, rules),
             conditions = coalesce(${patch["conditions"] ?? null}::jsonb, conditions),
             actions = coalesce(${patch["actions"] ?? null}::jsonb, actions),
             priority = coalesce(${patch["priority"] ?? null}::int, priority),
             version = version + 1, error_message = null,
             updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${input.automationId}
      returning id, org_id as "orgId", name, description, status, trigger, rules,
                conditions, actions, priority,
                last_run_at as "lastRunAt", error_message as "errorMessage", version
    `);
    const row = rows.rows[0];
    if (!row) throw new AutomationServiceError("the automation changed while saving — reload and try again");
    return row;
  });
}

export async function setAutomationStatus(input: {
  orgId: string;
  actorId: string;
  automationId: string;
  status: "enabled" | "disabled";
}): Promise<AutomationDTO> {
  await requireAutomations(input.orgId, input.actorId, "automations.manage");
  if (!["enabled", "disabled"].includes(input.status)) {
    throw new AutomationServiceError("status must be enabled or disabled — drafts enable, errors re-enable after a fix");
  }
  return withOrgTransaction(input.orgId, async () => {
    const current = await db.execute<{ trigger: unknown; actions: unknown; status: string }>(sql`
      select trigger, actions, status from automations
       where org_id = ${input.orgId} and id = ${input.automationId} for update
    `);
    const row = current.rows[0];
    if (!row) throw new AutomationServiceError("automation not found — reload the list and try again");
    if (input.status === "enabled") {
      // A broken recipe can never be enabled: re-validate on the way in.
      parseAutomationTrigger(row.trigger);
      assertPublishableAutomationActions(parseAutomationActions(row.actions));
    }
    const updated = await db.execute<AutomationDTO>(sql`
      update automations
         set status = ${input.status},
             error_message = case when ${input.status} = 'enabled' then null else error_message end,
             updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${input.automationId}
      returning id, org_id as "orgId", name, description, status, trigger, rules,
                conditions, actions, priority,
                last_run_at as "lastRunAt", error_message as "errorMessage", version
    `);
    const out = updated.rows[0];
    if (!out) throw new AutomationServiceError("the automation changed while saving — reload and try again");
    return out;
  });
}

export async function listAutomationRuns(
  orgId: string,
  actorId: string,
  automationId: string,
  status?: string,
): Promise<{ id: string; status: string; version: number; subjectKind: string | null; createdAt: string }[]> {
  await requireAutomations(orgId, actorId, "automations.read");
  return withOrg(orgId, async () => {
    const rows = await db.execute(sql`
      select id, status, version, subject_kind as "subjectKind", created_at as "createdAt"
        from automation_runs
       where org_id = ${orgId} and automation_id = ${automationId}
         and (${status ?? null}::text is null or status = ${status ?? null}::text)
       order by created_at desc limit 100
    `);
    return rows.rows as { id: string; status: string; version: number; subjectKind: string | null; createdAt: string }[];
  });
}

export async function getAutomationRun(orgId: string, actorId: string, runId: string): Promise<unknown> {
  await requireAutomations(orgId, actorId, "automations.read");
  return withOrg(orgId, async () => {
    const rows = await db.execute(sql`
      select id, automation_id as "automationId", version, trigger_payload as "triggerPayload",
             subject_kind as "subjectKind", subject_id as "subjectId", status,
             started_at as "startedAt", finished_at as "finishedAt", error, steps
        from automation_runs where org_id = ${orgId} and id = ${runId} limit 1
    `);
    const row = rows.rows[0];
    if (!row) throw new AutomationServiceError("run not found — reload the runs tab and try again");
    return row;
  });
}

const approvalSettingsBody = z.object({
  subjectKind: z.string().min(1),
  exceptionOnly: z.boolean(),
  thresholds: z.record(z.string(), z.unknown()).default({}),
  autoApproveWhenNoRule: z.boolean().default(false),
  delegateAfterDays: z.number().int().min(1).nullish(),
  excludeInitiator: z.boolean().default(true),
});

export async function saveApprovalSettings(input: {
  orgId: string;
  actorId: string;
  subjectKind: string;
  exceptionOnly: boolean;
  thresholds?: Record<string, unknown>;
  autoApproveWhenNoRule?: boolean;
  delegateAfterDays?: number | null;
  excludeInitiator?: boolean;
}): Promise<ApprovalSettings & { subjectKind: string }> {
  await requireAutomations(input.orgId, input.actorId, "automations.manage");
  const parsed = approvalSettingsBody.safeParse({
    subjectKind: input.subjectKind,
    exceptionOnly: input.exceptionOnly,
    thresholds: input.thresholds ?? {},
    autoApproveWhenNoRule: input.autoApproveWhenNoRule ?? false,
    delegateAfterDays: input.delegateAfterDays ?? null,
    excludeInitiator: input.excludeInitiator ?? true,
  });
  if (!parsed.success) {
    throw new AutomationServiceError(
      `approval settings are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    const rows = await db.execute(sql`
      insert into automation_approval_settings
        (org_id, subject_kind, exception_only, thresholds, auto_approve_when_no_rule,
         delegate_after_days, exclude_initiator, created_by, updated_by)
      values (${input.orgId}, ${parsed.data.subjectKind}, ${parsed.data.exceptionOnly},
              ${JSON.stringify(parsed.data.thresholds)}::jsonb, ${parsed.data.autoApproveWhenNoRule},
              ${parsed.data.delegateAfterDays}, ${parsed.data.excludeInitiator},
              ${input.actorId}, ${input.actorId})
      on conflict (org_id, subject_kind)
      do update set exception_only = excluded.exception_only, thresholds = excluded.thresholds,
                    auto_approve_when_no_rule = excluded.auto_approve_when_no_rule,
                    delegate_after_days = excluded.delegate_after_days,
                    exclude_initiator = excluded.exclude_initiator,
                    updated_by = excluded.updated_by, updated_at = now()
      returning subject_kind as "subjectKind", exception_only as "exceptionOnly",
                thresholds, auto_approve_when_no_rule as "autoApproveWhenNoRule",
                delegate_after_days as "delegateAfterDays",
                exclude_initiator as "excludeInitiator"
    `);
    // ON CONFLICT here is the settings upsert contract (one row per
    // subject): the conflict is expected and RETURNING re-reads the row.
    const row = rows.rows[0] as (ApprovalSettings & { subjectKind: string }) | undefined;
    if (!row) throw new AutomationServiceError("the settings write matched no row — reload and try again");
    return row;
  });
}

/** Five shipped recipe templates (created disabled-ready as drafts). */
export function automationRecipes(): { key: string; name: string; description: string; trigger: unknown; actions: unknown }[] {
  return [
    {
      key: "welcome_tasks",
      name: "Welcome tasks before start",
      description: "Three days before an employment starts, notify the manager to prepare.",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 3, direction: "before", atTime: "09:00" },
      actions: [{ kind: "send_notification", to: "manager", body: "A new starter joins in 3 days — prepare their workspace and access." }],
    },
    {
      key: "probation_end",
      name: "Probation-end reminder",
      description: "A reminder to the manager when probation approaches its end.",
      trigger: { kind: "date_relative", entity: "employment", dateField: "service_start", offsetDays: 7, direction: "after", atTime: "09:00" },
      actions: [{ kind: "send_notification", to: "manager", body: "Probation review is due — complete the review before the window closes." }],
    },
    {
      key: "qualification_expiring",
      name: "Qualification expiring in 30 days",
      description: "Warns the employee before a qualification lapses (lights up when certifications land).",
      trigger: { kind: "date_relative", entity: "enrollment", dateField: "coverage_to", offsetDays: 30, direction: "before", atTime: "09:00" },
      actions: [{ kind: "send_notification", to: "initiator", body: "A qualification expires in 30 days — renew it to stay compliant." }],
    },
    {
      key: "document_signed_onboarding",
      name: "Document signed starts onboarding",
      description: "When a signed document lands, start the onboarding process for the employment.",
      trigger: { kind: "document", event: "signed" },
      actions: [{ kind: "send_notification", to: "manager", body: "Signed document received — onboarding begins." }],
    },
    {
      key: "timesheet_unsubmitted",
      name: "Timesheet unsubmitted after deadline",
      description: "Nudges the employee when the week's timesheet is still a draft past the deadline.",
      trigger: { kind: "schedule", cron: "0 9 * * MON", timezone: "UTC" },
      actions: [{ kind: "send_notification", to: "initiator", body: "Your timesheet for last week is still unsubmitted — submit it today." }],
    },
  ];
}

export { AUTOMATION_STATUSES };
