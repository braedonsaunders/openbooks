import { z } from "zod";

/**
 * HR-16 automation trigger / rules / conditions / actions contracts.
 *
 * The trigger jsonb on automations is a zod-validated discriminated union
 * over SIX kinds (storage pins the kind vocabulary in
 * automations_trigger_shape, migration 0226 — the two lists must agree,
 * and trigger-shapes.test.ts pins that). Parsing is fail-closed: an
 * unknown kind, an unknown op, or an unknown field is a REFUSAL, never
 * a silent false — a trigger that cannot be understood must never fire,
 * and a condition that cannot be evaluated must never match.
 */

export const scheduleTrigger = z.object({
  kind: z.literal("schedule"),
  cron: z.string().min(1),
  timezone: z.string().min(1).default("UTC"),
});

export const dateRelativeTrigger = z.object({
  kind: z.literal("date_relative"),
  entity: z.string().min(1),
  dateField: z.string().min(1),
  offsetDays: z.number().int().min(0),
  direction: z.enum(["before", "after"]),
  atTime: z.string().regex(/^\d{2}:\d{2}$/, "at_time must be HH:MM"),
});

export const fieldChangeTrigger = z.object({
  kind: z.literal("field_change"),
  entity: z.string().min(1),
  field: z.string().min(1),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
});

export const eventTrigger = z.object({
  kind: z.literal("event"),
  subjectKind: z.string().min(1),
  eventKind: z.string().min(1),
});

export const documentTrigger = z.object({
  kind: z.literal("document"),
  event: z.enum(["uploaded", "signed", "created_from_template"]),
});

export const manualTrigger = z.object({
  kind: z.literal("manual"),
});

export const automationTrigger = z.discriminatedUnion("kind", [
  scheduleTrigger,
  dateRelativeTrigger,
  fieldChangeTrigger,
  eventTrigger,
  documentTrigger,
  manualTrigger,
]);

export type AutomationTrigger = z.infer<typeof automationTrigger>;

/** WHO the automation applies to: entity scope filters in the 0193
 *  applies_to shape (subsidiary, department, location, worker type,
 *  position) extended with custom-attribute predicates. */
export const automationRules = z.object({
  subsidiaryId: z.string().uuid().nullish(),
  departmentId: z.string().uuid().nullish(),
  locationId: z.string().uuid().nullish(),
  workerType: z.string().nullish(),
  positionId: z.string().uuid().nullish(),
  attributes: z.array(z.object({
    key: z.string().min(1),
    op: z.enum(["eq", "neq", "in"]),
    value: z.unknown(),
  })).default([]),
});

export type AutomationRules = z.infer<typeof automationRules>;

export const CONDITION_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "is_null",
  "changed_to",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

const conditionLeaf = z.object({
  field: z.string().min(1),
  op: z.enum(CONDITION_OPS),
  value: z.unknown().optional(),
});

export type ConditionLeaf = z.infer<typeof conditionLeaf>;

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | ConditionLeaf;

const conditionNode: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNode).min(1) }),
    z.object({ any: z.array(conditionNode).min(1) }),
    conditionLeaf,
  ]),
);

export const automationConditions = z.object({
  root: conditionNode.nullish(),
});

export type AutomationConditions = z.infer<typeof automationConditions>;

export const createTaskAction = z.object({
  kind: z.literal("create_task"),
  ownerKind: z.enum(["role", "person", "manager", "initiator"]),
  owner: z.string().nullish(),
  title: z.string().min(1),
  dueOffsetDays: z.number().int().min(0).default(0),
});

export const sendEmailAction = z.object({
  kind: z.literal("send_email"),
  templateKey: z.string().min(1),
  to: z.string().min(1),
});

export const sendNotificationAction = z.object({
  kind: z.literal("send_notification"),
  to: z.string().min(1),
  body: z.string().min(1),
});

export const startProcessAction = z.object({
  kind: z.literal("start_process"),
  templateId: z.string().uuid(),
});

export const startFlowAction = z.object({
  kind: z.literal("start_flow"),
  subject: z.string().min(1),
});

export const updateFieldAction = z.object({
  kind: z.literal("update_field"),
  entity: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});

export const webhookAction = z.object({
  kind: z.literal("webhook"),
  endpointKey: z.string().min(1),
});

export const delayAction = z.object({
  kind: z.literal("delay"),
  days: z.number().int().min(0),
});

export const approveStepAction = z.object({
  kind: z.literal("approve_step"),
});

export const automationAction = z.discriminatedUnion("kind", [
  createTaskAction,
  sendEmailAction,
  sendNotificationAction,
  startProcessAction,
  startFlowAction,
  updateFieldAction,
  webhookAction,
  delayAction,
  approveStepAction,
]);

export type AutomationAction = z.infer<typeof automationAction>;

export const automationActions = z.array(automationAction).min(1).max(25);

export class AutomationContractError extends Error {}

/** Parse-or-refuse for every automation authoring surface (API, tick). */
export function parseAutomationTrigger(raw: unknown): AutomationTrigger {
  const parsed = automationTrigger.safeParse(raw);
  if (!parsed.success) {
    throw new AutomationContractError(
      `automation trigger is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — fix the trigger and save again`,
    );
  }
  return parsed.data;
}

export function parseAutomationRules(raw: unknown): AutomationRules {
  const parsed = automationRules.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AutomationContractError(
      `automation rules are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — fix who the automation applies to and save again`,
    );
  }
  return parsed.data;
}

export function parseAutomationConditions(raw: unknown): AutomationConditions {
  const parsed = automationConditions.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new AutomationContractError(
      `automation conditions are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — fix the when-clause and save again`,
    );
  }
  return parsed.data;
}

export function parseAutomationActions(raw: unknown): AutomationAction[] {
  const parsed = automationActions.safeParse(raw ?? []);
  if (!parsed.success) {
    throw new AutomationContractError(
      `automation actions are invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")} — an automation needs at least one valid action; fix the action list and save again`,
    );
  }
  return parsed.data;
}

/**
 * Publish-time refusal for actions the builder vocabulary names but the
 * executor cannot deliver. Parsing stays purely syntactic (old stored rows
 * must still READ); publishing (create / update / enable) and execution
 * refuse through this one wording so the remedy is identical everywhere.
 */
export function unsupportedAutomationActionRefusal(action: AutomationAction): string | null {
  if (action.kind === "delay") {
    // Runs execute their actions immediately in one transaction: there is
    // no deferred continuation store and the tick never resumes partial
    // runs, so a delay could not pause later actions — they would all run
    // at once while the step text claimed a pause.
    return (
      `delay action of ${action.days} day(s) cannot run: automation runs execute all actions immediately with no resumable continuation, ` +
      `so later actions would run at once instead of waiting — remove the delay action and stage the work with a second automation on a schedule or date_relative trigger instead`
    );
  }
  if (action.kind === "approve_step") {
    // Approval gates are minted by configured approval flows with quorum,
    // delegation, and separation-of-duties semantics (flows/gates.ts); an
    // automation step cannot mint or decide one, so the step would report
    // success while no approval ever existed.
    return (
      `approve_step action cannot run: automations cannot mint approval gates — approvals live in the record's own approval flow, ` +
      `decided in Approvals — remove the approve_step action and route the record through submit-for-approval instead`
    );
  }
  if (action.kind === "start_flow") {
    // Flows start from their own graph triggers; there is no named-flow
    // dispatch entrypoint an automation could call, so the step would
    // report success while no flow ever started.
    return (
      `start_flow action for '${action.subject}' cannot run: flows start only from their own triggers and expose no named dispatch, ` +
      `so no flow would ever start — remove the start_flow action and configure the flow's own trigger instead`
    );
  }
  if (action.kind === "webhook") {
    // There is no outbound webhook transport: no outbox kind, no worker,
    // no endpoint caller anywhere in the engine carries automation
    // webhooks (the only webhook code is inbound payments). Enqueuing the
    // call as a flow email with no recipients fails every run with an
    // email-validation error, so the honest behavior is a named refusal.
    return (
      `webhook action to endpoint '${action.endpointKey}' cannot run: automations have no outbound webhook transport, ` +
      `so the call would never leave OpenBooks — remove the webhook action and use send_notification, send_email, or create_task instead`
    );
  }
  return null;
}

/** Refuse publishing any action the executor cannot deliver, naming the remedy. */
export function assertPublishableAutomationActions(actions: AutomationAction[]): void {
  for (const action of actions) {
    const refusal = unsupportedAutomationActionRefusal(action);
    if (refusal) {
      throw new AutomationContractError(`${refusal} — fix the action list and save again`);
    }
  }
}
