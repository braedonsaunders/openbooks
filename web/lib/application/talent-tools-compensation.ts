import "server-only";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";
import { ApplicationError, invalidInput } from "./errors";
import { talentCommand, type TalentCommandInput } from "./talent-tools-shared";
import {
  createCycleBody,
  setBudgetsBody,
  compCycleActionBody,
  cycleLineBody,
  createStatementBody,
  createPlanBody,
  createPlanLineBody,
  headcountPlanActionBody,
  approveHeadcountPlanLineBody,
  generateSnapshotBody,
  requestPayInfoBody,
  payInformationDecisionBody,
  compensationSettingsBody,
} from "@/app/api/hrm/compensation/bodies";
import { MERIT_CYCLES_NEED_PAYROLL } from "@openbooks/engine/hrm/compensation/errors";
import {
  createCycle,
  setCycleBudgets,
  openCycle,
  submitCycleForApproval,
  pushCycle,
  closeCycle,
  cancelCycle,
  getCycle,
  proposeLine,
  approveLine,
  reopenLine,
} from "@openbooks/engine/hrm/compensation/cycles";
import { generateStatement } from "@openbooks/engine/hrm/compensation/statements";
import { updateCompensationSettings } from "@openbooks/engine/hrm/compensation/architecture";
import { computeGapSnapshot } from "@openbooks/engine/hrm/compensation/pay-transparency";
import {
  requestPayInformation,
  fulfilPayInformationRequest,
  refusePayInformationRequest,
} from "@openbooks/engine/hrm/compensation/pay-transparency";
import {
  createPlan,
  createPlanLine,
  submitPlan,
  approvePlan,
  closePlan,
  approvePlanLine,
} from "@openbooks/engine/hrm/compensation/headcount-plans";

const FEATURE = "hrmCompensation";
const MANAGE = "hrm.compensation.manage";
const actor = (context: ApplicationContext) => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
});
const href = "/hrm/compensation";
function compensationMutationHref(
  result: Record<string, unknown>,
  input: TalentCommandInput,
): string {
  const idOf = (value: unknown): string | undefined =>
    value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : undefined;
  const type =
    input.recordName === "cycleId"
      ? "cycle"
      : input.recordName === "planId"
        ? "plan"
        : input.recordName === "requestId"
          ? "request"
          : ["cycle", "plan", "snapshot", "statement", "request"].find(
              (key) => idOf(result[key]) !== undefined,
            );
  const id = input.recordId ?? (type ? idOf(result[type]) : undefined);
  const encoded = id ? encodeURIComponent(id) : undefined;
  if (type === "cycle" && encoded) {
    const cycleHref = `/hrm/compensation/cycles/${encoded}`;
    return input.relatedName === "lineId" && input.relatedId
      ? `${cycleHref}?line=${encodeURIComponent(input.relatedId)}`
      : cycleHref;
  }
  if (type === "plan" && encoded) return `/hrm/compensation/plans/${encoded}`;
  if (type === "request") return "/hrm/compensation";
  if (type === "statement") return "/me/compensation";
  if (type === "snapshot") return "/hrm/compensation?tab=pay-gap";
  return href;
}
async function assertMeritPayroll(context: ApplicationContext): Promise<void> {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "payroll"))) {
    throw new ApplicationError("unsupported_operation", MERIT_CYCLES_NEED_PAYROLL, 422);
  }
}

export const COMPENSATION_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  talentCommand({
    name: "create_compensation_cycle",
    title: "Create Compensation Cycle",
    description:
      "Create a merit, promotion, adjustment or cost-of-living compensation cycle with an exact budget and validated guideline. Find currency, department and legal-employer ids with compensation reads; verify the cycle with hrm_compensation.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createCycleBody,
    payloadDescription:
      "Cycle name, kind, effectiveOn, currency, exact decimal budgetTotal, guideline kind/document, optional budget basis and scoped employer/department.",
    href: compensationMutationHref,
    beforeInvoke: assertMeritPayroll,
    invoke: async (context, _input, p) => ({
      cycle: await createCycle({
        ...actor(context),
        name: p.name as string,
        kind: p.kind as "merit" | "promotion" | "adjustment" | "cola",
        effectiveOn: p.effectiveOn as string,
        budgetBasis:
          (p.budgetBasis as "top_down" | "bottom_up" | "combined" | undefined) ?? "combined",
        budgetTotal: (p.budgetTotal as string | null | undefined) ?? null,
        currency: p.currency as string,
        guidelineKind: p.guidelineKind as "matrix" | "formula",
        guideline: p.guideline as Record<string, unknown>,
        scope: (p.scope as Record<string, unknown> | undefined) ?? {},
      }),
    }),
  }),
  talentCommand({
    name: "set_compensation_cycle_budgets",
    title: "Set Compensation Cycle Budgets",
    description:
      "Set exact department or manager budgets before opening a compensation cycle. Find the cycle and owner ids with hrm_compensation and verify the persisted budget rows there.",
    permission: MANAGE,
    featureKey: FEATURE,
    beforeInvoke: assertMeritPayroll,
    recordId: { name: "cycleId", description: "Compensation cycle id from hrm_compensation." },
    bodySchema: setBudgetsBody,
    payloadDescription:
      "Complete budget rows with exact decimal amount strings, ISO currency, and optional department or manager scope.",
    href: compensationMutationHref,
    invoke: async (context, input, p) => {
      await setCycleBudgets({
        ...actor(context),
        cycleId: input.recordId!,
        budgets: p.budgets as never,
      });
      return { ok: true };
    },
  }),
  ...(["open", "submit", "push", "close", "cancel"] as const).map((action) =>
    talentCommand({
      name: `${action}_compensation_cycle`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Compensation Cycle`,
      description: `${action} a compensation cycle through the native approval and payroll lifecycle. Find the cycle id with hrm_compensation; verify state and line outcomes there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "cycleId", description: "Compensation cycle id from hrm_compensation." },
      bodySchema: compCycleActionBody,
      payloadDescription: `Cycle action with action: "${action}"${action === "cancel" ? " and a cancellation reason" : ""}.`,
      destructive: action === "close" || action === "cancel",
      href: compensationMutationHref,
      beforeInvoke: assertMeritPayroll,
      invoke: async (context, input, p) => {
        const common = { ...actor(context), cycleId: input.recordId! };
        if (action === "open") return { ...(await openCycle(common)) };
        if (action === "submit") return { cycle: await submitCycleForApproval(common) };
        if (action === "push") {
          const result = await pushCycle(common);
          return { cycle: await getCycle(common), ...result } as unknown as Record<string, unknown>;
        }
        if (action === "close") return { cycle: await closeCycle(common) };
        const reason = (p.reason as string | undefined)?.trim();
        if (!reason) throw invalidInput("A cancellation reason is required.");
        return { cycle: await cancelCycle({ ...common, reason }) };
      },
    }),
  ),
  talentCommand({
    name: "propose_compensation_cycle_line",
    title: "Propose Compensation Cycle Line",
    description:
      "Propose an exact rate or percentage for a compensation-cycle line under the native guideline and scope checks. Find the cycle and line ids with hrm_compensation, then verify the proposal there.",
    permission: "hrm.compensation.read",
    featureKey: FEATURE,
    recordId: { name: "cycleId", description: "Compensation cycle id from hrm_compensation." },
    relatedId: { name: "lineId", description: "Line id listed in the selected cycle." },
    bodySchema: cycleLineBody,
    payloadDescription:
      "Exact decimal-string proposedPct or proposedRate and optional justification reason.",
    href: compensationMutationHref,
    beforeInvoke: assertMeritPayroll,
    invoke: async (context, input, p) => ({
      line: await proposeLine({
        ...actor(context),
        lineId: input.relatedId!,
        proposedPct: (p.proposedPct as string | null | undefined) ?? null,
        proposedRate: (p.proposedRate as string | null | undefined) ?? null,
        reason: (p.reason as string | null | undefined) ?? null,
      }),
    }),
  }),
  talentCommand({
    name: "approve_compensation_cycle_line",
    title: "Approve Compensation Cycle Line",
    description:
      "Approve a proposed compensation-cycle line as a distinct reviewer. Find the cycle and line ids with hrm_compensation and verify its decision there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "cycleId", description: "Compensation cycle id from hrm_compensation." },
    relatedId: { name: "lineId", description: "Line id listed in the selected cycle." },
    bodySchema: cycleLineBody,
    payloadDescription:
      "Optional exact-decimal decision body and reason accepted by the native line route.",
    href: compensationMutationHref,
    beforeInvoke: assertMeritPayroll,
    invoke: async (context, input, p) => ({
      line: await approveLine({
        ...actor(context),
        lineId: input.relatedId!,
        reason: (p.reason as string | null | undefined) ?? null,
      }),
    }),
  }),
  talentCommand({
    name: "reopen_compensation_cycle_line",
    title: "Reopen Compensation Cycle Line",
    description:
      "Reopen a decided compensation-cycle line with an auditable reason before payroll push. Find the cycle and line ids with hrm_compensation and verify its new state there.",
    permission: "hrm.compensation.approve",
    featureKey: FEATURE,
    recordId: { name: "cycleId", description: "Compensation cycle id from hrm_compensation." },
    relatedId: { name: "lineId", description: "Line id listed in the selected cycle." },
    bodySchema: cycleLineBody,
    payloadDescription: "Required reason for reopening the decided line.",
    href: compensationMutationHref,
    beforeInvoke: assertMeritPayroll,
    invoke: async (context, input, p) => {
      const reason = (p.reason as string | null | undefined)?.trim();
      if (!reason) throw invalidInput("A reason is required to reopen a compensation decision.");
      return { line: await reopenLine({ ...actor(context), lineId: input.relatedId!, reason }) };
    },
  }),
  talentCommand({
    name: "generate_compensation_statement",
    title: "Generate Compensation Statement",
    description:
      "Generate a persisted compensation statement for an employment record and period. Find employment and optional cycle ids with hrm_compensation, then verify the statement through its native read.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createStatementBody,
    payloadDescription: "Employment id, optional cycle id and inclusive periodFrom/periodTo dates.",
    href: compensationMutationHref,
    invoke: async (context, _input, p) => ({
      statement: await generateStatement({
        ...actor(context),
        employmentId: p.employmentId as string,
        cycleId: (p.cycleId as string | null | undefined) ?? null,
        periodFrom: p.periodFrom as string,
        periodTo: p.periodTo as string,
      }),
    }),
  }),
  talentCommand({
    name: "update_compensation_settings",
    title: "Update Compensation Settings",
    description:
      "Update organization-wide compensation policy for comparison attribute, gap threshold, response days, FTE rounding or exact burden rate. Requires unrestricted subsidiary scope; verify effective settings on the Compensation page.",
    permission: MANAGE,
    featureKey: FEATURE,
    unrestrictedScope: true,
    bodySchema: compensationSettingsBody,
    payloadDescription:
      "One or more compensation policy fields; decimal thresholds and burdenRate must be strings and cannot be silently rounded.",
    href: compensationMutationHref,
    invoke: async (context, _input, p) => ({
      settings: (await updateCompensationSettings({
        ...actor(context),
        ...p,
      } as never)) as unknown as Record<string, unknown>,
    }),
  }),
  talentCommand({
    name: "compute_pay_gap_snapshot",
    title: "Compute Pay Gap Snapshot",
    description:
      "Compute a frozen pay-gap snapshot from effective payroll rates as of a date. Find comparison group keys with compensation setup reads, then verify the snapshot through hrm_compensation.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: generateSnapshotBody,
    payloadDescription: "As-of date and the exact groupA/groupB categories to compare.",
    href: compensationMutationHref,
    invoke: async (context, _input, p) => ({
      snapshot: await computeGapSnapshot({
        ...actor(context),
        asOf: p.asOf as string,
        groupA: p.groupA as string,
        groupB: p.groupB as string,
      }),
    }),
  }),
  talentCommand({
    name: "request_own_pay_information",
    title: "Request Own Pay Information",
    description:
      "File a pay-information request for the caller's own employment only. Find the employment id with self-service reads and verify the request through the personal pay-information view.",
    permission: "hrm.self.request",
    featureKey: FEATURE,
    bodySchema: requestPayInfoBody,
    payloadDescription: "Employment id belonging to the signed-in caller.",
    href: "/me/compensation",
    invoke: async (context, _input, p) => ({
      request: await requestPayInformation({
        ...actor(context),
        employmentId: p.employmentId as string,
      }),
    }),
  }),
  ...(["fulfil", "refuse"] as const).map((action) =>
    talentCommand({
      name:
        action === "fulfil" ? "fulfil_pay_information_request" : "refuse_pay_information_request",
      title:
        action === "fulfil" ? "Fulfil Pay Information Request" : "Refuse Pay Information Request",
      description: `${action} a pay-information request through the compensation transparency service. Find the request id with hrm_compensation and verify the response there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: {
        name: "requestId",
        description: "Pay-information request id from hrm_compensation.",
      },
      bodySchema: payInformationDecisionBody,
      payloadDescription: `Decision action with action: "${action}"${action === "refuse" ? " and a reason" : ""}.`,
      destructive: action === "refuse",
      href: compensationMutationHref,
      invoke: async (context, input, p) => {
        if (action === "fulfil")
          return {
            request: await fulfilPayInformationRequest({
              ...actor(context),
              requestId: input.recordId!,
            }),
          };
        const reason = (p.reason as string | null | undefined)?.trim();
        if (!reason) throw invalidInput("A reason is required to refuse the request.");
        return {
          request: await refusePayInformationRequest({
            ...actor(context),
            requestId: input.recordId!,
            reason,
          }),
        };
      },
    }),
  ),
  talentCommand({
    name: "create_headcount_plan",
    title: "Create Headcount Plan",
    description:
      "Create a costed headcount plan for a fiscal period. Verify the persisted plan with hrm_compensation.",
    permission: MANAGE,
    featureKey: FEATURE,
    bodySchema: createPlanBody,
    payloadDescription: "Plan name and fiscal period start/end dates.",
    href: compensationMutationHref,
    invoke: async (context, _input, p) => {
      const from = p.fiscalPeriodFrom as string;
      const to = p.fiscalPeriodTo as string;
      if (to < from) throw invalidInput("fiscalPeriodTo must be on or after fiscalPeriodFrom.");
      return {
        plan: await createPlan({
          ...actor(context),
          name: p.name as string,
          fiscalPeriodFrom: from,
          fiscalPeriodTo: to,
        }),
      };
    },
  }),
  talentCommand({
    name: "add_headcount_plan_line",
    title: "Add Headcount Plan Line",
    description:
      "Add a costed create, backfill, change or informational termination line to a headcount plan. Find employer, position, level and department ids with hrm_compensation, then verify the cost basis on the plan.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "planId", description: "Headcount plan id from hrm_compensation." },
    bodySchema: createPlanLineBody,
    payloadDescription:
      "Line kind/title, legal employer, exact plannedFte decimal string, start date, currency and optional position, level, department, end date and reason.",
    href: compensationMutationHref,
    invoke: async (context, input, p) => ({
      line: await createPlanLine({ ...actor(context), planId: input.recordId!, ...p } as never),
    }),
  }),
  ...(["submit", "approve", "close"] as const).map((action) =>
    talentCommand({
      name: `${action}_headcount_plan`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Headcount Plan`,
      description: `${action} a headcount plan through its governed costing and approval lifecycle. Find the plan id with hrm_compensation and verify its state there.`,
      permission: MANAGE,
      featureKey: FEATURE,
      recordId: { name: "planId", description: "Headcount plan id from hrm_compensation." },
      bodySchema: headcountPlanActionBody,
      payloadDescription: `Headcount-plan action with action: "${action}".`,
      destructive: action === "close",
      href: compensationMutationHref,
      invoke: async (context, input) => {
        const common = { ...actor(context), planId: input.recordId! };
        if (action === "submit") return { plan: await submitPlan(common) };
        if (action === "approve") return { plan: await approvePlan(common) };
        return { plan: await closePlan(common) };
      },
    }),
  ),
  talentCommand({
    name: "approve_headcount_plan_line",
    title: "Approve Headcount Plan Line",
    description:
      "Approve one costed headcount line; create and backfill lines open a requisition through the native recruiting service. Find plan and line ids with hrm_compensation and verify the linked requisition there.",
    permission: MANAGE,
    featureKey: FEATURE,
    recordId: { name: "planId", description: "Headcount plan id from hrm_compensation." },
    relatedId: { name: "lineId", description: "Headcount plan line id from hrm_compensation." },
    bodySchema: approveHeadcountPlanLineBody,
    payloadDescription: "Approval action with action: " + '"approve"' + " and optional reason.",
    href: compensationMutationHref,
    invoke: async (context, input, p) => ({
      line: await approvePlanLine({
        ...actor(context),
        lineId: input.relatedId!,
        reason: (p.reason as string | null | undefined) ?? null,
      }),
    }),
  }),
];
