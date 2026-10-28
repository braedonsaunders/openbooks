import "server-only";
import { z } from "zod";
import {
  activateBenefitProgram,
  addProgramMembership,
  closeBenefitProgram,
  createBenefitAward,
  createBenefitProgram,
  createAdjustingAward,
  queueBenefitAward,
  queueAwardForPayRun,
  recordExternalDelivery,
  recordPayrollDelivery,
  removeProgramMembership,
  saveBenefitTransactionPolicy,
  settleIncentivePeriod,
  submitBenefitAward,
  updateBenefitProgram,
  voidBenefitAward,
  createDependent,
  deactivateDependent,
  linkDependent,
  unlinkDependent,
  updateDependent,
  cancelEnrollment,
  changeEnrollment,
  electEnrollment,
  endEnrollment,
  waiveEnrollment,
  withdrawUnusedEnrollment,
  createEnrollmentWindow,
  closeEnrollmentWindow,
  openEnrollmentWindow,
} from "@openbooks/engine/hrm/benefits";
import {
  describeObjectFields,
  hrmMutation,
  HRM_DATE,
  HRM_UUID,
  hrmShortText,
} from "./hrm-tools-shared";
import type { ApplicationToolDefinition } from "./tool-definition";
import {
  createProgramBody,
  benefitProgramPatchBody,
  addMemberBody,
} from "../../app/api/hrm/benefit-programs/bodies";
import { createAwardBody } from "../../app/api/hrm/benefit-awards/bodies";
import { createWindowBody, closeWindowBody } from "../../app/api/hrm/enrollment-windows/bodies";
import {
  electEnrollmentBody,
  waiveEnrollmentBody,
  changeEnrollmentBody,
  endEnrollmentBody,
  cancelEnrollmentBody,
  withdrawEnrollmentBody,
  linkDependentBody,
} from "../../app/api/hrm/enrollments/bodies";
import { createDependentBody, updateDependentBody } from "../../app/api/hrm/dependents/bodies";

const exactDecimal = (description: string) =>
  z.string().trim().min(1).max(64).describe(description);
const reason = hrmShortText("Reason recorded in the benefits audit trail.", 2000);
const idFor = (name: string) => HRM_UUID.describe(`${name} id from the native HRM Benefits read.`);
const createProgramInput = describeObjectFields(
  createProgramBody.omit({ action: true }).extend({
    effectiveFrom: HRM_DATE,
    effectiveTo: HRM_DATE.nullable().optional(),
    legalEntityId: HRM_UUID.nullable().optional(),
    payComponentId: HRM_UUID.nullable().optional(),
    scopeIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeCustomerIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeDepartmentIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeExcludedProjectIds: z.array(HRM_UUID).max(100).nullable().optional(),
    sourceAccountIds: z.array(HRM_UUID).max(100).nullable().optional(),
  }),
  (key) => `Program ${key} using the validated native Benefits contract.`,
);
const updateProgramInput = describeObjectFields(
  benefitProgramPatchBody.options[0]!.omit({ action: true }).extend({
    effectiveFrom: HRM_DATE.optional(),
    effectiveTo: HRM_DATE.nullable().optional(),
    changeEffectiveFrom: HRM_DATE.optional(),
    legalEntityId: HRM_UUID.nullable().optional(),
    payComponentId: HRM_UUID.nullable().optional(),
    scopeIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeCustomerIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeDepartmentIds: z.array(HRM_UUID).max(100).nullable().optional(),
    scopeExcludedProjectIds: z.array(HRM_UUID).max(100).nullable().optional(),
    sourceAccountIds: z.array(HRM_UUID).max(100).nullable().optional(),
  }),
  (key) => `Effective-dated program update value for ${key}.`,
);
const addMemberInput = describeObjectFields(
  addMemberBody.omit({ action: true }).extend({
    employmentId: HRM_UUID,
    effectiveFrom: HRM_DATE,
    effectiveTo: HRM_DATE.nullable().optional(),
  }),
  (key) => `Program member ${key} using the native membership contract.`,
);
const createAwardInput = describeObjectFields(
  createAwardBody.omit({ action: true }).extend({
    programId: HRM_UUID,
    employmentId: HRM_UUID,
    periodFrom: HRM_DATE,
    periodTo: HRM_DATE.nullable().optional(),
  }),
  (key) => `Benefit award ${key} using the validated native award contract.`,
);
const createWindowInput = describeObjectFields(
  createWindowBody.extend({
    opensOn: HRM_DATE,
    closesOn: HRM_DATE,
    planYearStartOn: HRM_DATE,
    employerSubsidiaryId: HRM_UUID.nullable().optional(),
    departmentId: HRM_UUID.nullable().optional(),
  }),
);
const closeWindowInput = describeObjectFields(closeWindowBody);
const providerContributionTerm = z
  .discriminatedUnion("electionMode", [
    z.object({
      ruleId: HRM_UUID.describe("Contribution rule id from the native plan read."),
      electionMode: z.literal("fixed").describe("Elected fixed contribution mode."),
      electedRate: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .describe("Exact selected contribution rate as a decimal string."),
      declaredPeriodsPerYear: z
        .number()
        .int()
        .min(1)
        .max(366)
        .nullable()
        .optional()
        .describe("Declared pay periods in the year, when required by the plan."),
    }),
    z.object({
      ruleId: HRM_UUID.describe("Contribution rule id from the native plan read."),
      electionMode: z.literal("follows_policy").describe("Follow the plan's configured policy."),
      electedRate: z.null().optional().describe("No override rate for this policy mode."),
      declaredPeriodsPerYear: z
        .number()
        .int()
        .min(1)
        .max(366)
        .nullable()
        .optional()
        .describe("Declared pay periods in the year, when required by the plan."),
    }),
  ])
  .describe("One election term for a plan contribution rule.");
const providerContributionTerms = z
  .array(providerContributionTerm)
  .min(1)
  .max(100)
  .describe("Contribution election terms, up to 100 plan rules.");
const electInput = describeObjectFields(
  electEnrollmentBody.omit({ action: true, selfService: true }).extend({
    employmentId: HRM_UUID,
    planId: HRM_UUID,
    windowId: HRM_UUID.nullable().optional(),
    contributionTerms: providerContributionTerms,
    effectiveFrom: HRM_DATE,
    effectiveTo: HRM_DATE.nullable().optional(),
  }),
  (key) => `Benefits election ${key} using the native enrollment contract.`,
);
const waiveInput = describeObjectFields(
  waiveEnrollmentBody.omit({ action: true, selfService: true }).extend({
    employmentId: HRM_UUID,
    planId: HRM_UUID,
    windowId: HRM_UUID.nullable().optional(),
    effectiveFrom: HRM_DATE,
  }),
  (key) => `Benefits waiver ${key} using the native enrollment contract.`,
);
const changeInput = describeObjectFields(
  changeEnrollmentBody.omit({ action: true }).extend({
    changeDate: HRM_DATE,
    contributionTerms: providerContributionTerms.optional(),
  }),
  (key) => `Effective-dated enrollment change ${key}.`,
);
const endInput = describeObjectFields(
  endEnrollmentBody.omit({ action: true }),
  (key) => `Enrollment end ${key}.`,
);
const cancelInput = describeObjectFields(
  cancelEnrollmentBody.omit({ action: true }),
  (key) => `Enrollment cancellation ${key}.`,
);
const withdrawInput = describeObjectFields(
  withdrawEnrollmentBody.omit({ action: true }),
  (key) => `Unused enrollment withdrawal ${key}.`,
);
const linkInput = describeObjectFields(
  linkDependentBody.omit({ action: true }).extend({ dependentId: HRM_UUID }),
  (key) => `Dependent coverage ${key}.`,
);
const dependentCreateInput = describeObjectFields(
  createDependentBody.extend({ employmentId: HRM_UUID, birthDate: HRM_DATE.nullable().optional() }),
);
const dependentUpdateInput = describeObjectFields(
  updateDependentBody.options[0]!.omit({ action: true }).extend({
    birthDate: HRM_DATE.nullable().optional(),
  }),
  (key) => `Dependent update ${key}.`,
);

export const HRM_BENEFIT_TOOLS: ApplicationToolDefinition[] = [
  hrmMutation({
    name: "create_benefit_award",
    title: "Create Benefit Award",
    description:
      "Create a manual draft award from an active program and eligible employment. Resolve program and employment ids from native Benefits and HRM reads; exact award value and currency are required.",
    input: createAwardInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award = await createBenefitAward({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "submit_benefit_award",
    title: "Submit Benefit Award",
    description:
      "Submit a draft award through the program's configured approval Flow. Read the award in the HRM Benefits workspace first; pending approval decisions use decide_approval.",
    input: z.object({ awardId: idFor("Award") }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award = await submitBenefitAward({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        awardId: input.awardId,
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "queue_benefit_award",
    title: "Queue Benefit Award",
    description:
      "Queue an approved benefit award for a payroll run or adjustment after resolving the target from native payroll reads. This finance handoff requires payroll.manage and preserves the award's exact value and source evidence.",
    input: z.object({
      awardId: idFor("Award"),
      payRunDocumentId: HRM_UUID.nullable()
        .optional()
        .describe("Payroll run document id, when queueing to a run."),
      payRunAdjustmentId: HRM_UUID.nullable()
        .optional()
        .describe("Payroll adjustment id, when queueing to an adjustment."),
    }),
    permission: "payroll.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award =
        input.payRunDocumentId && !input.payRunAdjustmentId
          ? (
              await queueAwardForPayRun({
                orgId: context.authz.user.orgId,
                actorId: context.authz.user.id,
                awardId: input.awardId,
                runDocumentId: input.payRunDocumentId,
              })
            ).award
          : await queueBenefitAward({
              orgId: context.authz.user.orgId,
              actorId: context.authz.user.id,
              awardId: input.awardId,
              payRunDocumentId: input.payRunDocumentId ?? null,
              payRunAdjustmentId: input.payRunAdjustmentId ?? null,
            });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "record_benefit_award_payroll_delivery",
    title: "Record Benefit Award Payroll Delivery",
    description:
      "Record that a queued benefit award was delivered by a committed payroll run or adjustment. Verify the pay run first; the native service binds delivery to that exact run.",
    input: z.object({
      awardId: idFor("Award"),
      payRunDocumentId: HRM_UUID.describe("Committed payroll run document id."),
      payRunAdjustmentId: HRM_UUID.describe("Payroll adjustment id linked to the delivery."),
    }),
    permission: "payroll.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award = await recordPayrollDelivery({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "record_external_benefit_award_delivery",
    title: "Record External Benefit Award Delivery",
    description:
      "Record delivery of an award sent outside payroll with the provider's own reference. Read the award first and use the exact external reference returned by the delivery provider.",
    input: z.object({
      awardId: idFor("Award"),
      externalRef: hrmShortText("Provider-issued delivery reference.", 500),
    }),
    permission: "payroll.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award = await recordExternalDelivery({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "adjust_benefit_award",
    title: "Adjust Benefit Award",
    description:
      "Create a governed adjusting award linked to the correction that authorizes it. Read the original award and correction first; a dated adjustment also needs its source row reference and complete period.",
    input: z
      .object({
        awardId: idFor("Award"),
        correctionId: idFor("Correction"),
        value: exactDecimal("Exact adjustment value as a decimal string."),
        reason,
        sourceReference: hrmShortText(
          "Source row reference for a dated adjustment.",
          500,
        ).optional(),
        periodFrom: HRM_DATE.optional().describe(
          "Adjustment earning-period start; supply with periodTo and sourceReference.",
        ),
        periodTo: HRM_DATE.optional().describe(
          "Adjustment earning-period end; supply with periodFrom and sourceReference.",
        ),
      })
      .superRefine((value, context) => {
        if ((value.periodFrom === undefined) !== (value.periodTo === undefined))
          context.addIssue({
            code: "custom",
            path: ["periodTo"],
            message: "Supply both period dates.",
          });
        if (value.periodFrom !== undefined && value.sourceReference === undefined)
          context.addIssue({
            code: "custom",
            path: ["sourceReference"],
            message: "A dated adjustment needs its source row reference.",
          });
      }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const award = await createAdjustingAward({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        awardId: input.awardId,
        correctionId: input.correctionId,
        value: input.value,
        reason: input.reason,
        ...(input.sourceReference === undefined ? {} : { sourceReference: input.sourceReference }),
        ...(input.periodFrom === undefined
          ? {}
          : { periodFrom: input.periodFrom, periodTo: input.periodTo! }),
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "void_benefit_award",
    title: "Void Benefit Award",
    description:
      "Void an award only while the native lifecycle permits it, with an audit reason. Read the award first; delivered or payroll-consumed history requires a governed correction instead.",
    input: z.object({ awardId: idFor("Award"), reason }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const award = await voidBenefitAward({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        award,
        awardId: award.id,
        status: award.status,
        href: "/hrm/benefits?view=awards",
      };
    },
  }),
  hrmMutation({
    name: "create_benefit_program",
    title: "Create Benefit Program",
    description:
      "Create a program draft with its native family, delivery, valuation and effective-dated scope. Read configured accounts, subsidiaries and component records first; amounts and rates remain exact decimal strings.",
    input: createProgramInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const program = await createBenefitProgram({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        code: input.code,
        reason: input.reason,
        name: input.name,
        family: input.family,
        description: input.description ?? null,
        legalEntityId: input.legalEntityId ?? null,
        currency: input.currency,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        payComponentId: input.payComponentId ?? null,
        deliveryMethod: input.deliveryMethod ?? "payroll",
        valuation: input.valuation ?? "fixed",
        metric: input.metric ?? null,
        metricScope: input.metricScope ?? null,
        scopeIds: input.scopeIds ?? [],
        scopeCustomerIds: input.scopeCustomerIds ?? [],
        scopeDepartmentIds: input.scopeDepartmentIds ?? [],
        unassignedTime: input.unassignedTime ?? "refuse",
        scopeExcludedProjectIds: input.scopeExcludedProjectIds ?? [],
        lossPercentRate: input.lossPercentRate ?? null,
        projectProfitCap: input.projectProfitCap ?? null,
        projectLossCap: input.projectLossCap ?? null,
        poolRounding: input.poolRounding ?? "share",
        includeOpenCommitments: input.includeOpenCommitments ?? false,
        hourClassifications: input.hourClassifications ?? [],
        eligibility: input.eligibility ?? "members",
        allocation: input.allocation ?? "equal",
        percentRate: input.percentRate ?? null,
        fixedAmount: input.fixedAmount ?? null,
        capAmount: input.capAmount ?? null,
        budgetAmount: input.budgetAmount ?? null,
        thresholdAmount: input.thresholdAmount ?? null,
        frequency: input.frequency ?? "manual",
        periodBasis: input.periodBasis ?? null,
        paymentDelayDays: input.paymentDelayDays ?? 0,
        sourceAccountIds: input.sourceAccountIds ?? [],
      });
      return {
        ok: true,
        program,
        programId: program.id,
        status: program.status,
        href: "/hrm/benefits?view=programs",
      };
    },
  }),
  hrmMutation({
    name: "update_benefit_program",
    title: "Update Benefit Program",
    description:
      "Update a draft program or make an effective-dated revision to an active program. Read the program detail first; changes to active terms require a reason and effective date and preserve prior periods.",
    input: z.object({ programId: idFor("Program"), ...updateProgramInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { programId, ...change } = input;
      const program = await updateBenefitProgram({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        programId,
        ...change,
        scopeIds: change.scopeIds ?? undefined,
        scopeCustomerIds: change.scopeCustomerIds ?? undefined,
        scopeDepartmentIds: change.scopeDepartmentIds ?? undefined,
        scopeExcludedProjectIds: change.scopeExcludedProjectIds ?? undefined,
        sourceAccountIds: change.sourceAccountIds ?? undefined,
      });
      return {
        ok: true,
        program,
        programId,
        status: program.status,
        href: "/hrm/benefits?view=programs",
      };
    },
  }),
  hrmMutation({
    name: "activate_benefit_program",
    title: "Activate Benefit Program",
    description:
      "Activate a validated draft benefit program for new awards and memberships. Read the program detail and resolve all required policies and components first; prior program terms are not rewritten.",
    input: z.object({
      programId: idFor("Program"),
      reason: hrmShortText("Reason for activation.", 2000).optional(),
    }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const program = await activateBenefitProgram({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        programId: input.programId,
        reason: input.reason,
      });
      return {
        ok: true,
        program,
        programId: input.programId,
        status: program.status,
        href: "/hrm/benefits?view=programs",
      };
    },
  }),
  hrmMutation({
    name: "close_benefit_program",
    title: "Close Benefit Program",
    description:
      "Close an active benefit program with a recorded reason when outstanding awards and membership rules allow it. Read the program and its open periods first; closure preserves its history.",
    input: z.object({ programId: idFor("Program"), reason }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const program = await closeBenefitProgram({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        program,
        programId: input.programId,
        status: program.status,
        href: "/hrm/benefits?view=programs",
      };
    },
  }),
  hrmMutation({
    name: "add_benefit_program_member",
    title: "Add Benefit Program Member",
    description:
      "Add an employment to a benefit program for an effective date range, with its exact allocation weight and eligibility reason. Read program membership and the employment's effective assignment first.",
    input: z.object({ programId: idFor("Program"), ...addMemberInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { programId, ...member } = input;
      const result = await addProgramMembership({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        programId,
        ...member,
      });
      return { ok: true, ...result, programId, href: "/hrm/benefits?view=programs" };
    },
  }),
  hrmMutation({
    name: "remove_benefit_program_member",
    title: "Remove Benefit Program Member",
    description:
      "End a program membership effective on a specified date with an audit reason. Read membership details from the program workspace; the action refuses a period that conflicts with settled awards.",
    input: z.object({
      programId: idFor("Program"),
      membershipId: idFor("Membership"),
      effectiveTo: HRM_DATE.nullable()
        .optional()
        .describe("Last included day; omit only when native policy supplies it."),
      reason,
    }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const result = await removeProgramMembership({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        ...result,
        programId: input.programId,
        href: "/hrm/benefits?view=programs",
      };
    },
  }),
  hrmMutation({
    name: "settle_benefit_program",
    title: "Settle Benefit Program",
    description:
      "Settle a closed benefit program period to freeze its facts and create draft awards for payable recipients. Read the program and period preview first; awards remain draft for the separate approval and payroll handoff.",
    input: z.object({
      programId: idFor("Program"),
      periodFrom: HRM_DATE.describe("First day in the period."),
      periodTo: HRM_DATE.nullable()
        .optional()
        .describe("Last day in the period; defaults to periodFrom when omitted."),
    }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const settled = await settleIncentivePeriod({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        programId: input.programId,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo ?? input.periodFrom,
      });
      return { ok: true, settled, awards: settled.awards, href: "/hrm/benefits?view=awards" };
    },
  }),
  hrmMutation({
    name: "update_benefit_transaction_policy",
    title: "Update Benefit Transaction Policy",
    description:
      "Save a revision-checked, effective-dated transaction policy for a program. Read its current policy first and supply the exact expected revision and reason; item, scope and weight rules are validated by the native policy service.",
    input: z.object({
      programId: idFor("Program"),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current policy revision returned by the native policy read."),
      reason,
      changeEffectiveFrom: HRM_DATE.nullable()
        .optional()
        .describe("Effective date for a revision to an active program."),
      documentKind: z
        .enum(["sales_order", "customer_invoice", "field_ticket", "quote"])
        .describe("Business document kind the policy allocates."),
      dateBasis: z
        .enum(["document_date", "work_date"])
        .describe("Date used to determine effective policy."),
      unassignedShare: z
        .enum(["refuse", "forfeit"])
        .default("refuse")
        .describe("Treatment when no eligible employee is assigned."),
      rounding: z
        .enum(["per_group", "per_recipient"])
        .default("per_group")
        .describe("Deterministic rounding level."),
      capPercent: exactDecimal("Optional exact percent cap.").nullable().optional(),
      capProjectTypeId: HRM_UUID.nullable()
        .optional()
        .describe("Optional project type limiting the cap."),
      groupingSegmentId: HRM_UUID.nullable().describe(
        "Segment used to group recipient allocation.",
      ),
      itemIds: z.array(HRM_UUID).min(1).max(10000).describe("Eligible item ids."),
      positions: z
        .array(
          z.object({
            key: hrmShortText("Stable position key.", 120),
            name: hrmShortText("Position label.", 200),
            weight: exactDecimal("Exact allocation weight."),
            recipientSource: z
              .enum([
                "assignment",
                "field_ticket_foreman",
                "field_ticket_superintendent",
                "project_foreman",
                "project_manager",
              ])
              .default("assignment")
              .describe("Source of the recipient employment."),
            fallbackOnlyWhenContextAbsent: z
              .boolean()
              .optional()
              .describe("Apply this fallback only when the source context is absent."),
            fallbackSource: z
              .enum([
                "field_ticket_foreman",
                "field_ticket_superintendent",
                "project_foreman",
                "project_manager",
              ])
              .nullable()
              .optional()
              .describe("Recipient fallback when context is absent."),
          }),
        )
        .min(1)
        .max(100)
        .describe("Weighted recipient positions."),
      responsibilities: z
        .array(
          z.object({
            groupId: HRM_UUID.describe("Allocation group id."),
            positionKey: hrmShortText("Position key from positions.", 120),
            employmentId: HRM_UUID.describe("Responsible employment id."),
            effectiveFrom: HRM_DATE.describe("First effective day."),
            effectiveTo: HRM_DATE.nullable().describe(
              "Last effective day, or null for open-ended.",
            ),
          }),
        )
        .max(10000)
        .describe("Effective-dated employment responsibilities."),
      limits: z
        .array(
          z.discriminatedUnion("kind", [
            z.object({
              groupId: HRM_UUID.describe("Allocation group id."),
              kind: z.literal("none").describe("No monetary cap."),
              amount: z.null().describe("No amount for an uncapped group."),
            }),
            z.object({
              groupId: HRM_UUID.describe("Allocation group id."),
              kind: z.literal("amount").describe("Fixed exact monetary cap."),
              amount: exactDecimal("Exact monetary cap amount."),
            }),
          ]),
        )
        .max(10000)
        .describe("Group payout limits."),
    }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const {
        programId,
        expectedRevision,
        reason: changeReason,
        changeEffectiveFrom,
        ...policy
      } = input;
      const record = await saveBenefitTransactionPolicy({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        programId,
        expectedRevision,
        reason: changeReason,
        policy,
        changeEffectiveFrom,
      });
      return {
        ok: true,
        record,
        programId,
        href: `/hrm/benefits?view=programs&program=${programId}`,
      };
    },
  }),
  hrmMutation({
    name: "create_enrollment_window",
    title: "Create Enrollment Window",
    description:
      "Create a draft open-enrollment, new-hire or life-event window with its plan year and optional employer or department scope. Read plan and employment configuration first; open_enrollment_window applies overlap and eligibility controls.",
    input: createWindowInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const window = await createEnrollmentWindow({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        name: input.name,
        kind: input.kind,
        opensOn: input.opensOn,
        closesOn: input.closesOn,
        planYearStartOn: input.planYearStartOn,
        employerSubsidiaryId: input.employerSubsidiaryId ?? null,
        departmentId: input.departmentId ?? null,
      });
      return {
        ok: true,
        window,
        windowId: window.id,
        status: window.status,
        href: "/hrm/benefits?view=windows",
      };
    },
  }),
  hrmMutation({
    name: "open_enrollment_window",
    title: "Open Enrollment Window",
    description:
      "Open a draft enrollment window after checking its date range, scope and existing overlapping windows. Find the window in the HRM Benefits windows workspace; the native service enforces eligibility.",
    input: z.object({ windowId: idFor("Enrollment window") }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const window = await openEnrollmentWindow({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        windowId: input.windowId,
      });
      return {
        ok: true,
        window,
        windowId: input.windowId,
        status: window.status,
        href: "/hrm/benefits?view=windows",
      };
    },
  }),
  hrmMutation({
    name: "close_enrollment_window",
    title: "Close Enrollment Window",
    description:
      "Close an open enrollment window with the required reason; the native service records that reason on each pending election that must be cancelled. Read the window and its pending elections first.",
    input: z.object({ windowId: idFor("Enrollment window"), ...closeWindowInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const window = await closeEnrollmentWindow({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        windowId: input.windowId,
        reason: input.reason,
      });
      return {
        ok: true,
        window,
        windowId: input.windowId,
        status: window.status,
        href: "/hrm/benefits?view=windows",
      };
    },
  }),
  hrmMutation({
    name: "elect_benefit_enrollment",
    title: "Elect Benefit Enrollment",
    description:
      "Elect a plan for an employment during an eligible enrollment window or qualifying life event. Read eligible plans, rules and current enrollments first; the native service validates exact elections and effective dates.",
    input: electInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const enrollment = await electEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        planId: input.planId,
        windowId: input.windowId ?? null,
        classKey: input.classKey,
        matchEligible: input.matchEligible,
        contributionTerms: input.contributionTerms,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        lifeEventReason: input.lifeEventReason ?? null,
        selfService: false,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "waive_benefit_enrollment",
    title: "Waive Benefit Enrollment",
    description:
      "Record an employee's waiver of a plan with a reason and effective date. Read the eligible plan and existing elections first; the native service enforces who may waive and when.",
    input: waiveInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const enrollment = await waiveEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        employmentId: input.employmentId,
        planId: input.planId,
        windowId: input.windowId ?? null,
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
        selfService: false,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "change_benefit_enrollment",
    title: "Change Benefit Enrollment",
    description:
      "Submit a successor enrollment for a covered employee after a qualifying change; current coverage remains active until its Flow approval completes. Read the enrollment and active program rules first.",
    input: z.object({ enrollmentId: idFor("Enrollment"), ...changeInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { enrollmentId, ...change } = input;
      const enrollment = await changeEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId,
        changeDate: change.changeDate,
        classKey: change.classKey,
        matchEligible: change.matchEligible,
        contributionTerms: change.contributionTerms,
        reason: change.reason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "end_benefit_enrollment",
    title: "End Benefit Enrollment",
    description:
      "End active coverage from a specified day with a recorded reason. Read the enrollment and any pending successor first; effective-dated history remains intact.",
    input: z.object({ enrollmentId: idFor("Enrollment"), ...endInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const enrollment = await endEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId: input.enrollmentId,
        endedOn: input.endedOn ?? null,
        reason: input.reason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "cancel_benefit_enrollment",
    title: "Cancel Benefit Enrollment",
    description:
      "Cancel an eligible enrollment with a reason. Read its current state and payroll effects first; the native service refuses cancellation that would rewrite committed coverage history.",
    input: z.object({ enrollmentId: idFor("Enrollment"), ...cancelInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const enrollment = await cancelEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId: input.enrollmentId,
        reason: input.reason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "withdraw_unused_benefit_enrollment",
    title: "Withdraw Unused Benefit Enrollment",
    description:
      "Withdraw an unused enrollment that has not entered a committed payroll period, with a reason. Read the enrollment first; the native service refuses after coverage has been consumed.",
    input: z.object({ enrollmentId: idFor("Enrollment"), ...withdrawInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const enrollment = await withdrawUnusedEnrollment({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId: input.enrollmentId,
        reason: input.reason,
      });
      return {
        ok: true,
        enrollment,
        enrollmentId: enrollment.id,
        status: enrollment.status,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "link_dependent_to_enrollment",
    title: "Link Dependent to Enrollment",
    description:
      "Add a dependent to one enrollment after verifying the dependent and election belong to the same employment. Find their ids from native dependent and enrollment reads.",
    input: z.object({ enrollmentId: idFor("Enrollment"), ...linkInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      await linkDependent({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        enrollmentId: input.enrollmentId,
        dependentId: input.dependentId,
      });
      return {
        ok: true,
        enrollmentId: input.enrollmentId,
        dependentId: input.dependentId,
        href: "/hrm/benefits?view=enrollments",
      };
    },
  }),
  hrmMutation({
    name: "unlink_dependent_from_enrollment",
    title: "Unlink Dependent from Enrollment",
    description:
      "Remove a dependent from one enrollment while retaining the dependent record and election history. Read the enrollment's covered dependents first.",
    input: z.object({ enrollmentId: idFor("Enrollment"), dependentId: idFor("Dependent") }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      await unlinkDependent({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return { ok: true, ...input, href: "/hrm/benefits?view=enrollments" };
    },
  }),
  hrmMutation({
    name: "create_benefit_dependent",
    title: "Create Benefit Dependent",
    description:
      "Create a dependent under one employment for later benefit elections. Read the employee's dependent list first; identity is fixed to this employment and cannot be moved by editing.",
    input: dependentCreateInput,
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const dependent = await createDependent({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        ...input,
      });
      return {
        ok: true,
        dependent,
        dependentId: dependent.id,
        href: "/hrm/benefits?view=employees",
      };
    },
  }),
  hrmMutation({
    name: "update_benefit_dependent",
    title: "Update Benefit Dependent",
    description:
      "Update a dependent's relationship, display name or birth date without changing which employment owns the record. Read the dependent first and provide only the fields to change.",
    input: z.object({ dependentId: idFor("Dependent"), ...dependentUpdateInput.shape }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    execute: async (context, input) => {
      const { dependentId, ...change } = input;
      const dependent = await updateDependent({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        dependentId,
        relationship: change.relationship,
        displayName: change.displayName,
        birthDate: change.birthDate ?? undefined,
      });
      return { ok: true, dependent, dependentId, href: "/hrm/benefits?view=employees" };
    },
  }),
  hrmMutation({
    name: "deactivate_benefit_dependent",
    title: "Deactivate Benefit Dependent",
    description:
      "Deactivate a dependent when they are no longer eligible for future coverage; prior coverage remains in enrollment history. Read the dependent and current elections first.",
    input: z.object({ dependentId: idFor("Dependent") }),
    permission: "hrm.benefits.manage",
    featureKey: "hrm",
    destructive: true,
    execute: async (context, input) => {
      const dependent = await deactivateDependent({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        dependentId: input.dependentId,
      });
      return {
        ok: true,
        dependent,
        dependentId: input.dependentId,
        href: "/hrm/benefits?view=employees",
      };
    },
  }),
];
