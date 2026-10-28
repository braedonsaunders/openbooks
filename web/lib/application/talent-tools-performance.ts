import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";
import { settleTalentRefusal, talentCommand, type TalentCommandInput } from "./talent-tools-shared";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { forbidden, notFound } from "./errors";
import { definition } from "./tool-definition";
import { createCycleBody, patchCycleBody } from "@/app/api/hrm/review-cycles/bodies";
import { saveReviewTemplateBody } from "@/app/api/hrm/review-templates/bodies";
import { patchReviewBody } from "@/app/api/hrm/reviews/bodies";
import { createGoalBody, patchGoalBody } from "@/app/api/hrm/goals/bodies";
import { writeFeedbackBody, fulfillRequestBody } from "@/app/api/hrm/feedback/bodies";
import {
  scheduleOneOnOneBody,
  patchOneOnOneBody,
  addOneOnOneItemBody,
  patchOneOnOneItemBody,
} from "@/app/api/hrm/one-on-ones/bodies";
import {
  createCalibrationSessionBody,
  patchCalibrationSessionBody,
  patchCalibrationEntryBody,
} from "@/app/api/hrm/calibration-sessions/bodies";
import {
  recordTalentReviewBody,
  addSuccessionCandidateBody,
} from "@/app/api/hrm/talent-reviews/bodies";
import {
  createSuccessionPlanBody,
  patchSuccessionPlanBody,
} from "@/app/api/hrm/succession-plans/bodies";
import {
  createFrameworkBody,
  patchFrameworkBody,
  createCompetencyBody,
  addCompetencyLevelBody,
  linkCompetencyBody,
} from "@/app/api/hrm/competency-frameworks/bodies";
import {
  createCycle,
  updateCycleManagement,
  openCycle,
  moveToCalibrating,
  closeCycle,
} from "@openbooks/engine/hrm/performance/review-cycles";
import {
  saveReviewDraft,
  submitReview,
  shareReview,
  acknowledgeReview,
  reopenReview,
} from "@openbooks/engine/hrm/performance/reviews";
import {
  createGoal,
  getGoal,
  updateGoalProgress,
  setGoalStatus,
} from "@openbooks/engine/hrm/performance/goals";
import { listGoals } from "@openbooks/engine/hrm/performance/performance-read";
import { listTemplateDocuments, saveTemplateDocument } from "@openbooks/engine/hrm/performance";
import {
  writeFeedback,
  fulfillRequest,
  retractFeedback,
  setFeedbackSettings,
} from "@openbooks/engine/hrm/performance/feedback";
import {
  scheduleOneOnOne,
  holdOneOnOne,
  skipOneOnOne,
  cancelOneOnOne,
  addOneOnOneItem,
  setOneOnOneItemDone,
} from "@openbooks/engine/hrm/performance/one-on-ones";
import {
  createCalibrationSession,
  openCalibrationSession,
  closeCalibrationSession,
  setCalibratedRating,
  setPotential,
  revertEntry,
} from "@openbooks/engine/hrm/performance/calibration";
import {
  recordTalentReview,
  createSuccessionPlan,
  listTalentReviews,
  listSuccessionPlans,
  setSuccessionPlanStatus,
  setSuccessionPlanNotes,
  addSuccessionCandidate,
  removeSuccessionCandidate,
} from "@openbooks/engine/hrm/performance/talent";
import {
  createFramework,
  getFramework,
  setFrameworkActive,
  createCompetency,
  addCompetencyLevel,
  linkCompetency,
  setSectionCompetency,
} from "@openbooks/engine/hrm/performance/competencies";

const HRM = "hrm";
const FEATURE = "hrmPerformance";
const MANAGE = "hrm.performance.manage";
const TEMPLATE_READ_PERMISSIONS = ["admin.setup.manage", MANAGE, "hrm.performance.read"];
const SELF_OR_MANAGER = ["hrm.self.request", MANAGE];
const SELF_OR_MANAGER_READ = ["hrm.self.read", "hrm.performance.read"];
const actor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
});
function assertAnyApplicationPermission(context: ApplicationContext, permissions: string[]): void {
  const granted = permissions.find((permission) => can(context.authz, permission));
  if (!granted) throw forbidden(permissions.join(" or "));
  assertApplicationPermission(context, granted);
}
const href = "/hrm/performance";
function performanceMutationHref(
  result: Record<string, unknown>,
  input: TalentCommandInput,
): string {
  const idOf = (value: unknown): string | undefined =>
    value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : undefined;
  const keys = ["cycle", "review", "goal", "feedback", "oneOnOne", "session", "plan", "template"];
  const resultKey = keys.find((key) => idOf(result[key]) !== undefined);
  const type =
    input.recordName === "cycleId"
      ? "cycle"
      : input.recordName === "reviewId"
        ? "review"
        : input.recordName === "goalId"
          ? "goal"
          : input.recordName === "feedbackId"
            ? "feedback"
            : input.recordName === "oneOnOneId"
              ? "oneOnOne"
              : input.recordName === "sessionId"
                ? "session"
                : input.recordName === "entryId"
                  ? "entry"
                  : input.recordName === "planId"
                    ? "plan"
                    : resultKey;
  const value = type ? result[type] : undefined;
  const id = input.recordId ?? idOf(value);
  const encoded = id ? encodeURIComponent(id) : undefined;
  if (
    !input.recordName &&
    result.review &&
    typeof result.review === "object" &&
    "cycleId" in result.review &&
    typeof result.review.cycleId === "string"
  ) {
    return `${href}?tab=talent&talentCycle=${encodeURIComponent(result.review.cycleId)}`;
  }
  if (type === "cycle" && encoded) return `${href}?cycle=${encoded}`;
  if (type === "review" && encoded) return `${href}?review=${encoded}`;
  if (type === "goal" && encoded) return `/hrm/performance/goals?goal=${encoded}`;
  if (type === "feedback") return `${href}?tab=feedback`;
  if (type === "oneOnOne" && encoded) return `/hrm/performance/conversations?one=${encoded}`;
  if (type === "session" && encoded) return `${href}?tab=calibration&session=${encoded}`;
  if (type === "entry") return `${href}?tab=calibration`;
  if (type === "plan" && encoded) return `${href}?tab=succession&plan=${encoded}`;
  if (type === "template" && encoded) return `/hrm/performance/templates?template=${encoded}`;
  if (input.relatedName === "lineId" && input.recordId)
    return `${href}?cycle=${encodeURIComponent(input.recordId)}`;
  return href;
}
const bodyNote = (action: string) =>
  `Native ${action} request body; include the required action and fields.`;

export const PERFORMANCE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_review_templates",
    title: "List Review Templates",
    description:
      "List full review-template documents, revisions and publish state. Use this to discover template ids and current revisions before assigning a template to a review cycle.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => TEMPLATE_READ_PERMISSIONS.some((permission) => can(authz, permission)),
    execute: async (context) => {
      try {
        assertAnyApplicationPermission(context, TEMPLATE_READ_PERMISSIONS);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return {
          templates: await listTemplateDocuments({ ...actor(context) }),
          href: "/hrm/performance/templates",
        };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  talentCommand({
    name: "save_review_template",
    title: "Save Review Template",
    description:
      "Create or revise a complete review template, optionally publishing the immutable version for new cycles. Find current ids and revisions with list_review_templates; this organization-wide designer requires unrestricted subsidiary scope.",
    permission: MANAGE,
    featureKey: FEATURE,
    unrestrictedScope: true,
    bodySchema: saveReviewTemplateBody,
    payloadDescription:
      "Optional template id and revision, complete document with rating scale, sections and questions, publish decision, and optional active state.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      template: await saveTemplateDocument({ ...p, ...actor(context) } as never),
    }),
  }),
  definition({
    name: "list_performance_goals",
    title: "List Performance Goals",
    description:
      "List goals visible to the caller, optionally for one employment. Use this to discover goal ids and current progress before updating or closing a goal.",
    inputSchema: z.object({
      employmentId: z
        .string()
        .regex(UUID_RE)
        .optional()
        .describe("Optional employment id from HRM workforce reads."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: HRM,
    visibleTo: (authz) => SELF_OR_MANAGER_READ.some((permission) => can(authz, permission)),
    execute: async (context, input) => {
      try {
        assertAnyApplicationPermission(context, SELF_OR_MANAGER_READ);
        if (!(await isFeatureEnabled(context.authz.user.orgId, HRM))) throw notFound(HRM);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return { goals: await listGoals({ ...actor(context), employmentId: input.employmentId }) };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "get_performance_goal",
    title: "Get Performance Goal",
    description:
      "Read a goal and its progress history through the caller's native goal scope. Find its id with list_performance_goals before updating progress or status.",
    inputSchema: z.object({
      goalId: z.string().regex(UUID_RE).describe("Goal id from list_performance_goals."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: HRM,
    visibleTo: (authz) => SELF_OR_MANAGER_READ.some((permission) => can(authz, permission)),
    execute: async (context, input) => {
      try {
        assertAnyApplicationPermission(context, SELF_OR_MANAGER_READ);
        if (!(await isFeatureEnabled(context.authz.user.orgId, HRM))) throw notFound(HRM);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return getGoal({ ...actor(context), goalId: input.goalId });
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "list_talent_reviews",
    title: "List Talent Reviews",
    description:
      "List talent reviews visible to the caller, optionally for a review cycle. Use this to discover review ids and their current assessment before succession planning.",
    inputSchema: z.object({
      cycleId: z
        .string()
        .regex(UUID_RE)
        .optional()
        .describe("Optional review cycle id from hrm_performance_cycles."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, MANAGE),
    execute: async (context, input) => {
      try {
        assertApplicationPermission(context, MANAGE);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return {
          talentReviews: await listTalentReviews({
            ...actor(context),
            ...(input.cycleId ? { cycleId: input.cycleId } : {}),
          }),
        };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  definition({
    name: "list_succession_plans",
    title: "List Succession Plans",
    description:
      "List succession plans and their candidate sets. Use this to discover plan and candidate ids before changing plan status or membership.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: FEATURE,
    visibleTo: (authz) => can(authz, MANAGE),
    execute: async (context) => {
      try {
        assertApplicationPermission(context, MANAGE);
        if (!(await isFeatureEnabled(context.authz.user.orgId, FEATURE))) throw notFound(FEATURE);
        return { plans: await listSuccessionPlans(actor(context)) };
      } catch (error) {
        settleTalentRefusal(error);
      }
    },
  }),
  talentCommand({
    name: "create_review_cycle",
    title: "Create Review Cycle",
    description:
      "Create a performance review cycle from an active review template and effective period. Find template and legal-entity ids with HRM setup reads, then verify the cycle with hrm_performance_cycles.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createCycleBody,
    payloadDescription:
      "Cycle name, templateId, periodStartOn, periodEndOn, optional self and manager due dates, appliesTo scope, and manager-review requirement.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      cycle: await createCycle({
        ...actor(context),
        templateId: p.templateId as string,
        name: p.name as string,
        periodStartOn: p.periodStartOn as string,
        periodEndOn: p.periodEndOn as string,
        selfDueOn: (p.selfDueOn as string | null | undefined) ?? null,
        managerDueOn: (p.managerDueOn as string | null | undefined) ?? null,
        appliesTo: (p.appliesTo as Record<string, unknown> | undefined) ?? {},
        requireManagerReviews: p.requireManagerReviews as boolean | undefined,
      }),
    }),
  }),
  ...(["update", "assign-reviewer", "open", "to-calibrating", "close"] as const).map((action) =>
    talentCommand({
      name:
        action === "open"
          ? "launch_review_cycle"
          : action === "to-calibrating"
            ? "move_review_cycle_to_calibration"
            : action === "close"
              ? "close_review_cycle"
              : action === "update"
                ? "update_review_cycle"
                : "assign_review_cycle_reviewer",
      title:
        action === "open"
          ? "Launch Review Cycle"
          : action === "to-calibrating"
            ? "Move Review Cycle to Calibration"
            : action === "close"
              ? "Close Review Cycle"
              : action === "update"
                ? "Update Review Cycle"
                : "Assign Review Cycle Reviewer",
      description: `${action === "open" ? "Launch" : action === "to-calibrating" ? "Move" : action === "close" ? "Close" : action === "update" ? "Update" : "Assign a reviewer to"} a performance review cycle through its governed lifecycle. Find the cycle, employment and reviewer ids with hrm_performance_cycles, then verify the cycle state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "cycleId", description: "Review cycle id from hrm_performance_cycles." },
      bodySchema: patchCycleBody,
      payloadDescription: bodyNote(action),
      destructive: action === "close",
      href: performanceMutationHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const common = { ...actor(context), cycleId: input.recordId! };
        if (action === "update" || action === "assign-reviewer")
          return { management: await updateCycleManagement({ ...body, ...common } as never) };
        if (action === "open") return { ...(await openCycle(common)) };
        if (action === "to-calibrating")
          return {
            cycle: await moveToCalibrating({
              ...common,
              force: body.force as boolean | undefined,
              forceReason: body.forceReason as string | undefined,
            }),
          };
        return { cycle: await closeCycle(common) };
      },
    }),
  ),
  ...(["save-draft", "submit", "share", "acknowledge", "reopen"] as const).map((action) =>
    talentCommand({
      name:
        action === "save-draft"
          ? "save_review_draft"
          : action === "submit"
            ? "submit_review"
            : action === "share"
              ? "share_review"
              : action === "acknowledge"
                ? "acknowledge_review"
                : "reopen_review",
      title:
        action === "save-draft"
          ? "Save Review Draft"
          : `${action[0]!.toUpperCase()}${action.slice(1)} Review`,
      description: `${action} a review using the assigned reviewer or subject identity and the persisted revision. Find the review id and revision with hrm_performance_cycles, then verify its lifecycle state there.`,
      permission: null,
      permissionAnyOf: SELF_OR_MANAGER,
      featureKey: FEATURE,
      recordId: { name: "reviewId", description: "Review id from hrm_performance_cycles." },
      bodySchema: patchReviewBody,
      payloadDescription: bodyNote(action),
      destructive: action === "reopen",
      href: performanceMutationHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const common = { ...actor(context), reviewId: input.recordId! };
        if (action === "save-draft")
          return {
            review: await saveReviewDraft({
              ...common,
              answers: body.answers,
              overallRating: body.overallRating,
              revision: body.revision,
            } as never),
          };
        if (action === "submit")
          return {
            review: await submitReview({
              ...common,
              revision: body.revision,
              answers: body.answers,
              overallRating: body.overallRating ?? null,
            } as never),
          };
        if (action === "share") return { review: await shareReview(common) };
        if (action === "acknowledge") return { review: await acknowledgeReview(common) };
        return { review: await reopenReview({ ...common, reason: body.reason as string }) };
      },
    }),
  ),
  talentCommand({
    name: "create_goal",
    title: "Create Goal",
    description:
      "Create a goal for an employment record with exact decimal weight and optional review-cycle link. Find employment and cycle ids with HRM performance reads, then verify the goal there.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: HRM,
    requiredFeatureKeys: [FEATURE],
    bodySchema: createGoalBody,
    payloadDescription:
      "Goal fields: employmentId, title, optional description, dueOn, exact decimal weight, and optional cycleId.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      goal: await createGoal({
        ...actor(context),
        employmentId: p.employmentId as string,
        title: p.title as string,
        description: (p.description as string | null | undefined) ?? null,
        dueOn: (p.dueOn as string | null | undefined) ?? null,
        weight: (p.weight as string | null | undefined) ?? null,
        cycleId: (p.cycleId as string | null | undefined) ?? null,
      }),
    }),
  }),
  ...(["progress", "achieve", "miss", "cancel"] as const).map((action) =>
    talentCommand({
      name: action === "progress" ? "update_goal_progress" : `${action}_goal`,
      title:
        action === "progress"
          ? "Update Goal Progress"
          : `${action[0]!.toUpperCase()}${action.slice(1)} Goal`,
      description: `${action} a performance goal and persist its progress evidence. Find the goal id and current state with HRM performance reads, then verify the updated goal there.`,
      permission: null,
      permissionAnyOf: SELF_OR_MANAGER,
      featureKey: HRM,
      requiredFeatureKeys: [FEATURE],
      recordId: { name: "goalId", description: "Goal id from HRM performance reads." },
      bodySchema: patchGoalBody,
      payloadDescription: bodyNote(action),
      destructive: action === "cancel",
      href: performanceMutationHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; [key: string]: unknown };
        const common = { ...actor(context), goalId: input.recordId! };
        if (action === "progress")
          return {
            goal: await updateGoalProgress({
              ...common,
              progressPercent: body.progressPercent as number,
              note: (body.note as string | null | undefined) ?? null,
            }),
          };
        const status =
          action === "achieve" ? "achieved" : action === "miss" ? "missed" : "cancelled";
        return {
          goal: await setGoalStatus({
            ...common,
            status,
            ...(action === "achieve" ? {} : { note: body.note as string }),
          } as never),
        };
      },
    }),
  ),
  talentCommand({
    name: "write_feedback",
    title: "Write Feedback",
    description:
      "Write praise or feedback for an employment record using the native visibility policy. Find the employment id with HRM performance reads, then verify the feedback in its read view.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: writeFeedbackBody,
    payloadDescription:
      "Feedback subjectEmploymentId, kind, visibility, body, and optional context or requestedFromPartyId.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      feedback: await writeFeedback({
        ...actor(context),
        subjectEmploymentId: p.subjectEmploymentId as string,
        kind: p.kind as string,
        visibility: p.visibility as string,
        body: p.body as string,
        context: (p.context as Record<string, unknown> | null | undefined) ?? null,
        requestedFromPartyId: (p.requestedFromPartyId as string | null | undefined) ?? null,
      } as never),
    }),
  }),
  talentCommand({
    name: "fulfill_feedback_request",
    title: "Fulfill Feedback Request",
    description:
      "Respond to a feedback request with its requested visibility. Find the request id with HRM performance reads and verify the created feedback there.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: fulfillRequestBody,
    payloadDescription: "Feedback requestId, visibility and response body.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      feedback: await fulfillRequest({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "retract_feedback",
    title: "Retract Feedback",
    description:
      "Retract feedback as its author or an authorized HR operator. Find the feedback id with HRM performance reads and verify its retained audit state there.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    recordId: { name: "feedbackId", description: "Feedback id from HRM performance reads." },
    destructive: true,
    href: performanceMutationHref,
    invoke: async (context, input) => ({
      feedback: (await retractFeedback({
        ...actor(context),
        id: input.recordId!,
      })) as unknown as Record<string, unknown>,
    }),
  }),
  talentCommand({
    name: "update_feedback_settings",
    title: "Update Feedback Settings",
    description:
      "Set who may publish public praise across the organization. Requires unrestricted HR scope; verify the effective setting in HRM feedback settings.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    unrestrictedScope: true,
    bodySchema: z.object({
      publicPraiseBy: z
        .enum(["anyone", "managers_and_hr"])
        .describe("Who may publish public praise across the organization."),
    }),
    payloadDescription: "Set publicPraiseBy to anyone or managers_and_hr.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      settings: (await setFeedbackSettings({
        ...actor(context),
        publicPraiseBy: p.publicPraiseBy as "anyone" | "managers_and_hr",
      })) as unknown as Record<string, unknown>,
    }),
  }),
  talentCommand({
    name: "schedule_one_on_one",
    title: "Schedule One-on-One",
    description:
      "Schedule a manager and report one-on-one with optional recurrence. Find both employment ids with HRM performance reads and verify the meeting there.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: scheduleOneOnOneBody,
    payloadDescription:
      "Manager and report employment ids, timezone-bearing scheduledAt, and optional weekly recurrence.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      oneOnOne: await scheduleOneOnOne({
        ...actor(context),
        managerEmploymentId: p.managerEmploymentId as string,
        reportEmploymentId: p.reportEmploymentId as string,
        scheduledAt: p.scheduledAt as string,
        recurrence:
          p.recurrence === undefined || p.recurrence === null
            ? null
            : {
                every_weeks: (p.recurrence as { every_weeks: number }).every_weeks,
                weekday: (p.recurrence as { weekday: number }).weekday,
                time: (p.recurrence as { time?: string | null }).time ?? undefined,
              },
      } as never),
    }),
  }),
  ...(["hold", "skip", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_one_on_one`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} One-on-One`,
      description: `${action} a scheduled one-on-one while preserving its agenda history. Find the meeting id with HRM performance reads and verify its state there.`,
      permission: null,
      permissionAnyOf: SELF_OR_MANAGER,
      featureKey: FEATURE,
      requiredFeatureKeys: [HRM],
      recordId: { name: "oneOnOneId", description: "One-on-one id from HRM performance reads." },
      bodySchema: patchOneOnOneBody,
      payloadDescription: bodyNote(action),
      destructive: action === "cancel",
      href: performanceMutationHref,
      invoke: async (context, input, p) => {
        const body = p as { action: string; reason?: string };
        const common = { ...actor(context), id: input.recordId! };
        if (action === "hold") return { oneOnOne: await holdOneOnOne(common) };
        if (action === "skip")
          return { oneOnOne: await skipOneOnOne({ ...common, reason: body.reason! }) };
        await cancelOneOnOne(common);
        return { ok: true };
      },
    }),
  ),
  talentCommand({
    name: "add_one_on_one_item",
    title: "Add One-on-One Item",
    description:
      "Add a shared/private talking point, note, or action item to a one-on-one. Find the meeting and assignee ids with HRM performance reads; verify the item in that meeting.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    recordId: { name: "oneOnOneId", description: "One-on-one id from hrm_one_on_ones." },
    bodySchema: addOneOnOneItemBody,
    payloadDescription: "Item kind, body, visibility, optional assigneePartyId and dueOn.",
    href: performanceMutationHref,
    invoke: async (context, input, p) => ({
      item: await addOneOnOneItem({
        ...actor(context),
        oneOnOneId: input.recordId!,
        ...p,
      } as never),
    }),
  }),
  talentCommand({
    name: "set_one_on_one_item_done",
    title: "Set One-on-One Item Done",
    description:
      "Mark an action item done or reopen it. Find the meeting and item ids with HRM performance reads, then verify the item state there.",
    permission: null,
    permissionAnyOf: SELF_OR_MANAGER,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    recordId: { name: "oneOnOneId", description: "One-on-one id from HRM performance reads." },
    bodySchema: patchOneOnOneItemBody,
    payloadDescription: "Item id and done boolean.",
    href: performanceMutationHref,
    invoke: async (context, input, p) => {
      await setOneOnOneItemDone({ ...actor(context), oneOnOneId: input.recordId!, ...p } as never);
      return { ok: true };
    },
  }),
  talentCommand({
    name: "create_calibration_session",
    title: "Create Calibration Session",
    description:
      "Create a calibration session for a review cycle and facilitator. Find cycle and facilitator ids with HRM performance reads, then verify the session there.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createCalibrationSessionBody,
    payloadDescription: "Cycle id, session name, optional scope and facilitatorPartyId.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      session: await createCalibrationSession({
        ...actor(context),
        cycleId: p.cycleId as string,
        name: p.name as string,
        scope: (p.scope as Record<string, unknown> | null | undefined) ?? null,
        facilitatorPartyId: (p.facilitatorPartyId as string | null | undefined) ?? null,
      }),
    }),
  }),
  ...(["open", "close"] as const).map((action) =>
    talentCommand({
      name: `${action}_calibration_session`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Calibration Session`,
      description: `${action} a calibration session after confirming its cycle and entry set. Find the session id with HRM performance reads, then verify the resulting state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "sessionId", description: "Calibration session id from hrm_calibration." },
      bodySchema: patchCalibrationSessionBody,
      payloadDescription: `Calibration session action with action: "${action}".`,
      destructive: action === "close",
      href: performanceMutationHref,
      invoke: async (context, input) => ({
        session: (await (action === "open" ? openCalibrationSession : closeCalibrationSession)({
          ...actor(context),
          id: input.recordId!,
        })) as unknown as Record<string, unknown>,
      }),
    }),
  ),
  ...(["rate", "potential", "revert"] as const).map((action) =>
    talentCommand({
      name:
        action === "rate"
          ? "set_calibrated_rating"
          : action === "potential"
            ? "set_calibration_potential"
            : "revert_calibration_entry",
      title:
        action === "rate"
          ? "Set Calibrated Rating"
          : action === "potential"
            ? "Set Calibration Potential"
            : "Revert Calibration Entry",
      description: `${action} a calibration entry and preserve its decision evidence. Find the entry id with HRM performance reads; verify the rating, potential or reverted state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      requiredFeatureKeys: [HRM],
      recordId: { name: "entryId", description: "Calibration entry id from hrm_calibration." },
      bodySchema: patchCalibrationEntryBody,
      payloadDescription: bodyNote(action),
      destructive: action === "revert",
      href: performanceMutationHref,
      invoke: async (context, input, p) => {
        const body = p as {
          calibratedRating?: string;
          justification?: string;
          potentialKey?: string;
          reason?: string;
        };
        const common = { ...actor(context), entryId: input.recordId! };
        if (action === "rate")
          return {
            entry: (await setCalibratedRating({
              ...common,
              calibratedRating: body.calibratedRating!,
              justification: body.justification!,
            })) as unknown as Record<string, unknown>,
          };
        if (action === "potential") {
          await setPotential({ ...common, potentialKey: body.potentialKey! });
          return { ok: true };
        }
        await revertEntry({ ...common, reason: body.reason! });
        return { ok: true };
      },
    }),
  ),
  talentCommand({
    name: "record_talent_review",
    title: "Record Talent Review",
    description:
      "Record a nine-box performance/potential assessment and loss-risk evidence for an employment record. Find employment and cycle ids with HRM performance reads; verify it in talent review results.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: recordTalentReviewBody,
    payloadDescription:
      "Employment and cycle ids, performance and potential keys, impact and risk of loss, and optional promotion readiness and notes.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      review: await recordTalentReview({
        ...actor(context),
        employmentId: p.employmentId as string,
        cycleId: p.cycleId as string,
        performanceKey: p.performanceKey as string,
        potentialKey: p.potentialKey as string,
        impactOfLoss: p.impactOfLoss as string,
        riskOfLoss: p.riskOfLoss as string,
        promotionReady: (p.promotionReady as boolean | undefined) ?? false,
        notes: (p.notes as string | null | undefined) ?? null,
      } as never),
    }),
  }),
  talentCommand({
    name: "create_succession_plan",
    title: "Create Succession Plan",
    description:
      "Create a succession plan for a position and optional incumbent. Find the position and employment ids with HRM workforce reads, then verify it in HRM performance reads.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createSuccessionPlanBody,
    payloadDescription: "Position id, optional incumbentEmploymentId and notes.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      plan: await createSuccessionPlan({
        ...actor(context),
        positionId: p.positionId as string,
        incumbentEmploymentId: (p.incumbentEmploymentId as string | null | undefined) ?? null,
        notes: (p.notes as string | null | undefined) ?? null,
      } as never),
    }),
  }),
  talentCommand({
    name: "update_succession_plan",
    title: "Update Succession Plan",
    description:
      "Change one succession-plan status or its notes through the native governed update. Find the plan id with HRM performance reads and verify the change there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "planId", description: "Succession plan id from HRM performance reads." },
    bodySchema: patchSuccessionPlanBody,
    payloadDescription:
      "Exactly one status or notes change, as accepted by the native update route.",
    href: performanceMutationHref,
    invoke: async (context, input, p) => {
      const body = p as { status?: string; notes?: string | null };
      const common = { ...actor(context), id: input.recordId! };
      if (body.status)
        await setSuccessionPlanStatus({
          ...common,
          status: body.status as "draft" | "active" | "archived",
        });
      else await setSuccessionPlanNotes({ ...common, notes: body.notes ?? null });
      return { ok: true };
    },
  }),
  talentCommand({
    name: "add_succession_candidate",
    title: "Add Succession Candidate",
    description:
      "Add a candidate employment record and readiness estimate to a succession plan. Find plan and employment ids with HRM performance reads; verify the candidate there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "planId", description: "Succession plan id from HRM performance reads." },
    bodySchema: addSuccessionCandidateBody,
    payloadDescription: "Employment id, readiness and optional candidate notes.",
    href: performanceMutationHref,
    invoke: async (context, input, p) => ({
      candidate: await addSuccessionCandidate({
        ...actor(context),
        planId: input.recordId!,
        employmentId: p.employmentId as string,
        readiness: p.readiness as string,
        notes: (p.notes as string | null | undefined) ?? null,
      } as never),
    }),
  }),
  talentCommand({
    name: "remove_succession_candidate",
    title: "Remove Succession Candidate",
    description:
      "Remove a candidate from a succession plan while preserving plan history. Find plan and candidate ids with HRM performance reads and verify the remaining candidate set there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "planId", description: "Succession plan id from HRM performance reads." },
    bodySchema: z.object({
      candidateId: z
        .string()
        .regex(UUID_RE)
        .describe("Succession candidate id from the plan read."),
    }),
    payloadDescription: "Candidate id to remove from the plan.",
    destructive: true,
    href: performanceMutationHref,
    invoke: async (context, input, p) => {
      await removeSuccessionCandidate({
        ...actor(context),
        planId: input.recordId!,
        candidateId: p.candidateId as string,
      });
      return { ok: true };
    },
  }),
  talentCommand({
    name: "create_competency_framework",
    title: "Create Competency Framework",
    description:
      "Create a reusable competency framework for a workforce scope. Find subsidiary and department ids with setup reads, then verify the framework with list_setup_records for hrm-competency-frameworks.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: createFrameworkBody,
    payloadDescription: "Framework name and optional subsidiary or department scope.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      framework: await createFramework({
        ...actor(context),
        name: p.name as string,
        appliesTo: (p.appliesTo as Record<string, unknown> | null | undefined) ?? null,
      }),
    }),
  }),
  talentCommand({
    name: "update_competency_framework",
    title: "Update Competency Framework",
    description:
      "Activate or deactivate a competency framework while preserving its history. Find the framework id with list_setup_records for hrm-competency-frameworks and verify the resulting state there.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    recordId: { name: "frameworkId", description: "Framework id from setup reads." },
    bodySchema: patchFrameworkBody,
    payloadDescription: "Set action to setActive and provide the new isActive boolean.",
    href: performanceMutationHref,
    invoke: async (context, input, p) => {
      await setFrameworkActive({
        ...actor(context),
        id: input.recordId!,
        isActive: p.isActive as boolean,
      });
      return {
        framework: await getFramework({
          ...actor(context),
          id: input.recordId!,
        }),
      };
    },
  }),
  talentCommand({
    name: "create_competency",
    title: "Create Competency",
    description:
      "Add a competency to an existing framework with its reusable code and description. Find framework ids with list_setup_records, then verify the competency under that framework.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: createCompetencyBody,
    payloadDescription:
      "Framework id, competency code and name, and optional description and category.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      competency: await createCompetency({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "add_competency_level",
    title: "Add Competency Level",
    description:
      "Add a ranked expectation to a competency. Find the competency id with list_setup_records for hrm-competencies and verify the new level under its framework.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: addCompetencyLevelBody,
    payloadDescription: "Competency id, positive level rank, level label and expectation text.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => ({
      level: await addCompetencyLevel({ ...actor(context), ...p } as never),
    }),
  }),
  talentCommand({
    name: "link_competency",
    title: "Link Competency",
    description:
      "Link a configured competency to a job level, position or review-template section. Find the competency and target ids with HRM setup reads and verify the link in the target view.",
    permission: MANAGE,
    featureKey: FEATURE,
    requiredFeatureKeys: [HRM],
    bodySchema: linkCompetencyBody,
    payloadDescription: "Link action with competencyId, targetKind and targetId.",
    href: performanceMutationHref,
    invoke: async (context, _input, p) => {
      const body = p as {
        action: string;
        competencyId?: string;
        targetKind?: string;
        targetId?: string;
        sectionId?: string;
        competencyId2?: string | null;
      };
      if (body.action === "link")
        await linkCompetency({
          ...actor(context),
          competencyId: body.competencyId!,
          targetKind: body.targetKind as "job_level" | "position" | "review_template_section",
          targetId: body.targetId!,
        });
      else
        await setSectionCompetency({
          ...actor(context),
          sectionId: body.sectionId!,
          competencyId: body.competencyId ?? null,
        });
      return { ok: true };
    },
  }),
];
